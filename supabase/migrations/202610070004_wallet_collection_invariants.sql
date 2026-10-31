begin;
alter function private.assert_financial_invariants() rename to assert_wallet_metering_invariants;
create function private.assert_financial_invariants()
returns table(invariant_name text,entity_id text,expected_nano numeric,actual_nano numeric,details jsonb)
language sql security definer set search_path=pg_catalog,private as $$
  select * from private.assert_wallet_metering_invariants()
  union all
  select 'wallet_pending_equals_fragments',r.id::text,f.total,r.pending_nano,'{}'::jsonb
  from private.wallet_receivables r cross join lateral (
    select coalesce(sum(f.amount_nano),0) total from private.wallet_charge_fragments f
      join private.wallet_charge_batches b on b.id=f.batch_id
      where f.receivable_id=r.id and b.state in('planned','submitted')) f where f.total<>r.pending_nano
  union all
  select 'wallet_batch_equals_fragments',b.id::text,b.amount_atomic::numeric*1000,f.total,'{}'::jsonb
  from private.wallet_charge_batches b cross join lateral (
    select coalesce(sum(f.amount_nano),0) total from private.wallet_charge_fragments f where f.batch_id=b.id) f
  where b.amount_atomic::numeric*1000<>f.total
  union all
  select 'wallet_receivable_equals_ledger',g.code,g.total,coalesce(b.balance_nano,0),'{}'::jsonb
  from (select 'asset:wallet-receivable:'||wallet_billing_account_id::text||':'||billing_account_id::text code,
    sum(outstanding_nano) total from private.wallet_receivables group by wallet_billing_account_id,billing_account_id) g
  left join private.ledger_accounts a on a.code=g.code left join private.ledger_balances b on b.account_id=a.id
  where g.total<>coalesce(b.balance_nano,0)
$$;
revoke all on function private.assert_financial_invariants(),private.assert_wallet_metering_invariants() from public,anon,authenticated;
commit;
