// Checks that every configured provider credential works before a deploy: a
// revoked or wrong key would otherwise fail every call once the new
// containers start. DeepSeek: the API key lists models. OpenRouter: the
// management key lists keys (it cannot call models itself).
// Runs in the catalog container: compose run --rm --no-deps catalog node ops/check-provider-keys.mjs
import {pathToFileURL} from 'node:url';
import {loadProvidersConfig} from '../src/config/providers.js';
import {DEEPSEEK_BASE_URL} from '../src/services/deepseek-catalog.js';
import {OPENROUTER_BASE_URL} from '../src/services/openrouter-catalog.js';

const CHECK={
  deepseek:p=>({url:`${DEEPSEEK_BASE_URL}/models`,keyEnv:p.apiKeyEnv}),
  openrouter:p=>({url:`${OPENROUTER_BASE_URL}/keys?offset=0`,keyEnv:p.managementKeyEnv}),
  'openai-compatible':p=>({url:`${p.baseUrl}/models`,keyEnv:p.apiKeyEnv})};

export async function checkProviderKeys(env,{fetchImpl=fetch}={}) {
  if(!env.PROVIDER_CONFIG_PATH)throw new Error('PROVIDER_CONFIG_REQUIRED');
  const {providers}=loadProvidersConfig(env.PROVIDER_CONFIG_PATH);
  const results=[];
  for(const p of providers) {
    const {url,keyEnv}=CHECK[p.type](p);
    const key=env[keyEnv];
    let status='KEY_MISSING';
    if(key) {
      try{status=String((await fetchImpl(url,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000)})).status);}
      catch{status='UNREACHABLE';}
    }
    results.push({provider:p.id,type:p.type,ok:status==='200',status});
  }
  return results;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href) {
  const results=await checkProviderKeys(process.env);
  for(const r of results)console.log(JSON.stringify(r));
  if(results.some(r=>!r.ok)){console.error('provider key check failed');process.exit(1);}
}
