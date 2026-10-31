begin;
-- Wallet billing moves from charging wallets directly (WalletChargeRouter) to
-- per-user prepaid pools (WalletPrepaidPool). Calls are reserved only against
-- USDC already in the user's own pool, which the user can take back after a
-- delay. Unsettled usage is therefore always covered, and debits can wait for
-- the next refill instead of costing a transaction per bill.

-- The pool replaces the charge router. Switching contracts mid-settlement would
-- strand a batch or permit signed for the old one, so require a quiet ledger.
do $$ begin
  if exists(select 1 from private.wallet_charge_batches where state in('planned','submitted'))
    or exists(select 1 from private.wallet_permit_requests where state='submitted')
    or (select reserved_nano from private.wallet_billing_policy where singleton)<>0 then
    raise exception 'WALLET_SETTLEMENT_IN_FLIGHT: finish open batches, permits and calls before moving to the prepaid pool'
      using errcode='P0001';
  end if;
end $$;
-- Unsent permits name the old router as spender.
update private.wallet_permit_requests set state='failed',error_code='WALLET_ROUTER_REPLACED',updated_at=now()
  where state='pending';
-- Bootstrap pins the pool contract and moves accounts to it; unpaid usage
-- (including sub-micro dust) is then settled from the user's pool.
update private.wallet_billing_policy set enabled=false,router_address=null,runtime_code_hash=null where singleton;

-- Wallet balance/allowance stay as the source for refills; the pool columns
-- are what calls are reserved against.
alter table private.wallet_billing_accounts
  add column pool_balance_atomic numeric(78,0) not null default 0 check(pool_balance_atomic>=0),
  add column pool_withdrawal_atomic numeric(78,0) not null default 0 check(pool_withdrawal_atomic>=0),
  add column pool_withdrawable_at timestamptz,
  add column pool_refill_target_atomic numeric(78,0) not null default 0 check(pool_refill_target_atomic>=0),
  add column pool_daily_remaining_atomic numeric(78,0) not null default 0 check(pool_daily_remaining_atomic>=0),
  add check((pool_withdrawal_atomic=0)=(pool_withdrawable_at is null));

-- A new contract starts with empty pools; every account reads a fresh snapshot.
update private.wallet_billing_accounts set snapshot_at=null;
alter table private.wallet_billing_policy alter column snapshot_ttl_seconds set default 60;

-- What a new call may be reserved against: the pool minus any amount being
-- withdrawn, and never more than may still be debited today.
create function private.wallet_pool_spendable_atomic(p_balance numeric,p_withdrawal numeric,p_daily numeric)
returns numeric language sql immutable as $$
  select least(greatest(p_balance-p_withdrawal,0),p_daily)
$$;

drop function private.record_wallet_billing_snapshot(uuid,bigint,text,numeric,numeric,timestamptz);
create function private.record_wallet_pool_snapshot(p_wallet uuid,p_block bigint,p_hash text,
  p_balance numeric,p_allowance numeric,p_pool_balance numeric,p_pool_withdrawal numeric,p_withdrawable_at timestamptz,
  p_refill_target numeric,p_daily_remaining numeric,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path=pg_catalog,private as $$
declare p private.wallet_billing_policy%rowtype; w private.wallet_billing_accounts%rowtype;
begin
  select * into strict p from private.wallet_billing_policy where singleton for update;
  select * into strict w from private.wallet_billing_accounts where id=p_wallet for update;
  if p_block<0 or p_hash !~ '^0x[0-9a-f]{64}$' or p_observed_at is null or p_observed_at>clock_timestamp()
    or p_observed_at<clock_timestamp()-make_interval(secs=>p.snapshot_ttl_seconds)
    or exists(select 1 from unnest(array[p_balance,p_allowance,p_pool_balance,p_pool_withdrawal,p_refill_target,p_daily_remaining]) v
      where v is null or v<0 or v<>trunc(v))
    or (p_pool_withdrawal>0 and p_withdrawable_at is null) then
    raise exception 'INVALID_WALLET_SNAPSHOT';
  end if;
  if p_block<w.last_settled_block or p_block<coalesce(w.snapshot_block,0) or p_observed_at<coalesce(w.snapshot_at,'epoch') then return false; end if;
  update private.wallet_billing_accounts set balance_atomic=p_balance,allowance_atomic=p_allowance,
    pool_balance_atomic=p_pool_balance,pool_withdrawal_atomic=p_pool_withdrawal,
    pool_withdrawable_at=case when p_pool_withdrawal>0 then p_withdrawable_at end,
    pool_refill_target_atomic=p_refill_target,pool_daily_remaining_atomic=p_daily_remaining,
    snapshot_block=p_block,snapshot_block_hash=p_hash,snapshot_at=p_observed_at where id=w.id;
  return true;
end $$;

-- Reserve against the pool. The overdue stop is dropped: pooled funds already
-- cover unsettled usage, and a low-volume user's small bill may rightly wait
-- days for the next refill.
do $$ declare definition text;
  old_cover text := 'least(v_wallet.balance_atomic,v_wallet.allowance_atomic)*1000';
  new_cover text := 'private.wallet_pool_spendable_atomic(v_wallet.pool_balance_atomic,v_wallet.pool_withdrawal_atomic,v_wallet.pool_daily_remaining_atomic)*1000';
  old_overdue text := '  if v_wallet.receivable_nano>=1000 and exists(select 1 from private.wallet_receivables r
    where r.wallet_billing_account_id=v_wallet.id and r.outstanding_nano>0
      and r.created_at<now()-make_interval(secs=>v_risk.debt_max_age_seconds)) then
    raise exception ''WALLET_BILL_OVERDUE''; end if;';
begin
  select pg_get_functiondef('private.reserve_wallet_model_request(uuid,uuid,uuid,uuid,bytea,bytea,bigint)'::regprocedure) into definition;
  if position(old_cover in definition)=0 or position(old_overdue in definition)=0 then
    raise exception 'WALLET_POOL_PATCH_POINT_MISSING';
  end if;
  execute replace(replace(definition,old_cover,new_cover),old_overdue,'');
end $$;

-- A batch debits usage, refills the pool, or both.
alter table private.wallet_charge_batches drop constraint wallet_charge_batches_amount_atomic_check;
alter table private.wallet_charge_batches
  add constraint wallet_charge_batches_amount_atomic_check check(amount_atomic>=0),
  add column refill_atomic bigint not null default 0 check(refill_atomic>=0),
  add column refill_result text check(refill_result in('refilled','skipped')),
  add check(amount_atomic>0 or refill_atomic>0);

-- A refill-only batch has no fragments.
do $$ declare definition text;
  old_total text := 'if total is null or total<>b.amount_atomic*1000 then';
begin
  select pg_get_functiondef('private.confirm_wallet_charge_batch(uuid,text,bigint,text,boolean)'::regprocedure) into definition;
  if position(old_total in definition)=0 then raise exception 'WALLET_POOL_PATCH_POINT_MISSING'; end if;
  execute replace(definition,old_total,'total:=coalesce(total,0);
  if total<>b.amount_atomic*1000 then');
end $$;

-- Plans one settlement for a wallet. A debit is sent when a refill is due anyway,
-- when the user is withdrawing (so accepted usage settles within the delay), or
-- once enough has accumulated or waited long enough. A refill tops the pool back
-- to its target once what is left uncommitted falls below p_refill_below_bps of it.
create function private.plan_wallet_pool_batch(p_wallet uuid,p_max_atomic bigint,p_min_atomic bigint,
  p_max_wait_seconds integer,p_refill_below_bps integer)
returns uuid language plpgsql security definer set search_path=pg_catalog,private,extensions as $$
declare w private.wallet_billing_accounts%rowtype; existing uuid; pending bigint; oldest timestamptz;
  debit bigint; refill numeric; remaining bigint; piece bigint; v_batch_id uuid:=gen_random_uuid();
  claim private.wallet_receivables%rowtype; root text:='0x'||repeat('0',64); key text; exiting boolean; uncommitted numeric;
begin
  if p_max_atomic<=0 or p_min_atomic<=0 or p_min_atomic>p_max_atomic or p_max_wait_seconds not between 1 and 31536000
    or p_refill_below_bps not between 0 and 10000 then raise exception 'INVALID_WALLET_COLLECTION_POLICY'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict w from private.wallet_billing_accounts where wallet_billing_accounts.id=p_wallet for update;
  if w.state='suspended' or w.snapshot_at is null then return null; end if;
  select b.id into existing from private.wallet_charge_batches b where b.wallet_billing_account_id=w.id and b.state in('planned','submitted');
  if existing is not null then return existing; end if;
  exiting := w.pool_withdrawal_atomic>0;
  select coalesce(sum(outstanding_nano-pending_nano),0),min(created_at) into pending,oldest
    from private.wallet_receivables where wallet_billing_account_id=w.id and outstanding_nano>pending_nano;
  -- Whole atomic units only; never more than the pool holds or today's limit allows.
  debit := least(pending/1000,p_max_atomic,w.pool_balance_atomic,w.pool_daily_remaining_atomic)::bigint;
  uncommitted := w.pool_balance_atomic*1000-w.reserved_nano-w.receivable_nano;
  refill := 0;
  if not exiting and w.pool_refill_target_atomic>0
    and uncommitted*10000<w.pool_refill_target_atomic*1000*p_refill_below_bps then
    refill := least(w.pool_refill_target_atomic-(w.pool_balance_atomic-debit),w.balance_atomic,w.allowance_atomic);
  end if;
  if refill<=0 then
    refill := 0;
    if debit=0 or not (exiting or debit>=p_min_atomic or oldest<=now()-make_interval(secs=>p_max_wait_seconds)) then
      return null;
    end if;
  end if;
  key := '0x'||encode(digest('router3-wallet-charge:'||v_batch_id::text,'sha256'),'hex');
  insert into private.wallet_charge_batches(id,wallet_billing_account_id,batch_key,claim_key,usage_root,amount_atomic,refill_atomic)
    values(v_batch_id,w.id,key,key,root,debit,refill::bigint);
  if debit>0 then
    remaining:=debit*1000;
    for claim in select * from private.wallet_receivables where wallet_billing_account_id=w.id and outstanding_nano>pending_nano
      order by created_at,request_id for update loop
      exit when remaining=0;
      piece:=least(remaining,claim.outstanding_nano-claim.pending_nano);
      insert into private.wallet_charge_fragments(batch_id,receivable_id,amount_nano) values(v_batch_id,claim.id,piece);
      update private.wallet_receivables set pending_nano=pending_nano+piece where wallet_receivables.id=claim.id;
      remaining:=remaining-piece;
    end loop;
    if remaining<>0 then raise exception 'WALLET_COLLECTION_UNBACKED'; end if;
    select '0x'||encode(digest(string_agg(receivable_id::text||':'||amount_nano::text,',' order by receivable_id),'sha256'),'hex') into root
      from private.wallet_charge_fragments where batch_id=v_batch_id;
    update private.wallet_charge_batches set usage_root=root where wallet_charge_batches.id=v_batch_id;
  end if;
  return v_batch_id;
end $$;

create function private.record_wallet_refill_result(p_batch uuid,p_result text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare b private.wallet_charge_batches%rowtype;
begin
  select * into strict b from private.wallet_charge_batches where id=p_batch for update;
  if b.refill_atomic=0 or b.state<>'confirmed' or p_result not in('refilled','skipped')
    or (b.refill_result is not null and b.refill_result<>p_result) then raise exception 'INVALID_REFILL_RESULT'; end if;
  update private.wallet_charge_batches set refill_result=p_result,updated_at=now() where id=b.id;
end $$;

-- Pool actions relayed by the settlement wallet: signed user requests, the
-- permissionless completion of a matured withdrawal, and Treasury sweeps.
create table private.wallet_pool_requests (
  id uuid primary key default gen_random_uuid(),
  wallet_billing_account_id uuid references private.wallet_billing_accounts(id),
  kind text not null check(kind in('configure','request_withdrawal','cancel_withdrawal','complete_withdrawal','sweep')),
  owner_address text check(owner_address ~ '^0x[0-9a-f]{40}$'),
  amount_atomic numeric(78,0) check(amount_atomic>0 and amount_atomic<=340282366920938463463374607431768211455),
  refill_target_atomic numeric(78,0) check(refill_target_atomic>=0),
  daily_limit_atomic numeric(78,0) check(daily_limit_atomic>0),
  nonce numeric(78,0) check(nonce>=0),
  deadline bigint check(deadline>0),
  signature text check(signature ~ '^0x([0-9a-f]{2})+$' and length(signature) between 132 and 4098),
  state text not null default 'pending' check(state in('pending','submitted','confirmed','failed')),
  tx_hash text unique check(tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(state not in('submitted','confirmed') or tx_hash is not null),
  check((kind='sweep')=(wallet_billing_account_id is null)),
  check((kind in('configure','request_withdrawal','cancel_withdrawal'))
    =(signature is not null and nonce is not null and deadline is not null and owner_address is not null)),
  check(kind<>'configure' or (refill_target_atomic is not null and daily_limit_atomic is not null)),
  check(kind<>'request_withdrawal' or amount_atomic is not null),
  check(kind<>'complete_withdrawal' or owner_address is not null)
);
create unique index wallet_one_open_pool_request on private.wallet_pool_requests(wallet_billing_account_id)
  where state in('pending','submitted') and wallet_billing_account_id is not null;
create unique index wallet_one_open_sweep on private.wallet_pool_requests(kind)
  where state in('pending','submitted') and kind='sweep';
create unique index wallet_pool_nonce_once on private.wallet_pool_requests(owner_address,nonce)
  where state<>'failed' and nonce is not null;
create index wallet_pool_requests_recent_idx on private.wallet_pool_requests(wallet_billing_account_id,created_at);

create function private.request_wallet_pool_action(p_owner uuid,p_wallet uuid,p_kind text,p_amount numeric,
  p_target numeric,p_limit numeric,p_nonce numeric,p_deadline bigint,p_signature text)
returns uuid language plpgsql security definer set search_path=pg_catalog,private as $$
declare w private.wallet_billing_accounts%rowtype; p private.wallet_billing_policy%rowtype; result uuid;
begin
  select * into strict p from private.wallet_billing_policy where singleton;
  if not p.enabled then raise exception 'WALLET_BILLING_DISABLED'; end if;
  if p_kind not in('configure','request_withdrawal','cancel_withdrawal') then raise exception 'WALLET_POOL_REQUEST_INVALID'; end if;
  select a.* into w from private.wallet_billing_accounts a where a.wallet_id=p_wallet and a.owner_app_user_id=p_owner
    and a.router_address=p.router_address for update;
  if w.id is null then raise exception 'WALLET_NOT_OWNED'; end if;
  -- Even a suspended account may always configure, withdraw or cancel its own pool.
  if exists(select 1 from private.wallet_pool_requests where wallet_billing_account_id=w.id and state in('pending','submitted')) then
    raise exception 'WALLET_POOL_REQUEST_PENDING'; end if;
  if (select count(*) from private.wallet_pool_requests where wallet_billing_account_id=w.id
      and created_at>now()-interval '1 day')>=20 then raise exception 'WALLET_POOL_REQUEST_RATE_LIMITED'; end if;
  insert into private.wallet_pool_requests(wallet_billing_account_id,kind,owner_address,amount_atomic,refill_target_atomic,
    daily_limit_atomic,nonce,deadline,signature)
    values(w.id,p_kind,w.payer_address,case when p_kind='request_withdrawal' then p_amount end,
      case when p_kind='configure' then p_target end,case when p_kind='configure' then p_limit end,p_nonce,p_deadline,lower(p_signature))
    returning id into result;
  return result;
end $$;

-- Executes a matured withdrawal for the user once nothing they used is left
-- unsettled. The user can always do this themselves; this saves them the gas.
-- Maturity is judged by chain time (the latest block), as the contract does.
create function private.enqueue_wallet_pool_completion(p_wallet uuid,p_chain_time timestamptz)
returns uuid language plpgsql security definer set search_path=pg_catalog,private as $$
declare w private.wallet_billing_accounts%rowtype; result uuid;
begin
  select * into strict w from private.wallet_billing_accounts where id=p_wallet for update;
  if p_chain_time is null or w.pool_withdrawal_atomic=0 or w.pool_withdrawable_at>p_chain_time or w.reserved_nano<>0 or w.receivable_nano>=1000
    or exists(select 1 from private.wallet_charge_batches where wallet_billing_account_id=w.id and state in('planned','submitted'))
    or exists(select 1 from private.wallet_pool_requests where wallet_billing_account_id=w.id and state in('pending','submitted')) then
    return null;
  end if;
  insert into private.wallet_pool_requests(wallet_billing_account_id,kind,owner_address)
    values(w.id,'complete_withdrawal',w.payer_address) returning id into result;
  return result;
end $$;

create function private.enqueue_wallet_pool_sweep()
returns uuid language plpgsql security definer set search_path=pg_catalog,private as $$
declare result uuid;
begin
  insert into private.wallet_pool_requests(kind) values('sweep') on conflict do nothing returning id into result;
  return result;
end $$;

create function private.mark_wallet_pool_request_submitted(p_id uuid,p_tx text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.wallet_pool_requests%rowtype;
begin
  if p_tx !~ '^0x[0-9a-f]{64}$' then raise exception 'INVALID_TRANSACTION_HASH'; end if;
  select * into strict r from private.wallet_pool_requests where id=p_id for update;
  if r.state in('submitted','confirmed') and r.tx_hash=p_tx then return; end if;
  if r.state<>'pending' then raise exception 'WALLET_POOL_REQUEST_NOT_PENDING'; end if;
  update private.wallet_pool_requests set state='submitted',tx_hash=p_tx,updated_at=now() where id=r.id;
end $$;

create function private.finish_wallet_pool_request(p_id uuid,p_success boolean,p_block bigint,p_error text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.wallet_pool_requests%rowtype;
begin
  if p_error is not null and p_error !~ '^[A-Z0-9_]{1,100}$' then raise exception 'INVALID_POOL_REQUEST_ERROR'; end if;
  select * into strict r from private.wallet_pool_requests where id=p_id for update;
  if r.state in('confirmed','failed') then return; end if;
  update private.wallet_pool_requests set state=case when p_success then 'confirmed' else 'failed' end,
    block_number=p_block,error_code=case when p_success then null else coalesce(p_error,'WALLET_POOL_REQUEST_FAILED') end,
    updated_at=now() where id=r.id;
  -- The pool changed on chain; the next reservation must read it again.
  if p_success and r.wallet_billing_account_id is not null then
    update private.wallet_billing_accounts set snapshot_at=null,
      last_settled_block=greatest(last_settled_block,coalesce(p_block,0)) where id=r.wallet_billing_account_id;
  end if;
end $$;

revoke all on private.wallet_pool_requests from public,anon,authenticated;
revoke all on function private.wallet_pool_spendable_atomic(numeric,numeric,numeric),
  private.record_wallet_pool_snapshot(uuid,bigint,text,numeric,numeric,numeric,numeric,timestamptz,numeric,numeric,timestamptz),
  private.plan_wallet_pool_batch(uuid,bigint,bigint,integer,integer),private.record_wallet_refill_result(uuid,text),
  private.request_wallet_pool_action(uuid,uuid,text,numeric,numeric,numeric,numeric,bigint,text),
  private.enqueue_wallet_pool_completion(uuid,timestamptz),private.enqueue_wallet_pool_sweep(),
  private.mark_wallet_pool_request_submitted(uuid,text),private.finish_wallet_pool_request(uuid,boolean,bigint,text)
  from public,anon,authenticated;
commit;
