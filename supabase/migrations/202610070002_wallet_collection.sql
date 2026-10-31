begin;
create table private.wallet_charge_batches (
  id uuid primary key default gen_random_uuid(),
  wallet_billing_account_id uuid not null references private.wallet_billing_accounts(id),
  batch_key text not null unique check(batch_key ~ '^0x[0-9a-f]{64}$'),
  claim_key text not null unique check(claim_key ~ '^0x[0-9a-f]{64}$'),
  usage_root text not null check(usage_root ~ '^0x[0-9a-f]{64}$'),
  amount_atomic bigint not null check(amount_atomic>0),
  state text not null default 'planned' check(state in('planned','submitted','confirmed','failed')),
  tx_hash text check(tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint,
  block_hash text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(state not in('submitted','confirmed') or tx_hash is not null)
);
create unique index wallet_one_pending_batch on private.wallet_charge_batches(wallet_billing_account_id)
  where state in('planned','submitted');
create table private.wallet_charge_fragments (
  batch_id uuid not null references private.wallet_charge_batches(id),
  receivable_id uuid not null references private.wallet_receivables(id),
  amount_nano bigint not null check(amount_nano>0),
  primary key(batch_id,receivable_id)
);

create function private.plan_wallet_charge_batch(p_wallet uuid,p_max_atomic bigint,p_min_atomic bigint,p_max_wait_seconds integer)
returns uuid language plpgsql security definer set search_path=pg_catalog,private,extensions as $$
declare w private.wallet_billing_accounts%rowtype; existing uuid; pending bigint; oldest timestamptz;
  atomic bigint; remaining bigint; piece bigint; v_batch_id uuid:=gen_random_uuid(); claim private.wallet_receivables%rowtype;
  root text; key text;
begin
  if p_max_atomic<=0 or p_min_atomic<=0 or p_min_atomic>p_max_atomic or p_max_wait_seconds not between 1 and 86400 then
    raise exception 'INVALID_WALLET_COLLECTION_POLICY'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict w from private.wallet_billing_accounts where wallet_billing_accounts.id=p_wallet for update;
  if w.state='suspended' then return null; end if;
  select b.id into existing from private.wallet_charge_batches b where b.wallet_billing_account_id=w.id and b.state in('planned','submitted');
  if existing is not null then return existing; end if;
  select coalesce(sum(outstanding_nano-pending_nano),0),min(created_at) into pending,oldest
    from private.wallet_receivables where wallet_billing_account_id=w.id and outstanding_nano>pending_nano;
  atomic := least(pending/1000,p_max_atomic);
  if atomic=0 or (atomic<p_min_atomic and oldest>now()-make_interval(secs=>p_max_wait_seconds)) then return null; end if;
  -- Integer division collects only whole USDC atomic units; dust remains owed.
  remaining:=atomic*1000;
  key := '0x'||encode(digest('router3-wallet-charge:'||v_batch_id::text,'sha256'),'hex');
  insert into private.wallet_charge_batches(id,wallet_billing_account_id,batch_key,claim_key,usage_root,amount_atomic)
    values(v_batch_id,w.id,key,key,'0x'||repeat('0',64),atomic);
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
  return v_batch_id;
end $$;

create function private.mark_wallet_charge_submitted(p_batch uuid,p_tx text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare b private.wallet_charge_batches%rowtype;
begin
  if p_tx !~ '^0x[0-9a-f]{64}$' then raise exception 'INVALID_TRANSACTION_HASH'; end if;
  select * into strict b from private.wallet_charge_batches where id=p_batch for update;
  if b.state in('submitted','confirmed') and b.tx_hash=p_tx then return; end if;
  if b.state<>'planned' then raise exception 'WALLET_BATCH_NOT_PLANNED'; end if;
  update private.wallet_charge_batches set state='submitted',tx_hash=p_tx,updated_at=now() where id=b.id;
end $$;

create function private.record_wallet_collection_error(p_wallet uuid,p_code text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  if p_code !~ '^[A-Z0-9_]{1,100}$' then raise exception 'INVALID_COLLECTION_ERROR'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  update private.wallet_billing_accounts set state=case when state='suspended' then state else 'collection_failed' end,
    last_collection_error=p_code,last_collection_attempt_at=now() where id=p_wallet;
end $$;

create function private.confirm_wallet_charge_batch(p_batch uuid,p_tx text,p_block bigint,p_hash text,p_succeeded boolean)
returns boolean language plpgsql security definer set search_path=pg_catalog,private as $$
declare b private.wallet_charge_batches%rowtype; w private.wallet_billing_accounts%rowtype; f record;
  asset uuid; treasury uuid; total bigint;
begin
  if p_tx !~ '^0x[0-9a-f]{64}$' or p_hash !~ '^0x[0-9a-f]{64}$' or p_block<0 or p_succeeded is null then
    raise exception 'INVALID_WALLET_RECEIPT'; end if;
  perform 1 from private.wallet_billing_policy where singleton for update;
  select * into strict b from private.wallet_charge_batches where id=p_batch;
  select * into strict w from private.wallet_billing_accounts where id=b.wallet_billing_account_id for update;
  select * into strict b from private.wallet_charge_batches where id=p_batch for update;
  if b.state in('confirmed','failed') then
    if b.tx_hash<>p_tx or b.block_number<>p_block or b.block_hash<>p_hash or (b.state='confirmed')<>p_succeeded then
      raise exception 'WALLET_RECEIPT_CONFLICT'; end if;
    return false;
  end if;
  if b.state<>'submitted' or b.tx_hash<>p_tx then raise exception 'WALLET_BATCH_NOT_SUBMITTED'; end if;
  select sum(amount_nano) into total from private.wallet_charge_fragments where batch_id=b.id;
  if total is null or total<>b.amount_atomic*1000 then raise exception 'WALLET_BATCH_AMOUNT_MISMATCH'; end if;
  if p_succeeded then
    select id into strict treasury from private.ledger_accounts where code='asset:treasury-usdc';
    for f in select r.*,s.amount_nano from private.wallet_charge_fragments s
      join private.wallet_receivables r on r.id=s.receivable_id where s.batch_id=b.id order by r.billing_account_id,r.id for update of r loop
      asset:=private.ensure_wallet_receivable_ledger(w.id,f.billing_account_id);
      perform private.post_ledger_transaction('wallet-collected:'||b.id||':'||f.id,'USDC_NANO','wallet_charge_batch',b.id::text,
        'Wallet USDC received by Treasury',jsonb_build_object('tx_hash',p_tx,'block_number',p_block),jsonb_build_array(
          jsonb_build_object('account_id',treasury,'side','debit','amount_nano',f.amount_nano),
          jsonb_build_object('account_id',asset,'side','credit','amount_nano',f.amount_nano)));
      update private.wallet_receivables set outstanding_nano=outstanding_nano-f.amount_nano,pending_nano=pending_nano-f.amount_nano where id=f.id;
      update private.usage_charges set settlement_status=case when f.outstanding_nano=f.amount_nano then 'settled' else 'partially_settled' end where id=f.charge_id;
    end loop;
    update private.wallet_billing_accounts set receivable_nano=receivable_nano-total,snapshot_at=null,
      last_settled_block=greatest(last_settled_block,p_block),last_collection_error=null,last_collection_attempt_at=now(),
      state=case when state='collection_failed' then 'active' else state end where id=w.id;
    update private.wallet_billing_policy set receivable_nano=receivable_nano-total where singleton;
  else
    update private.wallet_receivables r set pending_nano=r.pending_nano-s.amount_nano
      from private.wallet_charge_fragments s where s.batch_id=b.id and s.receivable_id=r.id;
    perform private.record_wallet_collection_error(w.id,'WALLET_TRANSACTION_REVERTED');
  end if;
  update private.wallet_charge_batches set state=case when p_succeeded then 'confirmed' else 'failed' end,
    block_number=p_block,block_hash=p_hash,updated_at=now() where id=b.id;
  return true;
end $$;

revoke all on private.wallet_charge_batches,private.wallet_charge_fragments from public,anon,authenticated;
revoke all on function private.plan_wallet_charge_batch(uuid,bigint,bigint,integer),
  private.mark_wallet_charge_submitted(uuid,text),private.record_wallet_collection_error(uuid,text),
  private.confirm_wallet_charge_batch(uuid,text,bigint,text,boolean) from public,anon,authenticated;
commit;
