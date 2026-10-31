begin;

do $$ begin
  create type public.organization_status as enum ('active', 'suspended', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.organization_role as enum ('owner', 'admin', 'developer', 'viewer', 'billing');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.member_status as enum ('active', 'invited', 'revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.project_status as enum ('active', 'paused', 'suspended', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.billing_status as enum ('active', 'withdrawal_pending', 'suspended', 'closed');
exception when duplicate_object then null; end $$;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  status public.organization_status not null default 'active',
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  app_user_id uuid not null references public.app_users(id) on delete cascade,
  role public.organization_role not null,
  status public.member_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, app_user_id)
);
create index if not exists organization_members_user_idx
  on public.organization_members(app_user_id, status);

create table if not exists private.billing_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete restrict,
  status private.billing_status not null default 'active',
  asset_unit text not null default 'USDC_NANO' check (asset_unit = 'USDC_NANO'),
  credit_balance_usdc_nano bigint not null default 0 check (credit_balance_usdc_nano >= 0),
  reserved_usdc_nano bigint not null default 0 check (reserved_usdc_nano >= 0),
  withdrawal_reserved_usdc_nano bigint not null default 0 check (withdrawal_reserved_usdc_nano >= 0),
  receivable_usdc_nano bigint not null default 0 check (receivable_usdc_nano >= 0),
  funding_fresh_until timestamptz,
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  billing_account_id uuid not null references private.billing_accounts(id) on delete restrict,
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  status public.project_status not null default 'active',
  pause_reason text,
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);
create index if not exists projects_org_idx on public.projects(organization_id, status);

create table if not exists private.project_spend_policies (
  project_id uuid primary key references public.projects(id) on delete cascade,
  max_per_request_usdc_nano bigint check (max_per_request_usdc_nano is null or max_per_request_usdc_nano >= 0),
  daily_limit_usdc_nano bigint check (daily_limit_usdc_nano is null or daily_limit_usdc_nano >= 0),
  monthly_limit_usdc_nano bigint check (monthly_limit_usdc_nano is null or monthly_limit_usdc_nano >= 0),
  lifetime_limit_usdc_nano bigint check (lifetime_limit_usdc_nano is null or lifetime_limit_usdc_nano >= 0),
  allowed_model_ids uuid[] not null default '{}',
  require_wallet_approval_above_usdc_nano bigint,
  updated_by uuid references public.app_users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.model_catalog (
  id uuid primary key default gen_random_uuid(),
  public_name text not null unique,
  provider text not null,
  provider_model text not null,
  modality text not null default 'text',
  enabled boolean not null default false,
  capabilities jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_model)
);

create table if not exists private.model_price_versions (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.model_catalog(id) on delete restrict,
  effective_from timestamptz not null,
  effective_until timestamptz,
  customer_input_usdc_nano_per_million bigint not null check (customer_input_usdc_nano_per_million >= 0),
  customer_cached_input_usdc_nano_per_million bigint not null default 0 check (customer_cached_input_usdc_nano_per_million >= 0),
  customer_output_usdc_nano_per_million bigint not null check (customer_output_usdc_nano_per_million >= 0),
  customer_reasoning_usdc_nano_per_million bigint not null default 0 check (customer_reasoning_usdc_nano_per_million >= 0),
  provider_input_usd_nano_per_million bigint not null check (provider_input_usd_nano_per_million >= 0),
  provider_cached_input_usd_nano_per_million bigint not null default 0 check (provider_cached_input_usd_nano_per_million >= 0),
  provider_output_usd_nano_per_million bigint not null check (provider_output_usd_nano_per_million >= 0),
  provider_reasoning_usd_nano_per_million bigint not null default 0 check (provider_reasoning_usd_nano_per_million >= 0),
  source_reference text,
  created_at timestamptz not null default now(),
  check (effective_until is null or effective_until > effective_from)
);
create index if not exists price_versions_model_effective_idx
  on private.model_price_versions(model_id, effective_from desc);

create table if not exists private.provider_credentials (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique,
  secret_reference text not null,
  endpoint_override text,
  enabled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function private.is_organization_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.app_user_id = private.current_app_user_id()
      and om.status = 'active'
  )
$$;

create or replace function private.has_organization_role(
  p_organization_id uuid,
  p_roles public.organization_role[]
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.app_user_id = private.current_app_user_id()
      and om.status = 'active'
      and om.role = any(p_roles)
  )
$$;

create or replace function private.create_organization(
  p_slug text,
  p_name text
)
returns table(organization_id uuid, billing_account_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user uuid := private.current_app_user_id();
  v_org uuid := gen_random_uuid();
  v_billing uuid := gen_random_uuid();
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;

  insert into public.organizations(id, slug, name, created_by)
  values (v_org, lower(trim(p_slug)), trim(p_name), v_user);

  insert into public.organization_members(organization_id, app_user_id, role)
  values (v_org, v_user, 'owner');

  insert into private.billing_accounts(id, organization_id)
  values (v_billing, v_org);

  return query select v_org, v_billing;
end;
$$;

create or replace function private.create_project(
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
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user uuid := private.current_app_user_id();
  v_billing uuid;
  v_project uuid := gen_random_uuid();
begin
  if not private.has_organization_role(p_organization_id, array['owner','admin','developer']::public.organization_role[]) then
    raise exception 'ORG_PERMISSION_DENIED' using errcode = 'P0001';
  end if;

  select id into strict v_billing
  from private.billing_accounts
  where organization_id = p_organization_id;

  insert into public.projects(
    id, organization_id, billing_account_id, slug, name, created_by
  ) values (
    v_project, p_organization_id, v_billing, lower(trim(p_slug)), trim(p_name), v_user
  );

  insert into private.project_spend_policies(
    project_id, max_per_request_usdc_nano, daily_limit_usdc_nano,
    monthly_limit_usdc_nano, lifetime_limit_usdc_nano,
    allowed_model_ids, updated_by
  ) values (
    v_project, p_max_per_request_usdc_nano, p_daily_limit_usdc_nano,
    p_monthly_limit_usdc_nano, p_lifetime_limit_usdc_nano,
    coalesce(p_allowed_model_ids, '{}'), v_user
  );

  return v_project;
end;
$$;

drop trigger if exists organizations_touch_updated_at on public.organizations;
create trigger organizations_touch_updated_at before update on public.organizations
for each row execute function private.touch_updated_at();
drop trigger if exists members_touch_updated_at on public.organization_members;
create trigger members_touch_updated_at before update on public.organization_members
for each row execute function private.touch_updated_at();
drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at before update on public.projects
for each row execute function private.touch_updated_at();
drop trigger if exists billing_touch_updated_at on private.billing_accounts;
create trigger billing_touch_updated_at before update on private.billing_accounts
for each row execute function private.touch_updated_at();
drop trigger if exists model_catalog_touch_updated_at on public.model_catalog;
create trigger model_catalog_touch_updated_at before update on public.model_catalog
for each row execute function private.touch_updated_at();

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table public.model_catalog enable row level security;

create policy organizations_member_select on public.organizations
for select to authenticated using (private.is_organization_member(id));

create policy members_org_select on public.organization_members
for select to authenticated using (private.is_organization_member(organization_id));

create policy projects_org_select on public.projects
for select to authenticated using (private.is_organization_member(organization_id));

create policy model_catalog_public_select on public.model_catalog
for select to authenticated using (enabled = true);

revoke insert, update, delete on public.organizations, public.organization_members, public.projects, public.model_catalog
from anon, authenticated;
grant select on public.organizations, public.organization_members, public.projects, public.model_catalog to authenticated;
grant execute on function private.is_organization_member(uuid) to authenticated;
grant execute on function private.has_organization_role(uuid, public.organization_role[]) to authenticated;
grant execute on function private.create_organization(text, text) to authenticated;
grant execute on function private.create_project(uuid, text, text, bigint, bigint, bigint, bigint, uuid[]) to authenticated;

commit;
