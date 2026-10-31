import assert from 'node:assert/strict';
import test from 'node:test';
import { createProxy, ChannelPool, normalizePrivateKey } from '../clients/x402-proxy/index.mjs';
import { createInMemoryGateway, fakeChainReader, InMemoryGatewayRepository, mockModel, PAYER_KEY } from './helpers/in-memory-gateway.js';
import { privateKeyToAccount } from 'viem/accounts';

// The local proxy in front of a channel-paid gateway over real HTTP: plain
// OpenAI-style clients get paid calls, concurrent requests get their own
// channels, and `refund --all` brings the deposits back.
test('the proxy pays concurrent requests from a channel pool and refunds every channel', async (t) => {
  const h = await createInMemoryGateway();
  const gatewayUrl = await h.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => h.app.close());
  const account = privateKeyToAccount(PAYER_KEY);
  h.chain.mint(account.address, 10_000_000n);
  const proxy = createProxy({ gatewayUrl, privateKey: PAYER_KEY, reader: fakeChainReader(h.chain), maxChannels: 3, logger: { error() {} } });
  const address = await proxy.listen(0);
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.payer, account.address); assert.equal(health.channels, 0);
  // Pass-through for unpaid paths.
  const models = await (await fetch(`${base}/v1/models`)).json();
  assert.deepEqual(models.data.map((m) => m.id), ['mock/echo']);
  // Five concurrent chat calls on a pool of three: all succeed, three channels exist.
  const call = (content, extra = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ignored' },
    body: JSON.stringify({ model: 'mock/echo', messages: [{ role: 'user', content }], max_tokens: 16, ...extra }) });
  const responses = await Promise.all([1, 2, 3, 4, 5].map((i) => call(`call ${i}`)));
  for (const [i, response] of responses.entries()) {
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, `mock:call ${i + 1}`);
    assert.equal(body.gateway.payment, 'x402');
    assert.equal(response.headers.get('x-model-gateway-request-id'), body.gateway.request_id);
  }
  assert.equal(proxy.pool.size, 3);
  assert.equal((await h.storage.list()).length, 3);
  assert.equal([...new Set([...h.ledger.requests.values()].map((r) => r.channelId))].length, 3);
  // Streams pass through as SSE.
  const stream = await call('stream me', { stream: true });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const text = await stream.text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.match(text, /"payment_response"/);
  // Refund everything: the gateway claims what it is owed first.
  const charged = (await h.storage.list()).reduce((sum, c) => sum + BigInt(c.chargedCumulativeAmount), 0n);
  const results = await proxy.refundAll();
  assert.equal(results.length, 3); assert.ok(results.every((r) => r.success), JSON.stringify(results));
  assert.equal(h.chain.balanceOf(account.address), 10_000_000n - charged);
  assert.deepEqual(await h.storage.list(), []);
});

test('the pool hands out idle channels first, grows to the limit, then queues', async () => {
  const pool = new ChannelPool({ account: { address: '0x' + '11'.repeat(20) }, storage: {}, maxChannels: 2, fetchImpl: fetch });
  const a = await pool.acquire(), b = await pool.acquire();
  assert.equal(pool.size, 2); assert.notEqual(a.salt, b.salt);
  let third = null;
  const waiting = pool.acquire().then((c) => { third = c; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(third, null, 'the third waits for a release');
  pool.release(a);
  await waiting;
  assert.equal(third, a, 'the released channel goes to the waiter');
  pool.release(b); pool.release(third);
  assert.equal(pool.channels.every((c) => !c.busy), true);
  assert.equal(normalizePrivateKey(` "${'ab'.repeat(32)}" `), `0x${'ab'.repeat(32)}`);
  assert.throws(() => normalizePrivateKey('nope'), /PAYER_KEY_INVALID/);
});

test('a 402 that is not a payment request reaches the client as the gateway sent it', async (t) => {
  const h = await createInMemoryGateway({ config: { X402_REQUEST_LIMIT_USDC: '0.001' } });
  const gatewayUrl = await h.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => h.app.close());
  const proxy = createProxy({ gatewayUrl, privateKey: PAYER_KEY, reader: fakeChainReader(h.chain), logger: { error() {} } });
  const address = await proxy.listen(0);
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock/echo', messages: [{ role: 'user', content: 'x' }], max_tokens: 1000000 }) });
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, 'X402_REQUEST_LIMIT');
  assert.equal((await h.storage.list()).length, 0, 'nothing was deposited');
});

test('requests holding more than a dollar are paid up to the configured cap', async (t) => {
  // 2 USDC per million output tokens: 900k tokens hold about 1.8 USDC.
  const h = await createInMemoryGateway({ repository: new InMemoryGatewayRepository({ models: [mockModel({ customer_output_usdc_nano_per_million: '2000000000' })] }) });
  const gatewayUrl = await h.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => h.app.close());
  h.chain.mint(privateKeyToAccount(PAYER_KEY).address, 100_000_000n);
  const start = async (maxPaymentUsd) => {
    const proxy = createProxy({ gatewayUrl, privateKey: PAYER_KEY, reader: fakeChainReader(h.chain), maxPaymentUsd, logger: { error() {} } });
    t.after(() => proxy.close());
    return `http://127.0.0.1:${(await proxy.listen(0)).port}`;
  };
  const call = (base) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock/echo', messages: [{ role: 'user', content: 'x' }], max_tokens: 900000 }) });
  assert.equal((await call(await start(5))).status, 200);
  assert.equal((await call(await start(1))).status, 502, 'over the cap the proxy refuses to sign');
});
