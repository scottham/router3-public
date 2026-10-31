begin;
-- One row per provider per catalog run, so price updates can be watched: when
-- each provider last synced, whether it worked, how many prices changed and how
-- many models were held back for review. Written by the catalog worker.
create table private.catalog_sync_runs (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z0-9-]{1,40}$'),
  ok boolean not null,
  error_code text check (error_code ~ '^[A-Z0-9_]{1,80}$'),
  models integer not null default 0 check (models>=0),
  changed integer not null default 0 check (changed>=0),
  excluded integer not null default 0 check (excluded>=0),
  review integer not null default 0 check (review>=0),
  price_source text check (price_source in ('api','page','file')),
  finished_at timestamptz not null default now(),
  check (ok=(error_code is null))
);
create index catalog_sync_runs_recent on private.catalog_sync_runs(provider,finished_at desc);
revoke all on private.catalog_sync_runs from public,anon,authenticated;

-- As before, plus the catalog: enabled models, price versions and sync runs per provider.
create or replace function private.metrics_snapshot() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,private,public as $$
declare result jsonb; signer jsonb := '[]'::jsonb;
begin
  -- The signer journal lives in its own schema, created after the migrations.
  if to_regclass('settlement_signing.transactions') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'max_cost_wei',cost::text)),'[]'::jsonb) from (
      select case when idempotency_key like 'wallet-permit:%' then 'permit' when idempotency_key like 'wallet-pool:%' then 'pool' else 'settlement' end kind,
        sum(max_cost_wei) cost from settlement_signing.transactions
      where created_at>=date_trunc('day',now() at time zone 'utc') at time zone 'utc' group by 1) s$q$ into signer;
  end if;
  select jsonb_build_object(
    'requests',(select coalesce(jsonb_agg(jsonb_build_object('model',model,'status',status,'n',n,'charged_nano',charged::text,'provider_cost_nano',cost::text)),'[]'::jsonb)
      from (select coalesce(c.public_name,'unknown') model,r.status::text status,count(*) n,
        coalesce(sum(r.actual_charge_usdc_nano),0) charged,coalesce(sum(r.provider_cost_usd_nano),0) cost
        from private.model_requests r left join public.model_catalog c on c.id=r.model_id group by 1,2) s),
    'failures',(select coalesce(jsonb_agg(jsonb_build_object('code',code,'n',n)),'[]'::jsonb)
      from (select failure_code code,count(*) n from private.model_requests where failure_code is not null group by 1) s),
    'latency',(select jsonb_build_object('n',count(*),
        'p50',percentile_cont(0.5) within group (order by extract(epoch from completed_at-coalesce(started_at,created_at))),
        'p95',percentile_cont(0.95) within group (order by extract(epoch from completed_at-coalesce(started_at,created_at))))
      from private.model_requests where status='completed' and completed_at>now()-interval '15 minutes'),
    'fees',(select jsonb_build_object(
      'service_nano',(select coalesce(sum(service_fee_usdc_nano),0)::text from private.call_charge_breakdowns),
      'activation_nano',(select coalesce(sum(original_nano),0)::text from private.wallet_receivables where kind='activation'))),
    'exposure',(select jsonb_build_object('enabled',enabled,'reserved_nano',reserved_nano::text,'receivable_nano',receivable_nano::text,
        'global_limit_nano',global_limit_nano::text,'wallet_limit_nano',wallet_limit_nano::text,'request_limit_nano',request_limit_nano::text)
      from private.wallet_billing_policy where singleton),
    'receivables',(select jsonb_build_object('outstanding_nano',coalesce(sum(outstanding_nano),0)::text,
        'oldest_age_seconds',coalesce(extract(epoch from now()-min(created_at)),0))
      from private.wallet_receivables where outstanding_nano>0),
    'wallets',(select coalesce(jsonb_agg(jsonb_build_object('state',state,'n',n,'pool_atomic',pool::text,'allowance_atomic',allowance::text,
        'oldest_snapshot_age_seconds',age)),'[]'::jsonb)
      from (select state,count(*) n,coalesce(sum(pool_balance_atomic),0) pool,coalesce(sum(allowance_atomic),0) allowance,
        coalesce(extract(epoch from now()-min(snapshot_at)),0) age from private.wallet_billing_accounts group by 1) s),
    'batches',(select coalesce(jsonb_agg(jsonb_build_object('state',state,'n',n,'amount_atomic',amount::text,'fee_wei',fee::text,
        'oldest_age_seconds',age)),'[]'::jsonb)
      from (select state,count(*) n,coalesce(sum(amount_atomic),0) amount,coalesce(sum(total_fee_wei),0) fee,
        coalesce(extract(epoch from now()-min(created_at)),0) age from private.wallet_charge_batches group by 1) s),
    'permits',(select coalesce(jsonb_agg(jsonb_build_object('state',state,'n',n)),'[]'::jsonb)
      from (select state,count(*) n from private.wallet_permit_requests group by 1) s),
    'pool_requests',(select coalesce(jsonb_agg(jsonb_build_object('kind',kind,'state',state,'n',n)),'[]'::jsonb)
      from (select kind,state,count(*) n from private.wallet_pool_requests group by 1,2) s),
    'incidents',(select coalesce(jsonb_agg(jsonb_build_object('severity',severity,'n',n)),'[]'::jsonb)
      from (select severity,count(*) n from private.reconciliation_incidents where status<>'resolved' group by 1) s),
    'users',(select count(*) from public.app_users),
    'active_keys',(select count(*) from private.project_api_keys where status='active' and (expires_at is null or expires_at>now())),
    'signer_today',signer,
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
      from (select distinct on (provider) * from private.catalog_sync_runs order by provider,finished_at desc) l)
  ) into result;
  return result;
end $$;
revoke all on function private.metrics_snapshot() from public,anon,authenticated;
commit;
