import {decimalUnits} from '../lib/money.js';
import {publishCatalog} from './catalog-publish.js';

// OpenRouter: models and prices from its model API, the serving hosts fixed
// per model (OpenRouter routes only among them, never to an unlisted one), and
// every call billed by the cost OpenRouter reports in the response
// (quote.billing='reported'). The quote's rates, the dearest host's, only size
// the hold.
export const OPENROUTER_BASE_URL='https://openrouter.ai/api/v1';
export const OPENROUTER_PRICE_SOURCE='https://openrouter.ai/models';
const MAX=9223372036854775807n;
// Per-token USD prices become nano USD per million tokens.
const rate=value=>{const n=decimalUnits(String(value),15);if(n>MAX)throw new Error('OPENROUTER_PRICE_INVALID');return n;};
const usd=n=>`${n/1000000000n}.${(n%1000000000n).toString().padStart(9,'0')}`;
// Hosts run by the model's vendor or serving its first-party weights
// (Bedrock, Vertex, Azure): preferred over resellers, and what OpenRouter's
// Zero Data Retention switches fall back to when the vendor's own API is off.
const OWN_HOSTS={deepseek:['DeepSeek'],anthropic:['Anthropic','Amazon Bedrock','Google','Google Vertex','Azure','Claude Platform on AWS'],
  openai:['OpenAI','Azure'],google:['Google','Google AI Studio','Google Vertex'],'x-ai':['xAI'],moonshotai:['Moonshot AI'],'z-ai':['Z.AI'],
  qwen:['Alibaba'],'bytedance-seed':['Seed','ByteDance','BytePlus'],minimax:['MiniMax'],mistralai:['Mistral'],cohere:['Cohere']};
// Other hosts join when priced within this factor of the reference host, so
// the hold (the dearest candidate) stays close to the usual price.
const SPREAD_BPS=15000n,MAX_HOSTS=8;

async function getJson(url,{fetchImpl=fetch,headers={}}={}) {
  let response;
  try{response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(30000)});}catch{throw new Error('OPENROUTER_CATALOG_UNAVAILABLE');}
  if(!response.ok)throw new Error(`OPENROUTER_CATALOG_HTTP_${response.status}`);
  return response.json();
}

// With the management key the list is OpenRouter's view for this account
// (/models/user): models its privacy settings (Zero Data Retention) leave no
// usable host for are absent, so the catalog never lists a model that 503s.
export async function fetchOpenRouterModels(options={}) {
  const headers=options.managementKey?{authorization:`Bearer ${options.managementKey}`}:{};
  const {data}=await getJson(`${OPENROUTER_BASE_URL}/models${options.managementKey?'/user':''}`,{...options,headers});
  if(!Array.isArray(data)||!data.length||data.length>5000||new Set(data.map(m=>m.id)).size!==data.length)throw new Error('OPENROUTER_CATALOG_INVALID');
  return data;
}

// The endpoints that keep no data (Zero Data Retention), as `model|tag`.
export async function fetchOpenRouterZdr(options={}) {
  const {data}=await getJson(`${OPENROUTER_BASE_URL}/endpoints/zdr`,options);
  if(!Array.isArray(data)||!data.length)throw new Error('OPENROUTER_ZDR_LIST_INVALID');
  return new Set(data.filter(e=>e.model_id&&e.tag).map(e=>`${e.model_id}|${e.tag}`));
}

export async function fetchOpenRouterEndpoints(id,options={}) {
  const {data}=await getJson(`${OPENROUTER_BASE_URL}/models/${id.split('/').map(encodeURIComponent).join('/')}/endpoints`,options);
  if(!Array.isArray(data?.endpoints))throw new Error('OPENROUTER_CATALOG_INVALID');
  return data.endpoints;
}

// Allowlisted ids plus every model of the allowlisted vendors (`families`),
// without the asynchronous batch and the free variants.
export function resolveAllowed(models,allowed=[],families=[]) {
  const items=[...allowed],seen=new Set(allowed.map(i=>typeof i==='string'?i:i.id));
  for(const m of models) {
    if(seen.has(m.id)||!families.includes(m.id.split('/')[0])||/:(batch|free)$/.test(m.id))continue;
    seen.add(m.id);items.push(m.id);
  }
  return items;
}

// OpenRouter routes by endpoint tag (provider/variant), e.g. google-vertex/us.
const slug=e=>e.tag??e.provider_name;
const max=(values)=>values.reduce((a,b)=>b>a?b:a);

// Cache behavior belongs to the selected endpoints, not the model name.
export function endpointCacheMode(endpoint) {
  const p=endpoint.pricing;
  if(p?.input_cache_read==null||rate(p.input_cache_read)>=rate(p.prompt))return 'none';
  if(endpoint.supports_implicit_caching===true)return 'implicit';
  if(endpoint.supports_implicit_caching===false&&p.input_cache_write!=null)return 'explicit';
  return 'unknown';
}

// The hosts a model may be served from, most preferred first: the one named in
// the allowlist entry, else the vendor's own hosts, then resellers, all priced
// within SPREAD_BPS of the cheapest own host, cheapest first. OpenRouter routes only among these and
// applies the account's privacy settings on top; the hold covers the dearest.
// With `zdr` (a set of `model|tag`), only those endpoints are candidates: an
// account that enforces Zero Data Retention gets a 404 for any other host.
export function chooseEndpoints(model,endpoints,preferred=null,zdr=null,refused=null) {
  let kept=zdr?endpoints.filter(e=>zdr.has(`${model.id}|${e.tag}`)):endpoints;
  // Hosts a probe found refusing this account (BYOK-only, policy) are dropped.
  if(refused)kept=kept.filter(e=>!refused.has(`${model.id}|${e.tag}`));
  if(zdr&&!kept.length&&endpoints.length)throw new Error('OPENROUTER_NO_ZDR_HOST');
  const live=kept.filter(e=>e.status===0&&e.pricing?.prompt!=null&&e.pricing?.completion!=null&&typeof e.provider_name==='string');
  if(preferred) {
    const match=live.filter(e=>e.provider_name===preferred);
    if(!match.length)throw new Error('OPENROUTER_HOST_UNAVAILABLE');
    return match;
  }
  // Per-request prices are not covered by token holds. Speed tiers (priority
  // or "fast" at several times the price, "flex" that may be refused under
  // load) are left out: the standard endpoints set the price.
  const tiered=e=>['priority','flex'].includes(e.service_tier)||/\/(fast|flex|priority)(\/|$)/.test(e.tag??'');
  const pool=live.filter(e=>!(e.pricing.request!=null&&rate(e.pricing.request)>0n)&&!tiered(e));
  if(!pool.length)throw new Error(!live.length?'OPENROUTER_NO_LIVE_HOST':live.every(tiered)?'OPENROUTER_ONLY_SPEED_TIERS':'OPENROUTER_PER_REQUEST_PRICE');
  const own=OWN_HOSTS[model.id.split('/')[0]]??[];
  const score=e=>rate(e.pricing.prompt)+rate(e.pricing.completion);
  const isOwn=e=>own.includes(e.provider_name);
  pool.sort((a,b)=>{
    const o=Number(isOwn(b))-Number(isOwn(a));
    if(o)return o;
    const d=score(a)-score(b);return d<0n?-1:d>0n?1:a.provider_name.localeCompare(b.provider_name);
  });
  // The cheapest of the vendor's own hosts (else of all) is the reference;
  // every candidate, own or not, is priced within SPREAD_BPS of it.
  const owned=pool.filter(isOwn);
  const reference=(owned.length?owned:pool).map(score).reduce((a,b)=>b<a?b:a);
  const near=e=>score(e)*10000n<=reference*SPREAD_BPS;
  return [...owned.filter(near),...pool.filter(e=>!isOwn(e)&&near(e))].slice(0,MAX_HOSTS);
}

export function buildOpenRouterQuote(model,endpoints) {
  if(!model.architecture?.output_modalities?.includes('text')||!model.architecture?.input_modalities?.includes('text'))throw new Error('OPENROUTER_NOT_CHAT_MODEL');
  const priced=endpoints.filter(e=>!(e.pricing.request!=null&&rate(e.pricing.request)>0n));
  if(!priced.length)throw new Error('OPENROUTER_PER_REQUEST_PRICE');
  const contexts=priced.map(e=>e.context_length??model.context_length);
  const outputs=priced.map((e,i)=>e.max_completion_tokens??model.top_provider?.max_completion_tokens??contexts[i]);
  if(![...contexts,...outputs].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('OPENROUTER_CONTEXT_UNAVAILABLE');
  const contextLength=max(contexts),maxOutputTokens=max(outputs);
  const top=key=>{const v=priced.map(e=>e.pricing[key]);return v.every(x=>x!=null)?max(v.map(rate)):null;};
  const writeBound=key=>{
    if(priced.some(e=>e.pricing[key]==null))return null;
    return max(priced.map(e=>{
      const input=rate(e.pricing.prompt),write=rate(e.pricing[key]);
      // A smaller write quote may be incremental storage rather than the
      // full input charge. Including input safely bounds either meaning.
      return write<input?input+write:write;
    }));
  };
  const input=top('prompt'),output=top('completion'),cached=top('input_cache_read'),cacheWrite=writeBound('input_cache_write'),cacheWrite1h=writeBound('input_cache_write_1h');
  const reasoning=priced.some(e=>e.pricing.internal_reasoning!=null)?max(priced.map(e=>e.pricing.internal_reasoning!=null?rate(e.pricing.internal_reasoning):0n)):0n;
  const tier={lower:0,upper:null,input:String(input),output:String(output),cachedInput:cached==null?null:String(cached),
    ...(cacheWrite==null?{}:{cacheWrite:String(cacheWrite)}),
    ...(cacheWrite1h==null?{}:{cacheWrite1h:String(cacheWrite1h)}),
    thinkingInput:String(input),thinkingOutput:String(output>reasoning?output:reasoning),thinkingCachedInput:cached==null?null:String(cached)};
  const modes=new Set(priced.map(endpointCacheMode));
  return {kind:'openrouter-usd-v1',currency:'USD',billing:'reported',region:'openrouter',model:model.id,
    cache:{mode:modes.size===1?[...modes][0]:'mixed'},
    route:{provider:priced[0].provider_name,tag:priced[0].tag??null,only:[...new Set(priced.map(slug))]},
    fx:{cnyPerUsd:'1',cnyPerUsdNano:'1000000000',policy:'usd-native',source:'identity',date:null},markupBps:0,
    contextLength,maxInputTokens:contextLength,maxOutputTokens,maxReasoningTokens:0,tiers:[tier]};
}

export function makeOpenRouterCatalog(models,endpointsById,allowed,now=new Date(),zdr=null,refused=null) {
  const entries=[],excluded=[],byId=new Map(models.map(m=>[m.id,m]));
  for(const item of allowed) {
    const id=typeof item==='string'?item:item.id,preferred=typeof item==='string'?null:item.provider??null;
    try {
      const model=byId.get(id);
      if(!model)throw new Error('OPENROUTER_MODEL_UNAVAILABLE');
      let hosts=chooseEndpoints(model,endpointsById.get(id)??[],preferred,zdr,refused);
      // Images billed per image (not per token) are refused by the hold, so
      // such hosts are dropped when per-token ones remain.
      const perImage=e=>e.pricing.image!=null&&rate(e.pricing.image)>0n;
      const tokenOnly=hosts.filter(e=>!perImage(e));
      if(tokenOnly.length)hosts=tokenOnly;
      const quote=buildOpenRouterQuote(model,hosts);
      // Listed price: the first host's, where OpenRouter sends the call unless
      // the account's privacy settings rule it out.
      const first=buildOpenRouterQuote(model,hosts.slice(0,1)).tiers[0];
      const imagePriced=hosts.some(perImage);
      entries.push({publicName:`openrouter/${id}`,provider:'openrouter',providerModel:id,
        usdPerMillion:{input:usd(BigInt(first.input)),cachedInput:usd(BigInt(first.cachedInput??first.input)),output:usd(BigInt(first.output)),reasoning:'0'},
        sourceReference:`${OPENROUTER_PRICE_SOURCE}/${id}`,reviewedAt:now.toISOString().slice(0,10),
        bailianQuote:quote,bailianState:{syncedAt:now.toISOString(),offlineAt:null},
        capabilities:{displayName:model.name??id,upstream:'openrouter',route:quote.route.provider,textChat:true,reasoningIncludedInOutput:true,hosts:quote.route.only,
          contextLength:quote.contextLength,maxOutputTokens:quote.maxOutputTokens,
          promptCache:quote.cache,tools:hosts.every(e=>(e.supported_parameters??model.supported_parameters??[]).includes('tools')),
          imageInput:(model.architecture?.input_modalities??[]).includes('image')&&!imagePriced,
          pricingPolicy:'openrouter-reported-cost',pricingCurrency:'USD',offlineAt:null}});
    }catch(error){excluded.push({model:id,reason:error.message});}
  }
  if(!entries.length)throw new Error('OPENROUTER_NO_BILLABLE_MODELS');
  return {entries,excluded};
}

export async function syncOpenRouterCatalog(client,env,options={}) {
  if(!options.allowedModels?.length&&!options.allowedFamilies?.length)throw new Error('OPENROUTER_ALLOWED_MODELS_REQUIRED');
  const models=await fetchOpenRouterModels({...options,managementKey:env.OPENROUTER_MANAGEMENT_KEY});
  const allowed=resolveAllowed(models,options.allowedModels,options.allowedFamilies);
  const endpointsById=new Map(),queue=allowed.map(i=>typeof i==='string'?i:i.id);
  await Promise.all(Array.from({length:8},async()=>{
    for(let id=queue.shift();id;id=queue.shift()) {
      try{endpointsById.set(id,await fetchOpenRouterEndpoints(id,options));}catch{endpointsById.set(id,[]);}
    }
  }));
  const zdr=options.zeroDataRetention?await fetchOpenRouterZdr(options):null;
  // Probed hosts that refuse this account are left out; dropping one may bring
  // in another, which is probed in the next round.
  const refused=new Set();
  let built=makeOpenRouterCatalog(models,endpointsById,allowed,options.now,zdr,refused);
  for(let round=0;options.probeHosts&&round<3;round++) {
    const pairs=built.entries.flatMap(e=>e.capabilities.hosts.map(tag=>`${e.providerModel}|${tag}`));
    const before=refused.size;
    for(const pair of await hostVerdicts(client,pairs,{...options,managementKey:env.OPENROUTER_MANAGEMENT_KEY}))refused.add(pair);
    if(refused.size===before)break;
    built=makeOpenRouterCatalog(models,endpointsById,allowed,options.now,zdr,refused);
  }
  const {entries,excluded}=built;
  const published=await publishCatalog(client,entries,0,{replaceProvider:'openrouter'});
  return {...published,excluded,priceSource:'api',review:[]};
}

// Sends each model/host pair one tiny request (16 output tokens) with a key
// minted for this run (capped at $1, deleted afterwards). A 400/403/404 means
// the host refuses this account (BYOK-only, privacy policy, not deployed);
// rate limits, server errors and timeouts say nothing and are tried again later.
export async function probeHosts(pairs,{managementKey,fetchImpl=fetch,concurrency=6}={}) {
  const verdicts=new Map();
  if(!pairs.length)return verdicts;
  const auth={authorization:`Bearer ${managementKey}`,'content-type':'application/json'};
  const minted=await (await fetchImpl(`${OPENROUTER_BASE_URL}/keys`,{method:'POST',headers:auth,body:JSON.stringify({name:`router3:probe:${Date.now()}`,limit:1})})).json();
  if(typeof minted?.key!=='string'||!minted.data?.hash)throw new Error('OPENROUTER_PROBE_KEY_UNAVAILABLE');
  try {
    const queue=[...pairs];
    await Promise.all(Array.from({length:concurrency},async()=>{
      for(let pair=queue.shift();pair;pair=queue.shift()) {
        const [model,host]=pair.split('|');
        try {
          const response=await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`,{method:'POST',signal:AbortSignal.timeout(90000),
            headers:{authorization:`Bearer ${minted.key}`,'content-type':'application/json'},
            body:JSON.stringify({model,messages:[{role:'user',content:'Say ok'}],max_tokens:16,provider:{only:[host],allow_fallbacks:false}})});
          await response.text().catch(()=>'');
          if(response.ok)verdicts.set(pair,true);
          else if([400,403,404].includes(response.status))verdicts.set(pair,false);
        } catch {/* timeout: no verdict */}
      }
    }));
  } finally {
    const hash=encodeURIComponent(minted.data.hash);
    await fetchImpl(`${OPENROUTER_BASE_URL}/keys/${hash}`,{method:'DELETE',headers:auth}).catch(()=>{});
  }
  return verdicts;
}

// The refused pairs among `pairs`: verdicts younger than a week are reused,
// the rest are probed and kept (provider 'openrouter-host', model 'id|host').
export async function hostVerdicts(client,pairs,options={}) {
  const maxAgeSeconds=options.hostCheckSeconds??604800;
  const {rows}=await client.query(`select model,usable from private.catalog_model_access
    where provider='openrouter-host' and model=any($1::text[]) and checked_at>now()-make_interval(secs=>$2)`,[pairs,maxAgeSeconds]);
  const known=new Map(rows.map(r=>[r.model,r.usable]));
  const stale=pairs.filter(p=>!known.has(p));
  if(stale.length) {
    const fresh=await (options.probe??probeHosts)(stale,options);
    const decided=[...fresh];
    if(decided.length)await client.query(`insert into private.catalog_model_access(provider,model,usable)
      select 'openrouter-host',m,u from unnest($1::text[],$2::boolean[]) as t(m,u)
      on conflict(provider,model) do update set usable=excluded.usable,checked_at=now()`,[decided.map(d=>d[0]),decided.map(d=>d[1])]);
    for(const [pair,usable] of decided)known.set(pair,usable);
  }
  return pairs.filter(p=>known.get(p)===false);
}

// Account credits (USD) through the management key, for the daily balance
// check against the cost recorded for OpenRouter requests.
export async function fetchOpenRouterBalance(managementKey,{fetchImpl=fetch}={}) {
  if(!managementKey)throw new Error('OPENROUTER_MANAGEMENT_KEY_REQUIRED');
  const {data}=await getJson(`${OPENROUTER_BASE_URL}/credits`,{fetchImpl,headers:{authorization:`Bearer ${managementKey}`}});
  if(typeof data?.total_credits!=='number'||typeof data?.total_usage!=='number')throw new Error('OPENROUTER_BALANCE_INVALID');
  const balance=decimalUnits(String(data.total_credits),9,'floor')-decimalUnits(String(data.total_usage),9);
  return usd(balance<0n?0n:balance).replace(/(\.\d{4})\d+$/,'$1');
}

export async function recordOpenRouterBalance(client,env,options={}) {
  const balance=await fetchOpenRouterBalance(env.OPENROUTER_MANAGEMENT_KEY,options);
  const {rows:[{r}]}=await client.query('select private.record_provider_balance($1,$2,$3) r',['openrouter',balance,'USD']);
  return r;
}
