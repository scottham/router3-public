begin;

create extension if not exists pgcrypto;
create schema if not exists private;

revoke all on schema private from public, anon, authenticated, service_role;

do $$ begin
  create type public.app_user_status as enum ('active', 'suspended', 'merged', 'deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.wallet_status as enum ('active', 'revoked');
exception when duplicate_object then null; end $$;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  status public.app_user_status not null default 'active',
  merged_into uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null))
);

create table if not exists public.user_profiles (
  app_user_id uuid primary key references public.app_users(id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists private.auth_bindings (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  app_user_id uuid not null references public.app_users(id) on delete restrict,
  provider text not null,
  provider_subject text,
  email_snapshot text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists auth_bindings_app_user_idx on private.auth_bindings(app_user_id);
create unique index if not exists auth_bindings_provider_subject_uq
  on private.auth_bindings(provider, provider_subject)
  where provider_subject is not null;

create table if not exists public.user_wallets (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  chain_id bigint not null check (chain_id > 0),
  address text not null,
  address_normalized text generated always as (lower(address)) stored,
  label text,
  status public.wallet_status not null default 'active',
  verified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (address ~ '^0x[0-9a-fA-F]{40}$')
);
create unique index if not exists user_wallets_chain_address_uq
  on public.user_wallets(chain_id, address_normalized);
create index if not exists user_wallets_user_idx on public.user_wallets(app_user_id);

create table if not exists private.wallet_link_challenges (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  chain_id bigint not null,
  address_normalized text not null,
  nonce text not null unique,
  domain text not null,
  uri text not null,
  statement text not null,
  message text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (address_normalized ~ '^0x[0-9a-f]{40}$')
);
create index if not exists wallet_challenges_expiry_idx
  on private.wallet_link_challenges(expires_at)
  where consumed_at is null;

create table if not exists private.account_merge_audit (
  id uuid primary key default gen_random_uuid(),
  source_app_user_id uuid not null,
  target_app_user_id uuid not null,
  source_auth_user_id uuid,
  target_auth_user_id uuid,
  confirmation text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select ab.app_user_id
  from private.auth_bindings ab
  where ab.auth_user_id = auth.uid()
  limit 1
$$;

create or replace function private.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  v_app_user_id uuid := gen_random_uuid();
  v_provider text;
  v_subject text;
begin
  v_provider := coalesce(new.raw_app_meta_data ->> 'provider', 'unknown');
  v_subject := coalesce(
    new.raw_user_meta_data ->> 'sub',
    new.raw_user_meta_data ->> 'user_name',
    new.id::text
  );

  insert into public.app_users(id) values (v_app_user_id);
  insert into public.user_profiles(app_user_id, display_name, avatar_url)
  values (
    v_app_user_id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  );

  insert into private.auth_bindings(
    auth_user_id, app_user_id, provider, provider_subject, email_snapshot
  ) values (
    new.id, v_app_user_id, v_provider, v_subject, new.email
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_model_gateway on auth.users;
create trigger on_auth_user_created_model_gateway
  after insert on auth.users
  for each row execute function private.handle_auth_user_created();

create or replace function private.sync_auth_binding_last_seen()
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update private.auth_bindings
  set last_seen_at = now()
  where auth_user_id = auth.uid();
end;
$$;

drop trigger if exists app_users_touch_updated_at on public.app_users;
create trigger app_users_touch_updated_at
before update on public.app_users
for each row execute function private.touch_updated_at();

drop trigger if exists user_profiles_touch_updated_at on public.user_profiles;
create trigger user_profiles_touch_updated_at
before update on public.user_profiles
for each row execute function private.touch_updated_at();

alter table public.app_users enable row level security;
alter table public.user_profiles enable row level security;
alter table public.user_wallets enable row level security;

create policy app_users_select_self on public.app_users
for select to authenticated
using (id = private.current_app_user_id());

create policy profiles_select_self on public.user_profiles
for select to authenticated
using (app_user_id = private.current_app_user_id());

create policy profiles_update_self on public.user_profiles
for update to authenticated
using (app_user_id = private.current_app_user_id())
with check (app_user_id = private.current_app_user_id());

create policy wallets_select_self on public.user_wallets
for select to authenticated
using (app_user_id = private.current_app_user_id());

-- Wallet inserts are deliberately server-only after SIWE/ERC-1271 verification.
revoke insert, update, delete on public.user_wallets from anon, authenticated;

grant select on public.app_users, public.user_profiles, public.user_wallets to authenticated;
grant update(display_name, avatar_url, locale, timezone) on public.user_profiles to authenticated;
grant execute on function private.current_app_user_id() to authenticated;
grant execute on function private.sync_auth_binding_last_seen() to authenticated;

commit;
