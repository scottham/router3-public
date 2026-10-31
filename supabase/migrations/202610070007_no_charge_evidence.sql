begin;
create table private.provider_no_charge_evidence (
  request_id uuid primary key references private.model_requests(id),
  evidence_digest text not null check(evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_request_id text not null,
  evidence text not null,
  created_at timestamptz not null default now()
);
revoke all on private.provider_no_charge_evidence from public,anon,authenticated;
create function private.reconcile_wallet_not_charged(p_request uuid,p_digest text,p_provider_id text,p_evidence text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.model_requests%rowtype;
begin
  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict r from private.model_requests where id=p_request;
  if r.wallet_billing_account_id is null then raise exception 'WALLET_REQUEST_REQUIRED'; end if;
  perform 1 from private.wallet_billing_accounts where id=r.wallet_billing_account_id for update;
  perform 1 from private.billing_accounts where id=r.billing_account_id for update;
  select * into strict r from private.model_requests where id=p_request for update;
  if r.status<>'usage_pending' then raise exception 'UNCERTAIN_REQUEST_REQUIRED'; end if;
  if exists(select 1 from private.provider_usage_receipts where request_id=p_request) then raise exception 'RECORDED_USAGE_MUST_BE_FINALIZED'; end if;
  if length(p_evidence)<20 or length(p_provider_id)=0 then raise exception 'PROVIDER_EVIDENCE_REQUIRED'; end if;
  insert into private.provider_no_charge_evidence(request_id,evidence_digest,provider_request_id,evidence)
    values(p_request,p_digest,p_provider_id,p_evidence);
  perform private.release_wallet_request_hold(p_request,'failed','OPERATOR_CONFIRMED_NOT_CHARGED');
end $$;
revoke all on function private.reconcile_wallet_not_charged(uuid,text,text,text) from public,anon,authenticated;
commit;
