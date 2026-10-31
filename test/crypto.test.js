import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, encryptJson, decryptJson, createApiKey, createSessionToken, constantTimeEqual } from '../src/lib/crypto.js';

test('canonical JSON is independent of object key order', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
});

test('encrypted response cache round-trips with AES-GCM', () => {
  const key = Buffer.alloc(32, 7);
  const record = encryptJson({ ok: true, value: 3 }, 'v1', key);
  assert.deepEqual(decryptJson(record, key), { ok: true, value: 3 });
});

test('API key plaintext is not its stored digest', () => {
  const generated = createApiKey('x'.repeat(32));
  assert.match(generated.token, /^mcg_live_/);
  assert.equal(generated.digest.length, 32);
  assert.equal(constantTimeEqual(generated.digest, generated.digest), true);
});

test('application session plaintext is not its stored digest', () => {
  const generated = createSessionToken('s'.repeat(32));
  assert.match(generated.token, /^mcg_session_/);
  assert.equal(generated.digest.length, 32);
  assert.equal(generated.digest.includes(generated.token), false);
});
