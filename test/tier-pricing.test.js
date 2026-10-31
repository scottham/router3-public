import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateTierActual,estimateTierMaximum} from '../src/services/tier-pricing.js';
import {parseEcbFx} from '../src/services/fx.js';

// A two-tier CNY quote (rates in CNY nano per million tokens, 8 CNY per USD):
// 0.8/2 below 128k input tokens, 2.4/6 above; thinking output 8/24; cache
// reads at a fifth of the input rate; 5% markup.
const tier=(input,output,thinkingOutput,range)=>({...range,input:String(input*1e9),output:String(output*1e9),cachedInput:String(input*2e8),
  thinkingInput:String(input*1e9),thinkingOutput:String(thinkingOutput*1e9),thinkingCachedInput:String(input*2e8)});
const quote={kind:'deepseek-cny-v1',currency:'CNY',fx:{cnyPerUsd:'8',cnyPerUsdNano:'8000000000'},markupBps:500,
  contextLength:1000000,maxInputTokens:1000000,maxOutputTokens:32768,maxReasoningTokens:81920,
  tiers:[tier(0.8,2,8,{lower:0,upper:128000}),tier(2.4,6,24,{lower:128000,upper:1000000})]};
const use=(input,output=1000,cached=0,reasoning=0)=>({inputTokens:input,outputTokens:output,cachedInputTokens:cached,reasoningTokens:reasoning});

test('decimal tier boundary applies to all tokens; reasoning selects the thinking tariff',()=>{
  assert.equal(calculateTierActual(use(128000),quote).providerCostUsdNano,13050000n);
  assert.equal(calculateTierActual(use(128001),quote).providerCostUsdNano,39150300n);
  assert.equal(calculateTierActual(use(128000,1000,0,500),quote).providerCostUsdNano,13800000n);
  assert.equal(calculateTierActual(use(1000,1000,1000),quote).providerCostUsdNano,270000n);
  assert.equal(calculateTierActual(use(1000,1000,1000),quote).customerChargeUsdcNano,283500n);
  assert.throws(()=>calculateTierActual(use(10,1,11),quote),/cached tokens/);
  assert.throws(()=>calculateTierActual(use(10,1,0,2),quote),/reasoning tokens/);
});

test('max_tokens includes separate worst-case reasoning reserve without changing default request',()=>{
  const request={messages:[{role:'user',content:'你好'}],max_tokens:10};
  assert.equal(estimateTierMaximum(request,quote).maxOutputTokens,81930n);
  assert.equal(estimateTierMaximum({...request,max_tokens:undefined,max_completion_tokens:10},quote).maxOutputTokens,10n);
  assert.equal(estimateTierMaximum({...request,max_tokens:undefined},quote).maxOutputTokens,114688n);
  assert.equal(request.enable_thinking,undefined);
  assert.throws(()=>estimateTierMaximum({...request,enable_search:true},quote),/unpriced option/);
  assert.throws(()=>estimateTierMaximum({...request,messages:[{role:'user',content:[{type:'video_url',video_url:{url:'x'}}]}]},quote,{imageInput:true}),/unpriced option: content.video_url/);
  assert.throws(()=>estimateTierMaximum({...request,messages:[{role:'user',content:[{type:'text',text:'a',cache_control:{type:'ephemeral'}}]}]},quote),/cache_control/);
  // Agent clients send plain text as content parts; it is priced like a string.
  const parts=estimateTierMaximum({...request,messages:[{role:'user',content:[{type:'text',text:'hello'}]}]},quote);
  assert.ok(parts.maxChargeUsdcNano>0n);
});

test('conservative reserve covers tier, thinking and cache scenarios',()=>{
  for(const bytes of [30,128001,256001]) {
    const estimate=estimateTierMaximum({messages:[{role:'user',content:'a'.repeat(bytes)}],max_completion_tokens:1000},quote);
    for(const tokens of [1,Math.min(bytes,128000),Math.min(bytes,128001),bytes]) {
      for(const thinking of [0,500])assert.ok(calculateTierActual(use(tokens,1000,0,thinking),quote).customerChargeUsdcNano<=estimate.maxChargeUsdcNano);
    }
  }
});

test('ECB cross rate is reproducible; stale and missing rates fail closed',()=>{
  const xml="<Cube time='2026-10-06'><Cube currency='USD' rate='1.1269'/><Cube currency='CNY' rate='7.5554'/></Cube>";
  assert.equal(parseEcbFx(xml,new Date('2026-10-07')).cnyPerUsd,'6.704587807');
  assert.throws(()=>parseEcbFx(xml,new Date('2026-10-12')),/STALE/);
  assert.throws(()=>parseEcbFx(xml.replace('CNY','JPY'),new Date('2026-10-07')),/INVALID/);
});

test('each image counts at the provider ceiling, never by its base64 size, and only on models that take images',()=>{
  const ask=(content)=>({messages:[{role:'user',content}],max_tokens:10,enable_thinking:false});
  const text=estimateTierMaximum(ask([{type:'text',text:'这张图里有什么？'}]),quote,{imageInput:true}).maxInputTokens;
  const image=(url)=>({type:'image_url',image_url:{url,detail:'xhigh'}});
  const small=estimateTierMaximum(ask([{type:'text',text:'这张图里有什么？'},image('https://example.com/a.png')]),quote,{imageInput:true}).maxInputTokens;
  const huge=estimateTierMaximum(ask([{type:'text',text:'这张图里有什么？'},image('data:image/png;base64,'+'A'.repeat(5_000_000))]),quote,{imageInput:true}).maxInputTokens;
  assert.equal(small,huge);
  assert.ok(small-text>=1002n,'covers the largest image DeepSeek bills (1002 tokens)');
  const two=estimateTierMaximum(ask([image('https://example.com/a.png'),image('https://example.com/b.png')]),quote,{imageInput:true}).maxInputTokens;
  assert.ok(two-small>=1002n-100n);
  assert.throws(()=>estimateTierMaximum(ask([image('https://example.com/a.png')]),quote,{imageInput:false}),/does not accept image/);
  assert.throws(()=>estimateTierMaximum(ask([image('https://example.com/a.png')]),quote),/does not accept image/);
});
