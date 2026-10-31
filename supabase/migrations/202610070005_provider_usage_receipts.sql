begin;
create table private.provider_usage_receipts (
  request_id uuid primary key references private.model_requests(id),
  receipt jsonb not null,
  created_at timestamptz not null default now()
);
create function private.record_provider_usage_receipt(p_request uuid,p_receipt jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.model_requests%rowtype; previous jsonb;
begin
  select * into strict r from private.model_requests where id=p_request for update;
  select receipt into previous from private.provider_usage_receipts where request_id=p_request;
  if previous is not null then
    if previous<>p_receipt then raise exception 'PROVIDER_RECEIPT_CONFLICT'; end if;
    return;
  end if;
  if r.status not in('running','usage_pending') or jsonb_typeof(p_receipt)<>'object'
    or coalesce(p_receipt->>'customerChargeUsdcNano','')!~ '^\d{1,18}$'
    or coalesce(p_receipt->>'providerCostUsdNano','')!~ '^\d{1,18}$'
    or coalesce(length(p_receipt->>'usageSourceEventId'),0)=0
    or coalesce(length(p_receipt->>'usageSource'),0)=0
    or jsonb_typeof(p_receipt->'normalizedUsage')<>'object' then raise exception 'INVALID_PROVIDER_RECEIPT'; end if;
  insert into private.provider_usage_receipts(request_id,receipt) values(p_request,p_receipt);
end $$;
create function private.recover_provider_usage_receipts()
returns table(request_id uuid,error_code text)
language plpgsql security definer set search_path=pg_catalog,private as $$
declare item record; p jsonb;
begin
  for item in select u.* from private.provider_usage_receipts u join private.model_requests r on r.id=u.request_id
    where r.status in('running','usage_pending') order by u.created_at limit 100 loop
    begin
      p:=item.receipt;
      perform private.finalize_model_request(item.request_id,(p->>'customerChargeUsdcNano')::bigint,
        (p->>'providerCostUsdNano')::bigint,p->>'providerRequestId',p->>'usageSource',p->>'usageSourceEventId',
        p->'normalizedUsage',p->'rawUsageRedacted');
    exception when others then
      request_id:=item.request_id;error_code:='PROVIDER_RECEIPT_RECOVERY_FAILED';return next;
    end;
  end loop;
end $$;
revoke all on private.provider_usage_receipts from public,anon,authenticated;
revoke all on function private.record_provider_usage_receipt(uuid,jsonb),private.recover_provider_usage_receipts() from public,anon,authenticated;
commit;
