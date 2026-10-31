begin;

-- Make ledger idempotency safe under concurrent retries.
create or replace function private.post_ledger_transaction(
  p_idempotency_key text,
  p_unit private.ledger_unit,
  p_reference_type text,
  p_reference_id text,
  p_description text,
  p_metadata jsonb,
  p_entries jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_transaction_id uuid;
  v_debits numeric;
  v_credits numeric;
  v_count integer;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'LEDGER_IDEMPOTENCY_KEY_REQUIRED' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_entries) <> 'array' then
    raise exception 'LEDGER_ENTRIES_MUST_BE_ARRAY' using errcode = 'P0001';
  end if;

  insert into private.ledger_transactions(
    idempotency_key, unit, reference_type, reference_id, description, metadata
  ) values (
    p_idempotency_key, p_unit, p_reference_type, p_reference_id,
    p_description, coalesce(p_metadata, '{}'::jsonb)
  ) on conflict (idempotency_key) do nothing
  returning id into v_transaction_id;

  if v_transaction_id is null then
    select id into strict v_transaction_id
    from private.ledger_transactions
    where idempotency_key = p_idempotency_key;
    return v_transaction_id;
  end if;

  insert into private.ledger_entries(transaction_id, account_id, side, amount_nano)
  select
    v_transaction_id,
    (entry ->> 'account_id')::uuid,
    (entry ->> 'side')::private.ledger_side,
    (entry ->> 'amount_nano')::bigint
  from jsonb_array_elements(p_entries) as entry;

  select count(*),
         coalesce(sum(amount_nano) filter (where side = 'debit'), 0),
         coalesce(sum(amount_nano) filter (where side = 'credit'), 0)
  into v_count, v_debits, v_credits
  from private.ledger_entries
  where transaction_id = v_transaction_id;

  if v_count < 2 or v_debits <= 0 or v_debits <> v_credits then
    raise exception 'LEDGER_NOT_BALANCED' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from private.ledger_entries e
    join private.ledger_accounts a on a.id = e.account_id
    where e.transaction_id = v_transaction_id and a.unit <> p_unit
  ) then
    raise exception 'LEDGER_UNIT_MISMATCH' using errcode = 'P0001';
  end if;

  insert into private.ledger_balances(account_id, balance_nano, version, updated_at)
  select e.account_id,
         sum(case when e.side = a.normal_side then e.amount_nano else -e.amount_nano end),
         1, now()
  from private.ledger_entries e
  join private.ledger_accounts a on a.id = e.account_id
  where e.transaction_id = v_transaction_id
  group by e.account_id
  on conflict (account_id) do update
  set balance_nano = private.ledger_balances.balance_nano + excluded.balance_nano,
      version = private.ledger_balances.version + 1,
      updated_at = now();

  update private.ledger_transactions
  set status = 'posted', posted_at = now()
  where id = v_transaction_id;

  return v_transaction_id;
end;
$$;

-- Status calculation uses outstanding receivable claims, so a recovered historical
-- shortfall does not keep a charge permanently marked unbacked.
create or replace function private.recalculate_usage_charge_status(p_usage_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_charge bigint;
  v_settled bigint;
  v_outstanding bigint;
begin
  select customer_charge_usdc_nano into strict v_charge
  from private.usage_charges where id = p_usage_charge_id;

  select coalesce(sum(fc.settled_usdc_nano),0)
  into v_settled
  from private.funding_commitments fc
  where fc.source_id = p_usage_charge_id
    and fc.source_type in ('usage_charge','receivable_recovery');

  select coalesce(sum(rc.outstanding_usdc_nano),0)
  into v_outstanding
  from private.receivable_claims rc
  where rc.source_id = p_usage_charge_id and rc.status = 'open';

  update private.usage_charges
  set settlement_status = case
    when v_outstanding > 0 then 'unbacked'
    when v_settled >= v_charge then 'settled'
    when v_settled > 0 then 'partially_settled'
    else 'unsettled'
  end
  where id = p_usage_charge_id;
end;
$$;

create or replace function private.create_project_api_key(
  p_actor_app_user_id uuid,
  p_project_id uuid,
  p_name text,
  p_key_prefix text,
  p_secret_digest bytea,
  p_scopes text[],
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select organization_id into strict v_org from public.projects where id = p_project_id;
  if not exists (
    select 1 from public.organization_members om
    where om.organization_id = v_org
      and om.app_user_id = p_actor_app_user_id
      and om.status = 'active'
      and om.role in ('owner','admin','developer')
  ) then
    raise exception 'PROJECT_KEY_PERMISSION_DENIED' using errcode = 'P0001';
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'API_KEY_EXPIRY_MUST_BE_FUTURE' using errcode = 'P0001';
  end if;
  if not ('model:invoke' = any(p_scopes)) then
    raise exception 'API_KEY_MODEL_SCOPE_REQUIRED' using errcode = 'P0001';
  end if;

  insert into private.project_api_keys(
    project_id, name, key_prefix, secret_digest, scopes, expires_at, created_by
  ) values (
    p_project_id, trim(p_name), p_key_prefix, p_secret_digest,
    p_scopes, p_expires_at, p_actor_app_user_id
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.revoke_project_api_key(
  p_actor_app_user_id uuid,
  p_api_key_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_org uuid;
begin
  select p.organization_id into strict v_org
  from private.project_api_keys k
  join public.projects p on p.id = k.project_id
  where k.id = p_api_key_id;

  if not exists (
    select 1 from public.organization_members om
    where om.organization_id = v_org
      and om.app_user_id = p_actor_app_user_id
      and om.status = 'active'
      and om.role in ('owner','admin','developer')
  ) then
    raise exception 'PROJECT_KEY_PERMISSION_DENIED' using errcode = 'P0001';
  end if;

  update private.project_api_keys
  set status = 'revoked', revoked_at = now()
  where id = p_api_key_id and status = 'active';
end;
$$;

create or replace function private.get_my_billing_summaries()
returns table(
  organization_id uuid,
  organization_name text,
  billing_account_id uuid,
  billing_status private.billing_status,
  credit_balance_usdc_nano bigint,
  reserved_usdc_nano bigint,
  withdrawal_reserved_usdc_nano bigint,
  receivable_usdc_nano bigint,
  available_usdc_nano bigint,
  funding_fresh_until timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select o.id, o.name, b.id, b.status,
         b.credit_balance_usdc_nano, b.reserved_usdc_nano,
         b.withdrawal_reserved_usdc_nano, b.receivable_usdc_nano,
         greatest(0, b.credit_balance_usdc_nano - b.reserved_usdc_nano - b.withdrawal_reserved_usdc_nano),
         b.funding_fresh_until
  from public.organizations o
  join public.organization_members om on om.organization_id = o.id
  join private.billing_accounts b on b.organization_id = o.id
  where om.app_user_id = private.current_app_user_id() and om.status = 'active'
$$;

create or replace function private.merge_app_users(
  p_source_auth_user_id uuid,
  p_target_auth_user_id uuid,
  p_confirmation text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_source uuid;
  v_target uuid;
  v_member record;
begin
  if p_confirmation <> 'MERGE_ACCOUNTS' then
    raise exception 'MERGE_CONFIRMATION_REQUIRED' using errcode = 'P0001';
  end if;

  select app_user_id into strict v_source from private.auth_bindings where auth_user_id = p_source_auth_user_id for update;
  select app_user_id into strict v_target from private.auth_bindings where auth_user_id = p_target_auth_user_id for update;
  if v_source = v_target then return v_target; end if;

  perform pg_advisory_xact_lock(hashtextextended(least(v_source::text, v_target::text), 777));
  perform pg_advisory_xact_lock(hashtextextended(greatest(v_source::text, v_target::text), 777));

  if exists (
    select 1 from private.balance_holds h
    join public.projects p on p.id = h.project_id
    join public.organization_members om on om.organization_id = p.organization_id
    where om.app_user_id = v_source and h.status in ('active','usage_pending')
  ) then
    raise exception 'SOURCE_ACCOUNT_HAS_ACTIVE_MODEL_HOLDS' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from private.chain_unlocks u
    join private.chain_accounts c on c.id = u.chain_account_id
    join public.user_wallets w on w.id = c.owner_wallet_id
    where w.app_user_id = v_source and u.status = 'pending'
  ) then
    raise exception 'SOURCE_ACCOUNT_HAS_PENDING_UNLOCK' using errcode = 'P0001';
  end if;

  for v_member in
    select * from public.organization_members where app_user_id = v_source
  loop
    insert into public.organization_members(organization_id, app_user_id, role, status)
    values (v_member.organization_id, v_target, v_member.role, v_member.status)
    on conflict (organization_id, app_user_id) do update
    set role = case
      when excluded.role = 'owner' or public.organization_members.role = 'owner' then 'owner'::public.organization_role
      when excluded.role = 'admin' or public.organization_members.role = 'admin' then 'admin'::public.organization_role
      when excluded.role = 'billing' or public.organization_members.role = 'billing' then 'billing'::public.organization_role
      when excluded.role = 'developer' or public.organization_members.role = 'developer' then 'developer'::public.organization_role
      else 'viewer'::public.organization_role
    end,
    status = case when excluded.status = 'active' or public.organization_members.status = 'active'
                  then 'active'::public.member_status else public.organization_members.status end;
  end loop;
  delete from public.organization_members where app_user_id = v_source;

  update public.user_wallets set app_user_id = v_target where app_user_id = v_source;
  update private.auth_bindings set app_user_id = v_target where app_user_id = v_source;
  delete from private.wallet_link_challenges where app_user_id = v_source;

  update public.app_users
  set status = 'merged', merged_into = v_target, updated_at = now()
  where id = v_source and status = 'active';

  insert into private.account_merge_audit(
    source_app_user_id, target_app_user_id, source_auth_user_id,
    target_auth_user_id, confirmation
  ) values (
    v_source, v_target, p_source_auth_user_id, p_target_auth_user_id, p_confirmation
  );

  return v_target;
end;
$$;

create or replace function private.cleanup_expired_operational_data()
returns table(cache_rows_deleted integer, challenges_deleted integer)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_cache integer;
  v_challenges integer;
begin
  delete from private.encrypted_response_cache where expires_at < now();
  get diagnostics v_cache = row_count;
  delete from private.wallet_link_challenges
  where expires_at < now() - interval '1 day';
  get diagnostics v_challenges = row_count;
  return query select v_cache, v_challenges;
end;
$$;

create or replace function private.assert_financial_invariants()
returns table(invariant_name text, entity_id text, expected_nano numeric, actual_nano numeric, details jsonb)
language sql
security definer
set search_path = pg_catalog, private
as $$
  with billing_funding as (
    select b.id,
           b.credit_balance_usdc_nano,
           coalesce(sum(fl.available_usdc_nano),0)::numeric as funded_available
    from private.billing_accounts b
    left join private.funding_lots fl on fl.billing_account_id = b.id
    group by b.id, b.credit_balance_usdc_nano
  ), hold_totals as (
    select b.id,
           b.reserved_usdc_nano,
           coalesce(sum(h.amount_usdc_nano) filter (where h.status in ('active','usage_pending')),0)::numeric as hold_total
    from private.billing_accounts b
    left join private.balance_holds h on h.billing_account_id = b.id
    group by b.id, b.reserved_usdc_nano
  ), receivable_totals as (
    select b.id,
           b.receivable_usdc_nano,
           coalesce(sum(rc.outstanding_usdc_nano) filter (where rc.status = 'open'),0)::numeric as claim_total
    from private.billing_accounts b
    left join private.receivable_claims rc on rc.billing_account_id = b.id
    group by b.id, b.receivable_usdc_nano
  ), chain_backing as (
    select c.id,
           c.confirmed_allocated_usdc_atomic * 1000 as chain_allocated_nano,
           coalesce(sum(fl.available_usdc_nano + fl.committed_usdc_nano),0)::numeric as tracked_allocated_nano
    from private.chain_accounts c
    left join private.funding_lots fl on fl.chain_account_id = c.id
    group by c.id, c.confirmed_allocated_usdc_atomic
  )
  select 'billing_credit_equals_available_funding', id::text,
         funded_available, credit_balance_usdc_nano, '{}'::jsonb
  from billing_funding where funded_available <> credit_balance_usdc_nano
  union all
  select 'billing_reserved_equals_active_holds', id::text,
         hold_total, reserved_usdc_nano, '{}'::jsonb
  from hold_totals where hold_total <> reserved_usdc_nano
  union all
  select 'billing_receivable_equals_open_claims', id::text,
         claim_total, receivable_usdc_nano, '{}'::jsonb
  from receivable_totals where claim_total <> receivable_usdc_nano
  union all
  select 'chain_allocated_equals_tracked_backing', id::text,
         chain_allocated_nano, tracked_allocated_nano, '{}'::jsonb
  from chain_backing where chain_allocated_nano <> tracked_allocated_nano
  union all
  select 'ledger_transaction_balanced', transaction_id::text,
         debit_nano, credit_nano, '{}'::jsonb
  from private.assert_ledger_balanced()
$$;

-- RLS is intentionally limited to non-financial public tables. Financial writes use
-- direct PostgreSQL roles and SECURITY DEFINER functions, never browser REST writes.
revoke all on schema private from anon, authenticated, service_role;
revoke all on all tables in schema private from anon, authenticated, service_role;
revoke all on all sequences in schema private from anon, authenticated, service_role;
revoke all on all functions in schema private from anon, authenticated, service_role;

-- Re-grant only the safe helper functions needed by RLS and read-only client RPCs.
grant usage on schema private to authenticated;
grant execute on function private.current_app_user_id() to authenticated;
grant execute on function private.sync_auth_binding_last_seen() to authenticated;
grant execute on function private.is_organization_member(uuid) to authenticated;
grant execute on function private.has_organization_role(uuid, public.organization_role[]) to authenticated;
grant execute on function private.create_organization(text, text) to authenticated;
grant execute on function private.create_project(uuid, text, text, bigint, bigint, bigint, bigint, uuid[]) to authenticated;
grant execute on function private.get_my_billing_summaries() to authenticated;

-- No grants to service_role on financial tables. Auth administration may use the
-- Supabase service key; finance services connect with the separate DB roles installed
-- from supabase/manual/create_backend_roles.sql.template.

commit;
