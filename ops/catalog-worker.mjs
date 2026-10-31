import pg from 'pg';
import {publishProviderCatalog} from './provider-catalog.mjs';
import {loadProvidersConfig} from '../src/config/providers.js';
import {OpenRouterManagement,ProviderKeyService} from '../src/services/provider-keys.js';
import {withJobLock} from '../src/lib/pg-job-lock.js';
import {sleep} from '../src/lib/sleep.js';

const env=process.env;
if(!env.DATABASE_URL_CATALOG)throw new Error('CATALOG_CONFIGURATION_REQUIRED');
const pool=new pg.Pool({connectionString:env.DATABASE_URL_CATALOG,max:1,connectionTimeoutMillis:10000,statement_timeout:60000});
pool.on('error',()=>console.error(JSON.stringify({message:'CATALOG_DATABASE_UNAVAILABLE'})));
const abort=new AbortController();
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>abort.abort());
// Daily by default; a failed run is retried within the hour, well inside the
// 36 h freshness window after which unrefreshed models stop serving.
const interval=Number(env.CATALOG_REFRESH_SECONDS??86400);
if(!Number.isSafeInteger(interval)||interval<60||interval>86400)throw new Error('INVALID_CATALOG_INTERVAL');
const retry=Math.min(interval,3600);
// Payer keys at the provider (limits, usage) are brought in line every hour,
// between catalog runs.
const keySync=Math.min(interval,Number(env.PROVIDER_KEY_SYNC_SECONDS??3600));

function providerKeys() {
  const openrouter=env.PROVIDER_CONFIG_PATH?loadProvidersConfig(env.PROVIDER_CONFIG_PATH).providers.find(p=>p.type==='openrouter'):null;
  if(!openrouter||!env[openrouter.managementKeyEnv]||!env.RESPONSE_ENCRYPTION_KEYS)return null;
  const keys=new Map(env.RESPONSE_ENCRYPTION_KEYS.split(',').map(pair=>{const [id,value]=pair.split(':');return [id.trim(),Buffer.from(value.trim(),'base64')];}));
  const config={PUBLIC_APP_URL:env.PUBLIC_APP_URL,responseEncryptionKeys:keys,activeResponseEncryptionKeyId:keys.keys().next().value};
  return new ProviderKeyService({pool,config,management:new OpenRouterManagement({managementKey:env[openrouter.managementKeyEnv]}),
    limitUsd:openrouter.payerKeyLimitUsd});
}

const keys=providerKeys();
let nextCatalog=0;
try {
  do {
    let wait=keySync;
    if(Date.now()>=nextCatalog) {
      try {
        await withJobLock(pool,'router3-catalog-worker',async client=>{
          const result=await publishProviderCatalog(client,env);
          console.log(JSON.stringify({message:'PROVIDER_CATALOG_SYNCED',models:result.models,changed:result.changed.length}));
        });
        nextCatalog=Date.now()+interval*1000;
      }catch{nextCatalog=Date.now()+retry*1000;console.error(JSON.stringify({message:'CATALOG_SYNC_FAILED',detail:'Existing prices retained; stale routes stop accepting requests.',retryInSeconds:retry}));}
    }
    if(keys) {
      try{const results=await keys.reconcileAll();console.log(JSON.stringify({message:'PROVIDER_KEYS_SYNCED',keys:results.length,errors:results.filter(r=>r?.error).length}));}
      catch(error){console.error(JSON.stringify({message:'PROVIDER_KEYS_SYNC_FAILED',error:/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'SYNC_FAILED'}));}
    }
    if(process.argv.includes('--once'))break;
    wait=Math.max(60,Math.min(wait,Math.ceil((nextCatalog-Date.now())/1000)));
    await sleep(wait*1000,abort.signal);
  }while(!abort.signal.aborted);
}finally{await pool.end();}
