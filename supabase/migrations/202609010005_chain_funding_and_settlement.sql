begin;

do $$ begin
  create type private.chain_account_status as enum ('active', 'unlock_pending', 'suspended', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.chain_event_status as enum ('applied', 'unmatched', 'quarantined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.settlement_batch_status as enum (
    'planned', 'awaiting_signature', 'submitted', 'confirmed', 'failed', 'quarantined'
  );
exception when duplicate_object then null; end $$;

create table if not exists private.chain_accounts (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  owner_wallet_id uuid not null references public.user_wallets(id) on delete restrict,
  chain_id bigint not null check (chain_id > 0),
  vault_address text not null,
  vault_address_normalized text generated always as (lower(vault_address)) stored,
  account_id_hex text not null,
  pool_key_hex text not null,
  status private.chain_account_status not null default 'active',
  confirmed_balance_usdc_atomic numeric(78,0) not null default 0 check (confirmed_balance_usdc_atomic >= 0),
  confirmed_allocated_usdc_atomic numeric(78,0) not null default 0 check (confirmed_allocated_usdc_atomic >= 0),
  pending_unlock_usdc_atomic numeric(78,0) not null default 0 check (pending_unlock_usdc_atomic >= 0),
  unlock_available_at timestamptz,
  last_finalized_block bigint,
  last_finalized_block_hash text,
  last_indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (vault_address ~ '^0x[0-9a-fA-F]{40}$'),
  check (account_id_hex ~ '^0x[0-9a-fA-F]{64}$'),
  check (pool_key_hex ~ '^0x[0-9a-fA-F]{64}$'),
  unique (chain_id, vault_address_normalized, account_id_hex),
  unique (billing_account_id, chain_id, vault_address_normalized, owner_wallet_id)
);
create index if not exists chain_accounts_billing_idx
  on private.chain_accounts(billing_account_id, status);

alter table private.ledger_accounts
  drop constraint if exists ledger_accounts_chain_account_id_fkey;
alter table private.ledger_accounts
  add constraint ledger_accounts_chain_account_id_fkey
  foreign key (chain_account_id) references private.chain_accounts(id) on delete restrict;

create table if not exists private.chain_events (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  vault_address_normalized text not null,
  tx_hash text not null,
  log_index integer not null check (log_index >= 0),
  block_number bigint not null,
  block_hash text not null,
  account_id_hex text,
  event_name text not null,
  payload jsonb not null,
  status private.chain_event_status not null,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (chain_id, vault_address_normalized, tx_hash, log_index)
);
create index if not exists chain_events_unmatched_idx
  on private.chain_events(status, chain_id, block_number)
  where status in ('unmatched','quarantined');

create table if not exists private.funding_lots (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  chain_account_id uuid not null references private.chain_accounts(id) on delete restrict,
  allocation_event_id uuid not null unique references private.chain_events(id) on delete restrict,
  total_usdc_nano bigint not null check (total_usdc_nano > 0),
  available_usdc_nano bigint not null check (available_usdc_nano >= 0),
  committed_usdc_nano bigint not null default 0 check (committed_usdc_nano >= 0),
  settled_usdc_nano bigint not null default 0 check (settled_usdc_nano >= 0),
  unlocked_usdc_nano bigint not null default 0 check (unlocked_usdc_nano >= 0),
  created_at timestamptz not null default now(),
  check (
    total_usdc_nano = available_usdc_nano + committed_usdc_nano + settled_usdc_nano + unlocked_usdc_nano
  )
);
create index if not exists funding_lots_available_idx
  on private.funding_lots(billing_account_id, created_at)
  where available_usdc_nano > 0;
create index if not exists funding_lots_chain_idx
  on private.funding_lots(chain_account_id, created_at);

create table if not exists private.funding_commitments (
  id uuid primary key default gen_random_uuid(),
  funding_lot_id uuid not null references private.funding_lots(id) on delete restrict,
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  source_type text not null check (source_type in ('usage_charge','receivable_recovery')),
  source_id uuid not null,
  amount_usdc_nano bigint not null check (amount_usdc_nano > 0),
  pending_usdc_nano bigint not null default 0 check (pending_usdc_nano >= 0),
  settled_usdc_nano bigint not null default 0 check (settled_usdc_nano >= 0),
  unbacked_usdc_nano bigint not null default 0 check (unbacked_usdc_nano >= 0),
  replaces_commitment_id uuid references private.funding_commitments(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (pending_usdc_nano + settled_usdc_nano + unbacked_usdc_nano <= amount_usdc_nano)
);
create index if not exists funding_commitments_settlement_idx
  on private.funding_commitments(funding_lot_id, created_at)
  where amount_usdc_nano > pending_usdc_nano + settled_usdc_nano + unbacked_usdc_nano;
create index if not exists funding_commitments_source_idx
  on private.funding_commitments(source_type, source_id);

create table if not exists private.chain_unlocks (
  id uuid primary key default gen_random_uuid(),
  chain_account_id uuid not null references private.chain_accounts(id) on delete restrict,
  request_event_id uuid not null unique references private.chain_events(id) on delete restrict,
  requested_usdc_atomic numeric(78,0) not null check (requested_usdc_atomic > 0),
  actual_unlocked_usdc_atomic numeric(78,0),
  status text not null check (status in ('pending','cancelled','finalized')),
  unlock_available_at timestamptz not null,
  finalized_event_id uuid references private.chain_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists chain_unlocks_one_pending_uq
  on private.chain_unlocks(chain_account_id)
  where status = 'pending';

create table if not exists private.settlement_batches (
  id uuid primary key default gen_random_uuid(),
  batch_key_hex text not null unique check (batch_key_hex ~ '^0x[0-9a-f]{64}$'),
  chain_account_id uuid not null references private.chain_accounts(id) on delete restrict,
  status private.settlement_batch_status not null default 'planned',
  total_usdc_nano bigint not null check (total_usdc_nano > 0),
  total_usdc_atomic numeric(78,0) not null check (total_usdc_atomic > 0),
  usage_root_hex text check (usage_root_hex is null or usage_root_hex ~ '^0x[0-9a-f]{64}$'),
  tx_hash text,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total_usdc_nano = total_usdc_atomic * 1000)
);
create index if not exists settlement_batches_status_idx
  on private.settlement_batches(status, created_at);

create table if not exists private.settlement_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references private.settlement_batches(id) on delete restrict,
  chain_account_id uuid not null references private.chain_accounts(id) on delete restrict,
  claim_key_hex text not null unique check (claim_key_hex ~ '^0x[0-9a-f]{64}$'),
  amount_usdc_nano bigint not null check (amount_usdc_nano > 0),
  amount_usdc_atomic numeric(78,0) not null check (amount_usdc_atomic > 0),
  created_at timestamptz not null default now(),
  unique (batch_id, chain_account_id),
  check (amount_usdc_nano = amount_usdc_atomic * 1000)
);

create table if not exists private.settlement_fragments (
  id uuid primary key default gen_random_uuid(),
  settlement_item_id uuid not null references private.settlement_items(id) on delete restrict,
  funding_commitment_id uuid not null references private.funding_commitments(id) on delete restrict,
  amount_usdc_nano bigint not null check (amount_usdc_nano > 0),
  created_at timestamptz not null default now(),
  unique (settlement_item_id, funding_commitment_id)
);

create table if not exists private.reconciliation_incidents (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid references private.billing_accounts(id) on delete restrict,
  chain_account_id uuid references private.chain_accounts(id) on delete restrict,
  severity text not null check (severity in ('warning','critical')),
  incident_type text not null,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists reconciliation_incidents_open_idx
  on private.reconciliation_incidents(status, severity, created_at)
  where status <> 'resolved';

create or replace function private.register_chain_account(
  p_actor_app_user_id uuid,
  p_billing_account_id uuid,
  p_owner_wallet_id uuid,
  p_chain_id bigint,
  p_vault_address text,
  p_account_id_hex text,
  p_pool_key_hex text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_org uuid;
  v_id uuid;
  v_wallet public.user_wallets%rowtype;
begin
  select organization_id into strict v_org
  from private.billing_accounts where id = p_billing_account_id;

  if not exists (
    select 1 from public.organization_members om
    where om.organization_id = v_org
      and om.app_user_id = p_actor_app_user_id
      and om.status = 'active'
      and om.role in ('owner','admin','billing')
  ) then
    raise exception 'ORG_BILLING_PERMISSION_DENIED' using errcode = 'P0001';
  end if;

  select * into strict v_wallet
  from public.user_wallets
  where id = p_owner_wallet_id and status = 'active';

  if v_wallet.app_user_id <> p_actor_app_user_id and not exists (
    select 1 from public.organization_members om
    where om.organization_id = v_org
      and om.app_user_id = v_wallet.app_user_id
      and om.status = 'active'
  ) then
    raise exception 'FUNDING_WALLET_NOT_ORG_MEMBER' using errcode = 'P0001';
  end if;

  if v_wallet.chain_id <> p_chain_id then
    raise exception 'WALLET_CHAIN_MISMATCH' using errcode = 'P0001';
  end if;

  insert into private.chain_accounts(
    billing_account_id, owner_wallet_id, chain_id, vault_address,
    account_id_hex, pool_key_hex
  ) values (
    p_billing_account_id, p_owner_wallet_id, p_chain_id, lower(p_vault_address),
    lower(p_account_id_hex), lower(p_pool_key_hex)
  )
  on conflict (chain_id, vault_address_normalized, account_id_hex)
  do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function private.heartbeat_chain_indexer(
  p_chain_id bigint,
  p_vault_address text,
  p_finalized_block bigint,
  p_finalized_block_hash text,
  p_fresh_for_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_count integer;
begin
  if p_fresh_for_seconds < 10 or p_fresh_for_seconds > 3600 then
    raise exception 'INVALID_FRESHNESS_WINDOW' using errcode = 'P0001';
  end if;

  update private.chain_accounts
  set last_indexed_at = now(),
      last_finalized_block = greatest(coalesce(last_finalized_block, 0), p_finalized_block),
      last_finalized_block_hash = p_finalized_block_hash,
      updated_at = now()
  where chain_id = p_chain_id
    and vault_address_normalized = lower(p_vault_address)
    and status <> 'closed';
  get diagnostics v_count = row_count;

  update private.billing_accounts b
  set funding_fresh_until = now() + make_interval(secs => p_fresh_for_seconds),
      version = version + 1
  where exists (
    select 1 from private.chain_accounts c
    where c.billing_account_id = b.id
      and c.chain_id = p_chain_id
      and c.vault_address_normalized = lower(p_vault_address)
      and c.status <> 'closed'
  )
  and not exists (
    select 1 from private.chain_accounts stale
    where stale.billing_account_id = b.id
      and stale.status <> 'closed'
      and (stale.last_indexed_at is null or stale.last_indexed_at < now() - make_interval(secs => p_fresh_for_seconds))
  );

  return v_count;
end;
$$;

-- Replaces the allocation function with a zero-safe ledger entry implementation.
create or replace function private.post_allocation_ledger(
  p_event_id uuid,
  p_chain_account_id uuid,
  p_asset_account_id uuid,
  p_customer_credit_id uuid,
  p_customer_receivable_id uuid,
  p_amount_nano bigint,
  p_credit_nano bigint,
  p_repay_nano bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_entries jsonb;
begin
  v_entries := jsonb_build_array(
    jsonb_build_object('account_id', p_asset_account_id, 'side', 'debit', 'amount_nano', p_amount_nano)
  );
  if p_repay_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', p_customer_receivable_id, 'side', 'credit', 'amount_nano', p_repay_nano)
    );
  end if;
  if p_credit_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', p_customer_credit_id, 'side', 'credit', 'amount_nano', p_credit_nano)
    );
  end if;

  perform private.post_ledger_transaction(
    'chain-allocation:' || p_event_id::text,
    'USDC_NANO', 'chain_event', p_event_id::text,
    'Confirmed USDC budget allocation',
    jsonb_build_object('chain_account_id', p_chain_account_id, 'event', 'BudgetAllocated'),
    v_entries
  );
end;
$$;

-- Patch apply_budget_allocated to use the zero-safe helper.
create or replace function private.apply_budget_allocated(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_amount_usdc_atomic numeric,
  p_balance_usdc_atomic numeric,
  p_allocated_usdc_atomic numeric,
  p_payload jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_event_id uuid;
  v_chain private.chain_accounts%rowtype;
  v_amount_nano bigint;
  v_repay bigint;
  v_credit bigint;
  v_asset uuid;
  v_accounts record;
  v_lot uuid;
  v_remaining_recovery bigint;
  v_unbacked record;
  v_piece bigint;
begin
  if p_amount_usdc_atomic <= 0 or p_amount_usdc_atomic > 9223372036854775 then
    raise exception 'INVALID_ALLOCATION_AMOUNT' using errcode = 'P0001';
  end if;
  v_amount_nano := (p_amount_usdc_atomic * 1000)::bigint;

  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'BudgetAllocated', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event_id;

  if v_event_id is null then return false; end if;

  select * into v_chain
  from private.chain_accounts
  where chain_id = p_chain_id
    and vault_address_normalized = lower(p_vault_address)
    and account_id_hex = lower(p_account_id_hex)
  for update;
  if not found then return false; end if;

  perform private.lock_billing_account(v_chain.billing_account_id);
  select * into v_accounts from private.ensure_billing_ledger_accounts(v_chain.billing_account_id);
  v_asset := private.ensure_chain_asset_ledger_account(
    v_chain.id, v_chain.billing_account_id, p_chain_id, p_vault_address
  );

  select least(receivable_usdc_nano, v_amount_nano)
  into v_repay
  from private.billing_accounts where id = v_chain.billing_account_id;
  v_credit := v_amount_nano - v_repay;

  insert into private.funding_lots(
    billing_account_id, chain_account_id, allocation_event_id,
    total_usdc_nano, available_usdc_nano, committed_usdc_nano
  ) values (
    v_chain.billing_account_id, v_chain.id, v_event_id,
    v_amount_nano, v_credit, v_repay
  ) returning id into v_lot;

  v_remaining_recovery := v_repay;
  for v_unbacked in
    select fc.* from private.funding_commitments fc
    where fc.billing_account_id = v_chain.billing_account_id
      and fc.unbacked_usdc_nano > 0
      and fc.source_type = 'usage_charge'
    order by fc.created_at, fc.id
    for update
  loop
    exit when v_remaining_recovery = 0;
    v_piece := least(v_remaining_recovery, v_unbacked.unbacked_usdc_nano);
    insert into private.funding_commitments(
      funding_lot_id, billing_account_id, source_type, source_id,
      amount_usdc_nano, replaces_commitment_id
    ) values (
      v_lot, v_chain.billing_account_id, 'receivable_recovery',
      v_unbacked.source_id, v_piece, v_unbacked.id
    );
    v_remaining_recovery := v_remaining_recovery - v_piece;
  end loop;
  if v_remaining_recovery <> 0 then
    raise exception 'RECEIVABLE_RECOVERY_ALLOCATION_MISMATCH' using errcode = 'P0001';
  end if;

  update private.billing_accounts
  set credit_balance_usdc_nano = credit_balance_usdc_nano + v_credit,
      receivable_usdc_nano = receivable_usdc_nano - v_repay,
      version = version + 1
  where id = v_chain.billing_account_id;

  update private.chain_accounts
  set confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
      confirmed_allocated_usdc_atomic = p_allocated_usdc_atomic,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash),
      last_indexed_at = now(), updated_at = now()
  where id = v_chain.id;

  perform private.post_allocation_ledger(
    v_event_id, v_chain.id, v_asset,
    v_accounts.customer_credit, v_accounts.customer_receivable,
    v_amount_nano, v_credit, v_repay
  );

  update private.chain_events set status = 'applied', applied_at = now() where id = v_event_id;
  return true;
end;
$$;

create or replace function private.consume_funding_for_charge(
  p_usage_charge_id uuid,
  p_billing_account_id uuid,
  p_amount_usdc_nano bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_remaining bigint := p_amount_usdc_nano;
  v_lot private.funding_lots%rowtype;
  v_piece bigint;
begin
  if p_amount_usdc_nano = 0 then return; end if;

  for v_lot in
    select * from private.funding_lots
    where billing_account_id = p_billing_account_id
      and available_usdc_nano > 0
    order by created_at, id
    for update
  loop
    exit when v_remaining = 0;
    v_piece := least(v_remaining, v_lot.available_usdc_nano);

    update private.funding_lots
    set available_usdc_nano = available_usdc_nano - v_piece,
        committed_usdc_nano = committed_usdc_nano + v_piece
    where id = v_lot.id;

    insert into private.funding_commitments(
      funding_lot_id, billing_account_id, source_type, source_id, amount_usdc_nano
    ) values (
      v_lot.id, p_billing_account_id, 'usage_charge', p_usage_charge_id, v_piece
    );

    v_remaining := v_remaining - v_piece;
  end loop;

  if v_remaining <> 0 then
    raise exception 'FUNDING_LOT_UNDERFLOW' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function private.plan_settlement_batch(
  p_chain_account_id uuid,
  p_max_usdc_atomic numeric default 1000000000000
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_chain private.chain_accounts%rowtype;
  v_total_available bigint;
  v_target bigint;
  v_remaining bigint;
  v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_batch_key text;
  v_claim_key text;
  v_commitment private.funding_commitments%rowtype;
  v_unassigned bigint;
  v_piece bigint;
begin
  select * into strict v_chain
  from private.chain_accounts where id = p_chain_account_id for update;

  if v_chain.status = 'suspended' or v_chain.status = 'closed' then
    raise exception 'CHAIN_ACCOUNT_NOT_SETTLEABLE' using errcode = 'P0001';
  end if;

  select coalesce(sum(
    fc.amount_usdc_nano - fc.pending_usdc_nano - fc.settled_usdc_nano - fc.unbacked_usdc_nano
  ), 0)::bigint
  into v_total_available
  from private.funding_commitments fc
  join private.funding_lots fl on fl.id = fc.funding_lot_id
  where fl.chain_account_id = p_chain_account_id;

  v_target := least(
    (v_total_available / 1000) * 1000,
    least(p_max_usdc_atomic, 9223372036854775)::bigint * 1000
  );
  if v_target < 1000 then return null; end if;

  v_batch_key := '0x' || encode(digest(v_batch::text || ':batch', 'sha256'), 'hex');
  v_claim_key := '0x' || encode(digest(v_item::text || ':claim', 'sha256'), 'hex');

  insert into private.settlement_batches(
    id, batch_key_hex, chain_account_id, total_usdc_nano, total_usdc_atomic
  ) values (
    v_batch, v_batch_key, p_chain_account_id, v_target, v_target / 1000
  );

  insert into private.settlement_items(
    id, batch_id, chain_account_id, claim_key_hex, amount_usdc_nano, amount_usdc_atomic
  ) values (
    v_item, v_batch, p_chain_account_id, v_claim_key, v_target, v_target / 1000
  );

  v_remaining := v_target;
  for v_commitment in
    select fc.*
    from private.funding_commitments fc
    join private.funding_lots fl on fl.id = fc.funding_lot_id
    where fl.chain_account_id = p_chain_account_id
      and fc.amount_usdc_nano > fc.pending_usdc_nano + fc.settled_usdc_nano + fc.unbacked_usdc_nano
    order by fc.created_at, fc.id
    for update of fc
  loop
    exit when v_remaining = 0;
    v_unassigned := v_commitment.amount_usdc_nano - v_commitment.pending_usdc_nano
      - v_commitment.settled_usdc_nano - v_commitment.unbacked_usdc_nano;
    v_piece := least(v_remaining, v_unassigned);

    insert into private.settlement_fragments(
      settlement_item_id, funding_commitment_id, amount_usdc_nano
    ) values (v_item, v_commitment.id, v_piece);

    update private.funding_commitments
    set pending_usdc_nano = pending_usdc_nano + v_piece
    where id = v_commitment.id;

    v_remaining := v_remaining - v_piece;
  end loop;

  if v_remaining <> 0 then
    raise exception 'SETTLEMENT_PLANNER_UNDERFLOW' using errcode = 'P0001';
  end if;

  return v_batch;
end;
$$;

create or replace function private.mark_settlement_batch_awaiting_signature(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.settlement_batches
  set status = 'awaiting_signature', updated_at = now()
  where id = p_batch_id and status = 'planned';
  if not found then raise exception 'BATCH_NOT_PLANNED' using errcode = 'P0001'; end if;
end;
$$;

create or replace function private.mark_settlement_batch_submitted(
  p_batch_id uuid,
  p_tx_hash text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.settlement_batches
  set status = 'submitted', tx_hash = lower(p_tx_hash), submitted_at = now(), updated_at = now()
  where id = p_batch_id and status = 'awaiting_signature';
  if not found then raise exception 'BATCH_NOT_AWAITING_SIGNATURE' using errcode = 'P0001'; end if;
end;
$$;

create or replace function private.release_failed_settlement_batch(
  p_batch_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_fragment record;
begin
  for v_fragment in
    select sf.funding_commitment_id, sf.amount_usdc_nano
    from private.settlement_fragments sf
    join private.settlement_items si on si.id = sf.settlement_item_id
    where si.batch_id = p_batch_id
  loop
    update private.funding_commitments
    set pending_usdc_nano = pending_usdc_nano - v_fragment.amount_usdc_nano
    where id = v_fragment.funding_commitment_id
      and pending_usdc_nano >= v_fragment.amount_usdc_nano;
    if not found then raise exception 'SETTLEMENT_PENDING_UNDERFLOW' using errcode = 'P0001'; end if;
  end loop;

  update private.settlement_batches
  set status = 'failed', failure_reason = p_reason, updated_at = now()
  where id = p_batch_id and status in ('planned','awaiting_signature','submitted');
end;
$$;

commit;
