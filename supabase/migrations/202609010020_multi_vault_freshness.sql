-- The newest Vault must never extend an older source's expiry. Previously a
-- heartbeat just before the old source expired granted a fresh full window.
create or replace function private.heartbeat_chain_indexer(
  p_chain_id bigint,p_vault_address text,p_finalized_block bigint,
  p_finalized_block_hash text,p_fresh_for_seconds integer
)
returns integer language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare v_count integer;
begin
  if p_fresh_for_seconds is null or p_fresh_for_seconds < 10 or p_fresh_for_seconds > 3600 then
    raise exception 'INVALID_FRESHNESS_WINDOW' using errcode = 'P0001';
  end if;
  update private.chain_accounts
  set last_indexed_at = now(),
      last_finalized_block = greatest(coalesce(last_finalized_block,0),p_finalized_block),
      last_finalized_block_hash = p_finalized_block_hash, updated_at = now()
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address) and status <> 'closed';
  get diagnostics v_count = row_count;

  update private.billing_accounts b
  set funding_fresh_until = (
    select case when count(*) filter (where c.last_indexed_at is null) > 0
      then now() - interval '1 second'
      else min(c.last_indexed_at) + make_interval(secs => p_fresh_for_seconds) end
    from private.chain_accounts c where c.billing_account_id = b.id and c.status <> 'closed'
  ), version = version + 1
  where exists (
    select 1 from private.chain_accounts c where c.billing_account_id = b.id
      and c.chain_id = p_chain_id and c.vault_address_normalized = lower(p_vault_address) and c.status <> 'closed'
  );
  return v_count;
end;
$$;
