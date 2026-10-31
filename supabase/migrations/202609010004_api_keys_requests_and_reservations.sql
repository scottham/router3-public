begin;

do $$ begin
  create type private.api_key_status as enum ('active', 'revoked', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.model_request_status as enum (
    'reserved', 'running', 'usage_pending', 'completed', 'failed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.hold_status as enum ('active', 'captured', 'released', 'usage_pending');
exception when duplicate_object then null; end $$;

create table if not exists private.project_api_keys (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  secret_digest bytea not null unique,
  scopes text[] not null default array['model:invoke']::text[],
  status private.api_key_status not null default 'active',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (length(key_prefix) between 8 and 32)
);
create index if not exists project_api_keys_project_idx
  on private.project_api_keys(project_id, status);

create table if not exists private.project_period_counters (
  project_id uuid not null references public.projects(id) on delete cascade,
  period_kind text not null check (period_kind in ('day','month','lifetime')),
  period_start date not null,
  spent_usdc_nano bigint not null default 0 check (spent_usdc_nano >= 0),
  reserved_usdc_nano bigint not null default 0 check (reserved_usdc_nano >= 0),
  updated_at timestamptz not null default now(),
  primary key (project_id, period_kind, period_start)
);

create table if not exists private.model_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  api_key_id uuid not null references private.project_api_keys(id) on delete restrict,
  model_id uuid not null references public.model_catalog(id) on delete restrict,
  price_version_id uuid not null references private.model_price_versions(id) on delete restrict,
  idempotency_digest bytea not null,
  request_digest bytea not null,
  status private.model_request_status not null default 'reserved',
  max_charge_usdc_nano bigint not null check (max_charge_usdc_nano >= 0),
  actual_charge_usdc_nano bigint check (actual_charge_usdc_nano is null or actual_charge_usdc_nano >= 0),
  unbilled_overrun_usdc_nano bigint not null default 0 check (unbilled_overrun_usdc_nano >= 0),
  provider_cost_usd_nano bigint check (provider_cost_usd_nano is null or provider_cost_usd_nano >= 0),
  provider_request_id text,
  failure_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, idempotency_digest)
);
create index if not exists model_requests_billing_status_idx
  on private.model_requests(billing_account_id, status, created_at);
create index if not exists model_requests_provider_request_idx
  on private.model_requests(provider_request_id)
  where provider_request_id is not null;

create table if not exists private.balance_holds (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references private.model_requests(id) on delete restrict,
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  amount_usdc_nano bigint not null check (amount_usdc_nano >= 0),
  status private.hold_status not null default 'active',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists balance_holds_billing_active_idx
  on private.balance_holds(billing_account_id, status)
  where status in ('active','usage_pending');

create table if not exists private.usage_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references private.model_requests(id) on delete restrict,
  source text not null,
  source_event_id text not null,
  normalized_usage jsonb not null,
  raw_usage_redacted jsonb,
  created_at timestamptz not null default now(),
  unique (source, source_event_id)
);

create table if not exists private.usage_charges (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references private.model_requests(id) on delete restrict,
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  customer_charge_usdc_nano bigint not null check (customer_charge_usdc_nano >= 0),
  provider_cost_usd_nano bigint not null check (provider_cost_usd_nano >= 0),
  settlement_status text not null default 'unsettled'
    check (settlement_status in ('unsettled','partially_settled','settled','unbacked')),
  created_at timestamptz not null default now()
);
create index if not exists usage_charges_settlement_idx
  on private.usage_charges(settlement_status, created_at);

create table if not exists private.encrypted_response_cache (
  request_id uuid primary key references private.model_requests(id) on delete cascade,
  key_id text not null,
  nonce bytea not null,
  auth_tag bytea not null,
  ciphertext bytea not null,
  content_type text not null default 'application/json',
  plaintext_size integer not null check (plaintext_size >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists response_cache_expiry_idx on private.encrypted_response_cache(expires_at);

create or replace function private.lock_billing_account(p_billing_account_id uuid)
returns private.billing_accounts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_account private.billing_accounts%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_billing_account_id::text, 4194304));
  select * into strict v_account
  from private.billing_accounts
  where id = p_billing_account_id
  for update;
  return v_account;
end;
$$;

create or replace function private.assert_billing_funding_fresh(p_billing_account_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_fresh_until timestamptz;
begin
  select funding_fresh_until into strict v_fresh_until
  from private.billing_accounts
  where id = p_billing_account_id;

  if v_fresh_until is null or v_fresh_until < now() then
    raise exception 'CHAIN_INDEXER_STALE' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function private.ensure_period_counter(
  p_project_id uuid,
  p_kind text,
  p_start date
)
returns private.project_period_counters
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_counter private.project_period_counters%rowtype;
begin
  insert into private.project_period_counters(project_id, period_kind, period_start)
  values (p_project_id, p_kind, p_start)
  on conflict (project_id, period_kind, period_start) do nothing;

  select * into strict v_counter
  from private.project_period_counters
  where project_id = p_project_id
    and period_kind = p_kind
    and period_start = p_start
  for update;

  return v_counter;
end;
$$;

create or replace function private.reserve_model_request(
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

  v_billing := private.lock_billing_account(v_project.billing_account_id);

  select * into v_existing
  from private.model_requests
  where project_id = p_project_id
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

  perform private.assert_billing_funding_fresh(v_billing.id);

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

  v_available := greatest(
    0,
    v_billing.credit_balance_usdc_nano
      - v_billing.reserved_usdc_nano
      - v_billing.withdrawal_reserved_usdc_nano
  );
  if v_available < p_max_charge_usdc_nano then
    raise exception 'INSUFFICIENT_AVAILABLE_CREDIT' using errcode = 'P0001';
  end if;

  insert into private.model_requests(
    id, project_id, billing_account_id, api_key_id, model_id, price_version_id,
    idempotency_digest, request_digest, max_charge_usdc_nano
  ) values (
    v_request_id, p_project_id, v_billing.id, p_api_key_id, p_model_id,
    p_price_version_id, p_idempotency_digest, p_request_digest,
    p_max_charge_usdc_nano
  );

  insert into private.balance_holds(
    request_id, billing_account_id, project_id, amount_usdc_nano
  ) values (v_request_id, v_billing.id, p_project_id, p_max_charge_usdc_nano);

  update private.billing_accounts
  set reserved_usdc_nano = reserved_usdc_nano + p_max_charge_usdc_nano,
      version = version + 1
  where id = v_billing.id;

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

create or replace function private.start_model_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.model_requests
  set status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
  where id = p_request_id and status = 'reserved';
  if not found then
    raise exception 'REQUEST_NOT_RESERVED' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function private.release_request_hold(
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
  select * into strict v_request from private.model_requests where id = p_request_id;
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

  update private.billing_accounts
  set reserved_usdc_nano = reserved_usdc_nano - v_hold.amount_usdc_nano,
      version = version + 1
  where id = v_request.billing_account_id
    and reserved_usdc_nano >= v_hold.amount_usdc_nano;
  if not found then
    raise exception 'BILLING_RESERVED_UNDERFLOW' using errcode = 'P0001';
  end if;

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

create or replace function private.mark_request_usage_pending(
  p_request_id uuid,
  p_failure_code text default 'USAGE_UNCERTAIN'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.model_requests
  set status = 'usage_pending', failure_code = p_failure_code, updated_at = now()
  where id = p_request_id and status in ('reserved','running');
  if not found then
    raise exception 'REQUEST_NOT_PENDING' using errcode = 'P0001';
  end if;

  update private.balance_holds
  set status = 'usage_pending'
  where request_id = p_request_id and status = 'active';
end;
$$;

create or replace function private.recover_stale_model_requests(p_stale_before timestamptz)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_count integer;
begin
  with changed as (
    update private.model_requests
    set status = 'usage_pending', failure_code = 'WORKER_LOST_USAGE_UNKNOWN', updated_at = now()
    where status in ('reserved','running')
      and coalesce(started_at, created_at) < p_stale_before
    returning id
  )
  update private.balance_holds h
  set status = 'usage_pending'
  from changed c
  where h.request_id = c.id and h.status = 'active';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

commit;
