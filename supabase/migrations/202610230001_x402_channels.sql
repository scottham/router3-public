begin;
-- x402 payment channels (the x402 Foundation `batch-settlement` scheme on
-- Monad). A payer deposits USDC into the shared x402BatchSettlement contract
-- once, then signs one cumulative voucher per request; the gateway charges the
-- actual cost up to the ceiling the voucher covers and claims on-chain in
-- batches. Channel state mirrors the SDK's record and is authoritative for the
-- cumulative charged amount; everything else is re-read from chain.
create table private.x402_channels (
  channel_id text primary key check(channel_id ~ '^0x[0-9a-f]{64}$'),
  payer text not null check(payer ~ '^0x[0-9a-f]{40}$'),
  payer_authorizer text not null check(payer_authorizer ~ '^0x[0-9a-f]{40}$'),
  state jsonb not null,
  charged_cumulative_atomic numeric(78,0) not null default 0 check(charged_cumulative_atomic>=0),
  signed_max_claimable_atomic numeric(78,0) not null default 0 check(signed_max_claimable_atomic>=0),
  balance_atomic numeric(78,0) not null default 0 check(balance_atomic>=0),
  total_claimed_atomic numeric(78,0) not null default 0 check(total_claimed_atomic>=0),
  withdraw_requested_at bigint not null default 0,
  last_request_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index x402_channels_payer_idx on private.x402_channels(payer,updated_at desc);

create type private.x402_request_status as enum('running','completed','failed','settlement_failed');
create table private.x402_requests (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null check(channel_id ~ '^0x[0-9a-f]{64}$'),
  payer text not null check(payer ~ '^0x[0-9a-f]{40}$'),
  protocol text not null check(protocol in ('chat','anthropic','responses','deposit')),
  model_id uuid references public.model_catalog(id) on delete restrict,
  price_version_id uuid references private.model_price_versions(id) on delete restrict,
  call_fee_policy_id uuid references private.call_fee_policies(id) on delete restrict,
  request_digest bytea,
  status private.x402_request_status not null default 'running',
  -- The hold (nano USDC) and the voucher ceiling it was rounded up to (micro USDC).
  max_charge_usdc_nano bigint not null check(max_charge_usdc_nano>=0),
  ceiling_atomic numeric(78,0) not null check(ceiling_atomic>=0),
  actual_charge_usdc_nano bigint check(actual_charge_usdc_nano is null or actual_charge_usdc_nano>=0),
  unbilled_overrun_usdc_nano bigint not null default 0 check(unbilled_overrun_usdc_nano>=0),
  charged_atomic numeric(78,0) check(charged_atomic is null or charged_atomic>=0),
  cumulative_atomic numeric(78,0) check(cumulative_atomic is null or cumulative_atomic>=0),
  charged_from text check(charged_from in ('usage','ceiling')),
  model_cost_usdc_nano bigint check(model_cost_usdc_nano is null or model_cost_usdc_nano>=0),
  service_fee_usdc_nano bigint check(service_fee_usdc_nano is null or service_fee_usdc_nano>=0),
  service_fee_bps integer check(service_fee_bps is null or service_fee_bps between 0 and 10000),
  provider_cost_usd_nano bigint check(provider_cost_usd_nano is null or provider_cost_usd_nano>=0),
  provider_request_id text,
  usage_source text,
  normalized_usage jsonb,
  raw_usage_redacted jsonb,
  settlement_transaction text,
  failure_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index x402_requests_payer_idx on private.x402_requests(payer,created_at desc);
create index x402_requests_channel_idx on private.x402_requests(channel_id,created_at desc);
create index x402_requests_status_idx on private.x402_requests(status) where status='running';

-- Every on-chain operation the gateway or its facilitator performed.
create table private.x402_settlements (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('deposit','claim','settle','refund')),
  channel_id text check(channel_id is null or channel_id ~ '^0x[0-9a-f]{64}$'),
  transaction text,
  vouchers integer not null default 0 check(vouchers>=0),
  amount_atomic numeric(78,0) check(amount_atomic is null or amount_atomic>=0),
  detail jsonb,
  created_at timestamptz not null default now()
);
create index x402_settlements_created_idx on private.x402_settlements(created_at desc);

create function private.touch_x402_updated_at() returns trigger language plpgsql as $$
begin new.updated_at:=now();return new;end $$;
create trigger x402_channels_touch before update on private.x402_channels for each row execute function private.touch_x402_updated_at();
create trigger x402_requests_touch before update on private.x402_requests for each row execute function private.touch_x402_updated_at();

-- Provider balance reconciliation counts x402 calls too.
create or replace function private.record_provider_balance(p_provider text,p_balance numeric,p_currency text default 'CNY') returns jsonb
language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare cost numeric; row private.provider_balance_checks;
begin
  if p_provider not in ('deepseek','openrouter') then raise exception 'PROVIDER_BALANCE_UNSUPPORTED'; end if;
  if (p_provider='deepseek' and p_currency<>'CNY') or (p_provider='openrouter' and p_currency<>'USD') then raise exception 'PROVIDER_BALANCE_CURRENCY_MISMATCH'; end if;
  -- Providers take a few minutes to deduct a call (DeepSeek measured 2026-10-22:
  -- about 3), so calls completed in the last 5 minutes wait for the next check.
  select coalesce(sum(t.cost),0)/1000000000 into cost from (
    select r.provider_cost_usd_nano*coalesce((v.bailian_quote->'fx'->>'cnyPerUsd')::numeric,1) cost
      from private.model_requests r
      join public.model_catalog c on c.id=r.model_id
      join private.model_price_versions v on v.id=r.price_version_id
      where c.provider=p_provider and v.bailian_quote->>'currency'=p_currency
        and r.status='completed' and r.completed_at<now()-interval '5 minutes'
    union all
    select r.provider_cost_usd_nano*coalesce((v.bailian_quote->'fx'->>'cnyPerUsd')::numeric,1)
      from private.x402_requests r
      join public.model_catalog c on c.id=r.model_id
      join private.model_price_versions v on v.id=r.price_version_id
      where c.provider=p_provider and v.bailian_quote->>'currency'=p_currency
        and r.status='completed' and r.provider_cost_usd_nano is not null and r.completed_at<now()-interval '5 minutes') t;
  insert into private.provider_balance_checks(provider,balance,recorded_cost,currency) values(p_provider,p_balance,cost,p_currency) returning * into row;
  return jsonb_build_object('balance',row.balance::text,'recorded_cost',row.recorded_cost::text,'currency',row.currency,'checked_at',row.checked_at);
end $$;

create function private.metrics_x402() returns jsonb
language sql stable security definer set search_path=pg_catalog,private,public as $$
  select jsonb_build_object(
    'channels',(select jsonb_build_object('n',count(*),'balance_atomic',coalesce(sum(balance_atomic),0)::text,
        'charged_atomic',coalesce(sum(charged_cumulative_atomic),0)::text,'claimed_atomic',coalesce(sum(total_claimed_atomic),0)::text,
        'unclaimed_atomic',coalesce(sum(greatest(charged_cumulative_atomic-total_claimed_atomic,0)),0)::text,
        'withdrawing',count(*) filter (where withdraw_requested_at>0))
      from private.x402_channels),
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('model',model,'status',status,'n',n,'charged_nano',charged::text,'provider_cost_nano',cost::text)),'[]'::jsonb)
      from (select coalesce(c.public_name,'deposit') model,r.status::text status,count(*) n,
        coalesce(sum(r.actual_charge_usdc_nano),0) charged,coalesce(sum(r.provider_cost_usd_nano),0) cost
        from private.x402_requests r left join public.model_catalog c on c.id=r.model_id group by 1,2) s),
    'ceiling_charges',(select count(*) from private.x402_requests where charged_from='ceiling'),
    'settlements',(select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'n',n,'amount_atomic',amount::text)),'[]'::jsonb)
      from (select kind,count(*) n,coalesce(sum(amount_atomic),0) amount from private.x402_settlements
        where created_at>=now()-interval '1 day' group by 1) s),
    'last_claim_age_seconds',(select extract(epoch from now()-max(created_at)) from private.x402_settlements where kind='claim'))
$$;

revoke all on private.x402_channels,private.x402_requests,private.x402_settlements from public,anon,authenticated;
revoke all on function private.metrics_x402(),private.record_provider_balance(text,numeric,text) from public,anon,authenticated;
commit;
