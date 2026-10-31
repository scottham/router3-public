begin;
-- The daily debit limit in force on-chain, recorded beside the pool snapshot so
-- the console can show it and prefill changes. Null until the next snapshot.
alter table private.wallet_billing_accounts
  add column pool_daily_limit_atomic numeric(78,0) check(pool_daily_limit_atomic>0);

-- Only for the snapshot just recorded: an older read never overwrites a newer one.
create function private.record_wallet_pool_daily_limit(p_wallet uuid,p_block bigint,p_limit numeric)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if p_limit is null or p_limit<=0 or p_limit<>trunc(p_limit) then raise exception 'INVALID_WALLET_SNAPSHOT'; end if;
  update private.wallet_billing_accounts set pool_daily_limit_atomic=p_limit
    where id=p_wallet and snapshot_block=p_block;
end $$;

-- Changes a project's name, spend limits and model allowlist. Owners and admins
-- may change any project; developers only those they created. A reservation
-- locks the policy row, so a change applies between requests, never inside one.
create function private.update_project(p_app_user uuid,p_project uuid,p_name text,
  p_max_per_request_usdc_nano bigint,p_daily_limit_usdc_nano bigint,p_monthly_limit_usdc_nano bigint,
  p_lifetime_limit_usdc_nano bigint,p_allowed_model_ids uuid[])
returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_project public.projects%rowtype; v_role public.organization_role;
begin
  select * into v_project from public.projects where id=p_project for update;
  if not found then raise exception 'PROJECT_PERMISSION_DENIED' using errcode='P0001'; end if;
  select role into v_role from public.organization_members
    where organization_id=v_project.organization_id and app_user_id=p_app_user and status='active';
  if v_role is null or not (v_role in('owner','admin') or (v_role='developer' and v_project.created_by=p_app_user)) then
    raise exception 'PROJECT_PERMISSION_DENIED' using errcode='P0001';
  end if;
  if v_project.status='archived' then raise exception 'PROJECT_ARCHIVED' using errcode='P0001'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 120
    or exists(select 1 from unnest(array[p_max_per_request_usdc_nano,p_daily_limit_usdc_nano,p_monthly_limit_usdc_nano,p_lifetime_limit_usdc_nano]) v where v<0) then
    raise exception 'INVALID_PROJECT_POLICY' using errcode='P0001';
  end if;
  if exists(select 1 from unnest(coalesce(p_allowed_model_ids,'{}')) m where not exists(select 1 from public.model_catalog c where c.id=m)) then
    raise exception 'UNKNOWN_MODEL' using errcode='P0001';
  end if;
  update public.projects set name=trim(p_name) where id=p_project;
  update private.project_spend_policies set max_per_request_usdc_nano=p_max_per_request_usdc_nano,
    daily_limit_usdc_nano=p_daily_limit_usdc_nano,monthly_limit_usdc_nano=p_monthly_limit_usdc_nano,
    lifetime_limit_usdc_nano=p_lifetime_limit_usdc_nano,
    allowed_model_ids=(select coalesce(array_agg(distinct m),'{}') from unnest(coalesce(p_allowed_model_ids,'{}')) m),
    updated_by=p_app_user,updated_at=now()
    where project_id=p_project;
end $$;

revoke all on function private.record_wallet_pool_daily_limit(uuid,bigint,numeric),
  private.update_project(uuid,uuid,text,bigint,bigint,bigint,bigint,uuid[]) from public,anon,authenticated;
commit;
