begin;
-- Daily provider balance check, written by the catalog worker. Each row keeps
-- the account balance and the provider cost recorded up to that moment, so the
-- drop in balance between two checks can be compared with what was recorded.
create table private.provider_balance_checks (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('deepseek')),
  balance_cny numeric(20,4) not null,
  recorded_cost_cny numeric(30,9) not null check (recorded_cost_cny>=0),
  checked_at timestamptz not null default now()
);
create index provider_balance_checks_recent on private.provider_balance_checks(provider,checked_at desc);
revoke all on private.provider_balance_checks from public,anon,authenticated;

-- DeepSeek takes a few minutes (measured 2026-10-22: about 3) to deduct a call
-- from the balance, so calls completed in the last 5 minutes are left for the
-- next check. Only CNY-priced versions count; earlier USD versions predate the
-- first check.
create function private.record_provider_balance(p_provider text,p_balance numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare cost numeric; row private.provider_balance_checks;
begin
  if p_provider is distinct from 'deepseek' then raise exception 'PROVIDER_BALANCE_UNSUPPORTED'; end if;
  select coalesce(sum(r.provider_cost_usd_nano*(v.bailian_quote->'fx'->>'cnyPerUsd')::numeric),0)/1000000000 into cost
    from private.model_requests r
    join public.model_catalog c on c.id=r.model_id
    join private.model_price_versions v on v.id=r.price_version_id
    where c.provider='deepseek' and v.bailian_quote->>'kind'='deepseek-cny-v1'
      and r.provider_cost_usd_nano is not null and r.completed_at<now()-interval '5 minutes';
  insert into private.provider_balance_checks(provider,balance_cny,recorded_cost_cny) values(p_provider,p_balance,cost) returning * into row;
  return jsonb_build_object('balance_cny',row.balance_cny::text,'recorded_cost_cny',row.recorded_cost_cny::text,'checked_at',row.checked_at);
end $$;

-- For the metrics exporter: the latest check per provider and the gap since the
-- one before (balance drop minus recorded cost; positive means the provider
-- charged more than recorded). A top-up raises the balance and leaves the gap empty.
create function private.metrics_provider_balance() returns jsonb
language sql stable security definer set search_path=pg_catalog,private as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'balance_cny',balance_cny::text,
    'checked_at',extract(epoch from checked_at),
    'gap_cny',case when prev_balance>=balance_cny then ((prev_balance-balance_cny)-(recorded_cost_cny-prev_cost))::text end)),'[]'::jsonb)
  from (select *,lag(balance_cny) over w prev_balance,lag(recorded_cost_cny) over w prev_cost,
      row_number() over (partition by provider order by checked_at desc,id desc) rn
    from private.provider_balance_checks window w as (partition by provider order by checked_at,id)) s
  where rn=1
$$;

revoke all on function private.record_provider_balance(text,numeric),private.metrics_provider_balance() from public,anon,authenticated;
commit;
