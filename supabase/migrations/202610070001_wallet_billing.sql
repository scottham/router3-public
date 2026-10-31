begin;

-- Wallet receivables are deliberately separate from old prepaid Vault lots.
create table private.wallet_billing_policy (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  chain_id bigint not null default 8453 check(chain_id=8453),
  router_address text check(router_address ~ '^0x[0-9a-f]{40}$'),
  runtime_code_hash text check(runtime_code_hash ~ '^0x[0-9a-f]{64}$'),
  treasury_address text check(treasury_address ~ '^0x[0-9a-f]{40}$'),
  wallet_limit_nano bigint not null default 1000000000 check(wallet_limit_nano>0),
  global_limit_nano bigint not null default 100000000000 check(global_limit_nano>0),
  request_limit_nano bigint not null default 1000000000 check(request_limit_nano>0),
  snapshot_ttl_seconds integer not null default 15 check(snapshot_ttl_seconds between 1 and 300),
  debt_max_age_seconds integer not null default 300 check(debt_max_age_seconds between 5 and 86400),
  reserved_nano bigint not null default 0 check(reserved_nano>=0),
  receivable_nano bigint not null default 0 check(receivable_nano>=0),
  check(not enabled or (router_address is not null and runtime_code_hash is not null and treasury_address is not null))
);
insert into private.wallet_billing_policy(singleton) values(true);

create table private.wallet_billing_accounts (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null unique references public.user_wallets(id) on delete restrict,
  owner_app_user_id uuid not null references public.app_users(id) on delete restrict,
  chain_id bigint not null check(chain_id=8453),
  payer_address text not null check(payer_address ~ '^0x[0-9a-f]{40}$'),
  router_address text not null check(router_address ~ '^0x[0-9a-f]{40}$'),
  state text not null default 'active' check(state in('active','collection_failed','suspended')),
  reserved_nano bigint not null default 0 check(reserved_nano>=0),
  receivable_nano bigint not null default 0 check(receivable_nano>=0),
  balance_atomic numeric(78,0) not null default 0 check(balance_atomic>=0),
  allowance_atomic numeric(78,0) not null default 0 check(allowance_atomic>=0),
  snapshot_block bigint,
  snapshot_block_hash text,
  snapshot_at timestamptz,
  last_settled_block bigint not null default 0,
  last_collection_error text,
  last_collection_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  unique(chain_id,payer_address),
  unique(owner_app_user_id,chain_id)
);
alter table private.model_requests add column wallet_billing_account_id uuid
  references private.wallet_billing_accounts(id) on delete restrict;
create index wallet_requests_idx on private.model_requests(wallet_billing_account_id,status);

create table private.wallet_receivables (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references private.model_requests(id) on delete restrict,
  wallet_billing_account_id uuid not null references private.wallet_billing_accounts(id) on delete restrict,
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  charge_id uuid not null unique references private.usage_charges(id) on delete restrict,
  original_nano bigint not null check(original_nano>0),
  outstanding_nano bigint not null check(outstanding_nano>=0),
  pending_nano bigint not null default 0 check(pending_nano>=0),
  created_at timestamptz not null default now(),
  check(pending_nano<=outstanding_nano and outstanding_nano<=original_nano)
);
create index wallet_receivables_open_idx on private.wallet_receivables(wallet_billing_account_id,created_at)
  where outstanding_nano>0;

create function private.register_wallet_billing(p_owner uuid,p_wallet uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare w public.user_wallets%rowtype; p private.wallet_billing_policy%rowtype; result uuid;
begin
  select * into strict p from private.wallet_billing_policy where singleton for update;
  if not p.enabled then raise exception 'WALLET_BILLING_DISABLED'; end if;
  select u.* into w from public.user_wallets u join private.base_account_bindings b
    on b.address_normalized=u.address_normalized and b.app_user_id=u.app_user_id
    where u.id=p_wallet and u.app_user_id=p_owner and u.chain_id=p.chain_id and u.status='active';
  if w.id is null then raise exception 'WALLET_NOT_OWNED'; end if;
  insert into private.wallet_billing_accounts(wallet_id,owner_app_user_id,chain_id,payer_address,router_address)
    values(w.id,p_owner,w.chain_id,w.address_normalized,p.router_address)
    on conflict(wallet_id) do nothing;
  select id into strict result from private.wallet_billing_accounts
    where wallet_id=p_wallet and owner_app_user_id=p_owner and router_address=p.router_address;
  return result;
end $$;

create function private.record_wallet_billing_snapshot(p_wallet uuid,p_block bigint,p_hash text,
  p_balance numeric,p_allowance numeric,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,private as $$
declare p private.wallet_billing_policy%rowtype; w private.wallet_billing_accounts%rowtype;
begin
  select * into strict p from private.wallet_billing_policy where singleton for update;
  select * into strict w from private.wallet_billing_accounts where id=p_wallet for update;
  if p_block<0 or p_hash !~ '^0x[0-9a-f]{64}$' or p_balance<0 or p_allowance<0
    or p_balance<>trunc(p_balance) or p_allowance<>trunc(p_allowance)
    or p_observed_at is null or p_observed_at>clock_timestamp()
    or p_observed_at<clock_timestamp()-make_interval(secs=>p.snapshot_ttl_seconds) then
    raise exception 'INVALID_WALLET_SNAPSHOT';
  end if;
  if p_block<w.last_settled_block or p_block<coalesce(w.snapshot_block,0) or p_observed_at<coalesce(w.snapshot_at,'epoch') then return false; end if;
  update private.wallet_billing_accounts set balance_atomic=p_balance,allowance_atomic=p_allowance,
    snapshot_block=p_block,snapshot_block_hash=p_hash,snapshot_at=p_observed_at where id=w.id;
  return true;
end $$;

create function private.ensure_wallet_receivable_ledger(p_wallet uuid,p_billing uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,private as $$
declare result uuid;
begin
  insert into private.ledger_accounts(code,name,unit,account_type,normal_side,organization_id,billing_account_id)
    select 'asset:wallet-receivable:'||p_wallet||':'||p_billing,'Wallet API receivable','USDC_NANO','asset','debit',organization_id,id
    from private.billing_accounts where id=p_billing on conflict(code) do update set name=excluded.name returning id into result;
  return result;
end $$;

create or replace function private.reserve_wallet_model_request(
  p_project_id uuid,
  p_api_key_id uuid,
  p_model_id uuid,
  p_price_version_id uuid,
  p_idempotency_digest bytea,
  p_request_digest bytea,
  p_max_charge_usdc_nano bigint
)
returns table(request_id uuid, request_status private.model_request_status, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_owner uuid;
  v_wallet private.wallet_billing_accounts%rowtype;
  v_risk private.wallet_billing_policy%rowtype;
  v_project public.projects%rowtype;
  v_billing private.billing_accounts%rowtype;
  v_policy private.project_spend_policies%rowtype;
  v_existing private.model_requests%rowtype;
  v_day private.project_period_counters%rowtype;
  v_month private.project_period_counters%rowtype;
  v_lifetime private.project_period_counters%rowtype;
  v_available bigint;
  v_request_id uuid := gen_random_uuid();
  v_today date := (now() at time zone 'UTC')::date;
  v_month_start date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if p_max_charge_usdc_nano <= 0 then
    raise exception 'MAX_CHARGE_MUST_BE_POSITIVE' using errcode = 'P0001';
  end if;

  select * into strict v_project
  from public.projects where id = p_project_id;

  -- All wallet transitions lock policy -> wallet -> billing -> request.
  select * into strict v_risk from private.wallet_billing_policy where singleton for update;
  if not v_risk.enabled then raise exception 'WALLET_BILLING_DISABLED'; end if;
  select w.* into v_wallet from private.wallet_billing_accounts w
    join private.project_api_keys k on k.owner_app_user_id=w.owner_app_user_id
    join public.user_wallets u on u.id=w.wallet_id and u.status='active'
    where k.id=p_api_key_id and k.project_id=p_project_id and w.chain_id=v_risk.chain_id
      and w.router_address=v_risk.router_address for update of w;
  if v_wallet.id is null then raise exception 'WALLET_BILLING_NOT_REGISTERED'; end if;
  v_billing := private.lock_billing_account(v_project.billing_account_id);

  select k.owner_app_user_id into v_owner from private.project_api_keys k
  join public.app_users u on u.id=k.owner_app_user_id
  join public.organization_members m on m.app_user_id=u.id and m.organization_id=v_project.organization_id
  where k.id=p_api_key_id and k.project_id=p_project_id and k.status='active'
    and (k.expires_at is null or k.expires_at>now()) and 'model:invoke'=any(k.scopes)
    and u.status='active' and m.status='active' and m.role in ('owner','admin','developer');
  if v_owner is null then raise exception 'API_KEY_NOT_ACTIVE'; end if;

  select * into v_existing
  from private.model_requests
  where project_id = p_project_id
    and owner_app_user_id = v_owner
    and idempotency_digest = p_idempotency_digest;

  if found then
    if v_existing.request_digest <> p_request_digest then
      raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' using errcode = 'P0001';
    end if;
    return query select v_existing.id, v_existing.status, true;
    return;
  end if;

  if v_project.status <> 'active' then
    raise exception 'PROJECT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_billing.status <> 'active' then
    raise exception 'BILLING_ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if v_wallet.state<>'active' then raise exception 'WALLET_COLLECTION_BLOCKED'; end if;
  if v_wallet.snapshot_at is null or v_wallet.snapshot_at<clock_timestamp()-make_interval(secs=>v_risk.snapshot_ttl_seconds)
    or v_wallet.snapshot_block<v_wallet.last_settled_block then raise exception 'WALLET_SNAPSHOT_STALE'; end if;
  if p_max_charge_usdc_nano>v_risk.request_limit_nano then raise exception 'WALLET_REQUEST_LIMIT'; end if;
  if v_wallet.reserved_nano+v_wallet.receivable_nano+p_max_charge_usdc_nano>v_risk.wallet_limit_nano then
    raise exception 'WALLET_EXPOSURE_LIMIT'; end if;
  if v_risk.reserved_nano+v_risk.receivable_nano+p_max_charge_usdc_nano>v_risk.global_limit_nano then
    raise exception 'PLATFORM_EXPOSURE_LIMIT'; end if;
  -- Sub-micro USDC dust is carried; it cannot be collected until it reaches one atomic unit.
  if v_wallet.receivable_nano>=1000 and exists(select 1 from private.wallet_receivables r
    where r.wallet_billing_account_id=v_wallet.id and r.outstanding_nano>0
      and r.created_at<now()-make_interval(secs=>v_risk.debt_max_age_seconds)) then
    raise exception 'WALLET_BILL_OVERDUE'; end if;

  if not exists (
    select 1 from private.project_api_keys k
    where k.id = p_api_key_id
      and k.project_id = p_project_id
      and k.status = 'active'
      and (k.expires_at is null or k.expires_at > now())
      and 'model:invoke' = any(k.scopes)
  ) then
    raise exception 'API_KEY_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.model_catalog m
    join private.model_price_versions pv on pv.model_id = m.id
    where m.id = p_model_id and m.enabled = true
      and pv.id = p_price_version_id
      and pv.effective_from <= now()
      and (pv.effective_until is null or pv.effective_until > now())
  ) then
    raise exception 'MODEL_OR_PRICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  select * into strict v_policy
  from private.project_spend_policies
  where project_id = p_project_id
  for update;

  if cardinality(v_policy.allowed_model_ids) > 0
     and not (p_model_id = any(v_policy.allowed_model_ids)) then
    raise exception 'MODEL_NOT_ALLOWED_FOR_PROJECT' using errcode = 'P0001';
  end if;

  if v_policy.max_per_request_usdc_nano is not null
     and p_max_charge_usdc_nano > v_policy.max_per_request_usdc_nano then
    raise exception 'PER_REQUEST_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  v_day := private.ensure_period_counter(p_project_id, 'day', v_today);
  v_month := private.ensure_period_counter(p_project_id, 'month', v_month_start);
  v_lifetime := private.ensure_period_counter(p_project_id, 'lifetime', date '1970-01-01');

  if v_policy.daily_limit_usdc_nano is not null
     and v_day.spent_usdc_nano + v_day.reserved_usdc_nano + p_max_charge_usdc_nano > v_policy.daily_limit_usdc_nano then
    raise exception 'DAILY_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;
  if v_policy.monthly_limit_usdc_nano is not null
     and v_month.spent_usdc_nano + v_month.reserved_usdc_nano + p_max_charge_usdc_nano > v_policy.monthly_limit_usdc_nano then
    raise exception 'MONTHLY_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;
  if v_policy.lifetime_limit_usdc_nano is not null
     and v_lifetime.spent_usdc_nano + v_lifetime.reserved_usdc_nano + p_max_charge_usdc_nano > v_policy.lifetime_limit_usdc_nano then
    raise exception 'LIFETIME_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  v_available := least(9223372036854775807::numeric,
    least(v_wallet.balance_atomic,v_wallet.allowance_atomic)*1000)::bigint
    - v_wallet.reserved_nano - v_wallet.receivable_nano;
  if v_available < p_max_charge_usdc_nano then raise exception 'WALLET_FUNDS_OR_ALLOWANCE_INSUFFICIENT'; end if;

  insert into private.model_requests(
    id, project_id, billing_account_id, api_key_id, model_id, price_version_id,
    idempotency_digest, request_digest, max_charge_usdc_nano, wallet_billing_account_id
  ) values (
    v_request_id, p_project_id, v_billing.id, p_api_key_id, p_model_id,
    p_price_version_id, p_idempotency_digest, p_request_digest,
    p_max_charge_usdc_nano, v_wallet.id
  );

  insert into private.balance_holds(
    request_id, billing_account_id, project_id, amount_usdc_nano
  ) values (v_request_id, v_billing.id, p_project_id, p_max_charge_usdc_nano);

  update private.wallet_billing_accounts set reserved_nano=reserved_nano+p_max_charge_usdc_nano where id=v_wallet.id;
  update private.wallet_billing_policy set reserved_nano=reserved_nano+p_max_charge_usdc_nano where singleton;

  update private.project_period_counters
  set reserved_usdc_nano = reserved_usdc_nano + p_max_charge_usdc_nano,
      updated_at = now()
  where project_id = p_project_id
    and (
      (period_kind = 'day' and period_start = v_today) or
      (period_kind = 'month' and period_start = v_month_start) or
      (period_kind = 'lifetime' and period_start = date '1970-01-01')
    );

  update private.project_api_keys set last_used_at = now() where id = p_api_key_id;

  return query select v_request_id, 'reserved'::private.model_request_status, false;
end;
$$;

create or replace function private.finalize_wallet_model_request(
  p_request_id uuid,
  p_computed_customer_charge_usdc_nano bigint,
  p_provider_cost_usd_nano bigint,
  p_provider_request_id text,
  p_usage_source text,
  p_usage_source_event_id text,
  p_normalized_usage jsonb,
  p_raw_usage_redacted jsonb default null
)
returns table(
  billed_usdc_nano bigint,
  receivable_usdc_nano bigint,
  unbilled_overrun_usdc_nano bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request private.model_requests%rowtype;
  v_wallet private.wallet_billing_accounts%rowtype;
  v_accounts record;
  v_wallet_asset uuid;
  v_hold private.balance_holds%rowtype;
  v_billing private.billing_accounts%rowtype;
  v_charge bigint;
  v_overrun bigint;
  v_covered bigint;
  v_receivable bigint;
  v_usage_charge_id uuid;
  v_today date;
  v_month_start date;
begin
  if p_computed_customer_charge_usdc_nano < 0 or p_provider_cost_usd_nano < 0 then
    raise exception 'NEGATIVE_USAGE_COST' using errcode = 'P0001';
  end if;

  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict v_request from private.model_requests where id=p_request_id;
  select * into strict v_wallet from private.wallet_billing_accounts where id=v_request.wallet_billing_account_id for update;
  v_billing := private.lock_billing_account(v_request.billing_account_id);
  select * into strict v_request from private.model_requests where id=p_request_id for update;

  if v_request.status = 'completed' then
    return query select
      v_request.actual_charge_usdc_nano,
      coalesce((select outstanding_nano from private.wallet_receivables where request_id=p_request_id),0),
      v_request.unbilled_overrun_usdc_nano;
    return;
  end if;
  if v_request.status not in ('reserved','running','usage_pending') then
    raise exception 'REQUEST_NOT_FINALIZABLE' using errcode = 'P0001';
  end if;

  v_billing := private.lock_billing_account(v_request.billing_account_id);
  select * into strict v_hold
  from private.balance_holds where request_id = p_request_id for update;
  if v_hold.status not in ('active','usage_pending') then
    raise exception 'REQUEST_HOLD_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  v_charge := least(p_computed_customer_charge_usdc_nano, v_request.max_charge_usdc_nano);
  v_overrun := greatest(0, p_computed_customer_charge_usdc_nano - v_request.max_charge_usdc_nano);
  v_covered := 0;
  v_receivable := v_charge - v_covered;

  v_today := (v_request.created_at at time zone 'UTC')::date;
  v_month_start := date_trunc('month', v_request.created_at at time zone 'UTC')::date;

  update private.wallet_billing_accounts set reserved_nano=reserved_nano-v_hold.amount_usdc_nano,
    receivable_nano=receivable_nano+v_charge where id=v_wallet.id and reserved_nano>=v_hold.amount_usdc_nano;
  if not found then raise exception 'WALLET_CAPTURE_UNDERFLOW'; end if;
  update private.wallet_billing_policy set reserved_nano=reserved_nano-v_hold.amount_usdc_nano,
    receivable_nano=receivable_nano+v_charge where singleton;

  update private.project_period_counters
  set reserved_usdc_nano = reserved_usdc_nano - v_hold.amount_usdc_nano,
      spent_usdc_nano = spent_usdc_nano + v_charge,
      updated_at = now()
  where project_id = v_request.project_id
    and (
      (period_kind = 'day' and period_start = v_today) or
      (period_kind = 'month' and period_start = v_month_start) or
      (period_kind = 'lifetime' and period_start = date '1970-01-01')
    )
    and reserved_usdc_nano >= v_hold.amount_usdc_nano;

  update private.balance_holds
  set status = 'captured', resolved_at = now()
  where id = v_hold.id;

  insert into private.usage_events(
    request_id, source, source_event_id, normalized_usage, raw_usage_redacted
  ) values (
    p_request_id, p_usage_source, p_usage_source_event_id,
    coalesce(p_normalized_usage, '{}'::jsonb), p_raw_usage_redacted
  ) on conflict (source, source_event_id) do nothing;

  insert into private.usage_charges(
    request_id, billing_account_id, customer_charge_usdc_nano,
    provider_cost_usd_nano, settlement_status
  ) values (
    p_request_id, v_request.billing_account_id, v_charge,
    p_provider_cost_usd_nano,
    case when v_charge=0 then 'settled' else 'unsettled' end
  ) returning id into v_usage_charge_id;

  if v_charge>0 then
    insert into private.wallet_receivables(request_id,wallet_billing_account_id,billing_account_id,charge_id,original_nano,outstanding_nano)
      values(p_request_id,v_wallet.id,v_request.billing_account_id,v_usage_charge_id,v_charge,v_charge);
  end if;

  if v_overrun > 0 then
    insert into private.reconciliation_incidents(
      billing_account_id, severity, incident_type, details
    ) values (
      v_request.billing_account_id, 'warning', 'provider_cost_exceeded_preauthorization',
      jsonb_build_object(
        'request_id', p_request_id,
        'computed_charge_usdc_nano', p_computed_customer_charge_usdc_nano,
        'authorized_charge_usdc_nano', v_request.max_charge_usdc_nano,
        'platform_absorbed_usdc_nano', v_overrun
      )
    );
  end if;

  if v_charge>0 then
    select * into v_accounts from private.ensure_billing_ledger_accounts(v_request.billing_account_id);
    v_wallet_asset := private.ensure_wallet_receivable_ledger(v_wallet.id,v_request.billing_account_id);
    perform private.post_ledger_transaction('wallet-usage:'||p_request_id,'USDC_NANO','model_request',p_request_id::text,
      'Wallet API usage billed',jsonb_build_object('wallet',v_wallet.id),jsonb_build_array(
        jsonb_build_object('account_id',v_wallet_asset,'side','debit','amount_nano',v_charge),
        jsonb_build_object('account_id',v_accounts.model_revenue,'side','credit','amount_nano',v_charge)));
  end if;
  perform private.post_provider_cost_ledger(p_request_id, p_provider_cost_usd_nano);

  update private.model_requests
  set status = 'completed',
      actual_charge_usdc_nano = v_charge,
      unbilled_overrun_usdc_nano = v_overrun,
      provider_cost_usd_nano = p_provider_cost_usd_nano,
      provider_request_id = p_provider_request_id,
      completed_at = now(), updated_at = now()
  where id = p_request_id;

  return query select v_charge, v_receivable, v_overrun;
end;
$$;
create or replace function private.release_wallet_request_hold(
  p_request_id uuid,
  p_final_status private.model_request_status,
  p_failure_code text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request private.model_requests%rowtype;
  v_hold private.balance_holds%rowtype;
  v_today date;
  v_month_start date;
begin
  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict v_request from private.model_requests where id=p_request_id;
  perform 1 from private.wallet_billing_accounts where id=v_request.wallet_billing_account_id for update;
  perform private.lock_billing_account(v_request.billing_account_id);
  select * into strict v_hold from private.balance_holds where request_id = p_request_id for update;

  if v_hold.status not in ('active','usage_pending') then
    return;
  end if;
  if p_final_status not in ('failed','cancelled') then
    raise exception 'INVALID_RELEASE_STATUS' using errcode = 'P0001';
  end if;

  v_today := (v_request.created_at at time zone 'UTC')::date;
  v_month_start := date_trunc('month', v_request.created_at at time zone 'UTC')::date;

  update private.wallet_billing_accounts set reserved_nano=reserved_nano-v_hold.amount_usdc_nano
    where id=v_request.wallet_billing_account_id and reserved_nano>=v_hold.amount_usdc_nano;
  if not found then raise exception 'WALLET_RELEASE_UNDERFLOW'; end if;
  update private.wallet_billing_policy set reserved_nano=reserved_nano-v_hold.amount_usdc_nano where singleton;

  update private.project_period_counters
  set reserved_usdc_nano = reserved_usdc_nano - v_hold.amount_usdc_nano,
      updated_at = now()
  where project_id = v_request.project_id
    and (
      (period_kind = 'day' and period_start = v_today) or
      (period_kind = 'month' and period_start = v_month_start) or
      (period_kind = 'lifetime' and period_start = date '1970-01-01')
    )
    and reserved_usdc_nano >= v_hold.amount_usdc_nano;

  update private.balance_holds
  set status = 'released', resolved_at = now()
  where id = v_hold.id;

  update private.model_requests
  set status = p_final_status, failure_code = p_failure_code,
      completed_at = now(), updated_at = now()
  where id = p_request_id;
end;
$$;

alter function private.finalize_model_request(uuid,bigint,bigint,text,text,text,jsonb,jsonb) rename to finalize_vault_model_request;
create function private.finalize_model_request(p_request_id uuid,p_computed_customer_charge_usdc_nano bigint,
  p_provider_cost_usd_nano bigint,p_provider_request_id text,p_usage_source text,p_usage_source_event_id text,
  p_normalized_usage jsonb,p_raw_usage_redacted jsonb default null)
returns table(billed_usdc_nano bigint,receivable_usdc_nano bigint,unbilled_overrun_usdc_nano bigint)
language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if exists(select 1 from private.model_requests where id=p_request_id and wallet_billing_account_id is not null) then
    return query select * from private.finalize_wallet_model_request(p_request_id,p_computed_customer_charge_usdc_nano,
      p_provider_cost_usd_nano,p_provider_request_id,p_usage_source,p_usage_source_event_id,p_normalized_usage,p_raw_usage_redacted);
  else
    return query select * from private.finalize_vault_model_request(p_request_id,p_computed_customer_charge_usdc_nano,
      p_provider_cost_usd_nano,p_provider_request_id,p_usage_source,p_usage_source_event_id,p_normalized_usage,p_raw_usage_redacted);
  end if;
end $$;

alter function private.release_request_hold(uuid,private.model_request_status,text) rename to release_vault_request_hold;
create function private.release_request_hold(p_request_id uuid,p_final_status private.model_request_status,p_failure_code text default null)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if exists(select 1 from private.model_requests where id=p_request_id and wallet_billing_account_id is not null) then
    perform private.release_wallet_request_hold(p_request_id,p_final_status,p_failure_code);
  else
    perform private.release_vault_request_hold(p_request_id,p_final_status,p_failure_code);
  end if;
end $$;

-- Historical invariants must exclude wallet holds from prepaid-credit counters.
do $$ declare definition text;
begin
  select pg_get_functiondef('private.assert_financial_invariants()'::regprocedure) into definition;
  if position('left join private.balance_holds h on h.billing_account_id = b.id' in definition)=0 then
    raise exception 'INVARIANT_INSERTION_POINT_MISSING'; end if;
  execute replace(definition,'left join private.balance_holds h on h.billing_account_id = b.id',
    'left join private.balance_holds h on h.billing_account_id = b.id and exists(select 1 from private.model_requests r where r.id=h.request_id and r.wallet_billing_account_id is null)');
end $$;
alter function private.assert_financial_invariants() rename to assert_vault_financial_invariants;
create function private.assert_financial_invariants()
returns table(invariant_name text,entity_id text,expected_nano numeric,actual_nano numeric,details jsonb)
language sql security definer set search_path=pg_catalog,private as $$
  select * from private.assert_vault_financial_invariants()
  union all
  select 'wallet_reserved_equals_holds',w.id::text,h.total,w.reserved_nano,'{}'::jsonb
  from private.wallet_billing_accounts w cross join lateral (
    select coalesce(sum(h.amount_usdc_nano),0) total from private.balance_holds h
      join private.model_requests r on r.id=h.request_id
      where r.wallet_billing_account_id=w.id and h.status in('active','usage_pending')) h where h.total<>w.reserved_nano
  union all
  select 'wallet_receivable_equals_claims',w.id::text,r.total,w.receivable_nano,'{}'::jsonb
  from private.wallet_billing_accounts w cross join lateral (
    select coalesce(sum(outstanding_nano),0) total from private.wallet_receivables where wallet_billing_account_id=w.id) r
    where r.total<>w.receivable_nano
  union all
  select 'wallet_global_reserved','global',coalesce(sum(w.reserved_nano),0),p.reserved_nano,'{}'::jsonb
    from private.wallet_billing_policy p left join private.wallet_billing_accounts w on true
    group by p.reserved_nano having coalesce(sum(w.reserved_nano),0)<>p.reserved_nano
  union all
  select 'wallet_global_receivable','global',coalesce(sum(w.receivable_nano),0),p.receivable_nano,'{}'::jsonb
    from private.wallet_billing_policy p left join private.wallet_billing_accounts w on true
    group by p.receivable_nano having coalesce(sum(w.receivable_nano),0)<>p.receivable_nano
$$;

-- Never grant browsers access to snapshots, metering or policy mutation.
revoke all on private.wallet_billing_policy,private.wallet_billing_accounts,private.wallet_receivables from public,anon,authenticated;
revoke all on function private.register_wallet_billing(uuid,uuid),
  private.record_wallet_billing_snapshot(uuid,bigint,text,numeric,numeric,timestamptz),
  private.ensure_wallet_receivable_ledger(uuid,uuid) from public,anon,authenticated;
revoke all on function private.reserve_wallet_model_request(uuid,uuid,uuid,uuid,bytea,bytea,bigint),
  private.finalize_wallet_model_request(uuid,bigint,bigint,text,text,text,jsonb,jsonb),
  private.finalize_model_request(uuid,bigint,bigint,text,text,text,jsonb,jsonb),
  private.release_wallet_request_hold(uuid,private.model_request_status,text),
  private.release_request_hold(uuid,private.model_request_status,text),
  private.assert_financial_invariants() from public,anon,authenticated;

commit;
