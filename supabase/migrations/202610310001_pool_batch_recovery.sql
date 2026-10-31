begin;

-- Only this function exposes the signer's transaction hash to the collector.
-- Serialize with signing, so a batch can be abandoned only if no signed
-- transaction exists and no delayed signer can create one after the check.
create function private.fail_unsigned_pool_batch(p_payer text,p_id uuid,p_error text)
returns private.pool_batches
language plpgsql security definer set search_path=pg_catalog,private as $$
declare b private.pool_batches; v_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('pool-batch:'||p_id::text,0));
  select * into b from private.pool_batches where id=p_id and payer=p_payer for update;
  if b.id is null or b.state<>'planned' then return b; end if;
  select tx_hash into v_hash from settlement_signing.transactions where idempotency_key='pool-settle:'||p_id::text;
  if v_hash is not null then
    update private.pool_batches set state='submitted',tx_hash=v_hash,error_code=null where id=p_id returning * into b;
  else
    update private.pool_batches set state='failed',error_code=left(p_error,120) where id=p_id returning * into b;
    update private.pool_requests set batch_id=null where batch_id=p_id;
  end if;
  return b;
end $$;
revoke all on function private.fail_unsigned_pool_batch(text,uuid,text) from public,anon,authenticated,service_role;

-- A crashed API must obey the same key caps as the ordinary close path,
-- including limits changed while the request was running. Daily spend is
-- attributed to the request's creation day, even if recovery happens later.
create or replace function private.recover_lost_pool_requests(p_before timestamptz) returns integer
language plpgsql security definer set search_path=pg_catalog,private as $$
declare r record; q private.pool_requests; k private.api_keys; n integer:=0;
  v_room bigint; v_charge bigint; v_today bigint; v_total bigint; v_held bigint; v_dayheld bigint; v_since timestamptz;
begin
  for r in select id,payer from private.pool_requests where status='running' and started_at<p_before order by started_at loop
    perform 1 from private.pool_accounts where payer=r.payer for update;
    select * into q from private.pool_requests where id=r.id and status='running';
    if q.id is null then continue; end if;
    select greatest(least(a.pool_balance_atomic-a.withdrawal_atomic,a.daily_remaining_atomic)-a.unsettled_atomic,0)
      into v_room from private.pool_accounts a where a.payer=r.payer;
    select * into k from private.api_keys where id=q.api_key_id;
    if k.id is not null and (k.daily_limit_atomic is not null or k.total_limit_atomic is not null) then
      v_since:=date_trunc('day',q.created_at at time zone 'UTC') at time zone 'UTC';
      select coalesce(sum(charged_atomic) filter(where status<>'running' and created_at>=v_since and created_at<v_since+interval '1 day'),0),
        coalesce(sum(charged_atomic) filter(where status<>'running'),0),
        coalesce(sum(ceiling_atomic) filter(where status='running' and id<>q.id),0),
        coalesce(sum(ceiling_atomic) filter(where status='running' and id<>q.id and created_at>=v_since and created_at<v_since+interval '1 day'),0)
        into v_today,v_total,v_held,v_dayheld from private.pool_requests where api_key_id=k.id;
      if k.daily_limit_atomic is not null then v_room:=least(v_room,greatest(k.daily_limit_atomic-v_today-v_dayheld,0)); end if;
      if k.total_limit_atomic is not null then v_room:=least(v_room,greatest(k.total_limit_atomic-v_total-v_held,0)); end if;
    end if;
    v_charge:=least(q.ceiling_atomic,v_room);
    update private.pool_requests set status='completed',charged_atomic=v_charge,charged_from='ceiling',
      actual_charge_usdc_nano=v_charge*1000,failure_code='LOST_REQUEST',usage_source='ceiling:LOST_REQUEST',completed_at=now() where id=q.id;
    update private.pool_accounts set held_atomic=greatest(held_atomic-q.ceiling_atomic,0),
      running=greatest(running-1,0),unsettled_atomic=unsettled_atomic+v_charge where payer=r.payer;
    n:=n+1;
  end loop;
  return n;
end $$;
commit;
