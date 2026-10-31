import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, fromPostgresError, publicError } from '../src/lib/errors.js';

test('maps gateway-raised PostgreSQL exceptions to their public code', () => {
  const mapped = fromPostgresError(new Error('WALLET_PERMIT_PENDING'));
  assert.equal(mapped.code, 'WALLET_PERMIT_PENDING');
  assert.equal(mapped.statusCode, 409);
  assert.equal(mapped.message, 'The previous authorization is still being submitted; wait a moment');
});

test('never echoes raw PostgreSQL text as a code or message', () => {
  const leak = new Error('relation "private.billing_accounts" does not exist\nLINE 1: select ...');
  const mapped = fromPostgresError(leak);
  assert.equal(mapped.statusCode, 500);
  assert.equal(mapped.code, 'DATABASE_ERROR');
  assert.equal(mapped.message, 'Database operation failed');

  const rendered = JSON.stringify(publicError(leak));
  assert.ok(!rendered.includes('billing_accounts'), 'internal schema names must not reach the client');
  assert.ok(!rendered.includes('LINE 1'));
});

test('preserves application errors and their details', () => {
  const error = new AppError('MODEL_NOT_FOUND', 'Requested model was not found', 404, { model: 'x' });
  assert.equal(fromPostgresError(error), error);
  assert.deepEqual(publicError(error), {
    statusCode: 404,
    body: { error: { code: 'MODEL_NOT_FOUND', message: 'Requested model was not found', details: { model: 'x' } } }
  });
});

// 2026-10-20: once the chat route accepted 20 MiB bodies, nginx stopped
// rejecting large bodies for the other routes, and Fastify's own 413 surfaced
// as a 500 because only gateway errors kept their status.
test('requests Fastify rejects before any handler keep their client status', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify({ bodyLimit: 1024 });
  app.post('/x', async () => ({ ok: true }));
  app.setErrorHandler((error, request, reply) => { const r = publicError(error); reply.code(r.statusCode).send(r.body); });
  const big = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ a: 'x'.repeat(4096) }) });
  assert.equal(big.statusCode, 413);
  assert.equal(big.json().error.code, 'REQUEST_BODY_TOO_LARGE');
  const broken = await app.inject({ method: 'POST', url: '/x', headers: { 'content-type': 'application/json' }, payload: '{"a":' });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.json().error.code, 'INVALID_JSON');
  assert.equal(publicError(Object.assign(new Error('boom'), { code: 'XX000' })).statusCode, 500, 'server errors stay 500');
  await app.close();
});
