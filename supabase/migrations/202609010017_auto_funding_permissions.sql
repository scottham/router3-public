begin;

-- Delegated signatures are encrypted at rest. No user private key is stored.
-- One immutable permission per on-chain nonce prevents ambiguous replacement;
-- changing a policy requires the owner to invalidate the old revision on-chain.
create table private.auto_funding_permissions (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.app_users(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  wallet_id uuid not null references public.user_wallets(id) on delete restrict,
  chain_account_id uuid not null references private.chain_accounts(id) on delete restrict,
  chain_id bigint not null check (chain_id in (8453,84532)),
  vault_address text not null check (vault_address ~ '^0x[0-9a-f]{40}$'),
  account_id_hex text not null check (account_id_hex ~ '^0x[0-9a-f]{64}$'),
  permission_hash_hex text not null check (permission_hash_hex ~ '^0x[0-9a-f]{64}$'),
  policy_nonce numeric(78,0) not null check (policy_nonce >= 0),
  permission_json jsonb not null check (jsonb_typeof(permission_json) = 'object'),
  encrypted_signature jsonb not null check (jsonb_typeof(encrypted_signature) = 'object'),
  state text not null default 'active' check (state in ('active','paused','superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id,permission_hash_hex),
  unique (chain_account_id,policy_nonce)
);
create unique index auto_funding_one_active_revision
  on private.auto_funding_permissions(chain_account_id) where state = 'active';
create index auto_funding_user_idx on private.auto_funding_permissions(app_user_id,wallet_id,organization_id);
alter table private.auto_funding_permissions enable row level security;
revoke all on private.auto_funding_permissions from public,anon,authenticated,service_role;

create function private.save_auto_funding_permission(
  p_actor uuid, p_chain_account uuid, p_hash text, p_nonce numeric,
  p_permission jsonb, p_encrypted_signature jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog,public,private
as $$
declare
  v_account record;
  v_existing private.auto_funding_permissions%rowtype;
  v_id uuid;
begin
  -- Serializes changes to this user's budget policy without touching funds.
  select c.*, w.app_user_id, w.address as wallet_address, b.organization_id into v_account
    from private.chain_accounts c
    join public.user_wallets w on w.id = c.owner_wallet_id
    join private.billing_accounts b on b.id = c.billing_account_id
    join public.organizations o on o.id = b.organization_id
    join public.organization_members om on om.organization_id = b.organization_id and om.app_user_id = p_actor
    where c.id = p_chain_account and w.app_user_id = p_actor and w.status = 'active'
      and om.status = 'active' and om.role in ('owner','admin','billing')
      and c.status = 'active' and b.status = 'active' and o.status = 'active'
    for update of c;
  if not found then raise exception 'AUTO_FUNDING_PERMISSION_DENIED' using errcode = 'P0001'; end if;
  if p_hash !~ '^0x[0-9a-f]{64}$' or p_nonce is null or p_nonce < 0 or p_nonce <> trunc(p_nonce)
     or octet_length(p_permission::text) > 8192 or octet_length(p_encrypted_signature::text) > 100000
     or lower(p_permission->>'account') is distinct from lower(v_account.wallet_address)
     or lower(p_permission->>'spender') is distinct from lower(v_account.vault_address)
  then raise exception 'INVALID_AUTO_FUNDING_POLICY' using errcode = 'P0001'; end if;

  select * into v_existing from private.auto_funding_permissions
    where chain_account_id = p_chain_account and policy_nonce = p_nonce;
  if found then
    if v_existing.permission_hash_hex <> p_hash or v_existing.permission_json <> p_permission then
      raise exception 'AUTO_FUNDING_REVISION_ALREADY_USED' using errcode = 'P0001';
    end if;
    -- Retrying a save never resumes a paused policy or replaces its signature.
    return v_existing.id;
  end if;
  if exists (select 1 from private.auto_funding_permissions where chain_account_id = p_chain_account and policy_nonce > p_nonce) then
    raise exception 'AUTO_FUNDING_STALE_REVISION' using errcode = 'P0001';
  end if;
  update private.auto_funding_permissions set state = 'superseded',updated_at = now()
    where chain_account_id = p_chain_account and state = 'active';
  insert into private.auto_funding_permissions (
    app_user_id,organization_id,wallet_id,chain_account_id,chain_id,vault_address,account_id_hex,
    permission_hash_hex,policy_nonce,permission_json,encrypted_signature
  ) values (
    p_actor,v_account.organization_id,v_account.owner_wallet_id,p_chain_account,v_account.chain_id,
    lower(v_account.vault_address),lower(v_account.account_id_hex),p_hash,p_nonce,p_permission,p_encrypted_signature
  ) returning id into v_id;
  return v_id;
end;
$$;

create function private.pause_auto_funding_permission(p_actor uuid,p_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog,public,private
as $$
begin
  -- The wallet owner can always stop the platform scheduler, even after leaving
  -- an organization. This is NOT an on-chain revocation of the spend permission.
  update private.auto_funding_permissions set state = 'paused',updated_at = now()
    where id = p_id and app_user_id = p_actor;
  if not found then raise exception 'AUTO_FUNDING_PERMISSION_NOT_FOUND' using errcode = 'P0001'; end if;
end;
$$;

revoke all on function private.save_auto_funding_permission(uuid,uuid,text,numeric,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.pause_auto_funding_permission(uuid,uuid) from public,anon,authenticated,service_role;
-- Clean installs may create backend roles after migrations.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'gateway_api') then
    grant select on private.auto_funding_permissions to gateway_api;
    grant execute on function private.save_auto_funding_permission(uuid,uuid,text,numeric,jsonb,jsonb) to gateway_api;
    grant execute on function private.pause_auto_funding_permission(uuid,uuid) to gateway_api;
  end if;
end $$;
create policy auto_funding_api_read on private.auto_funding_permissions for select
  using (current_user = 'gateway_api');

commit;
