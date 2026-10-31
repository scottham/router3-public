import {parseDecimalToNano} from '../lib/money.js';

// CNY/USD for providers that bill in CNY (DeepSeek). The daily ECB reference
// rate unless CNY_PER_USD fixes one.
export const ECB_URL='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const decimal=n=>`${n/1000000000n}.${(n%1000000000n).toString().padStart(9,'0')}`;

export function parseEcbFx(xml,now=new Date()) {
  const date=/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const rate=currency=>new RegExp(`<Cube\\s+currency=['"]${currency}['"]\\s+rate=['"]([0-9.]+)['"]`).exec(xml)?.[1];
  const usd=rate('USD'),cny=rate('CNY');
  if(!date||!usd||!cny)throw new Error('FX_SOURCE_INVALID');
  const age=now-new Date(`${date}T00:00:00Z`);
  // Includes weekends and ECB holidays. Expired data never silently freezes.
  if(age<0||age>5*86400000)throw new Error('FX_SOURCE_STALE');
  const u=parseDecimalToNano(usd),c=parseDecimalToNano(cny);
  if(u<=0n||c<=0n)throw new Error('FX_SOURCE_INVALID');
  return {cnyPerUsd:decimal((c*1000000000n+u/2n)/u),date,source:ECB_URL,policy:'daily-reference'};
}

export async function loadFx(env,{fetchImpl=fetch,now=new Date()}={}) {
  if(env.CNY_PER_USD) {
    if(!/^\d+(\.\d{1,9})?$/.test(env.CNY_PER_USD)||parseDecimalToNano(env.CNY_PER_USD)<=0n)throw new Error('INVALID_FIXED_FX');
    return {cnyPerUsd:env.CNY_PER_USD,date:null,source:'operator-configuration',policy:'fixed'};
  }
  const response=await fetchImpl(ECB_URL,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('FX_SOURCE_UNAVAILABLE');
  return parseEcbFx(await response.text(),now);
}
