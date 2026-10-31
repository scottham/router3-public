begin;
-- A wallet whose collection keeps failing was retried on every collector tick
-- (10 s), and each retry costs the signer about ten RPC calls. Consecutive
-- failures now back off exponentially, capped at an hour; a successful attempt
-- (the error is cleared) resets the count.
alter table private.wallet_billing_accounts add column collection_failures integer not null default 0 check(collection_failures>=0);

create or replace function private.record_wallet_collection_error(p_wallet uuid,p_code text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if p_code !~ '^[A-Z0-9_]{1,100}$' then raise exception 'INVALID_COLLECTION_ERROR'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  update private.wallet_billing_accounts set state=case when state='suspended' then state else 'collection_failed' end,
    last_collection_error=p_code,last_collection_attempt_at=now(),collection_failures=collection_failures+1 where id=p_wallet;
end $$;

create function private.reset_wallet_collection_failures() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.last_collection_error is null and old.last_collection_error is not null then new.collection_failures:=0; end if;
  return new;
end $$;
create trigger wallet_collection_failures_reset before update of last_collection_error on private.wallet_billing_accounts
  for each row execute function private.reset_wallet_collection_failures();

-- Seconds to wait after the last failed attempt before collecting again.
create function private.wallet_collection_backoff_seconds(p_failures integer) returns integer
language sql immutable set search_path=pg_catalog as $$
  select case when p_failures<=0 then 0 else least(3600,10*power(2,least(p_failures,12))::integer) end
$$;

-- Operator-only: takes back an activation fee booked by mistake (for example on
-- the Treasury, which the pool contract never lets pay). The ledger entry is
-- reversed and the receivable is left at zero, so the fee is not charged again.
create function private.waive_wallet_activation_fee(p_wallet uuid,p_reason text)
returns bigint language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.wallet_receivables%rowtype;
begin
  if length(coalesce(p_reason,''))<10 then raise exception 'WAIVER_REASON_REQUIRED'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  perform 1 from private.wallet_billing_accounts where id=p_wallet for update;
  select * into r from private.wallet_receivables where wallet_billing_account_id=p_wallet and kind='activation' for update;
  if r.id is null or r.outstanding_nano=0 then return 0; end if;
  if exists(select 1 from private.wallet_charge_fragments where receivable_id=r.id) then raise exception 'ACTIVATION_FEE_PARTLY_COLLECTED'; end if;
  update private.wallet_receivables set outstanding_nano=0 where id=r.id;
  update private.wallet_billing_accounts set receivable_nano=receivable_nano-r.outstanding_nano where id=p_wallet;
  update private.wallet_billing_policy set receivable_nano=receivable_nano-r.outstanding_nano where singleton;
  perform private.post_ledger_transaction('wallet-activation-waived:'||r.id,'USDC_NANO','wallet_receivable',r.id::text,
    p_reason,'{}'::jsonb,jsonb_build_array(
      jsonb_build_object('account_id',private.ensure_wallet_activation_fee_ledger(r.billing_account_id),'side','debit','amount_nano',r.outstanding_nano),
      jsonb_build_object('account_id',private.ensure_wallet_receivable_ledger(p_wallet,r.billing_account_id),'side','credit','amount_nano',r.outstanding_nano)));
  return r.outstanding_nano;
end $$;

-- Operator-only: abandons a planned batch the signer never signed.
create function private.abandon_wallet_batch(p_batch uuid,p_code text)
returns void language plpgsql security definer set search_path=pg_catalog,private,settlement_signing as $$
begin
  if p_code !~ '^[A-Z0-9_]{1,100}$' then raise exception 'INVALID_COLLECTION_ERROR'; end if;
  if exists(select 1 from settlement_signing.transactions where idempotency_key='wallet-charge:'||p_batch) then raise exception 'BATCH_ALREADY_SIGNED'; end if;
  if exists(select 1 from private.wallet_charge_fragments where batch_id=p_batch) then raise exception 'BATCH_HAS_FRAGMENTS'; end if;
  update private.wallet_charge_batches set state='failed',error_code=p_code,updated_at=now() where id=p_batch and state='planned';
  if not found then raise exception 'BATCH_NOT_PLANNED'; end if;
end $$;

revoke all on function private.reset_wallet_collection_failures(),private.wallet_collection_backoff_seconds(integer),
  private.waive_wallet_activation_fee(uuid,text),private.abandon_wallet_batch(uuid,text) from public,anon,authenticated;
commit;
