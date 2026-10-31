begin;

-- Explicit NULL rejection is important: SQL's three-valued logic must never
-- treat an absent lease or freshness window as permission to dispatch.
create or replace function private.auto_funding_can_execute(p_id uuid, p_fresh_seconds integer)
returns boolean language sql stable security definer set search_path = pg_catalog,public,private
as $$
  select coalesce(p_fresh_seconds between 10 and 3600,false) and exists (
    select 1 from private.auto_funding_permissions p
    join public.app_users u on u.id = p.app_user_id
    join public.user_wallets w on w.id = p.wallet_id and w.app_user_id = p.app_user_id
    join public.organizations o on o.id = p.organization_id
    join public.organization_members m on m.organization_id = o.id and m.app_user_id = p.app_user_id
    join private.chain_accounts c on c.id = p.chain_account_id and c.owner_wallet_id = w.id
    join private.billing_accounts b on b.id = c.billing_account_id and b.organization_id = o.id
    where p.id = p_id and p.state = 'active' and u.status = 'active' and w.status = 'active'
      and o.status = 'active' and m.status = 'active' and m.role in ('owner','admin','billing')
      and c.status = 'active' and b.status = 'active' and b.funding_mode = 'chain'
      and c.last_indexed_at >= now() - make_interval(secs => p_fresh_seconds)
      and b.funding_fresh_until > now()
  )
$$;

create or replace function private.dispatch_auto_funding_job(p_id uuid,p_lease uuid,p_metadata jsonb,p_hash text,p_fresh_seconds integer)
returns boolean language plpgsql security definer set search_path = pg_catalog,public,private
as $$
declare v_job private.auto_funding_jobs%rowtype; v_permission private.auto_funding_permissions%rowtype;
begin
  if p_lease is null or p_fresh_seconds is null then return false; end if;
  select p.* into v_permission from private.auto_funding_permissions p
    join private.auto_funding_jobs j on j.permission_id = p.id where j.id = p_id for update of p;
  select * into v_job from private.auto_funding_jobs where id = p_id for update;
  if not found or v_job.state <> 'planned' or v_job.lease_token is distinct from p_lease
    or v_job.lease_until is null or v_job.lease_until <= now()
    or not private.auto_funding_can_execute(v_job.permission_id,p_fresh_seconds) then return false; end if;
  if p_metadata is null or p_hash is null or p_hash !~ '^0x[0-9a-f]{64}$'
    or p_metadata->>'idempotencyKey' is distinct from 'auto-funding:' || p_id::text
    or p_metadata->>'to' is distinct from v_permission.vault_address
    or p_metadata->>'chainId' is distinct from v_permission.chain_id::text
    or p_metadata->>'value' is distinct from '0'
    or coalesce(p_metadata->>'dataHash','') !~ '^0x[0-9a-f]{64}$'
  then raise exception 'INVALID_AUTO_FUNDING_REQUEST'; end if;
  update private.auto_funding_jobs set state = 'dispatching',request_metadata = p_metadata,request_hash = p_hash,
    updated_at = now() where id = p_id;
  return true;
end;
$$;

create or replace function private.update_auto_funding_job(p_id uuid,p_lease uuid,p_state text,p_error text,
  p_tx text,p_block bigint,p_block_hash text)
returns boolean language plpgsql security definer set search_path = pg_catalog,private
as $$
declare v_job private.auto_funding_jobs%rowtype;
begin
  if p_lease is null then return false; end if;
  select * into v_job from private.auto_funding_jobs where id = p_id for update;
  if not found or v_job.lease_token is distinct from p_lease or v_job.lease_until is null or v_job.lease_until <= now() then return false; end if;
  if p_state is null or not (
    (v_job.state = 'planned' and p_state in ('planned','cancelled','attention')) or
    (v_job.state in ('dispatching','attention') and p_state in ('dispatching','submitted','attention')) or
    (v_job.state = 'attention' and v_job.tx_hash is not null and p_state in ('confirmed','reverted')) or
    (v_job.state = 'submitted' and p_state in ('submitted','confirmed','reverted','attention'))
  ) then raise exception 'INVALID_AUTO_FUNDING_JOB_TRANSITION'; end if;
  if p_tx is not null and v_job.tx_hash is not null and lower(p_tx) <> v_job.tx_hash then
    raise exception 'AUTO_FUNDING_TX_HASH_IMMUTABLE';
  end if;
  if p_state in ('confirmed','reverted') and (p_block is null or p_block < 0 or p_block_hash is null) then
    raise exception 'AUTO_FUNDING_RECEIPT_REQUIRED';
  end if;
  update private.auto_funding_jobs set state = p_state,error_code = p_error,
    tx_hash = coalesce(lower(p_tx),tx_hash),receipt_block = p_block,receipt_block_hash = lower(p_block_hash),
    lease_token = null,lease_until = null,updated_at = now(),
    next_check_at = now() + case when p_state in ('confirmed','reverted','attention') then interval '5 minutes'
      when p_state in ('cancelled','planned') then interval '1 minute' else interval '15 seconds' end
    where id = p_id;
  return true;
end;
$$;

commit;
