import {configureCallFeePolicy} from './call-fee-policy.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {publishProviderCatalog} from './provider-catalog.mjs';

const env=process.env;
const db=new pg.Client({connectionString:env.DATABASE_URL_ADMIN,connectionTimeoutMillis:10000,statement_timeout:60000});
const literal=value=>"'"+value.replaceAll("'","''")+"'";
try {
  await db.connect();
  await db.query("select pg_advisory_lock(hashtextextended('router3-bootstrap',0))");
  await db.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
    end $$;
    create schema if not exists extensions;create extension if not exists pgcrypto with schema extensions;
    create schema if not exists auth;
    create table if not exists auth.users(id uuid primary key,raw_app_meta_data jsonb,raw_user_meta_data jsonb,email text);
    create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations(version text primary key,name text not null,source_hash text not null,applied_at timestamptz not null default now());`);
  for(const file of readdirSync('supabase/migrations').filter(n=>n.endsWith('.sql')).sort()) {
    const version=file.split('_')[0],source=readFileSync(`supabase/migrations/${file}`,'utf8');
    const digest=createHash('sha256').update(source).digest('hex');
    const existing=(await db.query('select source_hash from supabase_migrations.schema_migrations where version=$1',[version])).rows[0];
    if(existing){if(existing.source_hash!==digest)throw new Error(`MIGRATION_CHANGED:${version}`);continue;}
    const body=source.replace(/^\s*begin;\s*/i,'').replace(/\s*commit;\s*$/i,'');
    await db.query('begin');
    try{await db.query(body);await db.query('insert into supabase_migrations.schema_migrations(version,name,source_hash) values($1,$2,$3)',[version,file,digest]);await db.query('commit');}
    catch(error){await db.query('rollback');throw new Error(`MIGRATION_FAILED:${version}:${error.code}`);}
  }
  let grants=readFileSync('supabase/manual/create_backend_roles.sql.template','utf8').replace('grant connect on database postgres','grant connect on database router3');
  for(const role of ['api','settler','reconciler']) {
    const password=decodeURIComponent(new URL(env[`DATABASE_URL_${role.toUpperCase()}`]).password);
    if(!/^[a-f0-9]{64}$/.test(password))throw new Error('INVALID_ROLE_PASSWORD_FORMAT');
    grants=grants.replaceAll(`REPLACE_${role.toUpperCase()}_DB_PASSWORD`,password);
  }
  await db.query(grants);
  // The signer reads channel/pool state to bound signatures and journals pool
  // transactions in its own schema before broadcasting.
  const signerPassword=decodeURIComponent(new URL(env.DATABASE_URL_SIGNER).password);
  if(!/^[a-f0-9]{64}$/.test(signerPassword))throw new Error('INVALID_SIGNER_PASSWORD_FORMAT');
  await db.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='gateway_signer') then create role gateway_signer login noinherit; end if; end $$;
    alter role gateway_signer password ${literal(signerPassword)};
    grant connect on database router3 to gateway_signer;
    grant usage on schema private,settlement_signing to gateway_signer;
    grant select on private.x402_channels,private.pool_accounts,private.pool_batches,private.pool_ops to gateway_signer;
    grant select,insert,update on settlement_signing.transactions to gateway_signer;
    alter role gateway_signer set search_path=pg_catalog;`);
  const catalogPassword=decodeURIComponent(new URL(env.DATABASE_URL_CATALOG).password);
  if(!/^[a-f0-9]{64}$/.test(catalogPassword))throw new Error('INVALID_CATALOG_PASSWORD');
  await db.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='gateway_catalog') then create role gateway_catalog login noinherit; end if; end $$;
    alter role gateway_catalog password ${literal(catalogPassword)};
    grant connect on database router3 to gateway_catalog;
    grant usage on schema public,private to gateway_catalog;
    grant select,insert,update on public.model_catalog,private.bailian_catalog_state to gateway_catalog;
    grant select,insert on private.model_price_versions to gateway_catalog;
    grant insert on private.catalog_sync_runs to gateway_catalog;
    grant select,insert,update on private.catalog_model_access to gateway_catalog;
    grant execute on function private.record_provider_balance(text,numeric,text) to gateway_catalog;
    grant select,update on private.provider_payer_keys to gateway_catalog;
    -- A wallet's OpenRouter key follows its pool daily limit.
    grant select on private.pool_accounts to gateway_catalog;
    drop policy if exists gateway_catalog_models on public.model_catalog;
    create policy gateway_catalog_models on public.model_catalog for all to gateway_catalog using(true) with check(true);
    alter role gateway_catalog set search_path=pg_catalog;`);
  // Optional: the metrics exporter may call the private.metrics_* functions and nothing else.
  if(env.DATABASE_URL_METRICS) {
    const metricsPassword=decodeURIComponent(new URL(env.DATABASE_URL_METRICS).password);
    if(!/^[a-f0-9]{64}$/.test(metricsPassword))throw new Error('INVALID_METRICS_PASSWORD');
    await db.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='gateway_metrics') then create role gateway_metrics login noinherit; end if; end $$;
      alter role gateway_metrics password ${literal(metricsPassword)};
      grant connect on database router3 to gateway_metrics;
      grant usage on schema private to gateway_metrics;
      grant execute on function private.metrics_snapshot(),private.metrics_provider_balance(),private.metrics_x402() to gateway_metrics;
      alter role gateway_metrics set search_path=pg_catalog;`);
  }
  const catalog=await publishProviderCatalog(db,env);
  const callFee=await configureCallFeePolicy(db,env);
  await db.query("update public.model_catalog set enabled=false where provider='mock'");
  const count=(await db.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n;
  console.log(JSON.stringify({migrations:count,callFee,catalog:{models:catalog.models,changed:catalog.changed.length,excluded:catalog.excluded?.length,fx:catalog.fx}}));
} catch(error) {
  console.error(JSON.stringify({error:'PRODUCTION_BOOTSTRAP_FAILED',code:error.code||null,message: /^[A-Z_]+:?[A-Za-z0-9_:]*$/.test(error.message)?error.message:'Database initialization failed'}));process.exitCode=1;
} finally {await db.end();}
