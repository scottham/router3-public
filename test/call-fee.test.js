import test from 'node:test';
import assert from 'node:assert/strict';
import {callFee} from '../src/lib/call-fee.js';
import {PricingService} from '../src/services/pricing-service.js';
import {deepseekTestEntries} from './helpers/deepseek-catalog.js';

test('call fee is separate, exact, rounded once and zero on free usage',()=>{
  assert.deepEqual(callFee(1000000000n,100),{modelCostUsdcNano:1000000000n,serviceFeeUsdcNano:10000000n,customerChargeUsdcNano:1010000000n});
  assert.equal(callFee(101n,100).serviceFeeUsdcNano,2n);
  assert.equal(callFee(0n,100).serviceFeeUsdcNano,0n);
  assert.equal(callFee(100n,0).customerChargeUsdcNano,100n);
  assert.throws(()=>callFee(-1n,100));assert.throws(()=>callFee(1n,1.5));
});
test('provider model rates are unchanged while reservations include the pinned call fee',()=>{
  // deepseek-flash at peak: 2 CNY per million input, 8 per million output, 8 CNY per USD.
  const quote=deepseekTestEntries().find(e=>e.providerModel==='deepseek-flash').bailianQuote;
  const pricing=new PricingService(),raw={bailian_quote:quote},price={...raw,call_fee_policy_id:'fee-v1',service_fee_bps:100};
  const usage={inputTokens:10000,outputTokens:9000,reasoningTokens:100,cachedInputTokens:0};
  const actual=pricing.calculateActual(usage,price);
  assert.equal(actual.modelCostUsdcNano,11500000n);assert.equal(actual.serviceFeeUsdcNano,115000n);
  assert.equal(actual.customerChargeUsdcNano,11615000n);assert.equal(actual.providerCostUsdNano,11500000n);
  const body={messages:[{role:'user',content:'hello'}]};
  const estimate=pricing.estimateMaximum(body,raw),withFee=pricing.estimateMaximum(body,price);
  assert.equal(withFee.maxChargeUsdcNano,callFee(estimate.maxChargeUsdcNano,100).customerChargeUsdcNano);
  assert.equal(quote.markupBps,0);assert.equal(body.max_tokens,undefined);assert.equal(body.enable_thinking,undefined);
  assert.equal(pricing.calculateActual(usage,{...price,service_fee_bps:200}).serviceFeeUsdcNano,230000n);
  assert.equal(actual.serviceFeeUsdcNano,115000n);
});
