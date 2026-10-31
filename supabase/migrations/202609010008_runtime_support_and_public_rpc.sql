begin;

alter table private.billing_accounts
  add column if not exists funding_mode text not null default 'chain'
  check (funding_mode in ('chain','development'));

create or replace function private.assert_billing_funding_fresh(p_billing_account_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_account private.billing_accounts%rowtype;
begin
  select * into strict v_account
  from private.billing_accounts where id = p_billing_account_id;
  if v_account.funding_mode = 'development' then return; end if;
  if v_account.funding_fresh_until is null or v_account.funding_fresh_until < now() then
    raise exception 'CHAIN_INDEXER_STALE' using errcode = 'P0001';
  end if;
end;
$$;

create table if not exists private.chain_indexer_cursors (
  chain_id bigint not null,
  vault_address_normalized text not null,
  next_block bigint not null check (next_block >= 0),
  last_finalized_block bigint,
  last_finalized_block_hash text,
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (chain_id, vault_address_normalized)
);

create or replace function private.claim_chain_indexer_cursor(
  p_chain_id bigint,
  p_vault_address text,
  p_default_start_block bigint,
  p_lease_owner text,
  p_lease_seconds integer
)
returns table(next_block bigint, last_finalized_block bigint, last_finalized_block_hash text)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if p_lease_seconds < 10 or p_lease_seconds > 300 then
    raise exception 'INVALID_INDEXER_LEASE' using errcode = 'P0001';
  end if;
  insert into private.chain_indexer_cursors(chain_id, vault_address_normalized, next_block)
  values (p_chain_id, lower(p_vault_address), p_default_start_block)
  on conflict (chain_id, vault_address_normalized) do nothing;

  update private.chain_indexer_cursors
  set lease_owner = p_lease_owner,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
    and (lease_expires_at is null or lease_expires_at < now() or lease_owner = p_lease_owner);
  if not found then
    raise exception 'INDEXER_LEASE_HELD' using errcode = 'P0001';
  end if;

  return query
  select c.next_block, c.last_finalized_block, c.last_finalized_block_hash
  from private.chain_indexer_cursors c
  where c.chain_id = p_chain_id and c.vault_address_normalized = lower(p_vault_address);
end;
$$;

create or replace function private.advance_chain_indexer_cursor(
  p_chain_id bigint,
  p_vault_address text,
  p_lease_owner text,
  p_next_block bigint,
  p_last_finalized_block bigint,
  p_last_finalized_block_hash text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.chain_indexer_cursors
  set next_block = p_next_block,
      last_finalized_block = p_last_finalized_block,
      last_finalized_block_hash = lower(p_last_finalized_block_hash),
      lease_expires_at = now() + interval '60 seconds',
      updated_at = now()
  where chain_id = p_chain_id and vault_address_normalized = lower(p_vault_address)
    and lease_owner = p_lease_owner and lease_expires_at > now()
    and p_next_block >= next_block;
  if not found then
    raise exception 'INDEXER_LEASE_LOST_OR_CURSOR_REGRESSION' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function private.list_unmatched_chain_events(p_limit integer default 100)
returns setof private.chain_events
language sql
security definer
set search_path = pg_catalog, private
as $$
  select * from private.chain_events
  where status = 'unmatched'
  order by block_number, log_index
  limit greatest(1, least(p_limit, 1000))
$$;

-- Price rows are append-only. Historical requests always retain their price_version_id.
create or replace function private.reject_price_version_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'PRICE_VERSIONS_ARE_IMMUTABLE' using errcode = 'P0001';
end;
$$;
drop trigger if exists model_price_versions_immutable on private.model_price_versions;
create trigger model_price_versions_immutable
before update or delete on private.model_price_versions
for each row execute function private.reject_price_version_mutation();

-- Public RPC wrappers are visible to Supabase PostgREST; all financial work remains
-- in private SECURITY DEFINER functions and is checked against auth.uid().
create or replace function public.create_organization(p_slug text, p_name text)
returns table(organization_id uuid, billing_account_id uuid)
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select * from private.create_organization(p_slug, p_name)
$$;

create or replace function public.create_project(
  p_organization_id uuid,
  p_slug text,
  p_name text,
  p_max_per_request_usdc_nano bigint default null,
  p_daily_limit_usdc_nano bigint default null,
  p_monthly_limit_usdc_nano bigint default null,
  p_lifetime_limit_usdc_nano bigint default null,
  p_allowed_model_ids uuid[] default '{}'
)
returns uuid
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select private.create_project(
    p_organization_id, p_slug, p_name,
    p_max_per_request_usdc_nano, p_daily_limit_usdc_nano,
    p_monthly_limit_usdc_nano, p_lifetime_limit_usdc_nano,
    p_allowed_model_ids
  )
$$;

create or replace function public.get_my_billing_summaries()
returns table(
  organization_id uuid,
  organization_name text,
  billing_account_id uuid,
  billing_status private.billing_status,
  credit_balance_usdc_nano bigint,
  reserved_usdc_nano bigint,
  withdrawal_reserved_usdc_nano bigint,
  receivable_usdc_nano bigint,
  available_usdc_nano bigint,
  funding_fresh_until timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select * from private.get_my_billing_summaries()
$$;

revoke all on function public.create_organization(text,text) from public, anon;
revoke all on function public.create_project(uuid,text,text,bigint,bigint,bigint,bigint,uuid[]) from public, anon;
revoke all on function public.get_my_billing_summaries() from public, anon;
grant execute on function public.create_organization(text,text) to authenticated;
grant execute on function public.create_project(uuid,text,text,bigint,bigint,bigint,bigint,uuid[]) to authenticated;
grant execute on function public.get_my_billing_summaries() to authenticated;

commit;
