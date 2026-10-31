begin;
alter table private.wallet_charge_batches
  add column gas_used bigint check(gas_used>=0),
  add column effective_gas_price numeric(78,0) check(effective_gas_price>=0),
  add column l1_fee_wei numeric(78,0) check(l1_fee_wei>=0),
  add column total_fee_wei numeric(78,0) generated always as (gas_used*effective_gas_price+l1_fee_wei) stored;
create function private.confirm_wallet_charge_with_fee(p_batch uuid,p_tx text,p_block bigint,p_hash text,p_succeeded boolean,
  p_gas bigint,p_price numeric,p_l1 numeric)
returns boolean language plpgsql security definer set search_path=pg_catalog,private as $$
declare result boolean; b private.wallet_charge_batches%rowtype;
begin
  if p_gas is null or p_gas<0 or p_price is null or p_price<0 or p_price<>trunc(p_price)
    or p_l1<0 or p_l1<>trunc(p_l1) then raise exception 'INVALID_NETWORK_FEE'; end if;
  result:=private.confirm_wallet_charge_batch(p_batch,p_tx,p_block,p_hash,p_succeeded);
  select * into strict b from private.wallet_charge_batches where id=p_batch for update;
  if b.gas_used is not null and (b.gas_used<>p_gas or b.effective_gas_price<>p_price
    or (b.l1_fee_wei is not null and b.l1_fee_wei is distinct from p_l1)) then raise exception 'NETWORK_FEE_CONFLICT'; end if;
  update private.wallet_charge_batches set gas_used=p_gas,effective_gas_price=p_price,l1_fee_wei=p_l1 where id=p_batch;
  return result;
end $$;
revoke all on function private.confirm_wallet_charge_with_fee(uuid,text,bigint,text,boolean,bigint,numeric,numeric) from public,anon,authenticated;
commit;
