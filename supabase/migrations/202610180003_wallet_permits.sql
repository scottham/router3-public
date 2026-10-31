begin;
-- Gasless allowance: the payer signs an EIP-2612 USDC permit for the pinned
-- router and the platform's settlement wallet submits it. The request stores
-- only public signature material; nothing here can move USDC by itself.
create table private.wallet_permit_requests (
  id uuid primary key default gen_random_uuid(),
  wallet_billing_account_id uuid not null references private.wallet_billing_accounts(id),
  owner_address text not null check(owner_address ~ '^0x[0-9a-f]{40}$'),
  spender_address text not null check(spender_address ~ '^0x[0-9a-f]{40}$'),
  value_atomic numeric(78,0) not null check(value_atomic>=0 and value_atomic<=1000000000000000),
  nonce numeric(78,0) not null check(nonce>=0),
  deadline bigint not null check(deadline>0),
  signature text not null check(signature ~ '^0x([0-9a-f]{2})+$' and length(signature) between 132 and 4098),
  state text not null default 'pending' check(state in('pending','submitted','confirmed','failed')),
  tx_hash text unique check(tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(state not in('submitted','confirmed') or tx_hash is not null)
);
-- A failed permit never consumed its nonce, so it may be signed again.
create unique index wallet_permit_nonce_once on private.wallet_permit_requests(owner_address,nonce) where state<>'failed';
create unique index wallet_one_open_permit on private.wallet_permit_requests(wallet_billing_account_id)
  where state in('pending','submitted');
create index wallet_permit_recent_idx on private.wallet_permit_requests(wallet_billing_account_id,created_at desc);

-- Called by the API after it verified the signature and read the current nonce.
-- The account must belong to the caller; the spender is always the pinned router.
create function private.request_wallet_permit(p_owner uuid,p_wallet uuid,p_value numeric,p_nonce numeric,
  p_deadline bigint,p_signature text)
returns uuid language plpgsql security definer set search_path=pg_catalog,private as $$
declare w private.wallet_billing_accounts%rowtype; p private.wallet_billing_policy%rowtype; v_id uuid;
begin
  select * into p from private.wallet_billing_policy where singleton;
  if not p.enabled then raise exception 'WALLET_BILLING_DISABLED'; end if;
  select * into w from private.wallet_billing_accounts where wallet_id=p_wallet and owner_app_user_id=p_owner for update;
  if not found then raise exception 'WALLET_NOT_OWNED'; end if;
  if w.state='suspended' then raise exception 'WALLET_SUSPENDED'; end if;
  if w.router_address<>p.router_address then raise exception 'WALLET_ROUTER_MISMATCH'; end if;
  if p_deadline<extract(epoch from now())::bigint+60 or p_deadline>extract(epoch from now())::bigint+86400 then
    raise exception 'WALLET_PERMIT_DEADLINE_INVALID'; end if;
  -- Each relayed permit costs the platform gas; bound it per wallet.
  if (select count(*) from private.wallet_permit_requests where wallet_billing_account_id=w.id
      and created_at>now()-interval '1 day')>=10 then raise exception 'WALLET_PERMIT_RATE_LIMITED'; end if;
  if exists(select 1 from private.wallet_permit_requests where wallet_billing_account_id=w.id and state in('pending','submitted')) then
    raise exception 'WALLET_PERMIT_PENDING'; end if;
  insert into private.wallet_permit_requests(wallet_billing_account_id,owner_address,spender_address,value_atomic,nonce,deadline,signature)
    values(w.id,w.payer_address,p.router_address,p_value,p_nonce,p_deadline,lower(p_signature)) returning id into v_id;
  return v_id;
exception when unique_violation then raise exception 'WALLET_PERMIT_NONCE_USED';
end $$;

create function private.mark_wallet_permit_submitted(p_id uuid,p_tx text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  update private.wallet_permit_requests set state='submitted',tx_hash=lower(p_tx),updated_at=now()
    where id=p_id and (state='pending' or (state='submitted' and tx_hash=lower(p_tx)));
  if not found then raise exception 'WALLET_PERMIT_STATE_INVALID'; end if;
end $$;

-- A confirmed permit changed the on-chain allowance: force the next request
-- to read a snapshot at or after that block instead of the cached one.
create function private.finish_wallet_permit(p_id uuid,p_success boolean,p_block bigint,p_error text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare r private.wallet_permit_requests%rowtype;
begin
  select * into r from private.wallet_permit_requests where id=p_id for update;
  if not found or r.state not in('pending','submitted') then raise exception 'WALLET_PERMIT_STATE_INVALID'; end if;
  if p_success and (r.state<>'submitted' or p_block is null) then raise exception 'WALLET_PERMIT_STATE_INVALID'; end if;
  update private.wallet_permit_requests set state=case when p_success then 'confirmed' else 'failed' end,
    block_number=p_block,error_code=case when p_success then null else coalesce(p_error,'WALLET_PERMIT_FAILED') end,updated_at=now()
    where id=p_id;
  if p_success then
    update private.wallet_billing_accounts set last_settled_block=greatest(last_settled_block,p_block)
      where id=r.wallet_billing_account_id;
  end if;
end $$;

revoke all on private.wallet_permit_requests from public,anon,authenticated;
revoke all on function private.request_wallet_permit(uuid,uuid,numeric,numeric,bigint,text),
  private.mark_wallet_permit_submitted(uuid,text),private.finish_wallet_permit(uuid,boolean,bigint,text)
  from public,anon,authenticated;
commit;
