import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHexPrivateKey, normalizeTestnetPrivateKey } from '../scripts/lib/testnet-private-key.mjs';

test('normalizes a testnet private key without exposing or changing its bytes', () => {
  const bytes = 'a'.repeat(64);
  assert.equal(normalizeTestnetPrivateKey(bytes), `0x${bytes}`);
  assert.equal(normalizeTestnetPrivateKey(`0x${bytes}`), `0x${bytes}`);
  assert.throws(() => normalizeTestnetPrivateKey('not-a-private-key'), /32-byte hexadecimal/);
});

test('normalizes a generic mainnet key with a context-specific validation label', () => {
  assert.equal(normalizeHexPrivateKey('22'.repeat(32), 'Mainnet key'), `0x${'22'.repeat(32)}`);
  assert.throws(() => normalizeHexPrivateKey('bad', 'Mainnet key'), /Mainnet key/);
});
