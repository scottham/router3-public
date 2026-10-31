import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('builds the API and serves the dependency-free health endpoint', async (t) => {
  const config = loadConfig({
    NODE_ENV: 'test',
    MCG_RUNTIME: 'api',
    PUBLIC_APP_URL: 'http://localhost:3000',
    AUTH_SESSION_HMAC_SECRET: 's'.repeat(32),
    DATABASE_URL_API: 'postgresql://gateway_api:test@127.0.0.1:54322/postgres',
    RESPONSE_ENCRYPTION_KEYS: `test:${Buffer.alloc(32).toString('base64')}`,
    TREASURY_ADDRESS: `0x${'5'.repeat(40)}`,
    SETTLER_ADDRESS: `0x${'6'.repeat(40)}`,
    SETTLER_SIGNER_URL: 'http://127.0.0.1:9/sign',
    SETTLER_SIGNER_BEARER_TOKEN: 't'.repeat(32),
    X402_FACILITATOR_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'silent'
  });
  // The facilitator is unreachable here: the app still builds and model calls answer 503 until it is.
  const { app, x402 } = await buildApp(config, { x402: { facilitator: { async getSupported() { throw new Error('offline'); } } } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  assert.equal(x402.service.ready, false);
  const terms = await app.inject({ method: 'GET', url: '/v1/x402' });
  assert.equal(terms.json().ready, false);
  assert.equal(terms.json().payTo, `0x${'5'.repeat(40)}`);
});
