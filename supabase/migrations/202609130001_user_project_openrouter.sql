begin;

alter table private.project_api_keys add column owner_app_user_id uuid references public.app_users(id);
-- Only unambiguous personal projects can inherit an owner automatically.
-- A creator on a shared project is an audit actor, not proof of ownership.
update private.project_api_keys k set owner_app_user_id=k.created_by
from public.projects p where p.id=k.project_id and k.created_by is not null
  and exists(select 1 from public.organization_members m where m.organization_id=p.organization_id
    and m.app_user_id=k.created_by and m.status='active' and m.role in ('owner','admin','developer'))
  and (select count(*) from public.organization_members m where m.organization_id=p.organization_id and m.status='active')=1;
create index project_api_keys_owner_project on private.project_api_keys(owner_app_user_id,project_id,status);

alter table private.model_requests add column owner_app_user_id uuid references public.app_users(id);
update private.model_requests r set owner_app_user_id=k.owner_app_user_id
from private.project_api_keys k where k.id=r.api_key_id and k.owner_app_user_id is not null;
alter table private.model_requests drop constraint model_requests_project_id_idempotency_digest_key;
create unique index model_requests_owner_idempotency on private.model_requests(project_id,owner_app_user_id,idempotency_digest)
  where owner_app_user_id is not null;
create unique index model_requests_legacy_idempotency on private.model_requests(project_id,idempotency_digest)
  where owner_app_user_id is null;

create function private.protect_api_key_owner() returns trigger language plpgsql
set search_path=pg_catalog,private as $$
begin
  if old.owner_app_user_id is not null and new.owner_app_user_id is distinct from old.owner_app_user_id then
    raise exception 'API_KEY_OWNER_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger protect_api_key_owner before update on private.project_api_keys
for each row execute function private.protect_api_key_owner();

create function private.protect_request_owner() returns trigger language plpgsql security definer
set search_path=pg_catalog,private as $$
declare v_owner uuid; v_project uuid;
begin
  if TG_OP='UPDATE' then
    if new.owner_app_user_id is distinct from old.owner_app_user_id then raise exception 'REQUEST_OWNER_IMMUTABLE'; end if;
  else
    select owner_app_user_id,project_id into v_owner,v_project from private.project_api_keys where id=new.api_key_id;
    if v_owner is null or v_project is distinct from new.project_id then raise exception 'API_KEY_OWNER_REQUIRED'; end if;
    if new.owner_app_user_id is not null and new.owner_app_user_id<>v_owner then raise exception 'REQUEST_OWNER_MISMATCH'; end if;
    new.owner_app_user_id:=v_owner;
  end if;
  return new;
end $$;
create trigger protect_request_owner before insert or update on private.model_requests
for each row execute function private.protect_request_owner();

-- Project procurement authorization remains a shared pool. Adding a user/key
-- does not mint another copy of the project's upstream allowance.
create table private.openrouter_project_budgets (
  project_id uuid not null references public.projects(id),
  environment text not null,
  limit_usd_nano bigint not null check(limit_usd_nano>=0),
  suspended boolean not null default false,
  rebalancing boolean not null default false,
  allocation_fingerprint text,
  created_at timestamptz not null default now(),
  primary key(project_id,environment)
);
insert into private.openrouter_project_budgets(project_id,environment,limit_usd_nano,suspended)
select project_id,environment,limit_usd_nano,suspended from private.openrouter_bindings;

alter table private.openrouter_bindings add column owner_app_user_id uuid references public.app_users(id);
alter table private.openrouter_bindings add column allowed_model_ids uuid[] not null default '{}';
alter table private.openrouter_bindings drop constraint openrouter_bindings_project_id_environment_key;
alter table private.openrouter_bindings add constraint openrouter_bindings_owner_project_environment_key unique(project_id,environment,owner_app_user_id);
alter table private.openrouter_bindings add foreign key(project_id,environment)
  references private.openrouter_project_budgets(project_id,environment);
create unique index openrouter_legacy_project_binding on private.openrouter_bindings(project_id,environment) where owner_app_user_id is null;
-- Retain legacy credentials/costs for reconciliation; they may never be handed
-- to one of the new owners. The worker disables them before reallocating funds.
update private.openrouter_bindings set suspended=true;
update private.openrouter_keys set state='draining' where state='active';

create or replace function private.create_project_api_key(
  p_actor_app_user_id uuid,p_project_id uuid,p_name text,p_key_prefix text,
  p_secret_digest bytea,p_scopes text[],p_expires_at timestamptz default null
) returns uuid language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_id uuid;
begin
  if not exists(select 1 from public.projects p join public.organization_members m on m.organization_id=p.organization_id
    join public.app_users u on u.id=m.app_user_id where p.id=p_project_id and u.id=p_actor_app_user_id
    and u.status='active' and m.status='active' and m.role in ('owner','admin','developer')) then
    raise exception 'PROJECT_KEY_PERMISSION_DENIED';
  end if;
  if p_expires_at is not null and p_expires_at<=now() then raise exception 'API_KEY_EXPIRY_MUST_BE_FUTURE'; end if;
  if p_scopes is null or not ('model:invoke'=any(p_scopes)) then raise exception 'API_KEY_MODEL_SCOPE_REQUIRED'; end if;
  insert into private.project_api_keys(project_id,name,key_prefix,secret_digest,scopes,expires_at,created_by,owner_app_user_id)
    values(p_project_id,trim(p_name),p_key_prefix,p_secret_digest,p_scopes,p_expires_at,p_actor_app_user_id,p_actor_app_user_id)
    returning id into v_id;
  return v_id;
end $$;

create or replace function private.revoke_project_api_key(p_actor_app_user_id uuid,p_api_key_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
  if not exists(select 1 from private.project_api_keys k join public.projects p on p.id=k.project_id
    join public.organization_members m on m.organization_id=p.organization_id join public.app_users u on u.id=m.app_user_id
    where k.id=p_api_key_id and m.app_user_id=p_actor_app_user_id and m.status='active' and u.status='active'
    and (m.role in ('owner','admin') or (m.role='developer' and k.owner_app_user_id=p_actor_app_user_id))) then
    raise exception 'PROJECT_KEY_PERMISSION_DENIED';
  end if;
  update private.project_api_keys set status='revoked',revoked_at=now() where id=p_api_key_id and status='active';
end $$;

create or replace function private.begin_openrouter_attempt(p_request_id uuid,p_environment text)
returns table(credential_id uuid,encrypted_secret jsonb,project_id uuid)
language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare r private.model_requests%rowtype; k private.openrouter_keys%rowtype; b private.openrouter_bindings%rowtype;
  budget private.openrouter_project_budgets%rowtype;
begin
  select * into strict r from private.model_requests where id=p_request_id for update;
  perform private.lock_billing_account(r.billing_account_id);
  if r.status<>'running' or exists(select 1 from private.openrouter_attempts a where a.request_id=r.id) then
    raise exception 'OPENROUTER_REQUEST_ALREADY_DISPATCHED';
  end if;
  if r.owner_app_user_id is null or not exists(select 1 from public.projects p join private.billing_accounts a on a.id=p.billing_account_id
    join private.project_api_keys c on c.project_id=p.id join public.app_users u on u.id=c.owner_app_user_id
    join public.organization_members m on m.organization_id=p.organization_id and m.app_user_id=u.id
    where p.id=r.project_id and p.status='active' and a.status='active' and c.id=r.api_key_id
    and c.owner_app_user_id=r.owner_app_user_id and u.status='active' and m.status='active'
    and m.role in ('owner','admin','developer') and c.status='active' and 'model:invoke'=any(c.scopes)
    and (c.expires_at is null or c.expires_at>now())) then raise exception 'OPENROUTER_DISPATCH_NOT_AUTHORIZED'; end if;
  perform private.assert_billing_funding_fresh(r.billing_account_id);
  select * into budget from private.openrouter_project_budgets x where x.project_id=r.project_id and x.environment=p_environment for update;
  if not found or budget.suspended or budget.rebalancing then raise exception 'OPENROUTER_KEY_NOT_READY'; end if;
  select * into b from private.openrouter_bindings x where x.project_id=r.project_id and x.environment=p_environment
    and x.owner_app_user_id=r.owner_app_user_id for update;
  if not found or b.suspended then raise exception 'OPENROUTER_KEY_NOT_READY'; end if;
  if cardinality(b.allowed_model_ids)>0 and not(r.model_id=any(b.allowed_model_ids)) then raise exception 'OPENROUTER_DISPATCH_NOT_AUTHORIZED'; end if;
  select * into k from private.openrouter_keys x where x.binding_id=b.id and x.state='active' and x.expires_at>now()+interval '5 minutes' for update;
  if not found then raise exception 'OPENROUTER_KEY_NOT_READY'; end if;
  insert into private.openrouter_attempts(request_id,credential_id) values(r.id,k.id);
  return query select k.id,k.encrypted_secret,r.project_id;
end $$;

revoke all on private.openrouter_project_budgets from public,anon,authenticated;
revoke all on function private.protect_api_key_owner(),private.protect_request_owner() from public,anon,authenticated;

-- The reservation function below preserves the existing funding/period locks
-- and the original idempotency digest. Only the explicit owner scopes lookup.
create or replace function private.reserve_model_request(
  p_project_id uuid,
  p_api_key_id uuid,
  p_model_id uuid,
  p_price_version_id uuid,
  p_idempotency_digest bytea,
  p_request_digest bytea,
  p_max_charge_usdc_nano bigint
)
returns table(request_id uuid, request_status private.model_request_status, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_owner uuid;
  v_project public.projects%rowtype;
  v_billing private.billing_accounts%rowtype;
  v_policy private.project_spend_policies%rowtype;
  v_existing private.model_requests%rowtype;
  v_day private.project_period_counters%rowtype;
  v_month private.project_period_counters%rowtype;
  v_lifetime private.project_period_counters%rowtype;
  v_available bigint;
  v_request_id uuid := gen_random_uuid();
  v_today date := (now() at time zone 'UTC')::date;
  v_month_start date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if p_max_charge_usdc_nano <= 0 then
    raise exception 'MAX_CHARGE_MUST_BE_POSITIVE' using errcode = 'P0001';
  end if;

  select * into strict v_project
  from public.projects where id = p_project_id;

  v_billing := private.lock_billing_account(v_project.billing_account_id);

  select k.owner_app_user_id into v_owner from private.project_api_keys k
  join public.app_users u on u.id=k.owner_app_user_id
  join public.organization_members m on m.app_user_id=u.id and m.organization_id=v_project.organization_id
  where k.id=p_api_key_id and k.project_id=p_project_id and k.status='active'
    and (k.expires_at is null or k.expires_at>now()) and 'model:invoke'=any(k.scopes)
    and u.status='active' and m.status='active' and m.role in ('owner','admin','developer');
  if v_owner is null then raise exception 'API_KEY_NOT_ACTIVE'; end if;

  select * into v_existing
  from private.model_requests
  where project_id = p_project_id
    and owner_app_user_id = v_owner
    and idempotency_digest = p_idempotency_digest;

  if found then
    if v_existing.request_digest <> p_request_digest then
      raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST' using errcode = 'P0001';
    end if;
    return query select v_existing.id, v_existing.status, true;
    return;
  end if;

  if v_project.status <> 'active' then
    raise exception 'PROJECT_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_billing.status <> 'active' then
    raise exception 'BILLING_ACCOUNT_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  perform private.assert_billing_funding_fresh(v_billing.id);

  if not exists (
    select 1 from private.project_api_keys k
    where k.id = p_api_key_id
      and k.project_id = p_project_id
      and k.status = 'active'
      and (k.expires_at is null or k.expires_at > now())
      and 'model:invoke' = any(k.scopes)
  ) then
    raise exception 'API_KEY_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.model_catalog m
    join private.model_price_versions pv on pv.model_id = m.id
    where m.id = p_model_id and m.enabled = true
      and pv.id = p_price_version_id
      and pv.effective_from <= now()
      and (pv.effective_until is null or pv.effective_until > now())
  ) then
    raise exception 'MODEL_OR_PRICE_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  select * into strict v_policy
  from private.project_spend_policies
  where project_id = p_project_id
  for update;

  if cardinality(v_policy.allowed_model_ids) > 0
     and not (p_model_id = any(v_policy.allowed_model_ids)) then
    raise exception 'MODEL_NOT_ALLOWED_FOR_PROJECT' using errcode = 'P0001';
  end if;

  if v_policy.max_per_request_usdc_nano is not null
     and p_max_charge_usdc_nano > v_policy.max_per_request_usdc_nano then
    raise exception 'PER_REQUEST_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  v_day := private.ensure_period_counter(p_project_id, 'day', v_today);
  v_month := private.ensure_period_counter(p_project_id, 'month', v_month_start);
  v_lifetime := private.ensure_period_counter(p_project_id, 'lifetime', date '1970-01-01');

  if v_policy.daily_limit_usdc_nano is not null
     and v_day.spent_usdc_nano + v_day.reserved_usdc_nano + p_max_charge_usdc_nano > v_policy.daily_limit_usdc_nano then
    raise exception 'DAILY_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;
  if v_policy.monthly_limit_usdc_nano is not null
     and v_month.spent_usdc_nano + v_month.reserved_usdc_nano + p_max_charge_usdc_nano > v_policy.monthly_limit_usdc_nano then
    raise exception 'MONTHLY_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;
  if v_policy.lifetime_limit_usdc_nano is not null
     and v_lifetime.spent_usdc_nano + v_lifetime.reserved_usdc_nano + p_max_charge_usdc_nano > v_policy.lifetime_limit_usdc_nano then
    raise exception 'LIFETIME_LIMIT_EXCEEDED' using errcode = 'P0001';
  end if;

  v_available := greatest(
    0,
    v_billing.credit_balance_usdc_nano
      - v_billing.reserved_usdc_nano
      - v_billing.withdrawal_reserved_usdc_nano
  );
  if v_available < p_max_charge_usdc_nano then
    raise exception 'INSUFFICIENT_AVAILABLE_CREDIT' using errcode = 'P0001';
  end if;

  insert into private.model_requests(
    id, project_id, billing_account_id, api_key_id, model_id, price_version_id,
    idempotency_digest, request_digest, max_charge_usdc_nano
  ) values (
    v_request_id, p_project_id, v_billing.id, p_api_key_id, p_model_id,
    p_price_version_id, p_idempotency_digest, p_request_digest,
    p_max_charge_usdc_nano
  );

  insert into private.balance_holds(
    request_id, billing_account_id, project_id, amount_usdc_nano
  ) values (v_request_id, v_billing.id, p_project_id, p_max_charge_usdc_nano);

  update private.billing_accounts
  set reserved_usdc_nano = reserved_usdc_nano + p_max_charge_usdc_nano,
      version = version + 1
  where id = v_billing.id;

  update private.project_period_counters
  set reserved_usdc_nano = reserved_usdc_nano + p_max_charge_usdc_nano,
      updated_at = now()
  where project_id = p_project_id
    and (
      (period_kind = 'day' and period_start = v_today) or
      (period_kind = 'month' and period_start = v_month_start) or
      (period_kind = 'lifetime' and period_start = date '1970-01-01')
    );

  update private.project_api_keys set last_used_at = now() where id = p_api_key_id;

  return query select v_request_id, 'reserved'::private.model_request_status, false;
end;
$$;


commit;
