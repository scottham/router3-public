begin;

create or replace function private.apply_deposited(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_owner_address text,
  p_pool_key_hex text,
  p_amount_usdc_atomic numeric,
  p_balance_usdc_atomic numeric,
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
  v_expected_owner text;
begin
  if p_amount_usdc_atomic <= 0 or p_balance_usdc_atomic < p_amount_usdc_atomic then
    raise exception 'INVALID_DEPOSIT_EVENT' using errcode = 'P0001';
  end if;

  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'Deposited', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event;
  if v_event is null then return false; end if;

  select c.*
  into v_chain
  from private.chain_accounts c
  where c.chain_id = p_chain_id
    and c.vault_address_normalized = lower(p_vault_address)
    and c.account_id_hex = lower(p_account_id_hex)
  for update of c;
  if not found then return false; end if;

  select lower(w.address)
  into strict v_expected_owner
  from public.user_wallets w
  where w.id = v_chain.owner_wallet_id;

  if v_expected_owner <> lower(p_owner_address)
     or v_chain.pool_key_hex <> lower(p_pool_key_hex) then
    update private.chain_accounts
    set status = 'suspended', updated_at = now()
    where id = v_chain.id;
    update private.billing_accounts
    set status = 'suspended', version = version + 1
    where id = v_chain.billing_account_id;
    insert into private.reconciliation_incidents(
      billing_account_id, chain_account_id, severity, incident_type, details
    ) values (
      v_chain.billing_account_id, v_chain.id, 'critical', 'deposit_identity_mismatch',
      jsonb_build_object(
        'event_id', v_event,
        'observed_owner', lower(p_owner_address),
        'observed_pool_key', lower(p_pool_key_hex)
      )
    );
    update private.chain_events
    set status = 'quarantined', applied_at = now()
    where id = v_event;
    return true;
  end if;

  update private.chain_accounts
  set confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash),
      last_indexed_at = now(),
      updated_at = now()
  where id = v_chain.id;

  update private.chain_events
  set status = 'applied', applied_at = now()
  where id = v_event;
  return true;
end;
$$;

create or replace function private.apply_withdrawn(
  p_chain_id bigint,
  p_vault_address text,
  p_tx_hash text,
  p_log_index integer,
  p_block_number bigint,
  p_block_hash text,
  p_account_id_hex text,
  p_recipient_address text,
  p_amount_usdc_atomic numeric,
  p_balance_usdc_atomic numeric,
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
begin
  if p_amount_usdc_atomic <= 0 or p_balance_usdc_atomic < 0 then
    raise exception 'INVALID_WITHDRAW_EVENT' using errcode = 'P0001';
  end if;

  insert into private.chain_events(
    chain_id, vault_address_normalized, tx_hash, log_index, block_number,
    block_hash, account_id_hex, event_name, payload, status
  ) values (
    p_chain_id, lower(p_vault_address), lower(p_tx_hash), p_log_index,
    p_block_number, lower(p_block_hash), lower(p_account_id_hex),
    'Withdrawn', p_payload, 'unmatched'
  ) on conflict (chain_id, vault_address_normalized, tx_hash, log_index) do nothing
  returning id into v_event;
  if v_event is null then return false; end if;

  select * into v_chain
  from private.chain_accounts
  where chain_id = p_chain_id
    and vault_address_normalized = lower(p_vault_address)
    and account_id_hex = lower(p_account_id_hex)
  for update;
  if not found then return false; end if;

  if p_balance_usdc_atomic < v_chain.confirmed_allocated_usdc_atomic then
    update private.chain_accounts
    set status = 'suspended',
        confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
        last_finalized_block = p_block_number,
        last_finalized_block_hash = lower(p_block_hash),
        last_indexed_at = now(), updated_at = now()
    where id = v_chain.id;
    update private.billing_accounts
    set status = 'suspended', version = version + 1
    where id = v_chain.billing_account_id;
    insert into private.reconciliation_incidents(
      billing_account_id, chain_account_id, severity, incident_type, details
    ) values (
      v_chain.billing_account_id, v_chain.id, 'critical', 'withdraw_balance_below_allocation',
      jsonb_build_object(
        'event_id', v_event,
        'recipient', lower(p_recipient_address),
        'observed_balance_usdc_atomic', p_balance_usdc_atomic,
        'expected_minimum_usdc_atomic', v_chain.confirmed_allocated_usdc_atomic
      )
    );
    update private.chain_events
    set status = 'quarantined', applied_at = now()
    where id = v_event;
    return true;
  end if;

  update private.chain_accounts
  set confirmed_balance_usdc_atomic = p_balance_usdc_atomic,
      last_finalized_block = p_block_number,
      last_finalized_block_hash = lower(p_block_hash),
      last_indexed_at = now(),
      updated_at = now()
  where id = v_chain.id;

  update private.chain_events
  set status = 'applied', applied_at = now()
  where id = v_event;
  return true;
end;
$$;

revoke execute on function private.apply_deposited(
  bigint,text,text,integer,bigint,text,text,text,text,numeric,numeric,jsonb
) from public, anon, authenticated;
revoke execute on function private.apply_withdrawn(
  bigint,text,text,integer,bigint,text,text,text,numeric,numeric,jsonb
) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'gateway_indexer') then
    execute 'grant execute on function private.apply_deposited(bigint,text,text,integer,bigint,text,text,text,text,numeric,numeric,jsonb) to gateway_indexer';
    execute 'grant execute on function private.apply_withdrawn(bigint,text,text,integer,bigint,text,text,text,numeric,numeric,jsonb) to gateway_indexer';
  end if;
end;
$$;

commit;
