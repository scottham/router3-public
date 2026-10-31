import {loadProvidersConfig,staticEntries} from '../src/config/providers.js';
import {recordDeepseekBalance,syncDeepseekCatalog} from '../src/services/deepseek-catalog.js';
import {recordOpenRouterBalance,syncOpenRouterCatalog} from '../src/services/openrouter-catalog.js';
import {publishCatalog} from '../src/services/catalog-publish.js';

// Providers whose catalog and prices are synced from the provider itself, and
// whose account balance is recorded with each run (docs/MONITORING.md).
const SYNC={
  deepseek:{sync:(db,env,p)=>syncDeepseekCatalog(db,{...env,DEEPSEEK_API_KEY:env[p.apiKeyEnv]},{allowedModels:p.allowedModels}),
    balance:(db,env,p)=>recordDeepseekBalance(db,{...env,DEEPSEEK_API_KEY:env[p.apiKeyEnv]})},
  openrouter:{sync:(db,env,p)=>syncOpenRouterCatalog(db,{...env,OPENROUTER_MANAGEMENT_KEY:env[p.managementKeyEnv]},{allowedModels:p.allowedModels,allowedFamilies:p.allowedFamilies,zeroDataRetention:p.zeroDataRetention,probeHosts:p.probeHosts}),
    balance:(db,env,p)=>recordOpenRouterBalance(db,{...env,OPENROUTER_MANAGEMENT_KEY:env[p.managementKeyEnv]})}
};

// Each synced catalog publishes independently: one provider's outage keeps
// its previous prices (which then go stale) without blocking the others.
async function syncAll(db,env,providers) {
  const changed=[];let count=0,failure=null;
  for(const p of providers) {
    try {
      const result=await SYNC[p.type].sync(db,env,p);
      count+=result.models;changed.push(...result.changed);
      if(result.review?.length)console.error(JSON.stringify({message:'CATALOG_PRICES_NEED_REVIEW',provider:p.type,review:result.review}));
      if(result.excluded?.length)console.error(JSON.stringify({message:'CATALOG_MODELS_EXCLUDED',provider:p.type,excluded:result.excluded}));
      await recordRun(db,p.type,{ok:true,models:result.models,changed:result.changed.length,excluded:result.excluded?.length??0,
        review:result.review?.filter(r=>!r.applied).length??0,priceSource:result.priceSource??'api'});
    }catch(error){
      failure??=error;
      await recordRun(db,p.type,{ok:false,error:/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'CATALOG_SYNC_FAILED'});
    }
  }
  for(const p of providers) {
    try{await SYNC[p.type].balance(db,env,p);}
    catch(error){console.error(JSON.stringify({message:'PROVIDER_BALANCE_NOT_RECORDED',provider:p.type,
      error:/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'CHECK_FAILED'}));}
  }
  return {count,changed,failure};
}

// Watched in Grafana (docs/MONITORING.md). A database that predates the run log
// (or a role without access) must not stop the catalog itself.
async function recordRun(db,provider,{ok,error=null,models=0,changed=0,excluded=0,review=0,priceSource=null}) {
  try {
    await db.query(`insert into private.catalog_sync_runs(provider,ok,error_code,models,changed,excluded,review,price_source)
      values($1,$2,$3,$4,$5,$6,$7,$8)`,[provider,ok,ok?null:error,models,changed,excluded,review,priceSource]);
  }catch{console.error(JSON.stringify({message:'CATALOG_RUN_NOT_RECORDED',provider}));}
}

export async function publishProviderCatalog(db,env) {
  if(!env.PROVIDER_CONFIG_PATH)throw new Error('PROVIDER_CONFIG_REQUIRED');
  const configured=loadProvidersConfig(env.PROVIDER_CONFIG_PATH);
  // A provider listed without its key (an optional OpenRouter account, say)
  // is not an outage: it is left out, and its models stay disabled.
  const keyed=(p)=>{const name=p.managementKeyEnv||p.apiKeyEnv;return !name||Boolean(env[name]);};
  const unkeyed=configured.providers.filter(p=>SYNC[p.type]&&!keyed(p));
  if(unkeyed.length)console.error(JSON.stringify({message:'PROVIDERS_WITHOUT_KEY_SKIPPED',providers:unkeyed.map(p=>`${p.id} (${p.managementKeyEnv||p.apiKeyEnv})`)}));
  const synced=configured.providers.filter(p=>SYNC[p.type]&&keyed(p));
  let {count,changed,failure}=await syncAll(db,env,synced);
  const entries=[...configured.entries,...configured.providers.filter(p=>p.type==='openai-compatible').flatMap(staticEntries)];
  if(entries.length) {
    const result=await publishCatalog(db,entries,0);count+=result.models;changed.push(...result.changed);
  }
  // A removed route is disabled; its price/usage history remains immutable.
  await db.query(`update public.model_catalog set enabled=false where
    not (public_name=any($1::text[]) or provider=any($2::text[]))`,[entries.map(e=>e.publicName),synced.map(p=>p.id)]);
  if(failure)throw failure;
  return {models:count,changed};
}
