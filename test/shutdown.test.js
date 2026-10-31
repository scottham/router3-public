import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import Fastify from 'fastify';
import { drainOnSignal } from '../src/lib/shutdown.js';

// Regression (2026-10-20): a deploy restarted the API while 47 streams were in
// flight; each was left with unknown usage and the wallet was paused.
test('SIGTERM lets an in-flight stream finish before the pool closes, and refuses new requests', async () => {
  const order = [];
  let release;
  const app = Fastify({ logger: false });
  app.post('/stream', async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: a\n\n');
    await new Promise((resolve) => { release = resolve; });
    order.push('usage recorded');
    reply.raw.end('data: [DONE]\n\n');
  });
  app.addHook('onClose', async () => { order.push('pool closed'); });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}/stream`;

  const signals = new EventEmitter();
  let exitCode;
  const exited = new Promise((resolve) => drainOnSignal(app, { target: signals, exit: (code) => { exitCode = code; resolve(); } }));
  const response = await fetch(url, { method: 'POST' });
  const body = response.text();
  signals.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(fetch(url, { method: 'POST' }), (error) => error.cause?.code === 'ECONNREFUSED');
  assert.deepEqual(order, []);

  release();
  assert.equal(await body, 'data: a\n\ndata: [DONE]\n\n');
  const started = Date.now();
  await exited;
  assert.ok(Date.now() - started < 3000, 'an idle keep-alive socket does not hold the exit for the keep-alive timeout');
  assert.deepEqual(order, ['usage recorded', 'pool closed']);
  assert.equal(exitCode, 0);
});
