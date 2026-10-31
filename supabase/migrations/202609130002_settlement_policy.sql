begin;

-- Retain the existing planner and any installed chain replay protection.
-- Its public argument is USDC atomic (1e6 per USDC), never ledger nano (1e9).
-- Fix the default for legacy callers too, without rewriting prior migrations.
do $$
declare v_body text;
begin
  select prosrc into strict v_body from pg_proc where oid='private.plan_settlement_batch(uuid,numeric)'::regprocedure;
  if position('  v_target := least(' in v_body)=0 then raise exception 'UNEXPECTED_SETTLEMENT_PLANNER_DEFINITION'; end if;
  v_body:=replace(v_body,'  v_target := least(',E'  if p_max_usdc_atomic is null or p_max_usdc_atomic < 1 or p_max_usdc_atomic > 9223372036854775 or p_max_usdc_atomic <> trunc(p_max_usdc_atomic) then\n    raise exception ''INVALID_SETTLEMENT_MAXIMUM'';\n  end if;\n  v_target := least(');
  execute format('create or replace function private.plan_settlement_batch(p_chain_account_id uuid,p_max_usdc_atomic numeric default 1000000000)
    returns uuid language plpgsql security definer set search_path=pg_catalog,private,extensions as %L',v_body);
end $$;

create function private.plan_settlement_batch_with_policy(
  p_chain_account_id uuid,p_max_usdc_atomic numeric,p_min_usdc_atomic numeric
) returns uuid language plpgsql security definer set search_path=pg_catalog,private as $$
declare v_chain private.chain_accounts%rowtype; v_available_atomic numeric; v_min numeric;
begin
  if p_max_usdc_atomic is null or p_min_usdc_atomic is null
    or p_max_usdc_atomic < 1 or p_max_usdc_atomic > 9223372036854775
    or p_min_usdc_atomic < 1 or p_min_usdc_atomic > p_max_usdc_atomic
    or p_max_usdc_atomic <> trunc(p_max_usdc_atomic) or p_min_usdc_atomic <> trunc(p_min_usdc_atomic) then
    raise exception 'INVALID_SETTLEMENT_POLICY';
  end if;
  -- Some existing installations have not enabled restricted accounts yet.
  -- If replay protection is installed, preserve its cursor-before-account lock order.
  if to_regprocedure('private.require_chain_projection_ready(uuid)') is not null then
    perform private.require_chain_projection_ready(p_chain_account_id);
  end if;
  select * into strict v_chain from private.chain_accounts where id=p_chain_account_id for update;
  if v_chain.status not in ('active','unlock_pending') then raise exception 'CHAIN_ACCOUNT_NOT_SETTLEABLE'; end if;
  v_min:=case when v_chain.status='unlock_pending' or v_chain.pending_unlock_usdc_atomic>0 then 1 else p_min_usdc_atomic end;
  select floor(coalesce(sum(fc.amount_usdc_nano-fc.pending_usdc_nano-fc.settled_usdc_nano-fc.unbacked_usdc_nano),0)/1000)
    into v_available_atomic from private.funding_commitments fc join private.funding_lots fl on fl.id=fc.funding_lot_id
    where fl.chain_account_id=p_chain_account_id;
  if v_available_atomic < v_min then return null; end if;
  return private.plan_settlement_batch(p_chain_account_id,p_max_usdc_atomic);
end $$;

revoke all on function private.plan_settlement_batch_with_policy(uuid,numeric,numeric) from public,anon,authenticated;
do $$ begin
  if exists(select 1 from pg_roles where rolname='gateway_settler') then
    grant execute on function private.plan_settlement_batch_with_policy(uuid,numeric,numeric) to gateway_settler;
  end if;
end $$;
commit;
