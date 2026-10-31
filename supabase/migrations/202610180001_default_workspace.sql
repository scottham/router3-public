begin;

-- A first sign-in provisions one personal space and project so a new user can
-- go straight to funding, allowance and an API key. The primary key is the
-- idempotency guarantee: one default workspace per user, ever. Deleting or
-- leaving it never causes a second one to be created.
create table if not exists private.default_workspaces (
  app_user_id uuid primary key references public.app_users(id) on delete cascade,
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  project_id uuid not null unique references public.projects(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function private.ensure_default_workspace()
returns table(organization_id uuid, project_id uuid, created boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user uuid := private.current_app_user_id();
  v_org uuid;
  v_project uuid;
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = 'P0001';
  end if;
  if not exists(select 1 from public.app_users u where u.id = v_user and u.status = 'active') then
    raise exception 'APP_USER_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  -- Serialise concurrent sign-ins of the same user. Under READ COMMITTED each
  -- statement below sees what the lock holder committed.
  perform pg_advisory_xact_lock(hashtextextended('router3:default-workspace:' || v_user::text, 0));

  select d.organization_id, d.project_id into v_org, v_project
  from private.default_workspaces d where d.app_user_id = v_user;
  if found then
    -- Only report it while the user can still use it.
    if exists(select 1 from public.organization_members m join public.projects p on p.organization_id = m.organization_id
              where m.organization_id = v_org and m.app_user_id = v_user and m.status = 'active'
                and p.id = v_project and p.status = 'active') then
      return query select v_org, v_project, false;
    end if;
    return;
  end if;

  -- Existing users who already belong to a space are left untouched.
  if exists(select 1 from public.organization_members m where m.app_user_id = v_user and m.status = 'active') then
    return;
  end if;

  select c.organization_id into strict v_org
  from private.create_organization('personal-' || replace(v_user::text, '-', ''), '默认空间') c;
  v_project := private.create_project(v_org, 'default', '默认项目');

  insert into private.default_workspaces(app_user_id, organization_id, project_id)
  values (v_user, v_org, v_project);

  return query select v_org, v_project, true;
end;
$$;

revoke all on private.default_workspaces from public, anon, authenticated, service_role;
revoke all on function private.ensure_default_workspace() from public, anon, authenticated, service_role;

do $$ begin
  if exists(select 1 from pg_roles where rolname = 'gateway_api') then
    grant execute on function private.ensure_default_workspace() to gateway_api;
  end if;
end $$;

commit;
