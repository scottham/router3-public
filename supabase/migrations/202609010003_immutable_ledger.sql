begin;

do $$ begin
  create type private.ledger_unit as enum ('USDC_NANO', 'USD_NANO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.ledger_account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.ledger_side as enum ('debit', 'credit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type private.ledger_transaction_status as enum ('draft', 'posted', 'reversed');
exception when duplicate_object then null; end $$;

create table if not exists private.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  unit private.ledger_unit not null,
  account_type private.ledger_account_type not null,
  normal_side private.ledger_side not null,
  organization_id uuid references public.organizations(id) on delete restrict,
  billing_account_id uuid references private.billing_accounts(id) on delete restrict,
  chain_account_id uuid,
  created_at timestamptz not null default now(),
  check (
    (account_type in ('asset','expense') and normal_side = 'debit') or
    (account_type in ('liability','equity','revenue') and normal_side = 'credit')
  )
);

create table if not exists private.ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  unit private.ledger_unit not null,
  status private.ledger_transaction_status not null default 'draft',
  reference_type text not null,
  reference_id text not null,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  posted_at timestamptz,
  reversed_by uuid references private.ledger_transactions(id),
  created_at timestamptz not null default now(),
  check ((status = 'posted') = (posted_at is not null) or status = 'reversed')
);
create index if not exists ledger_transactions_reference_idx
  on private.ledger_transactions(reference_type, reference_id);

create table if not exists private.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references private.ledger_transactions(id) on delete restrict,
  account_id uuid not null references private.ledger_accounts(id) on delete restrict,
  side private.ledger_side not null,
  amount_nano bigint not null check (amount_nano > 0),
  created_at timestamptz not null default now()
);
create index if not exists ledger_entries_transaction_idx on private.ledger_entries(transaction_id);
create index if not exists ledger_entries_account_idx on private.ledger_entries(account_id, created_at);

create table if not exists private.ledger_balances (
  account_id uuid primary key references private.ledger_accounts(id) on delete restrict,
  balance_nano bigint not null default 0,
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function private.reject_posted_ledger_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, private
as $$
declare
  v_status private.ledger_transaction_status;
begin
  if tg_table_name = 'ledger_transactions' then
    if old.status in ('posted','reversed') then
      raise exception 'POSTED_LEDGER_IS_IMMUTABLE' using errcode = 'P0001';
    end if;
  else
    select status into v_status
    from private.ledger_transactions
    where id = old.transaction_id;
    if v_status in ('posted','reversed') then
      raise exception 'POSTED_LEDGER_IS_IMMUTABLE' using errcode = 'P0001';
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists ledger_transactions_immutable on private.ledger_transactions;
create trigger ledger_transactions_immutable
before update or delete on private.ledger_transactions
for each row
when (old.status in ('posted','reversed'))
execute function private.reject_posted_ledger_mutation();

drop trigger if exists ledger_entries_immutable on private.ledger_entries;
create trigger ledger_entries_immutable
before update or delete on private.ledger_entries
for each row execute function private.reject_posted_ledger_mutation();

create or replace function private.ensure_platform_ledger_accounts()
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  insert into private.ledger_accounts(code, name, unit, account_type, normal_side)
  values
    ('asset:treasury-usdc', 'Treasury USDC', 'USDC_NANO', 'asset', 'debit'),
    ('expense:provider-usd', 'Provider expense', 'USD_NANO', 'expense', 'debit'),
    ('liability:provider-payable-usd', 'Provider payable', 'USD_NANO', 'liability', 'credit'),
    ('expense:reconciliation-loss-usdc', 'USDC reconciliation loss', 'USDC_NANO', 'expense', 'debit')
  on conflict (code) do nothing;
end;
$$;

create or replace function private.ensure_billing_ledger_accounts(p_billing_account_id uuid)
returns table(customer_credit uuid, customer_receivable uuid, model_revenue uuid)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_org uuid;
  v_credit uuid;
  v_receivable uuid;
  v_revenue uuid;
begin
  select organization_id into strict v_org
  from private.billing_accounts
  where id = p_billing_account_id;

  insert into private.ledger_accounts(
    code, name, unit, account_type, normal_side, organization_id, billing_account_id
  ) values (
    'liability:customer-credit:' || p_billing_account_id::text,
    'Customer service credit', 'USDC_NANO', 'liability', 'credit', v_org, p_billing_account_id
  ) on conflict (code) do update set name = excluded.name
  returning id into v_credit;

  insert into private.ledger_accounts(
    code, name, unit, account_type, normal_side, organization_id, billing_account_id
  ) values (
    'asset:customer-receivable:' || p_billing_account_id::text,
    'Customer receivable', 'USDC_NANO', 'asset', 'debit', v_org, p_billing_account_id
  ) on conflict (code) do update set name = excluded.name
  returning id into v_receivable;

  insert into private.ledger_accounts(
    code, name, unit, account_type, normal_side, organization_id, billing_account_id
  ) values (
    'revenue:model-usage:' || p_billing_account_id::text,
    'Model usage revenue', 'USDC_NANO', 'revenue', 'credit', v_org, p_billing_account_id
  ) on conflict (code) do update set name = excluded.name
  returning id into v_revenue;

  return query select v_credit, v_receivable, v_revenue;
end;
$$;

create or replace function private.ensure_chain_asset_ledger_account(
  p_chain_account_id uuid,
  p_billing_account_id uuid,
  p_chain_id bigint,
  p_vault_address text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  select organization_id into strict v_org
  from private.billing_accounts
  where id = p_billing_account_id;

  insert into private.ledger_accounts(
    code, name, unit, account_type, normal_side,
    organization_id, billing_account_id, chain_account_id
  ) values (
    'asset:vault-usdc:' || p_chain_account_id::text,
    'Vault USDC chain=' || p_chain_id::text || ' vault=' || lower(p_vault_address),
    'USDC_NANO', 'asset', 'debit', v_org, p_billing_account_id, p_chain_account_id
  ) on conflict (code) do update set name = excluded.name
  returning id into v_id;

  return v_id;
end;
$$;

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

  select id into v_transaction_id
  from private.ledger_transactions
  where idempotency_key = p_idempotency_key;

  if found then
    return v_transaction_id;
  end if;

  insert into private.ledger_transactions(
    idempotency_key, unit, reference_type, reference_id, description, metadata
  ) values (
    p_idempotency_key, p_unit, p_reference_type, p_reference_id,
    p_description, coalesce(p_metadata, '{}'::jsonb)
  ) returning id into v_transaction_id;

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
    where e.transaction_id = v_transaction_id
      and a.unit <> p_unit
  ) then
    raise exception 'LEDGER_UNIT_MISMATCH' using errcode = 'P0001';
  end if;

  insert into private.ledger_balances(account_id, balance_nano, version, updated_at)
  select
    e.account_id,
    sum(case when e.side = a.normal_side then e.amount_nano else -e.amount_nano end),
    1,
    now()
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

create or replace function private.assert_ledger_balanced()
returns table(transaction_id uuid, debit_nano numeric, credit_nano numeric)
language sql
security definer
set search_path = pg_catalog, private
as $$
  select t.id,
         coalesce(sum(e.amount_nano) filter (where e.side = 'debit'), 0),
         coalesce(sum(e.amount_nano) filter (where e.side = 'credit'), 0)
  from private.ledger_transactions t
  left join private.ledger_entries e on e.transaction_id = t.id
  where t.status in ('posted','reversed')
  group by t.id
  having coalesce(sum(e.amount_nano) filter (where e.side = 'debit'), 0)
      <> coalesce(sum(e.amount_nano) filter (where e.side = 'credit'), 0)
$$;

select private.ensure_platform_ledger_accounts();

commit;
