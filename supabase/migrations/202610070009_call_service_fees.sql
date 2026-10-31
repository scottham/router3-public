begin;
-- A call fee is an immutable, independently versioned policy; model prices
-- remain provider tariffs. Historical requests retain their original policy.
create table private.call_fee_policies (
  id uuid primary key default gen_random_uuid(),
  service_fee_bps integer not null check(service_fee_bps between 0 and 10000),
  effective_from timestamptz not null default clock_timestamp()
);
insert into private.call_fee_policies(service_fee_bps) values(100);
create trigger call_fee_policies_immutable before update or delete on private.call_fee_policies
  for each row execute function private.reject_price_version_mutation();
alter table private.model_requests add column call_fee_policy_id uuid references private.call_fee_policies(id);
create table private.call_charge_breakdowns (
  request_id uuid primary key references private.model_requests(id),
  fee_policy_id uuid not null references private.call_fee_policies(id),
  model_cost_usdc_nano bigint not null check(model_cost_usdc_nano>=0),
  service_fee_usdc_nano bigint not null check(service_fee_usdc_nano>=0),
  service_fee_bps integer not null check(service_fee_bps between 0 and 10000),
  total_usdc_nano bigint not null check(total_usdc_nano=model_cost_usdc_nano+service_fee_usdc_nano),
  quoted_model_cost_usdc_nano bigint not null check(quoted_model_cost_usdc_nano>=model_cost_usdc_nano),
  quoted_service_fee_usdc_nano bigint not null check(quoted_service_fee_usdc_nano>=service_fee_usdc_nano),
  created_at timestamptz not null default now()
);
create trigger call_charge_breakdowns_immutable before update or delete on private.call_charge_breakdowns
  for each row execute function private.reject_price_version_mutation();
revoke all on private.call_fee_policies,private.call_charge_breakdowns from public,anon,authenticated;

create function private.reserve_wallet_request_with_fee(p_project uuid,p_key uuid,p_model uuid,p_price uuid,
  p_idempotency bytea,p_digest bytea,p_max bigint,p_fee_policy uuid)
returns table(request_id uuid,request_status private.model_request_status,replayed boolean)
language plpgsql security definer set search_path=pg_catalog,private as $$
declare result record;
begin
  if p_fee_policy is null or not exists(select 1 from private.call_fee_policies where id=p_fee_policy and effective_from<=now()) then
    raise exception 'CALL_FEE_POLICY_NOT_FOUND';
  end if;
  select * into result from private.reserve_wallet_model_request(p_project,p_key,p_model,p_price,p_idempotency,p_digest,p_max);
  if not result.replayed then
    -- Fee-based calls cannot also carry a model markup.
    if exists(select 1 from private.model_price_versions p where p.id=p_price and (
      p.customer_input_usdc_nano_per_million<>p.provider_input_usd_nano_per_million or
      p.customer_cached_input_usdc_nano_per_million<>p.provider_cached_input_usd_nano_per_million or
      p.customer_output_usdc_nano_per_million<>p.provider_output_usd_nano_per_million or
      p.customer_reasoning_usdc_nano_per_million<>p.provider_reasoning_usd_nano_per_million or
      coalesce((p.bailian_quote->>'markupBps')::integer,0)<>0)) then raise exception 'MODEL_PRICE_INCLUDES_MARKUP'; end if;
    update private.model_requests set call_fee_policy_id=p_fee_policy where id=result.request_id;
  end if;
  return query select result.request_id,result.request_status,result.replayed;
end $$;

create function private.ensure_call_service_fee_ledger(p_billing uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,private as $$
declare result uuid;
begin
  insert into private.ledger_accounts(code,name,unit,account_type,normal_side,organization_id,billing_account_id)
    select 'revenue:call-service-fee:'||id,'Call service fee','USDC_NANO','revenue','credit',organization_id,id
    from private.billing_accounts where id=p_billing on conflict(code) do update set name=excluded.name returning id into result;
  return result;
end $$;
create or replace function private.finalize_wallet_model_request(
  p_request_id uuid,
  p_computed_customer_charge_usdc_nano bigint,
  p_provider_cost_usd_nano bigint,
  p_provider_request_id text,
  p_usage_source text,
  p_usage_source_event_id text,
  p_normalized_usage jsonb,
  p_raw_usage_redacted jsonb default null
)
returns table(
  billed_usdc_nano bigint,
  receivable_usdc_nano bigint,
  unbilled_overrun_usdc_nano bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_request private.model_requests%rowtype;
  v_wallet private.wallet_billing_accounts%rowtype;
  v_accounts record;
  v_fee_bps integer;
  v_model_cost bigint;
  v_service_fee bigint;
  v_fee_revenue uuid;
  v_lines jsonb;
  v_wallet_asset uuid;
  v_hold private.balance_holds%rowtype;
  v_billing private.billing_accounts%rowtype;
  v_charge bigint;
  v_overrun bigint;
  v_covered bigint;
  v_receivable bigint;
  v_usage_charge_id uuid;
  v_today date;
  v_month_start date;
begin
  if p_computed_customer_charge_usdc_nano < 0 or p_provider_cost_usd_nano < 0 then
    raise exception 'NEGATIVE_USAGE_COST' using errcode = 'P0001';
  end if;

  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict v_request from private.model_requests where id=p_request_id;
  select * into strict v_wallet from private.wallet_billing_accounts where id=v_request.wallet_billing_account_id for update;
  v_billing := private.lock_billing_account(v_request.billing_account_id);
  select * into strict v_request from private.model_requests where id=p_request_id for update;

  if v_request.status = 'completed' then
    return query select
      v_request.actual_charge_usdc_nano,
      coalesce((select outstanding_nano from private.wallet_receivables where request_id=p_request_id),0),
      v_request.unbilled_overrun_usdc_nano;
    return;
  end if;
  if v_request.status not in ('reserved','running','usage_pending') then
    raise exception 'REQUEST_NOT_FINALIZABLE' using errcode = 'P0001';
  end if;

  v_billing := private.lock_billing_account(v_request.billing_account_id);
  select * into strict v_hold
  from private.balance_holds where request_id = p_request_id for update;
  if v_hold.status not in ('active','usage_pending') then
    raise exception 'REQUEST_HOLD_NOT_ACTIVE' using errcode = 'P0001';
  end if;

  if v_request.call_fee_policy_id is not null then
    select service_fee_bps into strict v_fee_bps from private.call_fee_policies where id=v_request.call_fee_policy_id;
    if p_computed_customer_charge_usdc_nano::numeric <> p_provider_cost_usd_nano::numeric
      + ceil(p_provider_cost_usd_nano::numeric*v_fee_bps/10000) then
      raise exception 'CALL_FEE_TOTAL_MISMATCH';
    end if;
  end if;
  v_charge := least(p_computed_customer_charge_usdc_nano, v_request.max_charge_usdc_nano);
  -- Preserve the existing customer authorization cap. Any estimate overrun is
  -- recorded as an operator loss, never hidden in an inflated service fee.
  v_model_cost := least(v_charge,p_provider_cost_usd_nano);
  v_service_fee := v_charge-v_model_cost;
  v_overrun := greatest(0, p_computed_customer_charge_usdc_nano - v_request.max_charge_usdc_nano);
  v_covered := 0;
  v_receivable := v_charge - v_covered;

  v_today := (v_request.created_at at time zone 'UTC')::date;
  v_month_start := date_trunc('month', v_request.created_at at time zone 'UTC')::date;

  update private.wallet_billing_accounts set reserved_nano=reserved_nano-v_hold.amount_usdc_nano,
    receivable_nano=receivable_nano+v_charge where id=v_wallet.id and reserved_nano>=v_hold.amount_usdc_nano;
  if not found then raise exception 'WALLET_CAPTURE_UNDERFLOW'; end if;
  update private.wallet_billing_policy set reserved_nano=reserved_nano-v_hold.amount_usdc_nano,
    receivable_nano=receivable_nano+v_charge where singleton;

  update private.project_period_counters
  set reserved_usdc_nano = reserved_usdc_nano - v_hold.amount_usdc_nano,
      spent_usdc_nano = spent_usdc_nano + v_charge,
      updated_at = now()
  where project_id = v_request.project_id
    and (
      (period_kind = 'day' and period_start = v_today) or
      (period_kind = 'month' and period_start = v_month_start) or
      (period_kind = 'lifetime' and period_start = date '1970-01-01')
    )
    and reserved_usdc_nano >= v_hold.amount_usdc_nano;

  update private.balance_holds
  set status = 'captured', resolved_at = now()
  where id = v_hold.id;

  insert into private.usage_events(
    request_id, source, source_event_id, normalized_usage, raw_usage_redacted
  ) values (
    p_request_id, p_usage_source, p_usage_source_event_id,
    coalesce(p_normalized_usage, '{}'::jsonb), p_raw_usage_redacted
  ) on conflict (source, source_event_id) do nothing;

  insert into private.usage_charges(
    request_id, billing_account_id, customer_charge_usdc_nano,
    provider_cost_usd_nano, settlement_status
  ) values (
    p_request_id, v_request.billing_account_id, v_charge,
    p_provider_cost_usd_nano,
    case when v_charge=0 then 'settled' else 'unsettled' end
  ) returning id into v_usage_charge_id;

  if v_charge>0 then
    insert into private.wallet_receivables(request_id,wallet_billing_account_id,billing_account_id,charge_id,original_nano,outstanding_nano)
      values(p_request_id,v_wallet.id,v_request.billing_account_id,v_usage_charge_id,v_charge,v_charge);
  end if;

  if v_overrun > 0 then
    insert into private.reconciliation_incidents(
      billing_account_id, severity, incident_type, details
    ) values (
      v_request.billing_account_id, 'warning', 'provider_cost_exceeded_preauthorization',
      jsonb_build_object(
        'request_id', p_request_id,
        'computed_charge_usdc_nano', p_computed_customer_charge_usdc_nano,
        'authorized_charge_usdc_nano', v_request.max_charge_usdc_nano,
        'platform_absorbed_usdc_nano', v_overrun
      )
    );
  end if;

  if v_charge>0 then
    select * into v_accounts from private.ensure_billing_ledger_accounts(v_request.billing_account_id);
    v_wallet_asset := private.ensure_wallet_receivable_ledger(v_wallet.id,v_request.billing_account_id);
    v_lines := jsonb_build_array(jsonb_build_object('account_id',v_wallet_asset,'side','debit','amount_nano',v_charge));
    if v_request.call_fee_policy_id is null then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id',v_accounts.model_revenue,'side','credit','amount_nano',v_charge));
    else
      if v_model_cost>0 then
        v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id',v_accounts.model_revenue,'side','credit','amount_nano',v_model_cost));
      end if;
      if v_service_fee>0 then
        v_fee_revenue := private.ensure_call_service_fee_ledger(v_request.billing_account_id);
        v_lines := v_lines || jsonb_build_array(jsonb_build_object('account_id',v_fee_revenue,'side','credit','amount_nano',v_service_fee));
      end if;
    end if;
    perform private.post_ledger_transaction('wallet-usage:'||p_request_id,'USDC_NANO','model_request',p_request_id::text,
      'Wallet API usage and call service fee',jsonb_build_object('wallet',v_wallet.id),v_lines);
  end if;
  if v_request.call_fee_policy_id is not null then
    insert into private.call_charge_breakdowns(request_id,fee_policy_id,model_cost_usdc_nano,service_fee_usdc_nano,
      service_fee_bps,total_usdc_nano,quoted_model_cost_usdc_nano,quoted_service_fee_usdc_nano)
    values(p_request_id,v_request.call_fee_policy_id,v_model_cost,v_service_fee,v_fee_bps,v_charge,
      p_provider_cost_usd_nano,p_computed_customer_charge_usdc_nano-p_provider_cost_usd_nano);
  end if;
  perform private.post_provider_cost_ledger(p_request_id, p_provider_cost_usd_nano);

  update private.model_requests
  set status = 'completed',
      actual_charge_usdc_nano = v_charge,
      unbilled_overrun_usdc_nano = v_overrun,
      provider_cost_usd_nano = p_provider_cost_usd_nano,
      provider_request_id = p_provider_request_id,
      completed_at = now(), updated_at = now()
  where id = p_request_id;

  return query select v_charge, v_receivable, v_overrun;
end;
$$;

alter function private.assert_financial_invariants() rename to assert_wallet_before_call_fees;
create function private.assert_financial_invariants()
returns table(invariant_name text,entity_id text,expected_nano numeric,actual_nano numeric,details jsonb)
language sql security definer set search_path=pg_catalog,private as $$
  select * from private.assert_wallet_before_call_fees()
  union all
  select 'call_charge_breakdown',r.id::text,r.actual_charge_usdc_nano::numeric,b.total_usdc_nano::numeric,'{}'::jsonb
  from private.model_requests r left join private.call_charge_breakdowns b on b.request_id=r.id
  where r.call_fee_policy_id is not null and r.status='completed'
    and (b.request_id is null or b.total_usdc_nano is distinct from r.actual_charge_usdc_nano or b.fee_policy_id<>r.call_fee_policy_id)
$$;
revoke all on function private.reserve_wallet_request_with_fee(uuid,uuid,uuid,uuid,bytea,bytea,bigint,uuid),
  private.ensure_call_service_fee_ledger(uuid),private.assert_wallet_before_call_fees(),private.assert_financial_invariants()
  from public,anon,authenticated;
commit;
