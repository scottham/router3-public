begin;

-- Keep the Base wallet as the durable user owner, separately from the immutable
-- internal AA address which owns this particular on-chain budget. No key lives here.
alter table private.chain_accounts
  add column account_kind text not null default 'direct',
  add column onchain_owner_address text,
  add column restricted_identity jsonb,
  add constraint chain_account_owner_kind check (
    (account_kind = 'direct' and onchain_owner_address is null and restricted_identity is null)
    or (account_kind = 'restricted' and chain_id = 8453
      and onchain_owner_address is not null and onchain_owner_address ~ '^0x[0-9a-f]{40}$'
      and restricted_identity is not null and jsonb_typeof(restricted_identity) = 'object')
  );

-- The old uniqueness rule disallowed a direct budget and an AA budget in the
-- same Vault, or multiple finite-grant accounts. Preserve it for direct budgets.
do $$ declare v_name text; begin
  select conname into strict v_name from pg_constraint
  where conrelid = 'private.chain_accounts'::regclass and contype = 'u'
    and conkey = array[
      (select attnum from pg_attribute where attrelid = conrelid and attname = 'billing_account_id'),
      (select attnum from pg_attribute where attrelid = conrelid and attname = 'chain_id'),
      (select attnum from pg_attribute where attrelid = conrelid and attname = 'vault_address_normalized'),
      (select attnum from pg_attribute where attrelid = conrelid and attname = 'owner_wallet_id')
    ]::smallint[];
  execute format('alter table private.chain_accounts drop constraint %I', v_name);
end $$;
create unique index chain_accounts_direct_wallet_unique
  on private.chain_accounts(billing_account_id,chain_id,vault_address_normalized,owner_wallet_id)
  where account_kind = 'direct';
create unique index chain_accounts_restricted_address_unique
  on private.chain_accounts(chain_id,onchain_owner_address) where account_kind = 'restricted';

alter table private.chain_indexer_cursors add column replay_until_block bigint;

-- Serialize event projection and heartbeat with late registration. The caller
-- must hold this row lock until its event/advance/heartbeat transaction commits.
create function private.lock_chain_indexer_lease(p_chain_id bigint,p_vault_address text,p_lease_owner text)
returns void language plpgsql security definer set search_path = pg_catalog,private as $$
declare v_cursor private.chain_indexer_cursors%rowtype;
begin
  select * into v_cursor from private.chain_indexer_cursors
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address) for update;
  if not found or v_cursor.lease_owner is distinct from p_lease_owner
     or v_cursor.lease_expires_at is null or v_cursor.lease_expires_at <= clock_timestamp() then
    raise exception 'INDEXER_LEASE_LOST_OR_CURSOR_REGRESSION' using errcode = 'P0001';
  end if;
end $$;

-- The API supplies only a server-derived, code-verified chain identity. This
-- function is not public RPC and cannot verify Ethereum code by itself. It
-- independently enforces actor ownership, billing role, immutable binding and
-- atomic/idempotent registration. Registering never credits a chain snapshot.
create function private.register_restricted_chain_account(
  p_actor uuid,p_billing uuid,p_wallet uuid,p_chain bigint,p_vault text,
  p_account_id text,p_pool text,p_identity jsonb
) returns uuid language plpgsql security definer set search_path = pg_catalog,public,private as $$
declare v_wallet public.user_wallets%rowtype; v_org uuid; v_id uuid;
  v_existing private.chain_accounts%rowtype; v_cursor private.chain_indexer_cursors%rowtype;
  v_key text; v_start bigint; v_block bigint; v_replay_start bigint;
begin
  select * into v_wallet from public.user_wallets where id = p_wallet and status = 'active' for share;
  if not found or v_wallet.app_user_id is distinct from p_actor or v_wallet.chain_id is distinct from p_chain then
    raise exception 'RESTRICTED_ACCOUNT_PERMISSION_DENIED' using errcode = 'P0001';
  end if;
  select organization_id into v_org from private.billing_accounts where id = p_billing;
  perform 1 from public.organization_members where organization_id = v_org and app_user_id = p_actor
    and status = 'active' and role in ('owner','admin','billing') for share;
  if not found then raise exception 'ORG_BILLING_PERMISSION_DENIED' using errcode = 'P0001'; end if;
  if p_chain is distinct from 8453 or p_identity is null or jsonb_typeof(p_identity) <> 'object'
     or p_vault is null or p_vault !~ '^0x[0-9a-f]{40}$'
     or p_account_id is null or p_account_id !~ '^0x[0-9a-f]{64}$'
     or p_pool is null or p_pool !~ '^0x[0-9a-f]{64}$'
     or (select count(*) from jsonb_object_keys(p_identity)) <> 8
     or not (p_identity ?& array['owner','account','factory','index','initCodeHash','blockNumber','blockHash','startBlock']) then
    raise exception 'INVALID_RESTRICTED_ACCOUNT_IDENTITY' using errcode = 'P0001';
  end if;
  foreach v_key in array array['owner','account','factory'] loop
    if jsonb_typeof(p_identity->v_key) is distinct from 'string' or p_identity->>v_key !~ '^0x[0-9a-f]{40}$'
      or p_identity->>v_key = '0x0000000000000000000000000000000000000000' then
      raise exception 'INVALID_RESTRICTED_ACCOUNT_IDENTITY' using errcode = 'P0001';
    end if;
  end loop;
  foreach v_key in array array['initCodeHash','blockHash'] loop
    if jsonb_typeof(p_identity->v_key) is distinct from 'string' or p_identity->>v_key !~ '^0x[0-9a-f]{64}$'
      or p_identity->>v_key = '0x' || repeat('0',64) then
      raise exception 'INVALID_RESTRICTED_ACCOUNT_IDENTITY' using errcode = 'P0001';
    end if;
  end loop;
  foreach v_key in array array['index','blockNumber','startBlock'] loop
    if jsonb_typeof(p_identity->v_key) is distinct from 'string' or p_identity->>v_key !~ '^(0|[1-9][0-9]{0,77})$'
      or (p_identity->>v_key)::numeric >= power(2::numeric,256) then
      raise exception 'INVALID_RESTRICTED_ACCOUNT_IDENTITY' using errcode = 'P0001';
    end if;
  end loop;
  if p_identity->>'owner' <> lower(v_wallet.address) or p_identity->>'account' in (p_identity->>'owner',p_identity->>'factory',p_vault)
     or (p_identity->>'blockNumber')::numeric > 9007199254740991
     or (p_identity->>'startBlock')::numeric > (p_identity->>'blockNumber')::numeric then
    raise exception 'INVALID_RESTRICTED_ACCOUNT_IDENTITY' using errcode = 'P0001';
  end if;
  v_start := (p_identity->>'startBlock')::bigint; v_block := (p_identity->>'blockNumber')::bigint;
  -- One Vault cursor lock also serializes concurrent registrations. Indexer
  -- events must use lock_chain_indexer_lease in their projection transaction.
  insert into private.chain_indexer_cursors(chain_id,vault_address_normalized,next_block)
    values(p_chain,p_vault,v_start) on conflict (chain_id,vault_address_normalized) do nothing;
  select * into strict v_cursor from private.chain_indexer_cursors
    where chain_id = p_chain and vault_address_normalized = p_vault for update;
  select * into v_existing from private.chain_accounts
    where chain_id = p_chain and vault_address_normalized = p_vault and account_id_hex = p_account_id;
  if found then
    if v_existing.account_kind <> 'restricted' or v_existing.billing_account_id <> p_billing
      or v_existing.owner_wallet_id <> p_wallet or v_existing.pool_key_hex <> p_pool
      or v_existing.onchain_owner_address <> p_identity->>'account'
      or (v_existing.restricted_identity - array['blockNumber','blockHash']) <> (p_identity - array['blockNumber','blockHash']) then
      raise exception 'RESTRICTED_ACCOUNT_IDENTITY_CONFLICT' using errcode = 'P0001';
    end if;
    return v_existing.id;
  end if;
  insert into private.chain_accounts(billing_account_id,owner_wallet_id,chain_id,vault_address,account_id_hex,pool_key_hex,
    account_kind,onchain_owner_address,restricted_identity)
    values(p_billing,p_wallet,p_chain,p_vault,p_account_id,p_pool,'restricted',p_identity->>'account',p_identity) returning id into v_id;
  -- The existing indexer records unknown-account events, so start at the first
  -- relevant unmatched log (or the unfinished cursor range), not the Vault's
  -- entire lifetime on every user's first setup. The cursor row lock makes this
  -- query atomic with all projections. Never advance past the existing cursor.
  select least(v_cursor.next_block,coalesce(min(block_number),v_cursor.next_block)) into v_replay_start
    from private.chain_events where chain_id = p_chain and vault_address_normalized = p_vault
      and account_id_hex = p_account_id and status = 'unmatched';
  -- Only uncredited unmatched events of this newly registered identity are
  -- removed for canonical replay. Applied/quarantined events are never erased.
  delete from private.chain_events where chain_id = p_chain and vault_address_normalized = p_vault
    and account_id_hex = p_account_id and status = 'unmatched';
  update private.chain_indexer_cursors set next_block = v_replay_start,
    replay_until_block = greatest(coalesce(replay_until_block,0),coalesce(last_finalized_block,0),v_block),
    lease_owner = null,lease_expires_at = null,updated_at = now()
    where chain_id = p_chain and vault_address_normalized = p_vault;
  update private.chain_accounts set last_indexed_at = null
    where chain_id = p_chain and vault_address_normalized = p_vault and status <> 'closed';
  update private.billing_accounts b set funding_fresh_until = now() - interval '1 second',version = version + 1
    where exists(select 1 from private.chain_accounts c where c.billing_account_id = b.id
      and c.chain_id = p_chain and c.vault_address_normalized = p_vault and c.status <> 'closed');
  return v_id;
end $$;

-- Preserve the reviewed deposit projection verbatim except for resolving the
-- expected chain owner. Fail the migration if that historical body differs.
do $$ declare v_body text; v_old text := 'select lower(w.address)'; begin
  select pg_get_functiondef('private.apply_deposited(bigint,text,text,integer,bigint,text,text,text,text,numeric,numeric,jsonb)'::regprocedure) into v_body;
  if length(v_body) - length(replace(v_body,v_old,'')) <> length(v_old) then
    raise exception 'UNEXPECTED_DEPOSIT_PROJECTION_DEFINITION';
  end if;
  execute replace(v_body,v_old,'select coalesce(v_chain.onchain_owner_address, lower(w.address))');
end $$;

-- A partial historical replay cannot advertise current spendable model credit.
create or replace function private.heartbeat_chain_indexer(
  p_chain_id bigint,p_vault_address text,p_finalized_block bigint,
  p_finalized_block_hash text,p_fresh_for_seconds integer
) returns integer language plpgsql security definer set search_path = pg_catalog,private as $$
declare v_count integer;
begin
  if p_fresh_for_seconds is null or p_fresh_for_seconds < 10 or p_fresh_for_seconds > 3600 then
    raise exception 'INVALID_FRESHNESS_WINDOW' using errcode = 'P0001';
  end if;
  if exists(select 1 from private.chain_indexer_cursors where chain_id = p_chain_id
    and vault_address_normalized = lower(p_vault_address) and replay_until_block > p_finalized_block) then return 0; end if;
  update private.chain_indexer_cursors set replay_until_block = null where chain_id = p_chain_id
    and vault_address_normalized = lower(p_vault_address) and replay_until_block <= p_finalized_block;
  update private.chain_accounts set last_indexed_at = now(),
    last_finalized_block = greatest(coalesce(last_finalized_block,0),p_finalized_block),
    last_finalized_block_hash = p_finalized_block_hash,updated_at = now()
    where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address) and status <> 'closed';
  get diagnostics v_count = row_count;
  update private.billing_accounts b set funding_fresh_until = (
    select case when count(*) filter (where c.last_indexed_at is null) > 0 then now() - interval '1 second'
      else min(c.last_indexed_at) + make_interval(secs => p_fresh_for_seconds) end
    from private.chain_accounts c where c.billing_account_id = b.id and c.status <> 'closed'
  ),version = version + 1 where exists(select 1 from private.chain_accounts c where c.billing_account_id = b.id
    and c.chain_id = p_chain_id and c.vault_address_normalized = lower(p_vault_address) and c.status <> 'closed');
  return v_count;
end $$;

-- Backfilled allocations may repay old receivables. They must not be selected
-- for a new settlement batch while later historical unlocks are still missing.
-- Acquire cursor before chain-account row, matching registration/indexer order.
create function private.require_chain_projection_ready(p_account uuid)
returns void language plpgsql security definer set search_path = pg_catalog,private as $$
declare v_chain private.chain_accounts%rowtype; v_cursor private.chain_indexer_cursors%rowtype;
begin
  select * into strict v_chain from private.chain_accounts where id = p_account;
  select * into v_cursor from private.chain_indexer_cursors
    where chain_id = v_chain.chain_id and vault_address_normalized = v_chain.vault_address_normalized for update;
  if found and v_cursor.replay_until_block is not null then
    raise exception 'CHAIN_INDEXER_STALE' using errcode = 'P0001';
  end if;
end $$;
do $$ declare v_body text; v_old text := E'begin\n  select * into strict v_chain'; begin
  select pg_get_functiondef('private.plan_settlement_batch(uuid,numeric)'::regprocedure) into v_body;
  if length(v_body) - length(replace(v_body,v_old,'')) <> length(v_old) then
    raise exception 'UNEXPECTED_SETTLEMENT_PLANNER_DEFINITION';
  end if;
  execute replace(v_body,v_old,E'begin\n  perform private.require_chain_projection_ready(p_chain_account_id);\n  select * into strict v_chain');
end $$;

revoke all on function private.register_restricted_chain_account(uuid,uuid,uuid,bigint,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function private.lock_chain_indexer_lease(bigint,text,text) from public,anon,authenticated;
revoke all on function private.require_chain_projection_ready(uuid) from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'gateway_api') then
    grant execute on function private.register_restricted_chain_account(uuid,uuid,uuid,bigint,text,text,text,jsonb) to gateway_api;
  end if;
  if exists(select 1 from pg_roles where rolname = 'gateway_indexer') then
    grant execute on function private.lock_chain_indexer_lease(bigint,text,text) to gateway_indexer;
  end if;
end $$;
commit;
