begin;
-- The prepaid pool (WalletPrepaidPool, still deployed) is the API keys' billing
-- again. A wallet signs one USDC permit to the pool and its limits once; the
-- gateway refills the pool from the wallet up to the refill target and debits
-- settled usage within the daily limit. All of a wallet's keys share its pool.
-- x402 channels stay for payer-signed calls.

-- One row per wallet: the pool's on-chain state as last read (snapshot), and
-- the gateway's own running totals, changed only under this row's lock.
create table private.pool_accounts (
  payer text primary key check(payer ~ '^0x[0-9a-f]{40}$'),
  pool_balance_atomic bigint not null default 0 check(pool_balance_atomic>=0),
  withdrawal_atomic bigint not null default 0 check(withdrawal_atomic>=0),
  withdrawable_at timestamptz,
  refill_target_atomic bigint not null default 0 check(refill_target_atomic>=0),
  daily_limit_atomic bigint not null default 0 check(daily_limit_atomic>=0),
  daily_remaining_atomic bigint not null default 0 check(daily_remaining_atomic>=0),
  wallet_balance_atomic numeric(78,0) not null default 0 check(wallet_balance_atomic>=0),
  allowance_atomic numeric(78,0) not null default 0 check(allowance_atomic>=0),
  snapshot_block bigint,
  snapshot_at timestamptz,
  -- Charged to completed requests but not yet debited on-chain.
  unsettled_atomic bigint not null default 0 check(unsettled_atomic>=0),
  -- Holds of running requests and how many there are.
  held_atomic bigint not null default 0 check(held_atomic>=0),
  running integer not null default 0 check(running>=0),
  -- A request waits for a refill (set by the API, cleared by the collector).
  refill_wanted_at timestamptz,
  activation_charged boolean not null default false,
  collection_failures integer not null default 0 check(collection_failures>=0),
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Settlement transactions: a debit of completed charges and/or a refill.
create table private.pool_batches (
  id uuid primary key default gen_random_uuid(),
  payer text not null references private.pool_accounts(payer) on delete restrict,
  batch_key text not null unique check(batch_key ~ '^0x[0-9a-f]{64}$'),
  claim_key text unique check(claim_key is null or claim_key ~ '^0x[0-9a-f]{64}$'),
  debit_atomic bigint not null check(debit_atomic>=0),
  refill_atomic bigint not null check(refill_atomic>=0),
  usage_root text not null check(usage_root ~ '^0x[0-9a-f]{64}$'),
  state text not null default 'planned' check(state in ('planned','submitted','confirmed','failed')),
  tx_hash text,
  refill_result text check(refill_result in ('refilled','skipped')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(debit_atomic>0 or refill_atomic>0),
  check((debit_atomic>0)=(claim_key is not null))
);
create unique index pool_batches_open_idx on private.pool_batches(payer) where state in ('planned','submitted');

-- Requests paid from a pool, and fixed charges (the one-time activation fee).
create table private.pool_requests (
  id uuid primary key default gen_random_uuid(),
  payer text not null references private.pool_accounts(payer) on delete restrict,
  api_key_id uuid references private.api_keys(id) on delete restrict,
  kind text not null default 'request' check(kind in ('request','activation_fee')),
  protocol text check(protocol in ('chat','anthropic','responses')),
  model_id uuid references public.model_catalog(id) on delete restrict,
  price_version_id uuid references private.model_price_versions(id) on delete restrict,
  call_fee_policy_id uuid references private.call_fee_policies(id) on delete restrict,
  request_digest bytea,
  status text not null default 'running' check(status in ('running','completed','failed','settlement_failed')),
  max_charge_usdc_nano bigint not null default 0 check(max_charge_usdc_nano>=0),
  ceiling_atomic bigint not null default 0 check(ceiling_atomic>=0),
  actual_charge_usdc_nano bigint check(actual_charge_usdc_nano is null or actual_charge_usdc_nano>=0),
  unbilled_overrun_usdc_nano bigint not null default 0 check(unbilled_overrun_usdc_nano>=0),
  charged_atomic bigint not null default 0 check(charged_atomic>=0),
  charged_from text check(charged_from in ('usage','ceiling','fee')),
  model_cost_usdc_nano bigint check(model_cost_usdc_nano is null or model_cost_usdc_nano>=0),
  service_fee_usdc_nano bigint check(service_fee_usdc_nano is null or service_fee_usdc_nano>=0),
  service_fee_bps integer check(service_fee_bps is null or service_fee_bps between 0 and 10000),
  provider_cost_usd_nano bigint check(provider_cost_usd_nano is null or provider_cost_usd_nano>=0),
  provider_request_id text,
  usage_source text,
  normalized_usage jsonb,
  raw_usage_redacted jsonb,
  failure_code text,
  -- The settlement that debited this charge.
  batch_id uuid references private.pool_batches(id) on delete restrict,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pool_requests_payer_idx on private.pool_requests(payer,created_at desc);
create index pool_requests_key_idx on private.pool_requests(api_key_id,created_at desc) where api_key_id is not null;
create index pool_requests_running_idx on private.pool_requests(api_key_id) where status='running';
create index pool_requests_unsettled_idx on private.pool_requests(payer,completed_at) where batch_id is null and charged_atomic>0;
create index pool_requests_batch_idx on private.pool_requests(batch_id) where batch_id is not null;

-- Calls the wallet signed for the gateway to relay: the USDC permit to the
-- pool, its limits, a withdrawal request or cancellation; and the gateway's
-- own unsigned calls (executing a matured withdrawal, sweeping to the Treasury).
create table private.pool_ops (
  id uuid primary key default gen_random_uuid(),
  payer text check(payer is null or payer ~ '^0x[0-9a-f]{40}$'),
  kind text not null check(kind in ('permit','configure','request_withdrawal','cancel_withdrawal','withdraw','sweep')),
  payload jsonb not null default '{}'::jsonb,
  state text not null default 'queued' check(state in ('queued','submitted','confirmed','failed')),
  tx_hash text,
  error_code text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((kind='sweep')=(payer is null))
);
create index pool_ops_open_idx on private.pool_ops(state,created_at) where state in ('queued','submitted');
create unique index pool_ops_open_kind_idx on private.pool_ops(coalesce(payer,''),kind) where state in ('queued','submitted');

-- Per-key spending limits (null: no limit beyond the pool's own).
alter table private.api_keys add column daily_limit_atomic bigint check(daily_limit_atomic is null or daily_limit_atomic>0);
alter table private.api_keys add column total_limit_atomic bigint check(total_limit_atomic is null or total_limit_atomic>0);
-- New keys bill from the pool and have no channel; older keys keep theirs so
-- what is left on it stays refundable.
alter table private.api_keys alter column authorizer drop not null;
alter table private.api_keys alter column encrypted_authorizer drop not null;
alter table private.api_keys alter column salt drop not null;
alter table private.api_keys alter column channel_id drop not null;

create trigger pool_accounts_touch before update on private.pool_accounts for each row execute function private.touch_x402_updated_at();
create trigger pool_batches_touch before update on private.pool_batches for each row execute function private.touch_x402_updated_at();
create trigger pool_requests_touch before update on private.pool_requests for each row execute function private.touch_x402_updated_at();
create trigger pool_ops_touch before update on private.pool_ops for each row execute function private.touch_x402_updated_at();

-- Requests a crashed process left running: charged their hold (usage is
-- unknown), bounded by the pool like any charge.
create function private.recover_lost_pool_requests(p_before timestamptz) returns integer
language plpgsql security definer set search_path=pg_catalog,private as $$
declare r record; n integer:=0; v_room bigint; v_charge bigint;
begin
  for r in select id,payer from private.pool_requests where status='running' and started_at<p_before order by started_at loop
    perform 1 from private.pool_accounts where payer=r.payer for update;
    select greatest(least(a.pool_balance_atomic-a.withdrawal_atomic,a.daily_remaining_atomic)-a.unsettled_atomic,0)
      into v_room from private.pool_accounts a where a.payer=r.payer;
    select least(q.ceiling_atomic,v_room) into v_charge from private.pool_requests q where q.id=r.id and q.status='running';
    if v_charge is null then continue; end if;
    update private.pool_requests set status='completed',charged_atomic=v_charge,charged_from='ceiling',
      actual_charge_usdc_nano=v_charge*1000,failure_code='LOST_REQUEST',usage_source='ceiling:LOST_REQUEST',completed_at=now()
      where id=r.id;
    update private.pool_accounts set held_atomic=greatest(held_atomic-(select ceiling_atomic from private.pool_requests where id=r.id),0),
      running=greatest(running-1,0),unsettled_atomic=unsettled_atomic+v_charge where payer=r.payer;
    n:=n+1;
  end loop;
  return n;
end $$;
revoke all on function private.recover_lost_pool_requests(timestamptz) from public;

-- The settlement signer's journal: nonce and signed bytes are stored before
-- the first broadcast, so a restart re-sends the same transaction. Only the
-- signer role may read it.
create schema if not exists settlement_signing;
revoke all on schema settlement_signing from public;
create table if not exists settlement_signing.transactions (
  idempotency_key text primary key,
  request_digest text not null,
  chain_id bigint not null,
  sender text not null,
  nonce bigint not null,
  raw_transaction text not null,
  tx_hash text not null unique,
  max_cost_wei numeric(78,0) not null check(max_cost_wei>0),
  amount_usdc_atomic numeric(78,0) not null check(amount_usdc_atomic>=0),
  created_at timestamptz not null default now(),
  broadcast_at timestamptz,
  unique(chain_id,sender,nonce)
);
revoke all on all tables in schema settlement_signing from public;
commit;
