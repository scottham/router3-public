begin;
-- A delayed error from a replica must not undo a confirmed payment's status.
create function private.record_wallet_batch_error(p_batch uuid,p_code text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare b private.wallet_charge_batches%rowtype;
begin
  if p_code !~ '^[A-Z0-9_]{1,100}$' then raise exception 'INVALID_COLLECTION_ERROR'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict b from private.wallet_charge_batches where id=p_batch;
  perform 1 from private.wallet_billing_accounts where id=b.wallet_billing_account_id for update;
  select * into strict b from private.wallet_charge_batches where id=p_batch for update;
  if b.state not in ('planned','submitted') then return; end if;
  perform private.record_wallet_collection_error(b.wallet_billing_account_id,p_code);
end $$;
revoke all on function private.record_wallet_batch_error(uuid,text) from public,anon,authenticated;
commit;
