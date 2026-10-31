begin;

-- Base Account is the primary application identity. Supabase remains the managed
-- PostgreSQL platform, but browser authentication no longer depends on auth.users.
create table if not exists private.base_account_bindings (
  address_normalized text primary key,
  address text not null,
  chain_id bigint not null check (chain_id in (8453, 84532)),
  app_user_id uuid not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  check (address ~ '^0x[0-9a-fA-F]{40}$'),
  check (address_normalized = lower(address))
);
create index if not exists base_account_bindings_user_idx
  on private.base_account_bindings(app_user_id);

create table if not exists private.base_auth_challenges (
  id uuid primary key default gen_random_uuid(),
  nonce text not null unique,
  chain_id bigint not null check (chain_id in (8453, 84532)),
  domain text not null,
  uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists base_auth_challenges_expiry_idx
  on private.base_auth_challenges(expires_at) where consumed_at is null;

create table if not exists private.base_auth_sessions (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  address_normalized text not null references private.base_account_bindings(address_normalized) on delete cascade,
  token_digest bytea not null unique,
  user_agent_digest bytea,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists base_auth_sessions_user_active_idx
  on private.base_auth_sessions(app_user_id, expires_at)
  where revoked_at is null;

create or replace function private.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select coalesce(
    nullif(current_setting('request.app_user_id', true), '')::uuid,
    (
      select ab.app_user_id
      from private.auth_bindings ab
      where ab.auth_user_id = auth.uid()
      limit 1
    )
  )
$$;

create or replace function private.resolve_or_create_base_account(
  p_address text,
  p_chain_id bigint
)
returns table(app_user_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_address text := lower(p_address);
  v_user uuid;
  v_merged_into uuid;
  v_created boolean := false;
  v_status public.app_user_status;
begin
  if p_chain_id not in (8453, 84532) or p_address !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'INVALID_BASE_ACCOUNT' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_address, 8453));

  select b.app_user_id into v_user
  from private.base_account_bindings b
  where b.address_normalized = v_address
  for update;

  if v_user is null then
    -- Preserve an account created by an earlier identity system if this Base
    -- Account address was already linked on the authentication chain.
    select w.app_user_id into v_user
    from public.user_wallets w
    where w.chain_id = p_chain_id and w.address_normalized = v_address
    for update;
  end if;

  if v_user is null then
    v_user := gen_random_uuid();
    v_created := true;
    insert into public.app_users(id) values (v_user);
    insert into public.user_profiles(app_user_id, display_name)
    values (v_user, concat(left(p_address, 6), '…', right(p_address, 4)));
  else
    select status, merged_into into v_status, v_merged_into
    from public.app_users where id = v_user;
    if v_status = 'merged' and v_merged_into is not null then
      v_user := v_merged_into;
    end if;
    if v_status = 'deleted' or v_status = 'suspended' then
      raise exception 'APP_USER_NOT_ACTIVE' using errcode = 'P0001';
    end if;
  end if;

  insert into private.base_account_bindings(
    address_normalized, address, chain_id, app_user_id
  ) values (
    v_address, p_address, p_chain_id, v_user
  )
  on conflict (address_normalized) do update
  set address = excluded.address,
      chain_id = excluded.chain_id,
      app_user_id = excluded.app_user_id,
      last_seen_at = now();

  insert into public.user_wallets(app_user_id, chain_id, address, label)
  values (v_user, p_chain_id, p_address, 'Base Account')
  on conflict (chain_id, address_normalized) do update
  set status = 'active', revoked_at = null, verified_at = now(), label = 'Base Account';

  return query select v_user, v_created;
end;
$$;

create or replace function private.cleanup_expired_base_auth_data()
returns table(challenges_deleted integer, sessions_deleted integer)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_challenges integer;
  v_sessions integer;
begin
  delete from private.base_auth_challenges
  where expires_at < now() - interval '1 day';
  get diagnostics v_challenges = row_count;

  delete from private.base_auth_sessions
  where expires_at < now() - interval '7 days'
     or revoked_at < now() - interval '7 days';
  get diagnostics v_sessions = row_count;

  return query select v_challenges, v_sessions;
end;
$$;

revoke all on private.base_account_bindings,
  private.base_auth_challenges,
  private.base_auth_sessions from public, anon, authenticated, service_role;
revoke all on function private.resolve_or_create_base_account(text,bigint) from public, anon, authenticated, service_role;
revoke all on function private.cleanup_expired_base_auth_data() from public, anon, authenticated, service_role;

commit;
