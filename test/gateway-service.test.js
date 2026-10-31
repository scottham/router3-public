import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayService, GatewayStream } from '../src/services/gateway-service.js';
import { ProviderError } from '../src/providers/provider-error.js';
import { createInMemoryGateway, chatBody, post, mockModel, InMemoryGatewayRepository } from './helpers/in-memory-gateway.js';
import { MockProvider } from '../src/providers/mock.js';

const body = { model: 'test/model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 };

test('real spending is off by default and rejection occurs before any payment or provider dispatch', async () => {
  for (const enabled of [undefined, false]) {
    for (const provider of ['deepseek', 'openrouter', 'static']) {
      const service = new GatewayService({
        repository: { getModelAndPrice: async () => mockModel({ public_name: 'test/model', provider }) },
        providerRegistry: { get: () => assert.fail('must not contact vendor') },
        config: { REAL_MODEL_CALLS_ENABLED: enabled }
      });
      await assert.rejects(service.prepare({ body }), (error) => error.code === 'REAL_MODEL_CALLS_DISABLED' && error.statusCode === 503);
    }
  }
});

test('an unknown model, a missing output limit and conflicting limits are refused before pricing', async () => {
  const service = new GatewayService({ repository: new InMemoryGatewayRepository(), providerRegistry: { get: () => assert.fail('unreachable') }, config: { REAL_MODEL_CALLS_ENABLED: true } });
  await assert.rejects(service.prepare({ body }), { code: 'MODEL_NOT_FOUND' });
  await assert.rejects(service.prepare({ body: { model: 'mock/echo', messages: body.messages } }), { code: 'MAX_TOKENS_REQUIRED' });
  await assert.rejects(service.prepare({ body: { model: 'mock/echo', messages: body.messages, max_tokens: 1, max_completion_tokens: 1 } }), { code: 'OUTPUT_LIMIT_CONFLICT' });
  const plan = await service.prepare({ body: { model: 'mock/echo', messages: body.messages, max_tokens: 10 } });
  assert.ok(plan.estimate.maxChargeUsdcNano > 0n);
  assert.equal(plan.requestDigest.length, 32);
});

test('uncertain provider usage after the provider boundary is charged at the ceiling the payer signed', async () => {
  const h = await createInMemoryGateway({ providers: { get: () => ({ async invoke() {
    throw new ProviderError('Usage is missing', { code: 'PROVIDER_USAGE_UNAVAILABLE', statusCode: 502, chargeCertainty: 'unknown' });
  } }) } });
  const response = await h.client().fetch(post('/v1/chat/completions', chatBody()));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'PROVIDER_USAGE_UNAVAILABLE');
  const [row] = h.ledger.requests.values();
  assert.equal(row.status, 'completed'); assert.equal(row.chargedFrom, 'ceiling'); assert.equal(row.chargedAtomic, row.ceilingAtomic);
  await h.app.close();
});

test('a non-streaming call keeps running when the client leaves and is billed on usage; a stream is cut off', async () => {
  const mock = new MockProvider();
  const seen = [];
  const provider = { async invoke(request, model, signal) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    seen.push(signal.aborted);
    return mock.invoke(request, model);
  } };
  const service = new GatewayService({ repository: new InMemoryGatewayRepository(), providerRegistry: { get: () => provider },
    config: { REAL_MODEL_CALLS_ENABLED: true, DEFAULT_REQUEST_TIMEOUT_MS: 5000, MAX_REQUEST_TIMEOUT_MS: 5000, STREAM_REQUEST_TIMEOUT_MS: 5000, STREAM_IDLE_TIMEOUT_MS: 5000 } });
  const settled = [];
  const ledger = { async settle({ providerResult }) { settled.push(providerResult.usage); return {}; }, async fail(_id, error) { return error; }, async abandon() {} };
  for (const stream of [false, true]) {
    const plan = await service.prepare({ body: { model: 'mock/echo', messages: body.messages, max_tokens: 10, stream } });
    const client = new AbortController();
    const running = service.execute({ ledger, requestId: 'r', request: plan.request, model: plan.model, protocol: null, signal: client.signal, gatewayBase: {}, context: {} });
    client.abort();
    const result = await running;
    if (stream) assert.ok(result instanceof GatewayStream); else assert.equal(result.gateway !== undefined, true);
  }
  assert.deepEqual(seen, [false, true]);
  assert.equal(settled.length, 1, 'the non-streaming call settled on reported usage');
});
