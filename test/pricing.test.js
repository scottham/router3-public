import test from 'node:test';
import assert from 'node:assert/strict';
import { PricingService } from '../src/services/pricing-service.js';

const price = {
  customer_input_usdc_nano_per_million: '1000000',
  customer_cached_input_usdc_nano_per_million: '100000',
  customer_output_usdc_nano_per_million: '2000000',
  customer_reasoning_usdc_nano_per_million: '3000000',
  provider_input_usd_nano_per_million: '500000',
  provider_cached_input_usd_nano_per_million: '50000',
  provider_output_usd_nano_per_million: '1000000',
  provider_reasoning_usd_nano_per_million: '1500000',
  capabilities: { reasoningIncludedInOutput: true }
};

test('maximum estimate is positive and conservative', () => {
  const result = new PricingService().estimateMaximum({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 }, price);
  assert.ok(result.maxChargeUsdcNano > 0n);
  assert.equal(result.maxOutputTokens, 100n);
});

test('actual usage separates customer USDC from provider USD cost', () => {
  const result = new PricingService().calculateActual({ inputTokens: 1000, cachedInputTokens: 100, outputTokens: 200, reasoningTokens: 0 }, price);
  assert.ok(result.customerChargeUsdcNano > result.providerCostUsdNano);
});
