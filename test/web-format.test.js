import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLimit, formatNanoUsdc, formatPricePerMillion, shortAddress
} from '../web/src/format.js';
import { displayTokenAmount, tokenAmount } from '../web/src/wallet-actions.js';

test('nano balances render exactly, without floating point rounding', () => {
  assert.equal(formatNanoUsdc('1284500000000'), '1,284.50');
  assert.equal(formatNanoUsdc('0'), '0.00');
  // A dust balance keeps every digit instead of collapsing to 0.00.
  assert.equal(formatNanoUsdc('1'), '0.000000001');
  // Truncated, never rounded up: a displayed balance is always spendable.
  assert.equal(formatNanoUsdc('123456789012345678900'), '123,456,789,012.345678');
  assert.equal(formatPricePerMillion('35000000'), '0.035');
});

test('limits distinguish an unset policy from a zero limit', () => {
  assert.equal(formatLimit(null), 'No limit');
  assert.equal(formatLimit(undefined), 'No limit');
  assert.equal(formatLimit('0'), '0.00 USDC');
});

test('addresses are shortened without hiding short values', () => {
  assert.equal(shortAddress('0x8f3cAb129d4471bE5f0aE9C2d17B4c00e04421ab'), '0x8f3c…21ab');
  assert.equal(shortAddress('0x1234'), '0x1234');
  assert.equal(shortAddress(null), '—');
});

test('deposit amounts entered in USDC scale to micro USDC exactly', () => {
  assert.equal(tokenAmount('25', 6), 25_000_000n);
  assert.equal(tokenAmount('0.000001', 6), 1n);
  assert.equal(tokenAmount('0.1', 6), 100_000n);
  assert.throws(() => tokenAmount('-1', 6), /at most 6 decimals/);
  assert.throws(() => tokenAmount('1.0000001', 6), /at most 6 decimals/);
  assert.throws(() => tokenAmount('0', 6), /above 0/);
  assert.equal(displayTokenAmount('1500000'), '1.5');
  assert.equal(displayTokenAmount(null), '—');
});
