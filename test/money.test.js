import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimalToNano, formatNano, tokenCostNano, nanoToUsdcAtomicExact, usdcAtomicToNano } from '../src/lib/money.js';

test('decimal and nano conversion is exact', () => {
  assert.equal(parseDecimalToNano('1.000001'), 1_000_001_000n);
  assert.equal(formatNano(1_000_001_000n), '1.000001');
});

test('USDC atomic conversion is exact', () => {
  assert.equal(usdcAtomicToNano(1_000_001n), 1_000_001_000n);
  assert.equal(nanoToUsdcAtomicExact(1_000_001_000n), 1_000_001n);
  assert.throws(() => nanoToUsdcAtomicExact(1n));
});

test('token pricing rounds up and never undercharges', () => {
  assert.equal(tokenCostNano(1n, 1n), 1n);
  assert.equal(tokenCostNano(1_000_000n, 10n), 10n);
});
