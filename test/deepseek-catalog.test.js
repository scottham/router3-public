import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateTierActual,estimateTierMaximum,isPeak} from '../src/services/tier-pricing.js';
import {PricingService} from '../src/services/pricing-service.js';
import {applyDeepseekPage,fetchDeepseekBalance,fetchDeepseekModels,recordDeepseekBalance,loadDeepseekPrices,makeDeepseekCatalog,parseDeepseekPricePage} from '../src/services/deepseek-catalog.js';
import {DirectProvider} from '../src/providers/direct.js';

// Shape of GET https://api.deepseek.com/models on 2026-10-21.
const models=[
  {id:'deepseek-flash',name:'DeepSeek-V4.1-Flash',context_window:1048576,max_output_tokens:393216,input_modalities:['text','image'],output_modalities:['text']},
  {id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro',context_window:1048576,max_output_tokens:393216,input_modalities:['text'],output_modalities:['text']},
  {id:'deepseek-embed',context_window:8192,max_output_tokens:1,input_modalities:['text'],output_modalities:['embedding']}];
const prices=loadDeepseekPrices();
// 8 CNY per USD keeps the arithmetic readable.
const FX={cnyPerUsd:'8',date:'2026-10-21',source:'test',policy:'fixed'};
const {entries,excluded}=makeDeepseekCatalog(models,{...prices,models:[...prices.models,
  {...prices.models[0],model:'deepseek-embed'},{...prices.models[0],model:'deepseek-gone'}]},FX);
const entry=name=>entries.find(e=>e.providerModel===name);
const flash=entry('deepseek-flash').bailianQuote;
const use=(input,output=1000,cached=0,reasoning=0)=>({inputTokens:input,outputTokens:output,cachedInputTokens:cached,reasoningTokens:reasoning});

test('DeepSeek catalog: priced chat models only, images where /models says so',()=>{
  assert.deepEqual(entries.map(e=>e.publicName),['deepseek/deepseek-flash','deepseek/deepseek-v4-pro']);
  assert.equal(entry('deepseek-flash').capabilities.imageInput,true);
  assert.equal(entry('deepseek-v4-pro').capabilities.imageInput,false);
  assert.equal(entry('deepseek-flash').capabilities.pricingPolicy,'deepseek-time-of-use');
  assert.deepEqual(Object.fromEntries(excluded.map(e=>[e.model,e.reason])),{'deepseek-embed':'DEEPSEEK_NOT_CHAT_MODEL','deepseek-gone':'DEEPSEEK_MODEL_UNAVAILABLE'});
});

test('CNY tariff converts at the daily rate; without a start time it bills peak, reasoning counted as output',()=>{
  assert.deepEqual(entry('deepseek-flash').usdPerMillion,{input:'0.250000000',cachedInput:'0.005000000',output:'1.000000000',reasoning:'0'});
  assert.equal(flash.fx.cnyPerUsdNano,'8000000000');
  // (1000 * 2 + 1000 * 8) CNY per million = 0.01 CNY = 0.00125 USD
  assert.equal(calculateTierActual(use(1000),flash).providerCostUsdNano,1250000n);
  assert.equal(calculateTierActual(use(1000,1000,500),flash).providerCostUsdNano,1127500n);
  assert.equal(calculateTierActual(use(1000,1000,0,900),flash).providerCostUsdNano,1250000n);
});

test('the hold covers measured image cost; max_tokens already includes reasoning',()=>{
  const image={type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(3000000)}};
  const estimate=estimateTierMaximum({messages:[{role:'user',content:[{type:'text',text:'x'},image]}],max_tokens:100},flash,{imageInput:true});
  // Measured 2026-10-21: 1033 prompt tokens for one 4000x3000 image.
  assert.ok(calculateTierActual(use(1033,100),flash).customerChargeUsdcNano<=estimate.maxChargeUsdcNano);
  assert.ok(estimate.maxInputTokens<5000n,'base64 bytes must not count as tokens');
  assert.equal(estimate.maxOutputTokens,100n);
  assert.throws(()=>estimateTierMaximum({messages:[{role:'user',content:[image]}],max_tokens:10},entry('deepseek-v4-pro').bailianQuote,{imageInput:false}),/does not accept image/);
});

test('models API failures never publish a partial catalog',async()=>{
  await assert.rejects(fetchDeepseekModels(''),/KEY_REQUIRED/);
  await assert.rejects(fetchDeepseekModels('k',{fetchImpl:async()=>({ok:false,status:401})}),/HTTP_401/);
  await assert.rejects(fetchDeepseekModels('k',{fetchImpl:async()=>({ok:true,json:async()=>({data:[]})})}),/INVALID/);
  assert.throws(()=>makeDeepseekCatalog([],prices,FX),/NO_BILLABLE/);
});

test('DeepSeek is called directly with the bare model id and its own usage fields',async()=>{
  let sent,url;
  const instance=new DirectProvider({name:'deepseek',baseUrl:'https://api.deepseek.com',apiKey:'sk',fetchImpl:async(target,options)=>{url=target;sent=JSON.parse(options.body);
      return new Response(JSON.stringify({id:'d',usage:{prompt_tokens:31,completion_tokens:20,prompt_tokens_details:{cached_tokens:8},
        completion_tokens_details:{reasoning_tokens:20},prompt_cache_hit_tokens:8,prompt_cache_miss_tokens:23}}),{headers:{'content-type':'application/json'}});}});
  const result=await instance.invoke({messages:[{role:'user',content:'hi'}],max_tokens:20},
    {provider:'deepseek',provider_model:'deepseek-flash',public_name:'deepseek/deepseek-flash'},undefined,{requestId:'r'});
  assert.equal(url,'https://api.deepseek.com/chat/completions');
  assert.equal(sent.model,'deepseek-flash');
  assert.equal(sent.metadata,undefined);
  assert.deepEqual(result.usage,{inputTokens:31,cachedInputTokens:8,outputTokens:20,reasoningTokens:20});
  assert.equal(result.providerCostUsdNano,null);
});

test('production catalog: DeepSeek is published and every other provider is disabled',async()=>{
  const {publishProviderCatalog}=await import('../ops/provider-catalog.mjs');
  const queries=[];
  const db={query:async(sql,params)=>{queries.push([sql,params]);return {rows:/returning id/.test(sql)?[{id:`id-${queries.length}`}]:[]};}};
  const original=globalThis.fetch;
  globalThis.fetch=async url=>String(url)==='https://api.deepseek.com/models'?{ok:true,json:async()=>({data:models.slice(0,2)})}
    :String(url).startsWith('https://api-docs.deepseek.com/')?{ok:true,text:async()=>readFileSync(new URL('./fixtures/deepseek-pricing-zh.html',import.meta.url),'utf8')}:{ok:false,status:503};
  try {
    await publishProviderCatalog(db,{PROVIDER_CONFIG_PATH:'test/fixtures/providers-deepseek.json',DEEPSEEK_API_KEY:'c',CNY_PER_USD:'7.1'});
  }finally{globalThis.fetch=original;}
  const published=queries.filter(([sql])=>/insert into public.model_catalog/.test(sql)).map(([,p])=>p[0]);
  assert.deepEqual(published,['deepseek/deepseek-flash','deepseek/deepseek-v4-pro']);
  // Routes of removed providers are disabled; their history stays.
  assert.deepEqual(queries.at(-1)[1],[[],['deepseek']]);
});

// 2026-10-19 is a Monday. Peak: 01:00-04:00 and 06:00-10:00 UTC on weekdays.
const at=iso=>new Date(iso);
test('peak hours follow the published UTC schedule; weekends and listed holidays are off-peak',()=>{
  const t=flash.timeOfUse;
  for(const [iso,peak] of [['2026-10-19T00:59:59Z',false],['2026-10-19T01:00:00Z',true],['2026-10-19T03:59:59Z',true],['2026-10-19T04:00:00Z',false],
    ['2026-10-19T06:00:00Z',true],['2026-10-19T09:59:00Z',true],['2026-10-19T10:00:00Z',false],['2026-10-23T09:00:00Z',true],
    ['2026-10-24T02:00:00Z',false],['2026-10-25T07:00:00Z',false]])assert.equal(isPeak(t,at(iso)),peak,iso);
  // Holidays are Beijing dates: 2027-01-01 01:00 UTC is 09:00 that day in Beijing.
  assert.equal(isPeak({...t,offPeakDates:['2027-01-01']},at('2027-01-01T01:00:00Z')),false);
  assert.equal(isPeak({...t,offPeakDates:['2026-12-31']},at('2027-01-01T01:00:00Z')),true);
});

test('off-peak requests are billed at half; holds always use peak',()=>{
  const pricing=new PricingService();
  const price={bailian_quote:flash,capabilities:entry('deepseek-flash').capabilities};
  const cost=iso=>pricing.calculateModelActual(use(1000,1000,500),{...price,started_at:iso}).providerCostUsdNano;
  assert.equal(cost('2026-10-19T02:00:00Z'),1127500n);
  assert.equal(cost('2026-10-19T12:00:00Z'),563750n);
  assert.equal(cost(null),1127500n);
  const hold=estimateTierMaximum({messages:[{role:'user',content:'hi'}],max_tokens:1000},flash,{});
  assert.ok(hold.maxChargeUsdcNano>=calculateTierActual(use(Number(hold.maxInputTokens),1000),flash,at('2026-10-19T02:00:00Z')).customerChargeUsdcNano);
  // Shown in USD like the peak rates: 1 / 0.02 / 4 CNY at 8 per USD.
  assert.deepEqual(entry('deepseek-flash').capabilities.offPeakRates,{input:'125000000',cachedInput:'2500000',output:'500000000'});
});

const page=readFileSync(new URL('./fixtures/deepseek-pricing-zh.html',import.meta.url),'utf8');
test('official Chinese page: both bands of every rate in CNY and the Beijing peak schedule as UTC',()=>{
  const parsed=parseDeepseekPricePage(page);
  assert.deepEqual(parsed.models['deepseek-v4-pro'],{peak:{cachedInput:'0.30',input:'9.0',output:'27.0'},offPeak:{cachedInput:'0.15',input:'4.5',output:'13.5'}});
  assert.deepEqual(parsed.peakHoursUtc,[[1,4],[6,10]]);
  assert.deepEqual(applyDeepseekPage(prices,parsed).review,[]);
  assert.equal(parseDeepseekPricePage('<html>maintenance</html>'),null);
  assert.equal(parseDeepseekPricePage(page.replace('9.0元','$1.32')),null);
  assert.equal(parseDeepseekPricePage(page.replace('14:00 - 18:00','22:00 - 02:00')).peakHoursUtc,null);
});

test('page changes: a 3x jump keeps the reviewed price, an unreadable schedule bills peak only',()=>{
  const parsed=parseDeepseekPricePage(page);
  const jump=applyDeepseekPage(prices,{...parsed,models:{...parsed.models,'deepseek-flash':{...parsed.models['deepseek-flash'],peak:{input:'20',cachedInput:'0.04',output:'8'}}}});
  assert.deepEqual(jump.review,[{model:'deepseek-flash',reason:'PRICE_JUMP_NEEDS_REVIEW'}]);
  assert.equal(jump.prices.models[0].peak.input,'2');
  const moved=applyDeepseekPage(prices,{...parsed,models:{...parsed.models,'deepseek-flash':{...parsed.models['deepseek-flash'],peak:{input:'2.5',cachedInput:'0.04',output:'8'}}}});
  assert.equal(moved.prices.models[0].peak.input,'2.5');
  const noSchedule=applyDeepseekPage(prices,{...parsed,peakHoursUtc:null});
  assert.deepEqual(noSchedule.review,[{model:'*',reason:'PEAK_SCHEDULE_UNREADABLE'}]);
  const quote=makeDeepseekCatalog(models,noSchedule.prices,FX).entries[0].bailianQuote;
  assert.equal(calculateTierActual(use(1000),quote,at('2026-10-24T12:00:00Z')).providerCostUsdNano,1250000n);
  assert.deepEqual(applyDeepseekPage(prices,null).review,[{model:'*',reason:'PRICE_PAGE_UNREADABLE'}]);
});

test('DeepSeek balance: CNY total from /user/balance, recorded with the cost so far',async()=>{
  // Shape of GET https://api.deepseek.com/user/balance on 2026-10-22.
  const body={is_available:true,balance_infos:[{currency:'CNY',total_balance:'101.38',granted_balance:'0.00',topped_up_balance:'101.38'}]};
  const urls=[],queries=[];
  const fetchImpl=async(url,init)=>{urls.push([String(url),init.headers.authorization]);return {ok:true,json:async()=>body};};
  const client={query:async(sql,params)=>{queries.push([sql,params]);return {rows:[{r:{balance_cny:params[1]}}]};}};
  assert.deepEqual(await recordDeepseekBalance(client,{DEEPSEEK_API_KEY:'k'},{fetchImpl}),{balance_cny:'101.38'});
  assert.deepEqual(urls,[['https://api.deepseek.com/user/balance','Bearer k']]);
  assert.deepEqual(queries,[['select private.record_provider_balance($1,$2) r',['deepseek','101.38']]]);
  await assert.rejects(fetchDeepseekBalance('k',{fetchImpl:async()=>({ok:true,json:async()=>({balance_infos:[{currency:'USD',total_balance:'1'}]})})}),/DEEPSEEK_BALANCE_INVALID/);
  await assert.rejects(fetchDeepseekBalance('k',{fetchImpl:async()=>({ok:false,status:401})}),/DEEPSEEK_BALANCE_HTTP_401/);
});
