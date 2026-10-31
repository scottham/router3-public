import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

const baseEnv = Object.freeze({
  NODE_ENV: 'test',
  MCG_RUNTIME: 'api',
  PUBLIC_APP_URL: 'http://localhost:3000',
  MONAD_RPC_URL: 'https://rpc.monad.xyz',
  AUTH_SESSION_HMAC_SECRET: 's'.repeat(32),
  DATABASE_URL_API: 'postgresql://gateway_api:test@127.0.0.1:54322/postgres',
  RESPONSE_ENCRYPTION_KEYS: `test:${Buffer.alloc(32).toString('base64')}`,
  TREASURY_ADDRESS: `0x${'5'.repeat(40)}`,
  SETTLER_ADDRESS: `0x${'6'.repeat(40)}`,
  SETTLER_SIGNER_URL: 'http://signer:8790/sign',
  SETTLER_SIGNER_BEARER_TOKEN: 't'.repeat(32)
});
const chain = { rpcUrl: 'https://rpc.example.com', usdcAddress: `0x${'2'.repeat(40)}`, confirmations: 12 };

test('loads a minimal API configuration', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.MCG_RUNTIME, 'api');
  assert.equal(config.REAL_MODEL_CALLS_ENABLED, false);
  assert.equal(config.MONAD_RPC_URL, 'https://rpc.monad.xyz');
  assert.equal(config.AUTH_COOKIE_NAME, 'mcg_session');
  assert.deepEqual(config.chains, {});
  assert.equal(config.responseEncryptionKeys.get('test').length, 32);
  assert.equal(config.X402_FACILITATOR_URL, 'https://x402-facilitator.molandak.org');
  assert.equal(config.X402_MIN_DEPOSIT_USDC, '0.1');
  assert.equal(config.X402_MAX_CHANNELS_PER_PAYER, 128);
});

test('the API needs the channel receiver, the settler and the signer', () => {
  for (const name of ['TREASURY_ADDRESS', 'SETTLER_ADDRESS', 'SETTLER_SIGNER_URL', 'SETTLER_SIGNER_BEARER_TOKEN', 'AUTH_SESSION_HMAC_SECRET', 'RESPONSE_ENCRYPTION_KEYS']) {
    assert.throws(() => loadConfig({ ...baseEnv, [name]: '' }), new RegExp(`api runtime requires .*${name}`));
  }
  assert.throws(() => loadConfig({ ...baseEnv, SETTLER_ADDRESS: '0x12' }));
});

test('verifies database TLS certificates unless explicitly disabled', () => {
  assert.equal(loadConfig(baseEnv).DB_SSL_REJECT_UNAUTHORIZED, true);
  assert.equal(loadConfig({ ...baseEnv, DB_SSL_REJECT_UNAUTHORIZED: '' }).DB_SSL_REJECT_UNAUTHORIZED, true);
  assert.equal(loadConfig({ ...baseEnv, DB_SSL_REJECT_UNAUTHORIZED: 'false' }).DB_SSL_REJECT_UNAUTHORIZED, false);
});

test('the active response encryption key id always resolves to a usable key', () => {
  const key = Buffer.alloc(32).toString('base64');
  const config = loadConfig({
    ...baseEnv,
    RESPONSE_ENCRYPTION_KEYS: ` primary:${key} , secondary:${Buffer.alloc(32, 1).toString('base64')} `
  });
  assert.equal(config.activeResponseEncryptionKeyId, 'primary');
  assert.equal(config.responseEncryptionKeys.get(config.activeResponseEncryptionKeyId).length, 32);
  assert.equal(config.responseEncryptionKeys.size, 2);
});

test('production API requires HTTPS', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, NODE_ENV: 'production' }),
    /PUBLIC_APP_URL must use HTTPS/
  );
  const config = loadConfig({
    ...baseEnv,
    NODE_ENV: 'production',
    PUBLIC_APP_URL: 'https://gateway.example.com',
    MONAD_RPC_URL: 'https://monad-rpc.example.com'
  });
  assert.equal(config.MONAD_RPC_URL, 'https://monad-rpc.example.com');
});

test('production spending requires the Monad mainnet chain entry', () => {
  const production = { ...baseEnv, NODE_ENV: 'production', PUBLIC_APP_URL: 'https://gateway.example.com',
    MONAD_RPC_URL: 'https://monad-rpc.example.com', REAL_MODEL_CALLS_ENABLED: 'true' };
  assert.throws(() => loadConfig(production), /Monad mainnet chain/);
  const config = loadConfig({ ...production, CHAIN_CONFIG_JSON: JSON.stringify({ 143: chain }) });
  assert.equal(config.REAL_MODEL_CALLS_ENABLED, true);
});

test('worker runtimes need their database and the collector its signer', () => {
  const collector = { NODE_ENV: 'test', MCG_RUNTIME: 'collector', DATABASE_URL_SETTLER: 'postgresql://gateway_settler:test@127.0.0.1:54322/postgres',
    TREASURY_ADDRESS: baseEnv.TREASURY_ADDRESS, SETTLER_ADDRESS: baseEnv.SETTLER_ADDRESS, SETTLER_SIGNER_URL: baseEnv.SETTLER_SIGNER_URL, SETTLER_SIGNER_BEARER_TOKEN: 't' };
  const config = loadConfig(collector);
  assert.equal(config.MCG_RUNTIME, 'collector');
  assert.equal(config.responseEncryptionKeys.size, 0);
  assert.throws(() => loadConfig({ ...collector, SETTLER_ADDRESS: '' }), /collector runtime requires SETTLER_ADDRESS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MCG_RUNTIME: 'collector' }), /DATABASE_URL_SETTLER/);
  assert.equal(loadConfig({ NODE_ENV: 'test', MCG_RUNTIME: 'reconciler', DATABASE_URL_RECONCILER: collector.DATABASE_URL_SETTLER }).MCG_RUNTIME, 'reconciler');
  for (const runtime of ['indexer', 'settler', 'autofunder', 'provider']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', MCG_RUNTIME: runtime }));
  }
});

test('chains need an RPC, USDC and a non-negative confirmation depth', () => {
  assert.equal(loadConfig({ ...baseEnv, CHAIN_CONFIG_JSON: JSON.stringify({ 143: chain }) }).chains['143'].confirmations, 12);
  // Zero extra blocks is valid: receipts already wait for Monad finality.
  assert.equal(loadConfig({ ...baseEnv, CHAIN_CONFIG_JSON: JSON.stringify({ 143: { ...chain, confirmations: 0 } }) }).chains['143'].confirmations, 0);
  for (const broken of [{ ...chain, rpcUrl: undefined }, { ...chain, rpcUrl: 'ftp://rpc.example.com' }, { ...chain, usdcAddress: '0x12' },
    { ...chain, confirmations: -1 }, { ...chain, confirmations: 1.5 }]) {
    assert.throws(() => loadConfig({ ...baseEnv, CHAIN_CONFIG_JSON: JSON.stringify({ 143: broken }) }));
  }
});

test('address allowlist is optional, normalized and validated', () => {
  assert.deepEqual(loadConfig(baseEnv).AUTH_ALLOWED_ADDRESSES, []);
  const address = `0x${'aB'.repeat(20)}`;
  assert.deepEqual(loadConfig({ ...baseEnv, AUTH_ALLOWED_ADDRESSES: ` ${address}, ` }).AUTH_ALLOWED_ADDRESSES, [address.toLowerCase()]);
  assert.throws(() => loadConfig({ ...baseEnv, AUTH_ALLOWED_ADDRESSES: '0x1234' }), /AUTH_ALLOWED_ADDRESSES/);
});

// A channel reservation lives 10 minutes in the SDK: streams must settle
// before that, and the reconciler must never close a live stream as lost.
test('streams fit inside a channel reservation and the stale-request threshold outlasts them', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.DEFAULT_REQUEST_TIMEOUT_MS, 120000);
  assert.equal(config.STREAM_REQUEST_TIMEOUT_MS, 570000);
  assert.equal(config.STREAM_IDLE_TIMEOUT_MS, 90000);
  assert.ok(config.STALE_REQUEST_AFTER_SECONDS * 1000 > config.STREAM_REQUEST_TIMEOUT_MS);
  assert.throws(() => loadConfig({ ...baseEnv, STALE_REQUEST_AFTER_SECONDS: '500' }), /must exceed STREAM_REQUEST_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ...baseEnv, STREAM_REQUEST_TIMEOUT_MS: '600000', STALE_REQUEST_AFTER_SECONDS: '900' }), /at most 570000/);
});

// Base64 images make chat bodies far larger than any other call.
test('chat bodies may be 20 MiB while other requests stay at 1 MiB', () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.MAX_CHAT_BODY_BYTES, 20 * 1024 * 1024);
  assert.equal(config.MAX_REQUEST_BODY_BYTES, 1024 * 1024);
});
