import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { GatewayService, GatewayStream } from '../src/services/gateway-service.js';
import { registerGatewayRoutes, SSE_KEEPALIVE } from '../src/routes/gateway-routes.js';
import { ProviderError } from '../src/providers/provider-error.js';
import { AppError } from '../src/lib/errors.js';
import { MockProvider } from '../src/providers/mock.js';
import { InMemoryGatewayRepository, createInMemoryGateway, chatBody, mockModel, ok, parseSse, post, testConfig, TEST_SESSION_TOKEN } from './helpers/in-memory-gateway.js';

const body = { model: 'mock/echo', messages: [{ role: 'user', content: 'hello stream' }], max_tokens: 32, stream: true };

const chunk = (choices, extra = {}) => ({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 1700000000, model: 'upstream-name', choices, ...extra });
const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
const normalized = { inputTokens: 7, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 0 };

// A scripted streaming provider: `script` yields chunks in order; `ending`
// decides how the stream finishes.
function scriptedProvider({ chunks, ending = 'usage' }) {
  return {
    get() {
      return {
        async stream() {
          const full = { role: 'assistant', content: 'ab' };
          async function* generator() {
            for (const item of chunks) yield item;
            if (ending === 'usage') yield chunk([], { usage });
            if (ending === 'disconnect') throw new ProviderError('upstream closed the socket', { code: 'PROVIDER_STREAM_INCOMPLETE', statusCode: 502, chargeCertainty: 'unknown' });
            if (ending === 'rejected') throw new ProviderError('bad request', { code: 'PROVIDER_REQUEST_REJECTED', statusCode: 400, chargeCertainty: 'not_charged' });
          }
          return {
            chunks: generator(),
            result() {
              if (ending !== 'usage') throw new ProviderError('no usage', { code: 'PROVIDER_STREAM_INCOMPLETE', statusCode: 502, chargeCertainty: 'unknown' });
              return {
                providerRequestId: 'chatcmpl_test',
                usage: normalized,
                rawUsageRedacted: usage,
                body: { id: 'chatcmpl_test', object: 'chat.completion', created: 1700000000, model: 'mock/echo',
                  choices: [{ index: 0, message: full, finish_reason: 'stop' }], usage }
              };
            }
          };
        }
      };
    }
  };
}

const happyChunks = [
  chunk([{ index: 0, delta: { role: 'assistant', content: 'a' }, finish_reason: null }]),
  chunk([{ index: 0, delta: { content: 'b' }, finish_reason: null }]),
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
];

// The gateway service alone, with a ledger that records what it was told.
// Money semantics (ceiling, cancel) are the x402 ledger's and are tested in
// x402.test.js; this checks what the stream machinery hands it.
function service(providerRegistry, config = {}) {
  const repository = new InMemoryGatewayRepository();
  const svc = new GatewayService({ repository, providerRegistry, config: testConfig(config) });
  const calls = [];
  const ledger = {
    async settle({ requestId, model, providerResult, gatewayBase }) {
      calls.push(['settle', requestId]);
      const cost = svc.pricing.calculateActual(providerResult.usage, model, providerResult.providerCostUsdNano ?? null);
      return { ...gatewayBase, billed_usdc_nano: String(cost.customerChargeUsdcNano) };
    },
    // Like the channel ledger: provider failures surface as application errors.
    async fail(requestId, error) {
      calls.push(['fail', requestId, error.code ?? error.message]);
      return error instanceof ProviderError ? new AppError(error.code, error.message, error.statusCode, error.details, { cause: error }) : error;
    },
    async abandon(requestId) { calls.push(['abandon', requestId]); }
  };
  async function run(input = body, signal = undefined) {
    const plan = await svc.prepare({ body: input });
    return svc.execute({ ledger, requestId: 'r1', request: plan.request, model: plan.model, protocol: null, signal, gatewayBase: { request_id: 'r1' }, context: {} });
  }
  return { svc, calls, run };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream.events) events.push(event);
  return events;
}

test('stream:true forwards chunks, settles after usage and ends with a gateway usage chunk and [DONE]', async () => {
  const { calls, run } = service(scriptedProvider({ chunks: happyChunks }));
  const result = await run();
  assert.ok(result instanceof GatewayStream);
  assert.deepEqual(calls, [], 'nothing is settled before the stream is consumed');
  const events = await collect(result);
  const chunks = events.filter((e) => !e.event && e.data !== '[DONE]').map((e) => e.data);
  assert.equal(events.at(-1).data, '[DONE]');
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.slice(0, 3).map((c) => c.choices[0].delta.content ?? ''), ['a', 'b', '']);
  for (const c of chunks) {
    assert.equal(c.object, 'chat.completion.chunk');
    assert.equal(c.model, 'mock/echo', 'the upstream model name must not leak');
  }
  // Upstream usage is withheld; the gateway's own final chunk carries it plus billing.
  assert.equal(chunks.slice(0, 3).every((c) => c.usage === undefined), true);
  const final = chunks[3];
  assert.deepEqual(final.choices, []);
  assert.deepEqual(final.usage, usage);
  assert.equal(final.gateway.request_id, 'r1');
  // 7 input × 1000000/1e6 + 3 output × 2000000/1e6 = 7 + 6 nano
  assert.equal(final.gateway.billed_usdc_nano, '13');
  assert.deepEqual(calls, [['settle', 'r1']]);
});

test('an upstream disconnect mid-stream hands the ledger unknown usage and ends with an error event', async () => {
  const { calls, run } = service(scriptedProvider({ chunks: happyChunks.slice(0, 2), ending: 'disconnect' }));
  const events = await collect(await run());
  assert.equal(events.filter((e) => !e.event).length, 2, 'chunks before the failure were forwarded');
  const error = events.at(-1);
  assert.equal(error.event, 'error');
  assert.equal(error.data.error.code, 'PROVIDER_STREAM_INCOMPLETE');
  assert.equal(error.data.error.request_id, 'r1');
  assert.equal(events.some((e) => e.data === '[DONE]'), false);
  assert.deepEqual(calls, [['fail', 'r1', 'PROVIDER_STREAM_INCOMPLETE']]);
});

test('a stream that ends without usage is never settled as free', async () => {
  const { calls, run } = service(scriptedProvider({ chunks: happyChunks, ending: 'none' }));
  const events = await collect(await run());
  assert.equal(events.filter((e) => !e.event && e.data !== '[DONE]').length, 3);
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.error.code, 'PROVIDER_STREAM_INCOMPLETE');
  assert.deepEqual(calls, [['fail', 'r1', 'PROVIDER_STREAM_INCOMPLETE']]);
});

test('a pre-charge rejection raised while streaming reaches the ledger as such', async () => {
  const { calls, run } = service(scriptedProvider({ chunks: [], ending: 'rejected' }));
  const events = await collect(await run());
  assert.equal(events.at(-1).data.error.code, 'PROVIDER_REQUEST_REJECTED');
  assert.deepEqual(calls, [['fail', 'r1', 'PROVIDER_REQUEST_REJECTED']]);
});

test('abandoning the stream before settlement tells the ledger', async () => {
  const { calls, run } = service(scriptedProvider({ chunks: happyChunks }));
  const result = await run();
  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  assert.deepEqual(calls, [['abandon', 'r1']]);
});

test('a client abort signal stops forwarding and is reported as unknown usage', async () => {
  const { calls, run } = service(scriptedProvider({ chunks: happyChunks }));
  const abort = new AbortController();
  const result = await run(body, abort.signal);
  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();
  abort.abort();
  const events = [];
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
  assert.equal(events.at(-1).event, 'error');
  assert.deepEqual(calls, [['fail', 'r1', 'PROVIDER_STREAM_INCOMPLETE']]);
});

test('HTTP-level provider failures before the first chunk still surface as ordinary errors', async () => {
  const providerRegistry = { get: () => ({ async stream() { throw new ProviderError('upstream 503', { code: 'PROVIDER_HTTP_ERROR', statusCode: 502, chargeCertainty: 'unknown' }); } }) };
  const { calls, run } = service(providerRegistry);
  await assert.rejects(run(), (e) => e.code === 'PROVIDER_HTTP_ERROR' && e.statusCode === 502);
  assert.deepEqual(calls, [['fail', 'r1', 'PROVIDER_HTTP_ERROR']]);
});

test('adapters without a streaming transport serve stream:true as a single chunk', async () => {
  const providerRegistry = { get: () => ({ invoke: (request, model) => new MockProvider().invoke(request, model) }) };
  const { run } = service(providerRegistry);
  const events = await collect(await run());
  const chunks = events.filter((e) => !e.event && e.data !== '[DONE]').map((e) => e.data);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].choices[0].delta.content, 'mock:hello stream');
  assert.equal(chunks[0].choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks[1].choices, []);
  assert.ok(chunks[1].usage.total_tokens > 0);
  assert.equal(events.at(-1).data, '[DONE]');
});

test('the mock provider streams the same completion it answers synchronously', async () => {
  const { run } = service({ get: () => new MockProvider() });
  const events = await collect(await run());
  const chunks = events.filter((e) => !e.event && e.data !== '[DONE]').map((e) => e.data);
  const text = chunks.flatMap((c) => c.choices).map((c) => c.delta.content ?? '').join('');
  assert.equal(text, 'mock:hello stream');
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.equal(chunks.at(-1).usage.total_tokens, chunks.at(-1).usage.prompt_tokens + chunks.at(-1).usage.completion_tokens);
});

test('a paid stream is OpenAI SSE with the gateway request id in the headers', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const response = await h.client().fetch(post('/v1/chat/completions', body));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.ok(response.headers.get('x-model-gateway-request-id'));
  const text = await response.text();
  const events = parseSse(text);
  assert.equal(events.at(-1).data, '[DONE]');
  const final = events.at(-2).data;
  assert.deepEqual(final.choices, []);
  assert.equal(final.gateway.request_id, response.headers.get('x-model-gateway-request-id'));
  assert.equal(h.ledger.requests.get(final.gateway.request_id).status, 'completed');
  assert.equal(text.endsWith('data: [DONE]\n\n'), true);
});

test('the route emits a named error event when the stream fails after it started, and charges the ceiling', async (t) => {
  const h = await createInMemoryGateway({ providers: scriptedProvider({ chunks: happyChunks.slice(0, 1), ending: 'disconnect' }) });
  t.after(() => h.app.close());
  const response = await h.client().fetch(post('/v1/chat/completions', body));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /\nevent: error\ndata: \{"error":\{"code":"PROVIDER_STREAM_INCOMPLETE"/);
  assert.equal(text.includes('[DONE]'), false);
  const [row] = h.ledger.requests.values();
  assert.equal(row.chargedFrom, 'ceiling'); assert.equal(row.failureCode, 'PROVIDER_STREAM_INCOMPLETE');
});

test('non-streaming requests keep their JSON shape and expose the request id in headers', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const response = await h.client().fetch(post('/v1/chat/completions', { ...body, stream: false }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  const json = await response.json();
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.choices[0].message.content, 'mock:hello stream');
  assert.equal(json.gateway.request_id, response.headers.get('x-model-gateway-request-id'));
  assert.equal(json.gateway.payment, 'x402');
});

test('GET /v1/models serves the OpenAI list to anyone and the priced catalog to browser sessions', async (t) => {
  const other = mockModel({ model_id: '00000000-0000-4000-8000-000000000200', public_name: 'vendor/other', provider: 'static', created_at: '2026-02-01T00:00:00.000Z' });
  const h = await createInMemoryGateway({ repository: new InMemoryGatewayRepository({ models: [mockModel(), other] }) });
  t.after(() => h.app.close());
  const anonymous = await h.app.inject({ method: 'GET', url: '/v1/models' });
  assert.equal(anonymous.statusCode, 200);
  assert.deepEqual(anonymous.json().data.map((m) => m.id), ['mock/echo', 'vendor/other']);
  assert.deepEqual(anonymous.json().data[1], { id: 'vendor/other', object: 'model', created: Math.floor(Date.parse('2026-02-01T00:00:00.000Z') / 1000), owned_by: 'static' });
  const viaSession = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${TEST_SESSION_TOKEN}` } });
  assert.equal(viaSession.statusCode, 200);
  assert.equal(viaSession.json().length, 2);
  assert.equal(viaSession.json()[0].customer_input_usdc_nano_per_million, '1000000');
  const badSession = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer mcg_session_wrong' } });
  assert.equal(badSession.statusCode, 401);
  // Only the console's own cookie selects the catalog; unrelated cookies on the domain do not.
  const foreignCookies = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { cookie: '_ga=GA1.2.1; theme=dark' } });
  assert.equal(foreignCookies.statusCode, 200);
  assert.deepEqual(foreignCookies.json().data.map((m) => m.id), ['mock/echo', 'vendor/other']);
  const viaCookie = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { cookie: `theme=dark; mcg_session=${TEST_SESSION_TOKEN}` } });
  assert.equal(viaCookie.statusCode, 200);
  assert.equal(viaCookie.json().length, 2);
});

test('a silent stream gets SSE keepalive comments that clients ignore', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const events = (async function* () {
    await new Promise((resolve) => setTimeout(resolve, 70));
    yield { data: { choices: [{ index: 0, delta: { content: 'hi' } }] } };
    yield { data: '[DONE]' };
  })();
  const x402 = { service: { handle: async () => ({ response: new GatewayStream({ requestId: 'r', events }) }) } };
  await registerGatewayRoutes(app, { x402, keepaliveMs: 20 });
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
  assert.ok(response.body.startsWith(SSE_KEEPALIVE));
  assert.match(response.body, /data: \{"choices".*\n\ndata: \[DONE\]\n\n$/s);
  assert.equal(response.body.split('\n').filter((line) => line && !line.startsWith(':')).every((line) => line.startsWith('data: ')), true);
});

test('a stream may outlast the non-streaming timeout but is cut off after the idle limit', async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timed = (gaps, headersAfter = 0) => ({ get: () => ({ async stream() {
    await wait(headersAfter);
    async function* generator() { for (const [i, gap] of gaps.entries()) { await wait(gap); yield happyChunks[i]; } yield chunk([], { usage }); }
    return { chunks: generator(), result: () => ({
      providerRequestId: 'chatcmpl_test', usage: normalized, rawUsageRedacted: usage,
      body: { id: 'chatcmpl_test', object: 'chat.completion', created: 1700000000, model: 'mock/echo', choices: [], usage } }) };
  } }) });
  const config = { DEFAULT_REQUEST_TIMEOUT_MS: 50, MAX_REQUEST_TIMEOUT_MS: 50, STREAM_REQUEST_TIMEOUT_MS: 1000, STREAM_IDLE_TIMEOUT_MS: 60 };
  const steady = service(timed([30, 30, 30]), config);
  assert.equal((await collect(await steady.run())).at(-1).data, '[DONE]');
  // Regression (2026-10-20): a large image takes minutes to upload from this
  // server to a provider in China; no data flows until the upstream answers.
  const uploading = service(timed([10, 10, 10], 150), config);
  assert.equal((await collect(await uploading.run())).at(-1).data, '[DONE]');
  const stalled = service(timed([10, 200]), config);
  const events = await collect(await stalled.run());
  assert.equal(events.filter((e) => !e.event).length, 1);
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.error.code, 'PROVIDER_TIMEOUT');
  assert.deepEqual(stalled.calls, [['fail', 'r1', 'PROVIDER_TIMEOUT']]);
});

test('the chat route accepts bodies large enough for base64 images; its limit is separate', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(3_000_000)}` } };
  const big = chatBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, image] }] });
  const response = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: big });
  assert.notEqual(response.statusCode, 413);
  assert.equal(await ok(await h.client().fetch(post('/v1/chat/completions', chatBody()))).then((b) => b.gateway.payment), 'x402');
});
