begin;
-- Sign-in and wallet billing move from Base (8453) to Monad mainnet (143).
-- Rows written on Base stay as history: the new checks are NOT VALID, so they
-- bind every new row without rewriting old ones. Table names keep their
-- historical base_* prefix; only the accepted chain changes.

do $$
declare
  p private.wallet_billing_policy%rowtype;
begin
  select * into p from private.wallet_billing_policy where singleton;
  -- Never strand money in flight: open Base holds or unpaid Base receivables
  -- must be collected (or written off by the operator) before switching chains.
  if p.chain_id <> 143 and (p.reserved_nano <> 0 or p.receivable_nano <> 0) then
    raise exception 'BASE_RECEIVABLES_OUTSTANDING: collect or release Base wallet debt before moving to Monad'
      using errcode = 'P0001';
  end if;
end $$;

-- Drop the existing chain_id checks, whatever their generated names.
do $$
declare
  r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'c' and a.attname = 'chain_id'
      and c.conrelid in ('private.base_account_bindings'::regclass, 'private.base_auth_challenges'::regclass,
                         'private.wallet_billing_policy'::regclass, 'private.wallet_billing_accounts'::regclass)
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- Bindings are keyed by address, so a returning user's binding moves to Monad
-- on their next sign-in; it must accept both values until then.
alter table private.base_account_bindings
  add constraint base_account_bindings_chain_check check (chain_id in (8453, 84532, 143));
alter table private.base_auth_challenges
  add constraint base_auth_challenges_chain_check check (chain_id = 143) not valid;
alter table private.wallet_billing_accounts
  add constraint wallet_billing_accounts_chain_check check (chain_id = 143) not valid;

-- The Base router no longer exists for this policy; bootstrap pins the Monad one.
update private.wallet_billing_policy
  set chain_id = 143, enabled = false, router_address = null, runtime_code_hash = null, treasury_address = null
  where singleton and chain_id <> 143;
alter table private.wallet_billing_policy alter column chain_id set default 143;

-- Base wallets can no longer be read or charged. Retire them and end Base-era
-- sessions, so each user signs in again and gets their Monad wallet row.
update public.user_wallets set status = 'revoked', revoked_at = now()
  where chain_id in (8453, 84532) and status = 'active';
update private.base_auth_sessions set revoked_at = now() where revoked_at is null;
alter table private.wallet_billing_policy
  add constraint wallet_billing_policy_chain_check check (chain_id = 143);

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
  if p_chain_id <> 143 or p_address !~ '^0x[0-9a-fA-F]{40}$' then
    raise exception 'INVALID_WALLET_ACCOUNT' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_address, 8453));

  select b.app_user_id into v_user
  from private.base_account_bindings b
  where b.address_normalized = v_address
  for update;

  if v_user is null then
    -- The same address may already belong to a user through a Base-era wallet.
    select w.app_user_id into v_user
    from public.user_wallets w
    where w.address_normalized = v_address
    order by (w.chain_id = p_chain_id) desc, w.created_at
    limit 1
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
  values (v_user, p_chain_id, p_address, 'Monad 钱包')
  on conflict (chain_id, address_normalized) do update
  set status = 'active', revoked_at = null, verified_at = now(), label = 'Monad 钱包';

  return query select v_user, v_created;
end;
$$;
revoke all on function private.resolve_or_create_base_account(text,bigint) from public, anon, authenticated, service_role;

commit;
