begin;
-- One request with unknown usage used to pause the whole wallet until an
-- operator reconciled it; a deploy that cut 47 streams paused one for seven
-- hours. The request's hold already covers the most it can cost, so the rest
-- of the wallet keeps working. A hold nobody reconciles within the TTL is
-- released as not charged: the platform absorbs the provider cost rather than
-- billing the user the full hold.
do $$ declare definition text; guard text := '
  if exists(select 1 from private.model_requests where wallet_billing_account_id=v_wallet.id and status=''usage_pending'') then
    raise exception ''WALLET_USAGE_RECONCILIATION_REQUIRED'';
  end if;';
begin
  select pg_get_functiondef('private.reserve_wallet_model_request(uuid,uuid,uuid,uuid,bytea,bytea,bigint)'::regprocedure) into definition;
  if position(guard in definition)=0 then raise exception 'WALLET_GUARD_MISSING'; end if;
  execute replace(definition,guard,'');
end $$;

create function private.expire_uncertain_wallet_usage(p_started_before timestamptz)
returns integer language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.model_requests%rowtype; v_evidence text; v_count integer := 0;
begin
  -- Same lock order as reconcile_wallet_not_charged.
  perform 1 from private.wallet_billing_policy where singleton for update;
  for r in select * from private.model_requests m
    where m.status='usage_pending' and m.wallet_billing_account_id is not null
      and coalesce(m.started_at,m.created_at)<p_started_before
      -- Usage that did arrive is billed from its receipt instead.
      and not exists(select 1 from private.provider_usage_receipts u where u.request_id=m.id)
    order by m.created_at limit 200 for update skip locked
  loop
    perform 1 from private.wallet_billing_accounts where id=r.wallet_billing_account_id for update;
    v_evidence := format('No usage evidence for %s (%s) before %s; released as not charged by the uncertain-usage TTL.',
      r.id,coalesce(r.failure_code,'unknown'),p_started_before);
    insert into private.provider_no_charge_evidence(request_id,evidence_digest,provider_request_id,evidence)
      values(r.id,encode(sha256(convert_to(v_evidence,'UTF8')),'hex'),coalesce(r.provider_request_id,'none:ttl'),v_evidence);
    perform private.release_wallet_request_hold(r.id,'failed','UNCERTAIN_USAGE_EXPIRED');
    v_count := v_count+1;
  end loop;
  return v_count;
end $$;

-- For the metrics exporter: requests whose usage is still unknown.
create function private.metrics_uncertain_usage() returns jsonb
language sql stable security definer set search_path=pg_catalog,private as $$
  select jsonb_build_object('n',count(*),'held_nano',coalesce(sum(h.amount_usdc_nano),0)::text,
    'oldest_age_seconds',coalesce(extract(epoch from now()-min(coalesce(r.started_at,r.created_at))),0))
  from private.model_requests r left join private.balance_holds h on h.request_id=r.id and h.status='usage_pending'
  where r.status='usage_pending'
$$;

revoke all on function private.expire_uncertain_wallet_usage(timestamptz),private.metrics_uncertain_usage() from public,anon,authenticated;
commit;
