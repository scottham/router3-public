import {applyBasisPoints} from '../lib/money.js';
import {AppError} from '../lib/errors.js';
import {canonicalize} from '../lib/crypto.js';

// Tiered provider quotes (bailian_quote on a price version): input tiers by
// token count, thinking and cache rates per tier, a CNY/USD rate and an
// optional time-of-use schedule. Built per provider (deepseek-catalog.js).
const ceilDiv=(a,b)=>(a+b-1n)/b;
const max=(...values)=>values.reduce((a,b)=>a>b?a:b);

function usdCost(quote,input,output,cached,tier,thinking) {
  if(cached>input)throw new AppError('PROVIDER_USAGE_INVALID','The provider reported more cached tokens than input tokens',502);
  const rate=thinking?{input:tier.thinkingInput,output:tier.thinkingOutput,cached:tier.thinkingCachedInput}
    :{input:tier.input,output:tier.output,cached:tier.cachedInput};
  if(cached>0n&&rate.cached==null)throw new AppError('PRICE_CACHE_RATE_UNKNOWN','The current price version has no cached-input rate',503);
  const cnyTokenNano=(input-cached)*BigInt(rate.input)+cached*BigInt(rate.cached??0)+output*BigInt(rate.output);
  return ceilDiv(cnyTokenNano*1000000000n,1000000n*BigInt(quote.fx.cnyPerUsdNano));
}

// Most input tokens one image can cost, whatever detail or pixel limit the
// caller sets. DeepSeek (measured 2026-10-21) scales every image to about
// 1344x1344: at most 1002 tokens. deepseek-usd-v1 is kept for price versions
// published before CNY billing.
// OpenRouter models bill images as prompt tokens at the serving provider's own
// ratio (Anthropic ≤ ~1600, OpenAI ≤ ~1500 per detail tile set, Qwen ≤ 1280 by
// default); the hold uses one generous ceiling and the charge follows the
// reported cost.
export const IMAGE_TOKEN_CEILING=Object.freeze({'deepseek-usd-v1':2000n,'deepseek-cny-v1':2000n,'openrouter-usd-v1':4000n});

const imageUrl=part=>typeof part.image_url==='string'?part.image_url:part.image_url?.url;

// Text in the array form many agent clients send ([{type:'text',text}]) is
// priced like a string, and images on models that take them by the ceiling
// above. Video, audio, explicit cache writes and search are billed at rates
// this estimate does not cover, so they are refused and the refusal names the
// option.
function unpricedOption(request,quote,capabilities) {
  const cacheWritePriced=quote.tiers.every(t=>t.cacheWrite!=null);
  if(request.cache_control!=null&&!cacheWritePriced)return 'cache_control';
  for(const m of request.messages) {
    if(m.cache_control!=null&&!cacheWritePriced)return 'cache_control';
    if(m.content==null||typeof m.content==='string')continue;
    if(!Array.isArray(m.content))return 'content';
    for(const part of m.content) {
      if(part?.cache_control!=null&&!cacheWritePriced)return 'cache_control';
      if(part?.type==='text'&&typeof part.text==='string')continue;
      if(part?.type==='image_url'&&typeof imageUrl(part)==='string') {
        if(!capabilities?.imageInput||!IMAGE_TOKEN_CEILING[quote.kind])throw new AppError('MODEL_IMAGE_INPUT_UNSUPPORTED','This model does not accept image input',422);
        continue;
      }
      return `content.${part?.type??'unknown'}`;
    }
  }
  for(const option of ['enable_search','search_options','modalities','audio','service_tier'])if(request[option])return option;
  if(request.n!=null&&request.n!==1)return 'n';
  return null;
}

// Output tokens a hold covers: all of the limit, or at most `holdOutputTokens`.
export function heldOutput(tokens,holdOutputTokens) {
  return holdOutputTokens!=null&&tokens>BigInt(holdOutputTokens)?BigInt(holdOutputTokens):tokens;
}

export function estimateTierMaximum(request,quote,capabilities,{bytesPerToken=1,holdOutputTokens=null,cacheWriteTtl=null}={}) {
  const option=unpricedOption(request,quote,capabilities);
  if(option)throw new AppError('REQUEST_OPTION_NOT_PRICED',`Only text chat, images and tool calls are priced; this request uses an unpriced option: ${option}`,422,{option});
  // Image bytes (often megabytes of base64) say nothing about their token cost;
  // each image counts at the ceiling instead and its data is left out.
  let images=0n;
  const messages=request.messages.map(m=>Array.isArray(m.content)?{...m,content:m.content.map(part=>{
    if(part.type!=='image_url')return part;
    images++;return {type:'image_url'};
  })}:m);
  const bytes=BigInt(Buffer.byteLength(canonicalize({messages,tools:request.tools??null,response_format:request.response_format??null}),'utf8'));
  const text=(bytes+BigInt(bytesPerToken)-1n)/BigInt(bytesPerToken)+1024n;
  const input=text+images*(IMAGE_TOKEN_CEILING[quote.kind]??0n);
  const answer=BigInt(request.max_tokens??quote.maxOutputTokens);
  const reasoning=BigInt(request.enable_thinking===false?0:request.thinking_budget??quote.maxReasoningTokens);
  const output=BigInt(request.max_completion_tokens??(answer+reasoning));
  if(output<=0n||answer>BigInt(quote.maxOutputTokens)||output>BigInt(quote.maxOutputTokens)+BigInt(quote.maxReasoningTokens))throw new AppError('MAX_TOKENS_EXCEEDS_MODEL','The output limit exceeds the model maximum',422);
  if(input>BigInt(quote.maxInputTokens)||input>BigInt(quote.contextLength)
    ||(quote.tiers.at(-1).upper!=null&&input>BigInt(quote.tiers.at(-1).upper)))throw new AppError('CONTEXT_LIMIT_EXCEEDED','The request exceeds the model context or the priced input range',422);
  // The estimate may cross an input tier; take the worst reachable rate and
  // both thinking modes without changing the provider's default configuration.
  // Where explicit cache writes are priced above the input rate, every input
  // token may be written to the cache.
  const candidates=quote.tiers.filter(t=>BigInt(t.lower)<input||t.lower===0).map(t=>{
    if(cacheWriteTtl==='1h'&&t.cacheWrite!=null&&t.cacheWrite1h==null)
      throw new AppError('REQUEST_OPTION_NOT_PRICED','The current price version has no one-hour cache-write rate',422,{option:'cache_control.ttl'});
    const write=t.cacheWrite==null?0n:BigInt(cacheWriteTtl==='1h'?t.cacheWrite1h:t.cacheWrite);
    return write>BigInt(t.input)?{...t,input:String(write),thinkingInput:String(max(write,BigInt(t.thinkingInput)))}:t;
  });
  const held=heldOutput(output,holdOutputTokens);
  const provider=max(...candidates.flatMap(t=>[false,true].map(thinking=>usdCost(quote,input,held,0n,t,thinking))));
  const amount=applyBasisPoints(provider,quote.markupBps);
  return {maxChargeUsdcNano:amount>0n?amount:1n,maxInputTokens:input,maxOutputTokens:output};
}

// Time-of-use tariffs (DeepSeek): tiers hold the peak rates, which every hold
// uses; a request that started off-peak is billed at quote.offPeak. Peak days
// and holidays are dates in the provider's timezone, hours are UTC.
export function isPeak(timeOfUse,at) {
  const local=new Date(at.getTime()+timeOfUse.utcOffsetMinutes*60000);
  const date=local.toISOString().slice(0,10);
  if(timeOfUse.offPeakDates.includes(date)||!timeOfUse.peakWeekdays.includes(local.getUTCDay()))return false;
  const minute=at.getUTCHours()*60+at.getUTCMinutes();
  return timeOfUse.peakHoursUtc.some(([from,to])=>minute>=from*60&&minute<to*60);
}

export function calculateTierActual(usage,quote,at=null) {
  const input=BigInt(usage.inputTokens),output=BigInt(usage.outputTokens),cached=BigInt(usage.cachedInputTokens??0);
  const peakTier=quote.tiers.find(t=>(input>BigInt(t.lower)||t.lower===0)&&(t.upper==null||input<=BigInt(t.upper)));
  if(!peakTier)throw new AppError('PRICE_TIER_MISSING','Actual usage is outside the priced tiers',503);
  // Without a start time (or a parsed schedule) the peak rate applies.
  const offPeak=quote.timeOfUse&&quote.offPeak&&at&&!isPeak(quote.timeOfUse,at);
  const tier=offPeak?{...peakTier,input:quote.offPeak.input,output:quote.offPeak.output,cachedInput:quote.offPeak.cachedInput,
    thinkingInput:quote.offPeak.input,thinkingOutput:quote.offPeak.output,thinkingCachedInput:quote.offPeak.cachedInput}:peakTier;
  if(BigInt(usage.reasoningTokens??0)>output)throw new AppError('PROVIDER_USAGE_INVALID','The provider reported more reasoning tokens than output tokens',502);
  // The non-thinking tariff applies when no reasoning was produced, even if
  // thinking was enabled. The Anthropic format reports no reasoning count; a
  // thinking block sets usage.thinking instead (src/protocols/anthropic.js).
  const thinking=BigInt(usage.reasoningTokens??0)>0n||usage.thinking===true;
  const providerCostUsdNano=usdCost(quote,input,output,cached,tier,thinking);
  return {providerCostUsdNano,customerChargeUsdcNano:applyBasisPoints(providerCostUsdNano,quote.markupBps)};
}

export function tierDisplayRates(quote) {
  const toUsd=rate=>{
    const n=ceilDiv(BigInt(rate)*1000000000n,BigInt(quote.fx.cnyPerUsdNano));
    return `${n/1000000000n}.${(n%1000000000n).toString().padStart(9,'0')}`;
  };
  const first=quote.tiers[0];
  return {input:toUsd(first.input),cachedInput:toUsd(first.cachedInput??first.input),output:toUsd(first.output),reasoning:'0'};
}
