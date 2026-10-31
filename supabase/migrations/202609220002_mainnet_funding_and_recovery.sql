begin;

-- Operator-owned deployment policy. The API cannot change trusted collateral.
create table private.production_funding_policy (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  chain_id bigint not null default 8453 check(chain_id=8453),
  vault_address text check(vault_address ~ '^0x[0-9a-f]{40}$'),
  check(not enabled or vault_address is not null)
);
insert into private.production_funding_policy(singleton) values(true);
revoke all on private.production_funding_policy from public,anon,authenticated;

create function private.assert_production_funding(p_billing_account_id uuid,p_model_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare p private.production_funding_policy%rowtype; b private.billing_accounts%rowtype; available numeric;
begin
  select * into strict p from private.production_funding_policy where singleton;
  if not p.enabled or exists(select 1 from public.model_catalog where id=p_model_id and provider='mock') then return; end if;
  -- Same account lock as reservation, allocation, capture and unlock. A balance
  -- check outside this transaction could admit a concurrent test-credit deposit.
  b := private.lock_billing_account(p_billing_account_id);
  if b.funding_mode <> 'chain' then raise exception 'MAINNET_FUNDING_REQUIRED'; end if;
  if exists(select 1 from private.funding_lots f join private.chain_accounts c on c.id=f.chain_account_id
    where f.billing_account_id=b.id and (f.available_usdc_nano>0 or f.committed_usdc_nano>0)
      and (c.chain_id<>p.chain_id or c.vault_address_normalized<>p.vault_address)) then
    raise exception 'MIXED_NETWORK_FUNDING_NOT_ALLOWED';
  end if;
  select coalesce(sum(f.available_usdc_nano),0) into available
    from private.funding_lots f join private.chain_accounts c on c.id=f.chain_account_id
    where f.billing_account_id=b.id and c.chain_id=p.chain_id and c.vault_address_normalized=p.vault_address;
  if available<=0 or available<>b.credit_balance_usdc_nano then raise exception 'MAINNET_FUNDING_REQUIRED'; end if;
end $$;
revoke all on function private.assert_production_funding(uuid,uuid) from public,anon,authenticated;

do $$ declare body text; needle text := '  perform private.assert_billing_funding_fresh(v_billing.id);';
begin
  select pg_get_functiondef('private.reserve_model_request(uuid,uuid,uuid,uuid,bytea,bytea,bigint)'::regprocedure) into body;
  if position(needle in body)=0 then raise exception 'RESERVATION_GUARD_INSERTION_POINT_MISSING'; end if;
  execute replace(body,needle,'  perform private.assert_production_funding(v_billing.id,p_model_id);'||E'\n'||needle);
end $$;

-- A process may die after the signer broadcast or after the indexer already
-- confirmed the batch. Replaying the same transition must not strand funds.
create or replace function private.mark_settlement_batch_awaiting_signature(p_batch_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
begin
  update private.settlement_batches set status='awaiting_signature',updated_at=now()
    where id=p_batch_id and status='planned';
  if not found and not exists(select 1 from private.settlement_batches where id=p_batch_id
    and status in('awaiting_signature','submitted','confirmed')) then raise exception 'BATCH_NOT_PLANNED'; end if;
end $$;

create or replace function private.mark_settlement_batch_submitted(p_batch_id uuid,p_tx_hash text)
returns void language plpgsql security definer set search_path=pg_catalog,private as $$
declare b private.settlement_batches%rowtype;
begin
  if p_tx_hash !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'INVALID_TRANSACTION_HASH'; end if;
  select * into strict b from private.settlement_batches where id=p_batch_id for update;
  if b.status in('submitted','confirmed') and lower(b.tx_hash)=lower(p_tx_hash) then return; end if;
  if b.status<>'awaiting_signature' then raise exception 'BATCH_NOT_AWAITING_SIGNATURE'; end if;
  update private.settlement_batches set status='submitted',tx_hash=lower(p_tx_hash),submitted_at=now(),updated_at=now() where id=b.id;
end $$;

do $$ begin
  if exists(select 1 from pg_roles where rolname='gateway_api') then
    grant select on private.production_funding_policy to gateway_api;
  end if;
  if exists(select 1 from pg_roles where rolname='gateway_settler') then
    grant select on private.funding_lots,private.funding_commitments to gateway_settler;
  end if;
end $$;
commit;
