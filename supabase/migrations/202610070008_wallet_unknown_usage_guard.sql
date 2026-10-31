begin;
do $$ declare definition text; marker text := 'if v_wallet.state<>''active'' then raise exception ''WALLET_COLLECTION_BLOCKED''; end if;';
begin
  select pg_get_functiondef('private.reserve_wallet_model_request(uuid,uuid,uuid,uuid,bytea,bytea,bigint)'::regprocedure) into definition;
  if position(marker in definition)=0 then raise exception 'WALLET_GUARD_INSERTION_POINT_MISSING'; end if;
  execute replace(definition,marker,marker||'
  if exists(select 1 from private.model_requests where wallet_billing_account_id=v_wallet.id and status=''usage_pending'') then
    raise exception ''WALLET_USAGE_RECONCILIATION_REQUIRED'';
  end if;');
end $$;
commit;
