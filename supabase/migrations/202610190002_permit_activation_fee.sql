begin;
-- Relaying a permit costs the settlement wallet gas, and new wallets are free to
-- make. Two defences: a permit is relayed only for a wallet already holding some
-- USDC, and the first relayed permit of an account adds a one-time activation fee
-- to its bills, settled from the pool like usage. A user who sends the approve
-- (or a deposit) from their own wallet pays the network fee and no activation fee.
alter table private.wallet_billing_policy
  add column activation_fee_nano bigint not null default 50000000 check(activation_fee_nano between 0 and 1000000000),
  add column permit_min_balance_atomic numeric(78,0) not null default 1000000 check(permit_min_balance_atomic>=0);

alter table private.wallet_receivables
  add column kind text not null default 'usage' check(kind in('usage','activation')),
  alter column request_id drop not null,
  alter column charge_id drop not null,
  add constraint wallet_receivable_kind_source check((kind='usage')=(request_id is not null and charge_id is not null));
create unique index wallet_one_activation_fee on private.wallet_receivables(wallet_billing_account_id) where kind='activation';

create function private.ensure_wallet_activation_fee_ledger(p_billing uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,private as $$
declare result uuid;
begin
  insert into private.ledger_accounts(code,name,unit,account_type,normal_side,organization_id,billing_account_id)
    select 'revenue:wallet-activation-fee:'||id,'Wallet activation fee','USDC_NANO','revenue','credit',organization_id,id
    from private.billing_accounts where id=p_billing on conflict(code) do update set name=excluded.name returning id into result;
  return result;
end $$;

-- Once per account, on the first relayed permit granting an allowance. The fee is
-- booked to the user's default space, or their oldest owned space.
create function private.charge_wallet_activation_fee(p_wallet uuid,p_permit uuid)
returns void language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare p private.wallet_billing_policy%rowtype; w private.wallet_billing_accounts%rowtype; v_billing uuid; v_receivable uuid;
begin
  select * into strict p from private.wallet_billing_policy where singleton for update;
  select * into strict w from private.wallet_billing_accounts where id=p_wallet for update;
  if p.activation_fee_nano=0 or exists(select 1 from private.wallet_receivables where wallet_billing_account_id=w.id and kind='activation') then
    return;
  end if;
  select b.id into v_billing from private.default_workspaces d join private.billing_accounts b on b.organization_id=d.organization_id
    join public.organization_members m on m.organization_id=d.organization_id and m.app_user_id=d.app_user_id and m.status='active'
    where d.app_user_id=w.owner_app_user_id;
  if v_billing is null then
    select b.id into v_billing from public.organization_members m join public.organizations o on o.id=m.organization_id
      join private.billing_accounts b on b.organization_id=o.id
      where m.app_user_id=w.owner_app_user_id and m.status='active' and m.role='owner' order by o.created_at,o.id limit 1;
  end if;
  if v_billing is null then return; end if;
  insert into private.wallet_receivables(kind,wallet_billing_account_id,billing_account_id,original_nano,outstanding_nano)
    values('activation',w.id,v_billing,p.activation_fee_nano,p.activation_fee_nano) returning id into v_receivable;
  update private.wallet_billing_accounts set receivable_nano=receivable_nano+p.activation_fee_nano where id=w.id;
  update private.wallet_billing_policy set receivable_nano=receivable_nano+p.activation_fee_nano where singleton;
  perform private.post_ledger_transaction('wallet-activation:'||v_receivable,'USDC_NANO','wallet_permit_request',p_permit::text,
    'Wallet activation fee for a relayed permit','{}'::jsonb,jsonb_build_array(
      jsonb_build_object('account_id',private.ensure_wallet_receivable_ledger(w.id,v_billing),'side','debit','amount_nano',p.activation_fee_nano),
      jsonb_build_object('account_id',private.ensure_wallet_activation_fee_ledger(v_billing),'side','credit','amount_nano',p.activation_fee_nano)));
end $$;

-- As before, plus the activation fee when a relayed permit granting an allowance lands.
create or replace function private.finish_wallet_permit(p_id uuid,p_success boolean,p_block bigint,p_error text)
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
    if r.value_atomic>0 then perform private.charge_wallet_activation_fee(r.wallet_billing_account_id,r.id); end if;
  end if;
end $$;

revoke all on function private.ensure_wallet_activation_fee_ledger(uuid),private.charge_wallet_activation_fee(uuid,uuid),
  private.finish_wallet_permit(uuid,boolean,bigint,text) from public,anon,authenticated;
commit;
