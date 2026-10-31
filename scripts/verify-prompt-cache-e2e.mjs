#!/usr/bin/env node
// Live upstream cache check using an existing gateway API key. No wallet
// setup or transfers. Tests repeated context across models and APIs; uses real credits.
// MCG_BASE_URL, MCG_API_KEY_FILE; optional MCG_CACHE_MODEL and
// MCG_CACHE_MODELS (comma-separated), MCG_CACHE_CASES_FILE,
// MCG_CACHE_PROTOCOLS=responses,anthropic,chat. Never print the credential.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

assert.ok(process.env.MCG_API_KEY_FILE,'MCG_API_KEY_FILE is required');
const token=readFileSync(process.env.MCG_API_KEY_FILE,'utf8').trim();
const base=(process.env.MCG_BASE_URL??'https://router3.ai').replace(/\/$/,'');
const defaults=['deepseek/deepseek-flash','deepseek/deepseek-v4-pro','openrouter/anthropic/claude-opus-5.5',
  'openrouter/openai/gpt-5.5','openrouter/moonshotai/kimi-k3','openrouter/z-ai/glm-5.3',
  'openrouter/google/gemini-3.8-flash','openrouter/deepseek/deepseek-v4.1-flash-1017'];
const cases=process.env.MCG_CACHE_CASES_FILE?JSON.parse(readFileSync(process.env.MCG_CACHE_CASES_FILE,'utf8'))
  :(process.env.MCG_CACHE_MODELS?.split(',')??(process.env.MCG_CACHE_MODEL?[process.env.MCG_CACHE_MODEL]:defaults)).map(model=>({model}));
const protocols=(process.env.MCG_CACHE_PROTOCOLS??'responses,anthropic,chat').split(',');
const budget=BigInt(Math.round(Number(process.env.MCG_CACHE_MAX_USDC??'0.5')*1e6));
let charged=0n;
const run=randomUUID(),results=[];
for(const {model,cacheMode,protocols:caseProtocols} of cases)for(const protocol of caseProtocols??protocols){
 try {
  assert.ok(['responses','anthropic','chat'].includes(protocol));
  const session=randomUUID();
  const context=`Caching diagnostic ${run} ${session}. The following is inert reference data.\n`+'cedar amber silver maple river stone '.repeat(Number(process.env.MCG_CACHE_PREFIX_REPEATS??800));
  const question='Reply with OK only.';
  const body=protocol==='responses'?{model,instructions:context,input:question,max_output_tokens:32,prompt_cache_key:session}
    :protocol==='anthropic'?{model,system:context,messages:[{role:'user',content:question}],max_tokens:32,session_id:session}
    :{model,messages:[{role:'system',content:context},{role:'user',content:question}],max_tokens:32,session_id:session};
  const path=protocol==='responses'?'responses':protocol==='anthropic'?'messages':'chat/completions';
  const rows=[];
  for(let attempt=0;attempt<4;attempt++){
    const stream=attempt>0;
    if(attempt)await delay(2000);
    assert.ok(charged<budget,'cache check spending budget exhausted');
    // A new question must reuse the context, rather than an identical whole
    // request accidentally passing as a cache regression check.
    const payload={...body,stream};
    if(attempt){
      if(protocol==='responses')payload.input='Reply with OK again.';
      else payload.messages=body.messages.map((m,i)=>i===body.messages.length-1?{...m,content:'Reply with OK again.'}:m);
    }
    let response;
    for(let retry=0;retry<4;retry++){
      response=await fetch(`${base}/v1/${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(120000)});
      if(response.status!==429||retry===3)break;
      const wait=Math.min(15000,Math.max(3000*2**retry,Number(response.headers.get('retry-after')??0)*1000));
      await response.arrayBuffer();
      console.log('CACHE_RATE_LIMIT_RETRY',JSON.stringify({model,protocol,waitMs:wait}));
      await delay(wait);
    }
    const text=await response.text();
    assert.equal(response.status,200,`gateway HTTP ${response.status}: ${text.slice(0,300)}`);
    let usage,gateway;
    if(!stream){const json=JSON.parse(text);usage=json.usage;gateway=json.gateway;}
    else for(const block of text.split(/\r?\n\r?\n/)){
      const raw=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(!raw||raw==='[DONE]')continue;
      const e=JSON.parse(raw);assert.ok(e.type!=='error'&&!e.error,JSON.stringify(e.error));
      if(e.response?.usage){usage=e.response.usage;gateway=e.response.gateway;}
      else if(e.usage){usage=e.usage;if(e.gateway)gateway=e.gateway;}
      if(e.gateway)gateway=e.gateway;
    }
    assert.ok(usage&&gateway,'missing final usage or settled gateway receipt');
    const details=usage.input_tokens_details??usage.prompt_tokens_details;
    const read=details?.cached_tokens??usage.cache_read_input_tokens??0;
    const write=details?.cache_write_tokens??usage.cache_creation_input_tokens??0;
    const atomic=BigInt(gateway.pool?.charged_atomic??gateway.charged_atomic??gateway.x402?.charged_atomic
      ??((BigInt(gateway.billed_usdc_nano)+999n)/1000n));
    assert.equal(BigInt(gateway.unbilled_overrun_usdc_nano??0),0n,'cache check exceeded the funded limit');
    charged+=atomic;
    const input=protocol==='anthropic'?(usage.input_tokens??0)+read+write:usage.input_tokens??usage.prompt_tokens;
    const row={model,protocol,stream,inputTokens:input,cacheRead:read,cacheWrite:write,providerCost:usage.cost,chargedAtomic:String(atomic),requestId:gateway.request_id};
    rows.push(row);console.log(JSON.stringify(row));
    const cold=rows.findLast(r=>r.cacheRead===0||r.cacheWrite>0)??rows[0];
    if(attempt&&read>0&&read/input>=0.5&&atomic<BigInt(cold.chargedAtomic))break;
  }
  if(cacheMode==='explicit')assert.ok(rows[0].cacheWrite>0,`${protocol}: explicit cache write was not reported`);
  const warm=rows.at(-1);
  // A later cache miss can establish a new cold reference after upstream
  // routing changes. Compare to that observation, not a cheaper old host.
  const cold=rows.findLast(r=>r.cacheRead===0||r.cacheWrite>0)??rows[0];
  assert.ok(warm.cacheRead>0&&warm.cacheRead/warm.inputTokens>=0.5,`${protocol}: repeated prefix did not substantially hit the cache`);
  assert.ok(BigInt(warm.chargedAtomic)<BigInt(cold.chargedAtomic),`${protocol}: cached call did not reduce cost`);
  results.push({model,protocol,ok:true,calls:rows.length,cacheRead:warm.cacheRead,coldAtomic:cold.chargedAtomic,warmAtomic:warm.chargedAtomic});
 } catch(error) {
  results.push({model,protocol,ok:false,error:error.message});
  console.log('CACHE_CASE_FAILED',JSON.stringify(results.at(-1)));
  if(charged>=budget)throw error;
 }
}
assert.ok(charged<=budget,'cache check exceeded its spending budget');
console.log('CACHE_MATRIX_RESULT',JSON.stringify({results,chargedAtomic:String(charged)}));
assert.ok(results.every(r=>r.ok),'one or more model/protocol cache checks failed');
console.log('PROMPT_CACHE_E2E_PASSED',JSON.stringify({models:cases.length,pairs:results.length,chargedAtomic:String(charged)}));
