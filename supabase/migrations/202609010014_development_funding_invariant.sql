begin;

create or replace function private.assert_financial_invariants()
returns table(invariant_name text, entity_id text, expected_nano numeric, actual_nano numeric, details jsonb)
language sql
security definer
set search_path = pg_catalog, private
as $$
  with billing_funding as (
    select b.id,
           b.funding_mode,
           b.credit_balance_usdc_nano,
           coalesce(sum(fl.available_usdc_nano),0)::numeric as funded_available
    from private.billing_accounts b
    left join private.funding_lots fl on fl.billing_account_id = b.id
    group by b.id, b.funding_mode, b.credit_balance_usdc_nano
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
  from billing_funding
  where funding_mode = 'chain' and funded_available <> credit_balance_usdc_nano
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

commit;
