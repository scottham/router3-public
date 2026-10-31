begin;
-- One upstream API key per project for providers that mint call keys from a
-- management key (OpenRouter). The secret is encrypted with the response
-- encryption key; the limit mirrors the project's lifetime limit.
create table private.provider_project_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,30}$'),
  remote_name text not null,
  remote_hash text,
  state text not null check (state in ('active','disabled','deleted')),
  encrypted_secret jsonb,
  limit_usd_nano bigint not null default 0 check (limit_usd_nano>=0),
  usage_usd_nano bigint not null default 0 check (usage_usd_nano>=0),
  last_synced_at timestamptz,
  disabled_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id,provider),
  check (state<>'active' or (remote_hash is not null and encrypted_secret is not null))
);
revoke all on private.provider_project_keys from public,anon,authenticated;

-- Provider balances are checked in the provider's own currency: DeepSeek in
-- CNY, OpenRouter in USD. The recorded cost for the same period is converted
-- with the rate each price version carries (1 for USD quotes).
alter table private.provider_balance_checks drop constraint provider_balance_checks_provider_check;
alter table private.provider_balance_checks add constraint provider_balance_checks_provider_check check (provider in ('deepseek','openrouter'));
alter table private.provider_balance_checks add column currency text not null default 'CNY' check (currency in ('CNY','USD'));
alter table private.provider_balance_checks rename column balance_cny to balance;
alter table private.provider_balance_checks rename column recorded_cost_cny to recorded_cost;

drop function private.record_provider_balance(text,numeric);
create function private.record_provider_balance(p_provider text,p_balance numeric,p_currency text default 'CNY') returns jsonb
language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare cost numeric; row private.provider_balance_checks;
begin
  if p_provider not in ('deepseek','openrouter') then raise exception 'PROVIDER_BALANCE_UNSUPPORTED'; end if;
  if (p_provider='deepseek' and p_currency<>'CNY') or (p_provider='openrouter' and p_currency<>'USD') then raise exception 'PROVIDER_BALANCE_CURRENCY_MISMATCH'; end if;
  -- Providers take a few minutes to deduct a call (DeepSeek measured 2026-10-22:
  -- about 3), so calls completed in the last 5 minutes wait for the next check.
  select coalesce(sum(r.provider_cost_usd_nano*coalesce((v.bailian_quote->'fx'->>'cnyPerUsd')::numeric,1)),0)/1000000000 into cost
    from private.model_requests r
    join public.model_catalog c on c.id=r.model_id
    join private.model_price_versions v on v.id=r.price_version_id
    where c.provider=p_provider and v.bailian_quote->>'currency'=p_currency
      and r.provider_cost_usd_nano is not null and r.completed_at<now()-interval '5 minutes';
  insert into private.provider_balance_checks(provider,balance,recorded_cost,currency) values(p_provider,p_balance,cost,p_currency) returning * into row;
  return jsonb_build_object('balance',row.balance::text,'recorded_cost',row.recorded_cost::text,'currency',row.currency,'checked_at',row.checked_at);
end $$;

create or replace function private.metrics_provider_balance() returns jsonb
language sql stable security definer set search_path=pg_catalog,private as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'currency',currency,'balance',balance::text,
    'checked_at',extract(epoch from checked_at),
    'gap',case when prev_balance>=balance then ((prev_balance-balance)-(recorded_cost-prev_cost))::text end)),'[]'::jsonb)
  from (select *,lag(balance) over w prev_balance,lag(recorded_cost) over w prev_cost,
      row_number() over (partition by provider order by checked_at desc,id desc) rn
    from private.provider_balance_checks window w as (partition by provider order by checked_at,id)) s
  where rn=1
$$;

revoke all on function private.record_provider_balance(text,numeric,text),private.metrics_provider_balance() from public,anon,authenticated;
commit;
