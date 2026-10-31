import {MockProvider} from './mock.js';
import {DirectProvider} from './direct.js';
import {AppError} from '../lib/errors.js';
import {DEEPSEEK_BASE_URL} from '../services/deepseek-catalog.js';
import {OPENROUTER_BASE_URL} from '../services/openrouter-catalog.js';
import {openRouterCache,usesStickyCache} from './prompt-cache.js';

// One provider instance per entry of providers.json (config.providers), keyed
// by its id, which is also the catalog's provider column and the public model
// name prefix. `providerKeys` resolves the paying wallet's OpenRouter key.
export function createProviderRegistry(config,{providerKeys=null,env=process.env,fetchImpl=fetch}={}) {
  const providers=new Map([['mock',new MockProvider()]]);
  for(const p of config.providers??[]) {
    if(p.type==='deepseek') {
      providers.set(p.id,new DirectProvider({name:p.id,baseUrl:DEEPSEEK_BASE_URL,apiKey:env[p.apiKeyEnv],fetchImpl,
        protocolPaths:{anthropic:'/anthropic/v1/messages',responses:'/responses'}}));
    } else if(p.type==='openrouter') {
      providers.set(p.id,new DirectProvider({name:p.id,baseUrl:OPENROUTER_BASE_URL,fetchImpl,
        keyResolver:context=>{
          if(!providerKeys)throw new AppError('PROVIDER_NOT_CONFIGURED','OpenRouter keys are not configured',503);
          return providerKeys.keyFor(context.payer);
        },
        protocolPaths:{anthropic:'/messages',responses:'/responses'},
        headers:{...(config.PUBLIC_APP_URL?{'http-referer':config.PUBLIC_APP_URL}:{}),'x-title':config.APP_NAME??'Router 3'},
        // Usage accounting puts the cost in the response; routing only among
        // the catalog's hosts keeps the cost within the quoted hold.
        requestExtras:(request,model,protocol)=>({usage:{include:true},...openRouterCache(request,model,protocol),...openRouterRouting(model?.bailian_quote?.route,usesStickyCache(model))})}));
    } else if(p.type==='openai-compatible') {
      providers.set(p.id,new DirectProvider({name:p.id,baseUrl:p.baseUrl,apiKey:env[p.apiKeyEnv],fetchImpl}));
    }
  }
  return {
    get(name) {
      const provider=providers.get(name);
      if(!provider)throw new AppError('PROVIDER_NOT_SUPPORTED',`Provider ${name} is not supported`,503);
      return provider;
    },
    has(name) {return providers.has(name);},
    names() {return [...providers.keys()];},
    async ready() {}
  };
}

function openRouterRouting(route,sticky=false) {
  // A manual order disables OpenRouter's cache-aware sticky routing. The
  // allowlist still bounds both serving hosts and the maximum quoted price.
  if(route?.only?.length)return {provider:{...(sticky?{}:{order:route.only}),only:route.only,allow_fallbacks:false}};
  return route?.provider?{provider:{order:[route.provider],allow_fallbacks:false}}:{};
}
