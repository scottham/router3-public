begin;
-- Monad has no L1 data fee. Batches confirmed before the collector recorded 0
-- stored null, which left their generated total_fee_wei null as well.
update private.wallet_charge_batches b set l1_fee_wei = 0
  from private.wallet_billing_accounts w
  where w.id = b.wallet_billing_account_id and w.chain_id = 143
    and b.gas_used is not null and b.l1_fee_wei is null;
commit;
