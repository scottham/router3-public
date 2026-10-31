begin;

alter table private.model_price_versions add column if not exists provider_quote jsonb;
create table private.openrouter_catalog_state (
  model_id uuid primary key references public.model_catalog(id),
  fingerprint text not null,
  synced_at timestamptz not null default now()
);

-- Logical project identity survives all physical credential rotations.
create table private.openrouter_bindings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete restrict,
  environment text not null,
  limit_usd_nano bigint not null check (limit_usd_nano >= 0),
  suspended boolean not null default false,
  guardrail_id text,
  created_at timestamptz not null default now(),
  unique(project_id, environment)
);
create table private.openrouter_keys (
  id uuid primary key default gen_random_uuid(),
  binding_id uuid not null references private.openrouter_bindings(id) on delete restrict,
  remote_name text not null unique,
  remote_hash text unique,
  workspace_id text,
  state text not null check (state in ('provisioning','unknown','ready','active','draining','disabled','deleted')),
  encrypted_secret jsonb,
  expires_at timestamptz not null,
  usage_usd_nano bigint not null default 0 check (usage_usd_nano >= 0),
  last_synced_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  error_code text,
  check (state not in ('ready','active') or (remote_hash is not null and encrypted_secret is not null))
);
create unique index openrouter_one_active_key on private.openrouter_keys(binding_id) where state='active';
create unique index openrouter_one_pending_key on private.openrouter_keys(binding_id) where state in ('provisioning','unknown','ready');

create table private.openrouter_attempts (
  request_id uuid primary key references private.model_requests(id) on delete restrict,
  credential_id uuid not null references private.openrouter_keys(id) on delete restrict,
  generation_id text unique,
  created_at timestamptz not null default now()
);
create table private.openrouter_key_events (
  id bigint generated always as identity primary key,
  key_id uuid not null references private.openrouter_keys(id),
  state text not null,
  error_code text,
  created_at timestamptz not null default now()
);
create function private.audit_openrouter_key() returns trigger language plpgsql security definer
set search_path=pg_catalog,private as $$
begin
  if TG_OP='INSERT' or new.state is distinct from old.state or new.error_code is distinct from old.error_code then
    insert into private.openrouter_key_events(key_id,state,error_code) values(new.id,new.state,new.error_code);
  end if;
  return new;
end $$;
create trigger openrouter_key_audit after insert or update on private.openrouter_keys
for each row execute function private.audit_openrouter_key();

-- Only this function exposes one encrypted credential to the data plane. A
-- committed request reservation is required; the API cannot enumerate secrets.
create function private.begin_openrouter_attempt(p_request_id uuid,p_environment text)
returns table(credential_id uuid,encrypted_secret jsonb,project_id uuid)
language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare r private.model_requests%rowtype; k private.openrouter_keys%rowtype; b private.openrouter_bindings%rowtype;
begin
  select * into strict r from private.model_requests where id=p_request_id for update;
  perform private.lock_billing_account(r.billing_account_id);
  if r.status <> 'running' or exists(select 1 from private.openrouter_attempts a where a.request_id=r.id) then
    raise exception 'OPENROUTER_REQUEST_ALREADY_DISPATCHED';
  end if;
  if not exists(select 1 from public.projects p join private.billing_accounts a on a.id=p.billing_account_id
      join private.project_api_keys c on c.project_id=p.id
      where p.id=r.project_id and p.status='active' and a.status='active' and c.id=r.api_key_id
      and c.status='active' and (c.expires_at is null or c.expires_at>now())) then
    raise exception 'OPENROUTER_DISPATCH_NOT_AUTHORIZED';
  end if;
  perform private.assert_billing_funding_fresh(r.billing_account_id);
  select * into b from private.openrouter_bindings x where x.project_id=r.project_id and x.environment=p_environment for update;
  if not found or b.suspended then raise exception 'OPENROUTER_KEY_NOT_READY'; end if;
  select * into k from private.openrouter_keys x where x.binding_id=b.id and x.state='active' and x.expires_at>now()+interval '5 minutes' for update;
  if not found then raise exception 'OPENROUTER_KEY_NOT_READY'; end if;
  insert into private.openrouter_attempts(request_id,credential_id) values(r.id,k.id);
  return query select k.id,k.encrypted_secret,r.project_id;
end $$;

create function private.record_openrouter_generation(p_request_id uuid,p_generation_id text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if p_generation_id is null or length(p_generation_id) not between 1 and 250 then raise exception 'INVALID_GENERATION_ID'; end if;
  update private.openrouter_attempts set generation_id=p_generation_id
    where request_id=p_request_id and (generation_id is null or generation_id=p_generation_id);
  if not found then raise exception 'OPENROUTER_GENERATION_CONFLICT'; end if;
end $$;

-- Old provider routes are intentionally closed until their live OpenRouter
-- quote has been installed. Historical requests/prices remain intact.
update public.model_catalog set enabled=false where provider <> 'mock';

revoke all on private.openrouter_bindings,private.openrouter_keys,private.openrouter_attempts,
  private.openrouter_catalog_state,private.openrouter_key_events from public,anon,authenticated;
revoke all on function private.audit_openrouter_key(),private.begin_openrouter_attempt(uuid,text),
  private.record_openrouter_generation(uuid,text) from public,anon,authenticated;

commit;
