#!/usr/bin/env node
// Verifies that an unmodified official OpenAI Node SDK can talk to the gateway
// through the local x402 proxy: list models, a non-streaming chat completion
// and a streaming one. No vendor key, provider, facilitator or PostgreSQL is
// needed: by default the script boots the in-memory channel-paid gateway
// (real GatewayService, routes, x402 service and SSE framing; mock provider;
// fake facilitator over a fake chain) and the proxy on ephemeral ports.
//
//   node scripts/verify-openai-sdk-compat.mjs
//
// To point the same checks at a running proxy, set
//   MCG_BASE_URL=http://127.0.0.1:8402 [MCG_MODEL=deepseek/deepseek-flash]
import OpenAI from 'openai';

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail && !condition ? ` — ${detail}` : ''}`);
}

let baseURL = process.env.MCG_BASE_URL?.replace(/\/$/, '');
let close = async () => undefined;

if (!baseURL) {
  const { createInMemoryGateway, fakeChainReader, PAYER_KEY } = await import('../test/helpers/in-memory-gateway.js');
  const { createProxy } = await import('../clients/x402-proxy/index.mjs');
  const { privateKeyToAccount } = await import('viem/accounts');
  const h = await createInMemoryGateway();
  const gatewayUrl = await h.app.listen({ host: '127.0.0.1', port: 0 });
  h.chain.mint(privateKeyToAccount(PAYER_KEY).address, 10_000_000n);
  const proxy = createProxy({ gatewayUrl, privateKey: PAYER_KEY, reader: fakeChainReader(h.chain), maxChannels: 4 });
  const address = await proxy.listen(0);
  baseURL = `http://127.0.0.1:${address.port}`;
  close = async () => { await proxy.close(); await h.app.close(); };
  console.log(`in-memory gateway at ${gatewayUrl}, x402 proxy at ${baseURL} (mock provider, fake facilitator)`);
} else {
  console.log(`targeting the proxy at ${baseURL}`);
}

const client = new OpenAI({ baseURL: `${baseURL}/v1`, apiKey: 'x402', maxRetries: 0 });
const model = process.env.MCG_MODEL ?? 'mock/echo';
const prompt = 'hello from the openai sdk';

try {
  // 1. GET /v1/models, no credential.
  const models = await client.models.list();
  const ids = models.data.map((m) => m.id);
  check('models.list returns an OpenAI list', models.object === 'list' && Array.isArray(models.data), JSON.stringify(models));
  check(`models.list includes ${model}`, ids.includes(model), `got ${ids.join(', ') || '(none)'}`);
  const entry = models.data.find((m) => m.id === model);
  check('model entries carry object/created/owned_by', entry?.object === 'model' && Number.isInteger(entry?.created) && typeof entry?.owned_by === 'string', JSON.stringify(entry));

  // 2. Non-streaming chat completion: the proxy pays, the SDK sees a plain completion.
  const completion = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 64 });
  check('non-streaming completion has a message', typeof completion.choices?.[0]?.message?.content === 'string', JSON.stringify(completion));
  check('non-streaming completion reports usage', Number.isInteger(completion.usage?.total_tokens), JSON.stringify(completion.usage));
  check('non-streaming completion reports the x402 charge', typeof completion.gateway?.x402?.charged_atomic === 'string' && completion.gateway.payment === 'x402', JSON.stringify(completion.gateway));
  if (model === 'mock/echo') check('mock echo content matches', completion.choices[0].message.content === `mock:${prompt}`, completion.choices[0].message.content);

  // 3. Streaming chat completion.
  const stream = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 64, stream: true });
  let text = '';
  let chunkCount = 0;
  let finishReason = null;
  let last = null;
  for await (const chunk of stream) {
    chunkCount += 1;
    last = chunk;
    for (const choice of chunk.choices ?? []) {
      text += choice.delta?.content ?? '';
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }
  check('streaming yields multiple chunks', chunkCount >= 2, `got ${chunkCount}`);
  check('streaming reports a finish_reason', finishReason !== null);
  check('streaming final chunk carries usage', Number.isInteger(last?.usage?.total_tokens) && last.choices.length === 0, JSON.stringify(last));
  check('streaming final chunk carries the x402 receipt', typeof last?.gateway?.x402?.payment_response === 'string' && typeof last?.gateway?.request_id === 'string', JSON.stringify(last?.gateway));
  check('streamed text matches the synchronous answer', text === completion.choices[0].message.content, `stream="${text}" sync="${completion.choices[0].message.content}"`);

  // 4. Concurrent calls each get a channel; none is refused as busy.
  const parallel = await Promise.all([1, 2, 3].map((i) => client.chat.completions.create({ model, messages: [{ role: 'user', content: `${prompt} ${i}` }], max_tokens: 64 })));
  check('three concurrent completions all settle', parallel.every((c) => typeof c.gateway?.x402?.cumulative_atomic === 'string'), JSON.stringify(parallel.map((c) => c.gateway)));
} catch (error) {
  check('no SDK error', false, error?.stack ?? String(error));
} finally {
  await close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
