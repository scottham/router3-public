begin;

-- The TABLE return field receivable_usdc_nano is also a PL/pgSQL variable.
-- Qualify billing-account columns so finalization cannot fail at runtime with
-- "column reference ... is ambiguous" after an upstream request succeeds.
create or replace function private.finalize_model_request(
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

  select * into strict v_request
  from private.model_requests where id = p_request_id for update;

  if v_request.status = 'completed' then
    return query select
      v_request.actual_charge_usdc_nano,
      0::bigint,
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

  v_charge := least(p_computed_customer_charge_usdc_nano, v_request.max_charge_usdc_nano);
  v_overrun := greatest(0, p_computed_customer_charge_usdc_nano - v_request.max_charge_usdc_nano);
  v_covered := least(v_charge, v_billing.credit_balance_usdc_nano);
  v_receivable := v_charge - v_covered;

  v_today := (v_request.created_at at time zone 'UTC')::date;
  v_month_start := date_trunc('month', v_request.created_at at time zone 'UTC')::date;

  update private.billing_accounts as billing
  set credit_balance_usdc_nano = billing.credit_balance_usdc_nano - v_covered,
      reserved_usdc_nano = billing.reserved_usdc_nano - v_hold.amount_usdc_nano,
      receivable_usdc_nano = billing.receivable_usdc_nano + v_receivable,
      status = case
        when v_receivable > 0 then 'suspended'::private.billing_status
        else billing.status
      end,
      version = billing.version + 1
  where billing.id = v_request.billing_account_id
    and billing.reserved_usdc_nano >= v_hold.amount_usdc_nano;
  if not found then
    raise exception 'BILLING_CAPTURE_UNDERFLOW' using errcode = 'P0001';
  end if;

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
    case when v_receivable > 0 then 'unbacked' else 'unsettled' end
  ) returning id into v_usage_charge_id;

  if v_covered > 0 then
    perform private.consume_funding_for_charge(
      v_usage_charge_id, v_request.billing_account_id, v_covered
    );
  end if;

  if v_receivable > 0 then
    insert into private.receivable_claims(
      billing_account_id, source_type, source_id,
      original_usdc_nano, outstanding_usdc_nano
    ) values (
      v_request.billing_account_id, 'usage_charge', v_usage_charge_id,
      v_receivable, v_receivable
    );
    update public.projects
    set status = 'suspended', pause_reason = 'unbacked_usage', updated_at = now()
    where billing_account_id = v_request.billing_account_id and status <> 'archived';
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

  perform private.post_customer_charge_ledger(
    p_request_id, v_request.billing_account_id, v_covered, v_receivable, v_charge
  );
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

commit;
