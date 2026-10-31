begin;

create table if not exists private.receivable_claims (
  id uuid primary key default gen_random_uuid(),
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  source_type text not null check (source_type in ('usage_charge','unlock_shortfall','manual_adjustment')),
  source_id uuid not null,
  original_usdc_nano bigint not null check (original_usdc_nano > 0),
  outstanding_usdc_nano bigint not null check (outstanding_usdc_nano >= 0),
  status text not null default 'open' check (status in ('open','recovered','written_off')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (outstanding_usdc_nano <= original_usdc_nano)
);
create index if not exists receivable_claims_open_idx
  on private.receivable_claims(billing_account_id, created_at)
  where outstanding_usdc_nano > 0 and status = 'open';

create or replace function private.post_customer_charge_ledger(
  p_request_id uuid,
  p_billing_account_id uuid,
  p_covered_nano bigint,
  p_receivable_nano bigint,
  p_total_charge_nano bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_accounts record;
  v_entries jsonb := '[]'::jsonb;
begin
  select * into v_accounts from private.ensure_billing_ledger_accounts(p_billing_account_id);
  if p_covered_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', v_accounts.customer_credit, 'side', 'debit', 'amount_nano', p_covered_nano)
    );
  end if;
  if p_receivable_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', v_accounts.customer_receivable, 'side', 'debit', 'amount_nano', p_receivable_nano)
    );
  end if;
  if p_total_charge_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', v_accounts.model_revenue, 'side', 'credit', 'amount_nano', p_total_charge_nano)
    );
    perform private.post_ledger_transaction(
      'model-charge:' || p_request_id::text,
      'USDC_NANO', 'model_request', p_request_id::text,
      'Captured model request charge', '{}'::jsonb, v_entries
    );
  end if;
end;
$$;

create or replace function private.post_provider_cost_ledger(
  p_request_id uuid,
  p_provider_cost_usd_nano bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_expense uuid;
  v_payable uuid;
begin
  if p_provider_cost_usd_nano <= 0 then return; end if;
  perform private.ensure_platform_ledger_accounts();
  select id into strict v_expense from private.ledger_accounts where code = 'expense:provider-usd';
  select id into strict v_payable from private.ledger_accounts where code = 'liability:provider-payable-usd';
  perform private.post_ledger_transaction(
    'provider-cost:' || p_request_id::text,
    'USD_NANO', 'model_request', p_request_id::text,
    'Accrued model provider cost', '{}'::jsonb,
    jsonb_build_array(
      jsonb_build_object('account_id', v_expense, 'side', 'debit', 'amount_nano', p_provider_cost_usd_nano),
      jsonb_build_object('account_id', v_payable, 'side', 'credit', 'amount_nano', p_provider_cost_usd_nano)
    )
  );
end;
$$;

create or replace function private.finalize_model_request(
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

  select * into strict v_request
  from private.model_requests where id = p_request_id for update;

  if v_request.status = 'completed' then
    return query select
      v_request.actual_charge_usdc_nano,
      0::bigint,
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

  -- Never bill above the amount pre-authorized before the provider call.
  v_charge := least(p_computed_customer_charge_usdc_nano, v_request.max_charge_usdc_nano);
  v_overrun := greatest(0, p_computed_customer_charge_usdc_nano - v_request.max_charge_usdc_nano);
  v_covered := least(v_charge, v_billing.credit_balance_usdc_nano);
  v_receivable := v_charge - v_covered;

  v_today := (v_request.created_at at time zone 'UTC')::date;
  v_month_start := date_trunc('month', v_request.created_at at time zone 'UTC')::date;

  update private.billing_accounts
  set credit_balance_usdc_nano = credit_balance_usdc_nano - v_covered,
      reserved_usdc_nano = reserved_usdc_nano - v_hold.amount_usdc_nano,
      receivable_usdc_nano = receivable_usdc_nano + v_receivable,
      status = case when v_receivable > 0 then 'suspended'::private.billing_status else status end,
      version = version + 1
  where id = v_request.billing_account_id
    and reserved_usdc_nano >= v_hold.amount_usdc_nano;
  if not found then
    raise exception 'BILLING_CAPTURE_UNDERFLOW' using errcode = 'P0001';
  end if;

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
    case when v_receivable > 0 then 'unbacked' else 'unsettled' end
  ) returning id into v_usage_charge_id;

  if v_covered > 0 then
    perform private.consume_funding_for_charge(
      v_usage_charge_id, v_request.billing_account_id, v_covered
    );
  end if;

  if v_receivable > 0 then
    insert into private.receivable_claims(
      billing_account_id, source_type, source_id,
      original_usdc_nano, outstanding_usdc_nano
    ) values (
      v_request.billing_account_id, 'usage_charge', v_usage_charge_id,
      v_receivable, v_receivable
    );
    update public.projects
    set status = 'suspended', pause_reason = 'unbacked_usage', updated_at = now()
    where billing_account_id = v_request.billing_account_id and status <> 'archived';
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

  perform private.post_customer_charge_ledger(
    p_request_id, v_request.billing_account_id, v_covered, v_receivable, v_charge
  );
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

-- Allocation credits first repair explicitly recorded receivables, then become spendable credit.
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
  v_remaining bigint;
  v_claim private.receivable_claims%rowtype;
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
  if v_event_id is null then
    select id into v_event_id from private.chain_events
    where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
      and tx_hash = lower(p_tx_hash) and log_index = p_log_index
      and status = 'unmatched';
    if v_event_id is null then return false; end if;
  end if;

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
  into v_repay from private.billing_accounts where id = v_chain.billing_account_id;
  v_credit := v_amount_nano - v_repay;

  insert into private.funding_lots(
    billing_account_id, chain_account_id, allocation_event_id,
    total_usdc_nano, available_usdc_nano, committed_usdc_nano
  ) values (
    v_chain.billing_account_id, v_chain.id, v_event_id,
    v_amount_nano, v_credit, v_repay
  ) returning id into v_lot;

  v_remaining := v_repay;
  for v_claim in
    select * from private.receivable_claims
    where billing_account_id = v_chain.billing_account_id
      and status = 'open' and outstanding_usdc_nano > 0
    order by created_at, id
    for update
  loop
    exit when v_remaining = 0;
    v_piece := least(v_remaining, v_claim.outstanding_usdc_nano);

    insert into private.funding_commitments(
      funding_lot_id, billing_account_id, source_type, source_id,
      amount_usdc_nano
    ) values (
      v_lot, v_chain.billing_account_id, 'receivable_recovery',
      v_claim.source_id, v_piece
    );

    update private.receivable_claims
    set outstanding_usdc_nano = outstanding_usdc_nano - v_piece,
        status = case when outstanding_usdc_nano - v_piece = 0 then 'recovered' else status end,
        updated_at = now()
    where id = v_claim.id;

    v_remaining := v_remaining - v_piece;
  end loop;
  if v_remaining <> 0 then
    raise exception 'RECEIVABLE_CLAIM_TOTAL_MISMATCH' using errcode = 'P0001';
  end if;

  update private.billing_accounts
  set credit_balance_usdc_nano = credit_balance_usdc_nano + v_credit,
      receivable_usdc_nano = receivable_usdc_nano - v_repay,
      status = case
        when receivable_usdc_nano - v_repay = 0 and status = 'suspended'
          then 'active'::private.billing_status
        else status
      end,
      version = version + 1
  where id = v_chain.billing_account_id;

  if (select receivable_usdc_nano = 0 from private.billing_accounts where id = v_chain.billing_account_id)
     and not exists (
       select 1 from private.chain_unlocks u
       join private.chain_accounts c on c.id = u.chain_account_id
       where c.billing_account_id = v_chain.billing_account_id and u.status = 'pending'
     ) then
    update public.projects
    set status = 'active', pause_reason = null, updated_at = now()
    where billing_account_id = v_chain.billing_account_id
      and status = 'suspended' and pause_reason = 'unbacked_usage';
  end if;

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

create or replace function private.apply_unlock_requested(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_requested_usdc_atomic numeric,
  p_unlock_available_at timestamptz,
  p_payload jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_event uuid;
  v_chain private.chain_accounts%rowtype;
  v_reserved bigint;
begin
  if p_requested_usdc_atomic <= 0 or p_requested_usdc_atomic > 9223372036854775 then
    raise exception 'INVALID_UNLOCK_AMOUNT' using errcode = 'P0001';
  end if;

  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'BudgetUnlockRequested', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event;
  if v_event is null then return false; end if;

  select * into v_chain from private.chain_accounts
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
    and account_id_hex = lower(p_account_id_hex)
  for update;
  if not found then return false; end if;

  perform private.lock_billing_account(v_chain.billing_account_id);

  insert into private.chain_unlocks(
    chain_account_id, request_event_id, requested_usdc_atomic,
    status, unlock_available_at
  ) values (
    v_chain.id, v_event, p_requested_usdc_atomic, 'pending', p_unlock_available_at
  );

  update private.chain_accounts
  set status = 'unlock_pending', pending_unlock_usdc_atomic = p_requested_usdc_atomic,
      unlock_available_at = p_unlock_available_at,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash), last_indexed_at = now(), updated_at = now()
  where id = v_chain.id;

  select coalesce(sum((requested_usdc_atomic * 1000)::bigint), 0)
  into v_reserved
  from private.chain_unlocks u
  join private.chain_accounts c on c.id = u.chain_account_id
  where c.billing_account_id = v_chain.billing_account_id and u.status = 'pending';

  update private.billing_accounts
  set status = 'withdrawal_pending', withdrawal_reserved_usdc_nano = v_reserved,
      version = version + 1
  where id = v_chain.billing_account_id;

  update public.projects
  set status = 'paused', pause_reason = 'chain_unlock', updated_at = now()
  where billing_account_id = v_chain.billing_account_id and status = 'active';

  update private.chain_events set status = 'applied', applied_at = now() where id = v_event;
  return true;
end;
$$;

create or replace function private.apply_unlock_cancelled(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_payload jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_event uuid;
  v_chain private.chain_accounts%rowtype;
  v_reserved bigint;
  v_has_pending boolean;
begin
  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'BudgetUnlockCancelled', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event;
  if v_event is null then return false; end if;

  select * into v_chain from private.chain_accounts
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
    and account_id_hex = lower(p_account_id_hex)
  for update;
  if not found then return false; end if;
  perform private.lock_billing_account(v_chain.billing_account_id);

  update private.chain_unlocks
  set status = 'cancelled', updated_at = now()
  where chain_account_id = v_chain.id and status = 'pending';

  update private.chain_accounts
  set status = 'active', pending_unlock_usdc_atomic = 0, unlock_available_at = null,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash), last_indexed_at = now(), updated_at = now()
  where id = v_chain.id;

  select exists(
    select 1 from private.chain_unlocks u
    join private.chain_accounts c on c.id = u.chain_account_id
    where c.billing_account_id = v_chain.billing_account_id and u.status = 'pending'
  ) into v_has_pending;

  select coalesce(sum((requested_usdc_atomic * 1000)::bigint), 0)
  into v_reserved
  from private.chain_unlocks u
  join private.chain_accounts c on c.id = u.chain_account_id
  where c.billing_account_id = v_chain.billing_account_id and u.status = 'pending';

  update private.billing_accounts
  set status = case when not v_has_pending and receivable_usdc_nano = 0
                    then 'active'::private.billing_status else status end,
      withdrawal_reserved_usdc_nano = v_reserved,
      version = version + 1
  where id = v_chain.billing_account_id;

  if not v_has_pending then
    update public.projects
    set status = 'active', pause_reason = null, updated_at = now()
    where billing_account_id = v_chain.billing_account_id
      and status = 'paused' and pause_reason = 'chain_unlock';
  end if;

  update private.chain_events set status = 'applied', applied_at = now() where id = v_event;
  return true;
end;
$$;

create or replace function private.post_unlock_ledger(
  p_event_id uuid,
  p_chain_account_id uuid,
  p_asset_account_id uuid,
  p_customer_credit_id uuid,
  p_customer_receivable_id uuid,
  p_available_removed_nano bigint,
  p_committed_removed_nano bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_total bigint := p_available_removed_nano + p_committed_removed_nano;
  v_entries jsonb := '[]'::jsonb;
begin
  if p_available_removed_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', p_customer_credit_id, 'side', 'debit', 'amount_nano', p_available_removed_nano)
    );
  end if;
  if p_committed_removed_nano > 0 then
    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object('account_id', p_customer_receivable_id, 'side', 'debit', 'amount_nano', p_committed_removed_nano)
    );
  end if;
  v_entries := v_entries || jsonb_build_array(
    jsonb_build_object('account_id', p_asset_account_id, 'side', 'credit', 'amount_nano', v_total)
  );
  perform private.post_ledger_transaction(
    'chain-unlock:' || p_event_id::text,
    'USDC_NANO', 'chain_event', p_event_id::text,
    'USDC budget unlocked back to the owner',
    jsonb_build_object('chain_account_id', p_chain_account_id), v_entries
  );
end;
$$;

create or replace function private.apply_budget_unlocked(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_unlocked_usdc_atomic numeric,
  p_balance_usdc_atomic numeric,
  p_allocated_usdc_atomic numeric,
  p_payload jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_event uuid;
  v_chain private.chain_accounts%rowtype;
  v_amount bigint;
  v_remaining bigint;
  v_available_removed bigint := 0;
  v_committed_removed bigint := 0;
  v_unaccounted bigint := 0;
  v_lot private.funding_lots%rowtype;
  v_commit private.funding_commitments%rowtype;
  v_piece bigint;
  v_pending_piece bigint;
  v_asset uuid;
  v_accounts record;
  v_reserved bigint;
  v_has_pending boolean;
begin
  if p_unlocked_usdc_atomic <= 0 or p_unlocked_usdc_atomic > 9223372036854775 then
    raise exception 'INVALID_UNLOCKED_AMOUNT' using errcode = 'P0001';
  end if;
  v_amount := (p_unlocked_usdc_atomic * 1000)::bigint;

  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'BudgetUnlocked', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event;
  if v_event is null then return false; end if;

  select * into v_chain from private.chain_accounts
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
    and account_id_hex = lower(p_account_id_hex)
  for update;
  if not found then return false; end if;
  perform private.lock_billing_account(v_chain.billing_account_id);

  v_remaining := v_amount;
  for v_lot in
    select * from private.funding_lots
    where chain_account_id = v_chain.id and available_usdc_nano > 0
    order by created_at, id for update
  loop
    exit when v_remaining = 0;
    v_piece := least(v_remaining, v_lot.available_usdc_nano);
    update private.funding_lots
    set available_usdc_nano = available_usdc_nano - v_piece,
        unlocked_usdc_nano = unlocked_usdc_nano + v_piece
    where id = v_lot.id;
    v_available_removed := v_available_removed + v_piece;
    v_remaining := v_remaining - v_piece;
  end loop;

  -- If the platform missed its settlement window, the user may unlock funds already
  -- committed to completed usage. Record the exact shortfall as a receivable and suspend.
  if v_remaining > 0 then
    for v_commit in
      select fc.*
      from private.funding_commitments fc
      join private.funding_lots fl on fl.id = fc.funding_lot_id
      where fl.chain_account_id = v_chain.id
        and fc.amount_usdc_nano > fc.settled_usdc_nano + fc.unbacked_usdc_nano
      order by fc.created_at, fc.id
      for update of fc
    loop
      exit when v_remaining = 0;
      v_piece := least(
        v_remaining,
        v_commit.amount_usdc_nano - v_commit.settled_usdc_nano - v_commit.unbacked_usdc_nano
      );
      v_pending_piece := least(v_piece, v_commit.pending_usdc_nano);

      update private.funding_commitments
      set pending_usdc_nano = pending_usdc_nano - v_pending_piece,
          unbacked_usdc_nano = unbacked_usdc_nano + v_piece
      where id = v_commit.id;

      update private.funding_lots
      set committed_usdc_nano = committed_usdc_nano - v_piece,
          unlocked_usdc_nano = unlocked_usdc_nano + v_piece
      where id = v_commit.funding_lot_id;

      if v_pending_piece > 0 then
        update private.settlement_batches b
        set status = 'quarantined', failure_reason = 'unlock_confirmed_during_pending_settlement', updated_at = now()
        where b.id in (
          select si.batch_id
          from private.settlement_fragments sf
          join private.settlement_items si on si.id = sf.settlement_item_id
          where sf.funding_commitment_id = v_commit.id
        ) and b.status <> 'confirmed';
      end if;

      insert into private.receivable_claims(
        billing_account_id, source_type, source_id,
        original_usdc_nano, outstanding_usdc_nano
      ) values (
        v_chain.billing_account_id, 'unlock_shortfall', v_commit.source_id,
        v_piece, v_piece
      );

      v_committed_removed := v_committed_removed + v_piece;
      v_remaining := v_remaining - v_piece;
    end loop;
  end if;

  if v_remaining <> 0 then
    v_unaccounted := v_remaining;
    v_remaining := 0;
    insert into private.reconciliation_incidents(
      billing_account_id, chain_account_id, severity, incident_type, details
    ) values (
      v_chain.billing_account_id, v_chain.id, 'critical',
      'unlock_exceeded_tracked_funding',
      jsonb_build_object('unaccounted_usdc_nano', v_unaccounted, 'event_id', v_event)
    );
  end if;

  select * into v_accounts from private.ensure_billing_ledger_accounts(v_chain.billing_account_id);
  v_asset := private.ensure_chain_asset_ledger_account(
    v_chain.id, v_chain.billing_account_id, p_chain_id, p_vault_address
  );

  update private.billing_accounts
  set credit_balance_usdc_nano = credit_balance_usdc_nano - v_available_removed,
      receivable_usdc_nano = receivable_usdc_nano + v_committed_removed,
      status = case when v_committed_removed > 0 or v_unaccounted > 0 then 'suspended'::private.billing_status else status end,
      version = version + 1
  where id = v_chain.billing_account_id
    and credit_balance_usdc_nano >= v_available_removed;
  if not found then raise exception 'UNLOCK_CREDIT_UNDERFLOW' using errcode = 'P0001'; end if;

  update private.chain_unlocks
  set status = 'finalized', actual_unlocked_usdc_atomic = p_unlocked_usdc_atomic,
      finalized_event_id = v_event, updated_at = now()
  where chain_account_id = v_chain.id and status = 'pending';

  update private.chain_accounts
  set confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
      confirmed_allocated_usdc_atomic = p_allocated_usdc_atomic,
      pending_unlock_usdc_atomic = 0, unlock_available_at = null,
      status = case when v_committed_removed > 0 or v_unaccounted > 0 then 'suspended'::private.chain_account_status else 'active'::private.chain_account_status end,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash), last_indexed_at = now(), updated_at = now()
  where id = v_chain.id;

  select exists(
    select 1 from private.chain_unlocks u
    join private.chain_accounts c on c.id = u.chain_account_id
    where c.billing_account_id = v_chain.billing_account_id and u.status = 'pending'
  ) into v_has_pending;
  select coalesce(sum((u.requested_usdc_atomic * 1000)::bigint), 0)
  into v_reserved
  from private.chain_unlocks u
  join private.chain_accounts c on c.id = u.chain_account_id
  where c.billing_account_id = v_chain.billing_account_id and u.status = 'pending';

  update private.billing_accounts
  set withdrawal_reserved_usdc_nano = v_reserved,
      status = case
        when v_committed_removed > 0 or v_unaccounted > 0 then 'suspended'::private.billing_status
        when not v_has_pending and receivable_usdc_nano = 0 then 'active'::private.billing_status
        else status
      end,
      version = version + 1
  where id = v_chain.billing_account_id;

  if not v_has_pending and v_committed_removed = 0 and v_unaccounted = 0 then
    update public.projects
    set status = 'active', pause_reason = null, updated_at = now()
    where billing_account_id = v_chain.billing_account_id
      and status = 'paused' and pause_reason = 'chain_unlock';
  end if;

  if v_committed_removed > 0 or v_unaccounted > 0 then
    update public.projects
    set status = 'suspended', pause_reason = 'unbacked_usage', updated_at = now()
    where billing_account_id = v_chain.billing_account_id and status <> 'archived';
    insert into private.reconciliation_incidents(
      billing_account_id, chain_account_id, severity, incident_type, details
    ) values (
      v_chain.billing_account_id, v_chain.id, 'critical', 'settlement_window_missed',
      jsonb_build_object('receivable_usdc_nano', v_committed_removed, 'unaccounted_usdc_nano', v_unaccounted, 'event_id', v_event)
    );
  end if;

  perform private.post_unlock_ledger(
    v_event, v_chain.id, v_asset,
    v_accounts.customer_credit, v_accounts.customer_receivable,
    v_available_removed, v_committed_removed
  );

  if v_unaccounted > 0 then
    perform private.ensure_platform_ledger_accounts();
    perform private.post_ledger_transaction(
      'unlock-reconciliation-loss:' || v_event::text,
      'USDC_NANO', 'chain_event', v_event::text,
      'Untracked Vault asset removed during unlock',
      jsonb_build_object('chain_account_id', v_chain.id, 'quarantined', true),
      jsonb_build_array(
        jsonb_build_object(
          'account_id', (select id from private.ledger_accounts where code = 'expense:reconciliation-loss-usdc'),
          'side', 'debit', 'amount_nano', v_unaccounted
        ),
        jsonb_build_object('account_id', v_asset, 'side', 'credit', 'amount_nano', v_unaccounted)
      )
    );
  end if;

  update private.chain_events
  set status = case when v_unaccounted > 0 then 'quarantined'::private.chain_event_status else 'applied'::private.chain_event_status end,
      applied_at = now()
  where id = v_event;
  return true;
end;
$$;

create or replace function private.recalculate_usage_charge_status(p_usage_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_charge bigint;
  v_settled bigint;
  v_unbacked bigint;
begin
  select customer_charge_usdc_nano into strict v_charge
  from private.usage_charges where id = p_usage_charge_id;

  select coalesce(sum(fc.settled_usdc_nano),0), coalesce(sum(fc.unbacked_usdc_nano),0)
  into v_settled, v_unbacked
  from private.funding_commitments fc
  where fc.source_id = p_usage_charge_id
    and fc.source_type in ('usage_charge','receivable_recovery');

  update private.usage_charges
  set settlement_status = case
    when v_unbacked > 0 then 'unbacked'
    when v_settled >= v_charge then 'settled'
    when v_settled > 0 then 'partially_settled'
    else 'unsettled'
  end
  where id = p_usage_charge_id;
end;
$$;

create or replace function private.apply_budget_settled(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_batch_key_hex text,
  p_claim_key_hex text,
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
  v_event uuid;
  v_chain private.chain_accounts%rowtype;
  v_batch private.settlement_batches%rowtype;
  v_item private.settlement_items%rowtype;
  v_fragment record;
  v_amount bigint;
  v_asset uuid;
  v_treasury uuid;
  v_source uuid;
begin
  if p_amount_usdc_atomic <= 0 or p_amount_usdc_atomic > 9223372036854775 then
    raise exception 'INVALID_SETTLEMENT_AMOUNT' using errcode = 'P0001';
  end if;
  v_amount := (p_amount_usdc_atomic * 1000)::bigint;

  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'BudgetSettled', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event;
  if v_event is null then return false; end if;

  select * into v_chain from private.chain_accounts
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
    and account_id_hex = lower(p_account_id_hex)
  for update;
  if not found then return false; end if;
  perform private.lock_billing_account(v_chain.billing_account_id);

  select * into v_batch
  from private.settlement_batches
  where batch_key_hex = lower(p_batch_key_hex) and chain_account_id = v_chain.id
  for update;

  select * into v_item
  from private.settlement_items
  where claim_key_hex = lower(p_claim_key_hex) and chain_account_id = v_chain.id
  for update;

  perform private.ensure_platform_ledger_accounts();
  v_asset := private.ensure_chain_asset_ledger_account(
    v_chain.id, v_chain.billing_account_id, p_chain_id, p_vault_address
  );
  select id into strict v_treasury from private.ledger_accounts where code = 'asset:treasury-usdc';

  if v_batch.id is null or v_item.id is null or v_item.batch_id <> v_batch.id
     or v_item.amount_usdc_nano <> v_amount then
    update private.chain_accounts
    set status = 'suspended', confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
        confirmed_allocated_usdc_atomic = p_allocated_usdc_atomic,
        last_finalized_block = p_block_number,
        last_finalized_block_hash = lower(p_block_hash), last_indexed_at = now(), updated_at = now()
    where id = v_chain.id;
    update private.billing_accounts set status = 'suspended', version = version + 1
    where id = v_chain.billing_account_id;
    insert into private.reconciliation_incidents(
      billing_account_id, chain_account_id, severity, incident_type, details
    ) values (
      v_chain.billing_account_id, v_chain.id, 'critical', 'unknown_or_mismatched_settlement',
      jsonb_build_object('event_id', v_event, 'batch_key', p_batch_key_hex,
                         'claim_key', p_claim_key_hex, 'amount_usdc_nano', v_amount)
    );
    perform private.post_ledger_transaction(
      'external-settlement:' || v_event::text,
      'USDC_NANO', 'chain_event', v_event::text,
      'Unmatched settlement asset movement',
      jsonb_build_object('quarantined', true, 'chain_account_id', v_chain.id),
      jsonb_build_array(
        jsonb_build_object('account_id', v_treasury, 'side', 'debit', 'amount_nano', v_amount),
        jsonb_build_object('account_id', v_asset, 'side', 'credit', 'amount_nano', v_amount)
      )
    );
    update private.chain_events set status = 'quarantined', applied_at = now() where id = v_event;
    return true;
  end if;

  if v_batch.status not in ('awaiting_signature','submitted') then
    raise exception 'SETTLEMENT_BATCH_BAD_STATE' using errcode = 'P0001';
  end if;

  for v_fragment in
    select sf.*, fc.funding_lot_id, fc.source_id, fc.source_type
    from private.settlement_fragments sf
    join private.funding_commitments fc on fc.id = sf.funding_commitment_id
    where sf.settlement_item_id = v_item.id
    for update of fc
  loop
    update private.funding_commitments
    set pending_usdc_nano = pending_usdc_nano - v_fragment.amount_usdc_nano,
        settled_usdc_nano = settled_usdc_nano + v_fragment.amount_usdc_nano
    where id = v_fragment.funding_commitment_id
      and pending_usdc_nano >= v_fragment.amount_usdc_nano;
    if not found then raise exception 'SETTLEMENT_FRAGMENT_UNDERFLOW' using errcode = 'P0001'; end if;

    update private.funding_lots
    set committed_usdc_nano = committed_usdc_nano - v_fragment.amount_usdc_nano,
        settled_usdc_nano = settled_usdc_nano + v_fragment.amount_usdc_nano
    where id = v_fragment.funding_lot_id
      and committed_usdc_nano >= v_fragment.amount_usdc_nano;
    if not found then raise exception 'FUNDING_LOT_COMMITTED_UNDERFLOW' using errcode = 'P0001'; end if;

    if v_fragment.source_type in ('usage_charge','receivable_recovery') then
      v_source := v_fragment.source_id;
      if exists (select 1 from private.usage_charges where id = v_source) then
        perform private.recalculate_usage_charge_status(v_source);
      end if;
    end if;
  end loop;

  update private.settlement_batches
  set status = 'confirmed', tx_hash = lower(p_tx_hash), confirmed_at = now(), updated_at = now()
  where id = v_batch.id;

  update private.chain_accounts
  set confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
      confirmed_allocated_usdc_atomic = p_allocated_usdc_atomic,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash), last_indexed_at = now(), updated_at = now()
  where id = v_chain.id;

  perform private.post_ledger_transaction(
    'settlement-confirmed:' || v_event::text,
    'USDC_NANO', 'settlement_batch', v_batch.id::text,
    'Confirmed Vault to Treasury USDC movement',
    jsonb_build_object('chain_account_id', v_chain.id, 'batch_id', v_batch.id),
    jsonb_build_array(
      jsonb_build_object('account_id', v_treasury, 'side', 'debit', 'amount_nano', v_amount),
      jsonb_build_object('account_id', v_asset, 'side', 'credit', 'amount_nano', v_amount)
    )
  );

  update private.chain_events set status = 'applied', applied_at = now() where id = v_event;
  return true;
end;
$$;

commit;
