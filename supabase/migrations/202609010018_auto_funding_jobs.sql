begin;

-- This outbox contains request fingerprints, never plaintext delegated signatures
-- or signed calldata. A dispatch marker is committed BEFORE the only POST.
create table private.auto_funding_jobs (
  id uuid primary key default gen_random_uuid(),
  permission_id uuid not null references private.auto_funding_permissions(id) on delete restrict,
  chain_account_id uuid not null references private.chain_accounts(id) on delete restrict,
  state text not null default 'planned' check (state in
    ('planned','dispatching','submitted','attention','confirmed','reverted','cancelled')),
  request_metadata jsonb,
  request_hash text check (request_hash ~ '^0x[0-9a-f]{64}$'),
  tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  receipt_block bigint,
  receipt_block_hash text check (receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
  lease_token uuid,
  lease_until timestamptz,
  next_check_at timestamptz not null default now(),
  error_code text check (error_code ~ '^[A-Z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((request_metadata is null) = (request_hash is null)),
  check (request_metadata is null or (jsonb_typeof(request_metadata) = 'object'
    and not (request_metadata ? 'data') and not (request_metadata ? 'signature')
    and octet_length(request_metadata::text) <= 8192)),
  check (state not in ('dispatching','submitted','confirmed','reverted') or request_hash is not null),
  check (state not in ('submitted','confirmed','reverted') or tx_hash is not null)
);
-- Include attention and OLD permission revisions: an unresolved transaction can
-- never be bypassed by saving a new policy on the same budget account.
create unique index auto_funding_one_unresolved_job on private.auto_funding_jobs(chain_account_id)
  where state in ('planned','dispatching','submitted','attention');
create index auto_funding_jobs_due on private.auto_funding_jobs(next_check_at);
alter table private.auto_funding_jobs enable row level security;
revoke all on private.auto_funding_jobs from public,anon,authenticated,service_role;

create table private.auto_funding_worker_health (
  chain_id bigint not null,
  vault_address text not null check (vault_address ~ '^0x[0-9a-f]{40}$'),
  code_hash text not null check (code_hash ~ '^0x[0-9a-f]{64}$'),
  ready boolean not null,
  checked_at timestamptz not null default now(),
  primary key(chain_id,vault_address)
);
alter table private.auto_funding_worker_health enable row level security;
revoke all on private.auto_funding_worker_health from public,anon,authenticated,service_role;
create function private.record_auto_funding_worker_health(p_chain bigint,p_vault text,p_hash text,p_ready boolean)
returns void language sql security definer set search_path = pg_catalog,private
as $$
  insert into private.auto_funding_worker_health(chain_id,vault_address,code_hash,ready)
    values(p_chain,lower(p_vault),lower(p_hash),p_ready)
  on conflict(chain_id,vault_address) do update set code_hash = excluded.code_hash,ready = excluded.ready,checked_at = now()
$$;

create function private.auto_funding_can_execute(p_id uuid, p_fresh_seconds integer)
returns boolean language sql stable security definer set search_path = pg_catalog,public,private
as $$
  select p_fresh_seconds between 10 and 3600 and exists (
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

-- Only the executor receives this context. No table SELECT privilege is needed.
create function private.auto_funding_job_context(p_id uuid, p_fresh_seconds integer)
returns jsonb language sql stable security definer set search_path = pg_catalog,public,private
as $$
  select jsonb_build_object('job',to_jsonb(j),'permission',to_jsonb(p),
    'eligible',private.auto_funding_can_execute(p.id,p_fresh_seconds),
    'account',jsonb_build_object('chainAccountId',c.id,'chainId',c.chain_id,
      'ownerAddress',w.address,'vaultAddress',c.vault_address,'accountId',c.account_id_hex,'poolKey',c.pool_key_hex))
  from private.auto_funding_jobs j join private.auto_funding_permissions p on p.id = j.permission_id
  join private.chain_accounts c on c.id = j.chain_account_id
  join public.user_wallets w on w.id = c.owner_wallet_id where j.id = p_id
$$;

create function private.claim_auto_funding_job(p_chain bigint,p_vault text,p_fresh_seconds integer,p_allow_new boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog,public,private
as $$
declare v_job uuid; v_permission private.auto_funding_permissions%rowtype;
begin
  if p_fresh_seconds not between 10 and 3600 then raise exception 'INVALID_FRESHNESS_WINDOW'; end if;
  -- Observe unresolved jobs even after the owner pauses/leaves the organization.
  select j.id into v_job from private.auto_funding_jobs j
    join private.auto_funding_permissions p on p.id = j.permission_id
    where p.chain_id = p_chain and p.vault_address = lower(p_vault)
      and j.state in ('planned','dispatching','submitted','attention')
      and j.next_check_at <= now() and (j.lease_until is null or j.lease_until < now())
    order by j.next_check_at,j.id for update of j skip locked limit 1;
  if v_job is null and p_allow_new then
    select p.* into v_permission from private.auto_funding_permissions p
      where p.chain_id = p_chain and p.vault_address = lower(p_vault)
        and private.auto_funding_can_execute(p.id,p_fresh_seconds)
        and not exists (select 1 from private.auto_funding_jobs j where j.chain_account_id = p.chain_account_id
          and (j.state in ('planned','dispatching','submitted','attention') or j.next_check_at > now()))
      order by p.created_at,p.id for update of p skip locked limit 1;
    if found then
      insert into private.auto_funding_jobs(permission_id,chain_account_id)
        values(v_permission.id,v_permission.chain_account_id) returning id into v_job;
    end if;
  end if;
  if v_job is null then return null; end if;
  update private.auto_funding_jobs set lease_token = gen_random_uuid(),lease_until = now() + interval '120 seconds'
    where id = v_job;
  return private.auto_funding_job_context(v_job,p_fresh_seconds);
end;
$$;

create function private.dispatch_auto_funding_job(p_id uuid,p_lease uuid,p_metadata jsonb,p_hash text,p_fresh_seconds integer)
returns boolean language plpgsql security definer set search_path = pg_catalog,public,private
as $$
declare v_job private.auto_funding_jobs%rowtype; v_permission private.auto_funding_permissions%rowtype;
begin
  -- Serialize with the owner's pause. Any already-dispatched call still requires
  -- an on-chain nonce change to revoke; a local pause cannot recall a broadcast.
  select p.* into v_permission from private.auto_funding_permissions p
    join private.auto_funding_jobs j on j.permission_id = p.id where j.id = p_id for update of p;
  select * into v_job from private.auto_funding_jobs where id = p_id for update;
  if not found or v_job.state <> 'planned' or v_job.lease_token is distinct from p_lease
    or v_job.lease_until <= now() or not private.auto_funding_can_execute(v_job.permission_id,p_fresh_seconds) then return false; end if;
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

create function private.update_auto_funding_job(p_id uuid,p_lease uuid,p_state text,p_error text,
  p_tx text,p_block bigint,p_block_hash text)
returns boolean language plpgsql security definer set search_path = pg_catalog,private
as $$
declare v_job private.auto_funding_jobs%rowtype;
begin
  select * into v_job from private.auto_funding_jobs where id = p_id for update;
  if not found or v_job.lease_token is distinct from p_lease or v_job.lease_until <= now() then return false; end if;
  if not (
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

revoke all on function private.auto_funding_can_execute(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function private.auto_funding_job_context(uuid,integer) from public,anon,authenticated,service_role;
revoke all on function private.claim_auto_funding_job(bigint,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function private.dispatch_auto_funding_job(uuid,uuid,jsonb,text,integer) from public,anon,authenticated,service_role;
revoke all on function private.update_auto_funding_job(uuid,uuid,text,text,text,bigint,text) from public,anon,authenticated,service_role;
revoke all on function private.record_auto_funding_worker_health(bigint,text,text,boolean) from public,anon,authenticated,service_role;
do $$ begin
  if exists(select 1 from pg_roles where rolname = 'gateway_autofunder') then
    grant execute on function private.claim_auto_funding_job(bigint,text,integer,boolean) to gateway_autofunder;
    grant execute on function private.dispatch_auto_funding_job(uuid,uuid,jsonb,text,integer) to gateway_autofunder;
    grant execute on function private.update_auto_funding_job(uuid,uuid,text,text,text,bigint,text) to gateway_autofunder;
    grant execute on function private.record_auto_funding_worker_health(bigint,text,text,boolean) to gateway_autofunder;
  end if;
  if exists(select 1 from pg_roles where rolname = 'gateway_api') then
    grant select(id,permission_id,state,error_code,tx_hash,updated_at,created_at) on private.auto_funding_jobs to gateway_api;
    grant select on private.auto_funding_worker_health to gateway_api;
  end if;
end $$;
create policy auto_funding_jobs_api_read on private.auto_funding_jobs for select using(current_user = 'gateway_api');
create policy auto_funding_health_api_read on private.auto_funding_worker_health for select using(current_user = 'gateway_api');

commit;
