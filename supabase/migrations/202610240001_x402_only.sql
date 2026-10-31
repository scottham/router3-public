begin;
-- x402 only (2026-10-24). The prepaid pool, project API keys, organizations,
-- projects, spend policies, the pool ledger and every table of the earlier
-- vault/auto-funding generations are removed. What stays: wallet sign-in and
-- sessions (the console), the model catalog and its price versions, the
-- per-call fee policy, provider balance checks, catalog sync state, and the
-- x402 channel tables. OpenRouter call keys are now minted per payer wallet
-- instead of per project.

drop table if exists
  private.account_merge_audit, private.auth_bindings,
  private.auto_funding_jobs, private.auto_funding_permissions, private.auto_funding_worker_health,
  private.balance_holds, private.billing_accounts, private.call_charge_breakdowns,
  private.chain_accounts, private.chain_events, private.chain_indexer_cursors, private.chain_unlocks,
  private.default_workspaces, private.encrypted_response_cache,
  private.funding_commitments, private.funding_lots,
  private.gas_reserve_deposits, private.gas_reserve_jobs, private.gas_reserve_policies, private.gas_reserve_wallets,
  private.ledger_accounts, private.ledger_balances, private.ledger_entries, private.ledger_transactions,
  private.model_requests,
  private.openrouter_attempts, private.openrouter_bindings, private.openrouter_catalog_state,
  private.openrouter_key_events, private.openrouter_keys, private.openrouter_project_budgets,
  private.production_funding_policy, private.project_api_keys, private.project_period_counters, private.project_spend_policies,
  private.provider_credentials, private.provider_no_charge_evidence, private.provider_project_keys, private.provider_usage_receipts,
  private.receivable_claims, private.reconciliation_incidents,
  private.settlement_batches, private.settlement_fragments, private.settlement_items,
  private.usage_charges, private.usage_events,
  private.wallet_billing_accounts, private.wallet_billing_policy, private.wallet_charge_batches, private.wallet_charge_fragments,
  private.wallet_link_challenges, private.wallet_permit_requests, private.wallet_pool_requests, private.wallet_receivables,
  public.organization_members, public.organizations, public.projects
  cascade;
drop schema if exists settlement_signing cascade;

-- Functions and enum types that served the removed tables.
do $$
declare
  keep text[] := array['resolve_or_create_base_account','cleanup_expired_base_auth_data','current_app_user_id','touch_updated_at',
    'touch_x402_updated_at','metrics_provider_balance','metrics_x402','record_provider_balance','reject_price_version_mutation'];
  f record;
begin
  for f in select p.oid::regprocedure sig, p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='private' and p.prokind='f' loop
    if not (f.name = any(keep)) then execute format('drop function if exists %s cascade', f.sig); end if;
  end loop;
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('create_organization','create_project','get_my_billing_summaries') loop
    execute format('drop function if exists %s cascade', f.sig);
  end loop;
  for f in select n.nspname||'.'||t.typname sig from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where t.typtype='e' and ((n.nspname='private' and t.typname<>'x402_request_status')
      or (n.nspname='public' and t.typname in ('member_status','organization_role','organization_status','project_status'))) loop
    execute format('drop type if exists %s cascade', f.sig);
  end loop;
end $$;

-- One OpenRouter call key per payer wallet, minted from the management key.
create table private.provider_payer_keys (
  id uuid primary key default gen_random_uuid(),
  payer text not null check(payer ~ '^0x[0-9a-f]{40}$'),
  provider text not null,
  remote_name text not null,
  remote_hash text,
  state text not null check(state in ('active','disabled','deleted')),
  encrypted_secret jsonb,
  limit_usd_nano bigint not null default 0,
  usage_usd_nano bigint not null default 0,
  last_synced_at timestamptz,
  disabled_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(payer,provider)
);
create trigger provider_payer_keys_touch before update on private.provider_payer_keys for each row execute function private.touch_x402_updated_at();

-- Provider balance reconciliation now counts channel-paid calls only.
create or replace function private.record_provider_balance(p_provider text,p_balance numeric,p_currency text default 'CNY') returns jsonb
language plpgsql security definer set search_path=pg_catalog,private,public as $$
declare cost numeric; row private.provider_balance_checks;
begin
  if p_provider not in ('deepseek','openrouter') then raise exception 'PROVIDER_BALANCE_UNSUPPORTED'; end if;
  if (p_provider='deepseek' and p_currency<>'CNY') or (p_provider='openrouter' and p_currency<>'USD') then raise exception 'PROVIDER_BALANCE_CURRENCY_MISMATCH'; end if;
  -- Providers take a few minutes to deduct a call (DeepSeek measured 2026-10-22:
  -- about 3), so calls completed in the last 5 minutes wait for the next check.
  select coalesce(sum(r.provider_cost_usd_nano*coalesce((v.bailian_quote->'fx'->>'cnyPerUsd')::numeric,1)),0)/1000000000 into cost
    from private.x402_requests r
    join public.model_catalog c on c.id=r.model_id
    join private.model_price_versions v on v.id=r.price_version_id
    where c.provider=p_provider and v.bailian_quote->>'currency'=p_currency
      and r.status='completed' and r.provider_cost_usd_nano is not null and r.completed_at<now()-interval '5 minutes';
  insert into private.provider_balance_checks(provider,balance,recorded_cost,currency) values(p_provider,p_balance,cost,p_currency) returning * into row;
  return jsonb_build_object('balance',row.balance::text,'recorded_cost',row.recorded_cost::text,'currency',row.currency,'checked_at',row.checked_at);
end $$;

-- A request whose API process died before settling: the SDK's reservation on
-- the channel expired on its own, nothing was charged, the row is closed.
create function private.recover_lost_x402_requests(p_before timestamptz) returns integer
language plpgsql security definer set search_path=pg_catalog,private as $$
declare n integer;
begin
  update private.x402_requests set status='failed',failure_code='REQUEST_LOST',completed_at=now()
    where status='running' and started_at<p_before;
  get diagnostics n=row_count;
  return n;
end $$;

-- Operational numbers for the metrics exporter, besides metrics_x402().
create function private.metrics_snapshot() returns jsonb
language sql stable security definer set search_path=pg_catalog,private,public as $$
  select jsonb_build_object(
    'failures',(select coalesce(jsonb_agg(jsonb_build_object('code',code,'n',n)),'[]'::jsonb)
      from (select failure_code code,count(*) n from private.x402_requests where failure_code is not null group by 1) s),
    'latency',(select jsonb_build_object('n',count(*),
        'p50',percentile_cont(0.5) within group (order by extract(epoch from completed_at-started_at)),
        'p95',percentile_cont(0.95) within group (order by extract(epoch from completed_at-started_at)))
      from private.x402_requests where status='completed' and protocol<>'deposit' and completed_at>now()-interval '15 minutes'),
    'service_fee_nano',(select coalesce(sum(service_fee_usdc_nano),0)::text from private.x402_requests where status='completed'),
    'users',(select count(*) from public.app_users),
    'provider_keys',(select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'state',state,'n',n,'usage_usd_nano',usage::text)),'[]'::jsonb)
      from (select provider,state,count(*) n,coalesce(sum(usage_usd_nano),0) usage from private.provider_payer_keys group by 1,2) s),
    'catalog',(select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'enabled',enabled,'total',total)),'[]'::jsonb)
      from (select provider,count(*) filter(where enabled) enabled,count(*) total from public.model_catalog group by 1) s),
    'price_versions',(select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'n',n)),'[]'::jsonb)
      from (select c.provider,count(*) n from private.model_price_versions v join public.model_catalog c on c.id=v.model_id group by 1) s),
    'catalog_runs',(select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'ok',ok,'n',n)),'[]'::jsonb)
      from (select provider,ok,count(*) n from private.catalog_sync_runs group by 1,2) s),
    'catalog_last',(select coalesce(jsonb_agg(jsonb_build_object('provider',provider,'ok',ok,'error_code',error_code,'models',models,
        'changed',changed,'excluded',excluded,'review',review,'price_source',price_source,
        'finished_at',extract(epoch from finished_at),'last_success_at',(select extract(epoch from max(finished_at))
          from private.catalog_sync_runs s where s.provider=l.provider and s.ok))),'[]'::jsonb)
      from (select distinct on (provider) * from private.catalog_sync_runs order by provider,finished_at desc) l))
$$;

revoke all on private.provider_payer_keys from public,anon,authenticated;
revoke all on function private.metrics_snapshot(),private.recover_lost_x402_requests(timestamptz),
  private.record_provider_balance(text,numeric,text) from public,anon,authenticated;
commit;
