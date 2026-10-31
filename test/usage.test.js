import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalUsageCounter, requiredUsageCounter } from '../src/providers/usage.js';

test('accepts valid required and optional usage counters', () => {
  const usage = { input: 12, details: { cached: 3 } };
  assert.equal(requiredUsageCounter(usage, 'input'), 12);
  assert.equal(optionalUsageCounter(usage, 'details.cached'), 3);
  assert.equal(optionalUsageCounter(usage, 'details.reasoning'), 0);
});

test('fails closed when required provider usage is missing', () => {
  assert.throws(
    () => requiredUsageCounter({}, 'prompt_tokens'),
    (error) => error.code === 'PROVIDER_USAGE_UNAVAILABLE'
      && error.chargeCertainty === 'unknown'
      && error.details.field === 'prompt_tokens'
  );
});

test('rejects fractional and unsafe provider usage', () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12']) {
    assert.throws(
      () => requiredUsageCounter({ value }, 'value'),
      (error) => error.code === 'PROVIDER_USAGE_UNAVAILABLE'
    );
  }
});
