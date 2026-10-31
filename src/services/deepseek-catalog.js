import {readFileSync} from 'node:fs';
import {parseDecimalToNano} from '../lib/money.js';
import {tierDisplayRates} from './tier-pricing.js';
import {loadFx} from './fx.js';
import {publishCatalog} from './catalog-publish.js';

// DeepSeek's own API. /models reports token limits and input modalities but no
// prices; those come from the official pricing page each run, checked against
// an operator-reviewed copy (providers/deepseek-prices.json). DeepSeek bills peak
// and off-peak rates by time of day. The account is charged in CNY, so prices
// come from the Chinese page and convert at the daily ECB rate; estimation,
// image ceilings and billing are in tier-pricing.js.
export const DEEPSEEK_BASE_URL='https://api.deepseek.com';
export const DEEPSEEK_PRICE_PAGE='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const PRICES_PATH=new URL('../../providers/deepseek-prices.json',import.meta.url);
const MAX=9223372036854775807n;
const numeric=value=>{const n=parseDecimalToNano(String(value));if(n<0n||n>MAX)throw new Error('INVALID_DEEPSEEK_PRICE');return n.toString();};
const limit=v=>Number.isSafeInteger(v)&&v>0;
const ceilDiv=(a,b)=>(a+b-1n)/b;
const RATES=['input','cachedInput','output'];
// A page price more than 3x away from the reviewed one is held for review.
const within=(a,b)=>{const x=parseDecimalToNano(String(a)),y=parseDecimalToNano(String(b));return x*3n>=y&&y*3n>=x;};

export function loadDeepseekPrices(path=PRICES_PATH) {
  const prices=JSON.parse(readFileSync(path,'utf8'));
  if(prices.currency!=='CNY'||!Array.isArray(prices.models)||!validSchedule(prices.timeOfUse))throw new Error('DEEPSEEK_PRICES_INVALID');
  if(new Set(prices.models.map(m=>m.model)).size!==prices.models.length)throw new Error('DEEPSEEK_PRICES_DUPLICATE');
  return prices;
}

function validSchedule(t) {
  return t&&Array.isArray(t.peakHoursUtc)&&t.peakHoursUtc.every(([a,b])=>Number.isInteger(a)&&Number.isInteger(b)&&0<=a&&a<b&&b<=24)
    &&Array.isArray(t.peakWeekdays)&&t.peakWeekdays.every(d=>Number.isInteger(d)&&d>=0&&d<=6)
    &&Number.isInteger(t.utcOffsetMinutes)&&Array.isArray(t.offPeakDates)&&t.offPeakDates.every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d));
}

export async function fetchDeepseekPricePage({fetchImpl=fetch}={}) {
  let response;
  try{response=await fetchImpl(DEEPSEEK_PRICE_PAGE,{headers:{'user-agent':'Mozilla/5.0 (router3 price sync)'},signal:AbortSignal.timeout(30000)});}
  catch{throw new Error('DEEPSEEK_PRICE_PAGE_UNAVAILABLE');}
  if(!response.ok)throw new Error(`DEEPSEEK_PRICE_PAGE_HTTP_${response.status}`);
  return response.text();
}

const cells=row=>[...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m=>m[1].replace(/<[^>]+>/g,' ').replace(/&nbsp;|​/g,' ').replace(/\s+/g,' ').trim());
const BEIJING=8;

// The "模型细节" table: a 模型 row naming the columns, then 空闲时段 and 高峰时段
// rows under cache hit, cache miss and output, in 元. Returns null for anything
// it cannot read whole, and the peak schedule only if the footnote still reads
// as it did when this parser was written.
export function parseDeepseekPricePage(html) {
  const table=/<table[\s\S]*?<\/table>/.exec(html)?.[0];
  if(!table)return null;
  const rows=[...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(m=>cells(m[0]));
  const ids=rows.find(r=>r[0]==='模型')?.slice(1).map(c=>c.replace(/\(\d+\)$/,'').trim());
  if(!ids?.length)return null;
  const models=Object.fromEntries(ids.map(id=>[id,{peak:{},offPeak:{}}]));
  let rate=null;
  for(const r of rows) {
    const label=r.find(c=>/百万tokens(输入|输出)/.test(c));
    if(label)rate=/缓存未命中/.test(label)?'input':/缓存命中/.test(label)?'cachedInput':/输出/.test(label)?'output':null;
    const band=r.findIndex(c=>c==='高峰时段'||c==='空闲时段');
    if(!rate||band<0)continue;
    const values=r.slice(band+1);
    if(values.length!==ids.length||!values.every(v=>/^\d+(\.\d+)?元$/.test(v)))return null;
    ids.forEach((id,i)=>{models[id][r[band]==='高峰时段'?'peak':'offPeak'][rate]=values[i].slice(0,-1);});
  }
  if(!Object.values(models).every(m=>RATES.every(k=>m.peak[k]!=null&&m.offPeak[k]!=null)))return null;
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const hours=/北京时间周一至周五（不含中国法定节假日） ?((?:\d{1,2}:00 - \d{1,2}:00、?)+) ?为高峰时段/.exec(text)?.[1];
  const local=hours?[...hours.matchAll(/(\d{1,2}):00 - (\d{1,2}):00/g)].map(m=>[Number(m[1])-BEIJING,Number(m[2])-BEIJING]):null;
  // Stored in UTC; a band crossing UTC midnight would need splitting.
  const peakHoursUtc=local?.every(([a,b])=>0<=a&&a<b&&b<=24)?local:null;
  return {models,peakHoursUtc};
}

// Page prices replace the reviewed ones unless they move more than 3x; the
// schedule follows the page, and an unreadable schedule bills peak rates only.
export function applyDeepseekPage(reviewed,page,now=new Date()) {
  const review=[];
  if(!page)return {prices:{...reviewed,priceSource:'file'},review:[{model:'*',reason:'PRICE_PAGE_UNREADABLE'}]};
  const models=reviewed.models.map(m=>{
    const live=page.models[m.model];
    if(!live){review.push({model:m.model,reason:'PRICE_ROW_MISSING'});return m;}
    if(!['peak','offPeak'].every(b=>RATES.every(k=>within(live[b][k],m[b][k])))){review.push({model:m.model,reason:'PRICE_JUMP_NEEDS_REVIEW'});return m;}
    return {...m,peak:live.peak,offPeak:live.offPeak};
  });
  let timeOfUse={...reviewed.timeOfUse,peakHoursUtc:page.peakHoursUtc};
  if(!page.peakHoursUtc){timeOfUse=null;review.push({model:'*',reason:'PEAK_SCHEDULE_UNREADABLE'});}
  else if(JSON.stringify(page.peakHoursUtc)!==JSON.stringify(reviewed.timeOfUse.peakHoursUtc))review.push({model:'*',reason:'PEAK_SCHEDULE_CHANGED',applied:true});
  return {prices:{...reviewed,models,timeOfUse,source:DEEPSEEK_PRICE_PAGE,reviewedAt:now.toISOString().slice(0,10),priceSource:'page'},review};
}

export async function fetchDeepseekModels(apiKey,{fetchImpl=fetch}={}) {
  if(!apiKey)throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  let response;try{response=await fetchImpl(`${DEEPSEEK_BASE_URL}/models`,
    {headers:{authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(30000)});}catch{throw new Error('DEEPSEEK_CATALOG_UNAVAILABLE');}
  if(!response.ok)throw new Error(`DEEPSEEK_CATALOG_HTTP_${response.status}`);
  const {data}=await response.json();
  if(!Array.isArray(data)||!data.length||data.length>1000||new Set(data.map(m=>m.id)).size!==data.length)throw new Error('DEEPSEEK_CATALOG_INVALID');
  return data;
}

export function buildDeepseekQuote(model,price,timeOfUse,fx) {
  if(!model.input_modalities?.includes('text')||!model.output_modalities?.includes('text'))throw new Error('DEEPSEEK_NOT_CHAT_MODEL');
  if(!limit(model.context_window)||!limit(model.max_output_tokens))throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE');
  const peak=Object.fromEntries(RATES.map(k=>[k,numeric(price.peak[k])]));
  const offPeak=Object.fromEntries(RATES.map(k=>[k,numeric(price.offPeak[k])]));
  if(RATES.some(k=>BigInt(offPeak[k])>BigInt(peak[k])))throw new Error('DEEPSEEK_OFF_PEAK_ABOVE_PEAK');
  const fxNano=numeric(fx.cnyPerUsd);if(BigInt(fxNano)<=0n)throw new Error('INVALID_FX');
  // One tariff whether or not the model thinks; max_tokens covers reasoning too
  // (a 20-token limit returns 20 completion tokens, all reasoning).
  const tiers=[{lower:0,upper:null,...peak,thinkingInput:peak.input,thinkingOutput:peak.output,thinkingCachedInput:peak.cachedInput}];
  return {kind:'deepseek-cny-v1',currency:'CNY',region:'deepseek',model:model.id,cache:{mode:'implicit'},fx:{...fx,cnyPerUsdNano:fxNano},markupBps:0,
    contextLength:model.context_window,maxInputTokens:model.context_window,maxOutputTokens:model.max_output_tokens,
    maxReasoningTokens:0,tiers,offPeak,timeOfUse:timeOfUse??null};
}

const usdNano=(rate,fx)=>ceilDiv(BigInt(rate)*1000000000n,BigInt(fx.cnyPerUsdNano)).toString();

export function makeDeepseekCatalog(models,prices,fx,now=new Date()) {
  const entries=[],excluded=[],byId=new Map(models.map(m=>[m.id,m]));
  for(const price of prices.models) {
    try {
      const model=byId.get(price.model);
      if(!model)throw new Error('DEEPSEEK_MODEL_UNAVAILABLE');
      const quote=buildDeepseekQuote(model,price,prices.timeOfUse,fx);
      entries.push({publicName:`deepseek/${model.id}`,provider:'deepseek',providerModel:model.id,
        usdPerMillion:tierDisplayRates(quote),sourceReference:prices.source,reviewedAt:prices.reviewedAt,
        bailianQuote:quote,bailianState:{syncedAt:now.toISOString(),offlineAt:null},
        capabilities:{displayName:model.name??model.id,upstream:'deepseek',textChat:true,reasoningIncludedInOutput:true,promptCache:quote.cache,
          contextLength:quote.contextLength,maxOutputTokens:quote.maxOutputTokens,tools:true,
          imageInput:model.input_modalities.includes('image'),pricingPolicy:'deepseek-time-of-use',
          // USD nano per million, like the customer rates beside it.
          offPeakRates:quote.timeOfUse?Object.fromEntries(RATES.map(k=>[k,usdNano(quote.offPeak[k],quote.fx)])):null,
          pricingCurrency:'CNY',fx:quote.fx,
          peakHoursUtc:quote.timeOfUse?.peakHoursUtc??null,offlineAt:null}});
    }catch(error){excluded.push({model:price.model,reason:error.message});}
  }
  if(!entries.length)throw new Error('DEEPSEEK_NO_BILLABLE_MODELS');
  return {entries,excluded};
}

// DEEPSEEK_PRICE_SOURCE=page (default) reads the official page each run; =file
// uses the reviewed copy only.
// The account balance (CNY) drops a few minutes after each call; comparing
// its daily drop with the cost recorded for the same period catches calls
// billed differently from our prices (or made outside the gateway).
export async function fetchDeepseekBalance(apiKey,{fetchImpl=fetch}={}) {
  if(!apiKey)throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  let response;try{response=await fetchImpl(`${DEEPSEEK_BASE_URL}/user/balance`,
    {headers:{authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(30000)});}catch{throw new Error('DEEPSEEK_BALANCE_UNAVAILABLE');}
  if(!response.ok)throw new Error(`DEEPSEEK_BALANCE_HTTP_${response.status}`);
  const balance=(await response.json())?.balance_infos?.find(b=>b.currency==='CNY')?.total_balance;
  if(typeof balance!=='string'||!/^-?\d+(\.\d{1,4})?$/.test(balance))throw new Error('DEEPSEEK_BALANCE_INVALID');
  return balance;
}

export async function recordDeepseekBalance(client,env,options={}) {
  const balance=await fetchDeepseekBalance(env.DEEPSEEK_API_KEY,options);
  const {rows:[{r}]}=await client.query('select private.record_provider_balance($1,$2) r',['deepseek',balance]);
  return r;
}

export async function syncDeepseekCatalog(client,env,options={}) {
  const reviewed=options.prices??loadDeepseekPrices(env.DEEPSEEK_PRICES_PATH??PRICES_PATH);
  const fromPage=!options.prices&&(env.DEEPSEEK_PRICE_SOURCE??'page')==='page';
  const [models,html,fx]=await Promise.all([fetchDeepseekModels(env.DEEPSEEK_API_KEY,options),fromPage?fetchDeepseekPricePage(options):null,loadFx(env,options)]);
  const {prices,review}=fromPage?applyDeepseekPage(reviewed,parseDeepseekPricePage(html),options.now):{prices:{...reviewed,priceSource:'file'},review:[]};
  const {entries,excluded}=makeDeepseekCatalog(models,prices,fx,options.now);
  const published=await publishCatalog(client,entries,0,{replaceProvider:'deepseek'});
  const known=new Set(reviewed.models.map(m=>m.model));
  return {...published,excluded,fx,priceSource:prices.priceSource,
    review:[...review,...models.filter(m=>!known.has(m.id)).map(m=>({model:m.id,reason:'NEW_MODEL_UNMAPPED'}))]};
}
