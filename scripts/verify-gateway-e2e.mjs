#!/usr/bin/env node
// End-to-end checks against a running gateway, paid from a real wallet. By
// default through an API key created for the run (sign-in with the wallet,
// on the wallet's prepaid pool, automatic payment turned on if needed); `--proxy` pays through the
// local x402 proxy instead. Spends a few cents of USDC from the wallet.
//
//   node --env-file=.env scripts/verify-gateway-e2e.mjs [--proxy] [--long] [--agent]
//
// PRIVATE_KEY is the payer (USDC on Monad, no MON needed). MCG_BASE_URL
// defaults to https://router3.ai. --long streams past the old 120 s cut-off
// (about 4 minutes); --agent runs a small coding agent per model, all models
// at once, executing the code they write in a container without network
// (needs docker and the router3-mainnet-app image). Concurrent agents share
// one API key (or the proxy's channel pool).
//
// Each check names the regression it guards where one exists (2026-10-20).
import OpenAI from 'openai';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import zlib from 'node:zlib';
import { openPayment } from './lib/e2e-payment.mjs';

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) { console.error('PRIVATE_KEY (the payer wallet) is required'); process.exit(2); }
const gatewayUrl = (process.env.MCG_BASE_URL ?? 'https://router3.ai').replace(/\/(v1)?$/, '');
const payment = await openPayment({ gatewayUrl, privateKey, maxChannels: 16 });
const baseURL = `${payment.base}/v1`;
console.log(`${payment.mode}: ${payment.describe}, payer ${payment.payer}`);
const client = new OpenAI({ baseURL, apiKey: payment.token, maxRetries: 0, timeout: 900000 });
const DS = process.env.MCG_DS_MODEL ?? 'deepseek/deepseek-flash';
const OR = process.env.MCG_OR_MODEL ?? 'openrouter/moonshotai/kimi-k3';
const TEXT_ONLY = process.env.MCG_TEXT_ONLY_MODEL ?? 'deepseek/deepseek-v4-pro';
const VISION = [DS, OR];
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`ok   ${name} (${(Date.now() - started) / 1000}s) ${JSON.stringify(detail ?? '').slice(0, 200)}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`FAIL ${name} (${(Date.now() - started) / 1000}s) ${`${error.status ?? ''} ${error.code ?? error.error?.code ?? ''} ${error.message}`.trim().slice(0, 300)}`); }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const raw = (body) => fetch(`${baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${payment.token}` }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, code: (await r.json().catch(() => ({}))).error?.code }));
async function streamed(body) {
  const stream = await client.chat.completions.create({ ...body, stream: true });
  let text = '', last = null;
  for await (const chunk of stream) { text += chunk.choices[0]?.delta?.content ?? ''; if (chunk.usage) last = chunk; }
  assert(last?.usage && payment.charged(last.gateway), 'no final usage chunk with the charge');
  return { text, usage: last.usage, gateway: last.gateway };
}
// Provider usage is internally consistent; a recount by a proxy is not.
const saneUsage = (u) => assert((u.completion_tokens_details?.reasoning_tokens ?? 0) <= u.completion_tokens, `reasoning ${u.completion_tokens_details?.reasoning_tokens} > completion ${u.completion_tokens}`);
const weather = [{ type: 'function', function: { name: 'get_weather', description: 'Current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
function png(width, height, noise = false) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let x = 0xffffffff; for (const b of bytes) x = table[(x ^ b) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const typed = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed)); return Buffer.concat([len, typed, sum]); };
  const row = Buffer.alloc(1 + width * 3); for (let i = 0; i < width; i++) row.set([(i * 5) & 255, 128, 64], 1 + i * 3);
  const rows = noise ? Array.from({ length: height }, () => Buffer.concat([Buffer.alloc(1), randomBytes(width * 3)])) : Array(height).fill(row);
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

try {
  await check('list models', async () => { const m = await client.models.list(); assert(m.data.length > 0, 'empty catalog'); return { count: m.data.length }; });
  await check('terms: the gateway is ready for channel payments', async () => {
    const t = await (await fetch(`${gatewayUrl}/v1/x402`)).json(); assert(t.ready === true, JSON.stringify(t)); return { facilitator: t.facilitator, maxChannels: t.maxChannelsPerPayer };
  });

  for (const model of [DS, OR]) {
    const prompt = { model, messages: [{ role: 'user', content: '用一句话说明什么是 USDC。' }], max_tokens: 2000 };
    await check(`non-stream ${model}`, async () => {
      const r = await client.chat.completions.create(prompt);
      assert(r.choices[0].message.content, 'empty content'); saneUsage(r.usage);
      assert(payment.charged(r.gateway), `no charge: ${JSON.stringify(r.gateway)}`);
      return { usage: r.usage, charged: payment.charged(r.gateway) };
    });
    // Regression (2026-10-20): a proxy once recounted stream usage (prompt 23 for
    // Ark's 43, reasoning above completion) and billed its own numbers.
    await check(`stream bills provider usage: same prompt tokens as non-stream, ${model}`, async () => {
      const a = await client.chat.completions.create(prompt);
      const b = await streamed(prompt);
      saneUsage(b.usage);
      assert(a.usage.prompt_tokens === b.usage.prompt_tokens, `stream ${b.usage.prompt_tokens} vs non-stream ${a.usage.prompt_tokens}`);
      return { prompt: b.usage.prompt_tokens, completion: b.usage.completion_tokens };
    });
    await check(`tool call and tool result ${model}`, async () => {
      const messages = [{ role: 'user', content: '北京现在天气怎么样？请调用工具。' }];
      const first = await client.chat.completions.create({ model, messages, tools: weather, max_tokens: 2000 });
      const call = first.choices[0].message.tool_calls?.[0];
      assert(call?.function.name === 'get_weather', 'no tool call');
      messages.push(first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ temp_c: 18, sky: '晴' }) });
      const second = await client.chat.completions.create({ model, messages, tools: weather, max_tokens: 2000 });
      assert(/18/.test(second.choices[0].message.content ?? ''), 'answer ignores the tool result');
    });
    await check(`streamed tool call ${model}`, async () => {
      const stream = await client.chat.completions.create({ model, stream: true, messages: [{ role: 'user', content: '上海天气？请调用工具。' }], tools: weather, max_tokens: 2000 });
      let name = '', args = '';
      for await (const c of stream) { const tc = c.choices[0]?.delta?.tool_calls?.[0]; if (tc) { name += tc.function?.name ?? ''; args += tc.function?.arguments ?? ''; } }
      assert(name === 'get_weather' && JSON.parse(args).city, `bad call ${name} ${args}`);
    });
    await check(`json mode ${model}`, async () => {
      const r = await client.chat.completions.create({ model, response_format: { type: 'json_object' }, max_tokens: 2000,
        messages: [{ role: 'user', content: '以 JSON 返回三种编程语言及其诞生年份，格式 {"languages":[{"name":..,"year":..}]}' }] });
      // Claude has no JSON mode and may fence its JSON; the request itself must pass.
      const content = r.choices[0].message.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      assert(JSON.parse(content).languages?.length === 3, 'wrong shape');
    });
    // Regression: text sent as content parts, as agent clients do, was refused (2026-10-20).
    await check(`text as content parts ${model}`, async () => {
      const r = await client.chat.completions.create({ model, max_tokens: 500, messages: [{ role: 'user', content: [{ type: 'text', text: '只回复：好' }] }] });
      assert(r.choices[0].message.content, 'empty content');
    });
  }

  for (const model of VISION) {
    // Thinking models can spend a small budget on reasoning and return no text.
    const ask = (url) => ({ model, max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话描述这张图。' }, { type: 'image_url', image_url: { url } }] }] });
    await check(`image by base64 (4000x3000) ${model}`, async () => {
      const r = await client.chat.completions.create(ask(`data:image/png;base64,${png(4000, 3000).toString('base64')}`));
      assert(r.choices[0].message.content && r.usage.prompt_tokens > 500, `image not counted: ${r.usage.prompt_tokens}`);
      return { prompt: r.usage.prompt_tokens };
    });
    // Regression: nginx kept its 1 MiB limit until reloaded, so real photos sent
    // as base64 were refused with 413 before reaching the gateway.
    await check(`image larger than 1 MiB ${model}`, async () => {
      const url = `data:image/png;base64,${png(1000, 700, true).toString('base64')}`;
      assert(url.length > 2 * 1024 * 1024, 'test image too small');
      const r = await client.chat.completions.create(ask(url));
      assert(r.choices[0].message.content, 'empty content');
      return { bytes: url.length, prompt: r.usage.prompt_tokens };
    });
    await check(`image by URL ${model}`, async () => {
      const url = 'https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg';
      const r = await client.chat.completions.create(ask(url));
      assert(r.choices[0].message.content, 'empty content');
      return { prompt: r.usage.prompt_tokens };
    });
  }
  await check('image on a text-only model is refused before any payment', async () => {
    const r = await raw({ model: TEXT_ONLY, max_tokens: 20, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] });
    assert(r.status === 422 && r.code === 'MODEL_IMAGE_INPUT_UNSUPPORTED', JSON.stringify(r)); return r;
  });

  await check('reasoning model', async () => {
    const r = await client.chat.completions.create({ model: VISION[0], max_tokens: 2000, messages: [{ role: 'user', content: '数列 2, 6, 12, 20, 30 的下一个数是多少？只给数字。' }] });
    assert(/42/.test(r.choices[0].message.content), r.choices[0].message.content); saneUsage(r.usage);
  });
  await check('system prompt and multi-turn', async () => {
    const r = await client.chat.completions.create({ model: TEXT_ONLY, max_tokens: 500, messages: [{ role: 'system', content: '你只用英文大写回答。' },
      { role: 'user', content: '我叫小明。' }, { role: 'assistant', content: 'NICE TO MEET YOU.' }, { role: 'user', content: '我叫什么？' }] });
    assert(/[A-Z]/.test(r.choices[0].message.content), r.choices[0].message.content);
  });
  await check(payment.mode === 'proxy' ? '8 concurrent streams each pay from their own channel' : '8 concurrent streams on one API key', async () => {
    const before = await payment.view();
    const done = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => streamed({ model: i % 2 ? OR : DS, max_tokens: 500, messages: [{ role: 'user', content: `只回复数字 ${i}` }] })));
    assert(done.length === 8, 'missing streams');
    if (payment.proxy) assert(payment.proxy.pool.size >= Math.min(8, payment.proxy.pool.maxChannels), `pool only grew to ${payment.proxy.pool.size}`);
    const after = await payment.view();
    if (!payment.proxy) assert(BigInt(after.chargedAtomic) > BigInt(before.chargedAtomic) && after.running === 0, JSON.stringify(after));
    return payment.proxy ? { channels: after.channels } : { charged: after.chargedAtomic, unspent: after.unspentAtomic };
  });
  await check('errors: no payment 402, unknown model 404, empty messages 422, max_tokens beyond the model 422', async () => {
    const unpaid = await fetch(`${gatewayUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: DS, messages: [{ role: 'user', content: 'x' }], max_tokens: 10 }) });
    const got = [unpaid.status, (await raw({ model: 'nope/model', messages: [{ role: 'user', content: 'x' }] })).status,
      (await raw({ model: DS, messages: [] })).status, (await raw({ model: DS, messages: [{ role: 'user', content: 'x' }], max_tokens: 1000000 })).status];
    assert(JSON.stringify(got) === '[402,404,422,422]', JSON.stringify(got)); return got;
  });

  // Regression: the gateway's 120 s total timeout cut long streams mid-output.
  if (process.argv.includes('--long')) await check('a stream runs past 120 s', async () => {
    const started = Date.now();
    const r = await streamed({ model: process.env.MCG_LONG_MODEL ?? TEXT_ONLY, max_tokens: 12000,
      messages: [{ role: 'user', content: '用中文写一篇约 12000 字的长文：《分布式系统中的一致性：从 Paxos 到 CRDT》，分 12 节，每节详细展开。不要提前结束。' }] });
    const seconds = (Date.now() - started) / 1000;
    assert(seconds > 120, `finished in ${seconds}s; pick a slower model with MCG_LONG_MODEL`); saneUsage(r.usage);
    return { seconds, completion: r.usage.completion_tokens };
  });

  if (process.argv.includes('--agent')) {
    const task = {
      'package.json': '{ "type": "module", "private": true }\n',
      'TASK.md': '1. `src/slugify.js` has a bug: its tests fail. Fix it.\n2. Implement `src/lru.js`: export class `LRUCache` with `constructor(capacity)`, `get`, `set`, `delete`, `has` and a `size` getter; reads and writes make a key most recent; going over capacity evicts the least recent; capacity below 1 throws `RangeError`. See `test/lru.test.js`.\nRun the tests until everything passes. Do not modify test/.\n',
      'src/slugify.js': "export function slugify(text) {\n  return text.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()\n    .replace(/[^a-z0-9]+/, '-').replace(/^-|-$/, '');\n}\n",
      'test/slugify.test.js': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { slugify } from '../src/slugify.js';\ntest('dashes', () => assert.equal(slugify('Hello, World  Again'), 'hello-world-again'));\ntest('accents', () => assert.equal(slugify('Crème Brûlée'), 'creme-brulee'));\ntest('trim', () => assert.equal(slugify('  --Trim me--  '), 'trim-me'));\n",
      'test/lru.test.js': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { LRUCache } from '../src/lru.js';\ntest('evicts least recent', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.has('b'), false); assert.equal(c.size, 2); });\ntest('overwrite refreshes', () => { const c = new LRUCache(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.equal(c.get('a'), 9); assert.equal(c.has('b'), false); });\ntest('delete and falsy', () => { const c = new LRUCache(2); c.set('z', 0); assert.equal(c.get('z'), 0); assert.equal(c.delete('z'), true); assert.equal(c.size, 0); });\ntest('capacity', () => assert.throws(() => new LRUCache(0), RangeError));\n"
    };
    // Model-written code runs in a container. MCG_DOCKER is the command that
    // reaches Docker (e.g. "sudo -u ubuntu -g docker docker"); without access,
    // every test run would fail and look like the agent's fault.
    const docker = (process.env.MCG_DOCKER ?? 'docker').split(' ');
    execFileSync(docker[0], [...docker.slice(1), 'image', 'inspect', 'router3-mainnet-app'], { stdio: 'ignore' });
    const agent = async (model) => {
      const work = mkdtempSync(join(tmpdir(), 'router3-agent-'));
      try {
        for (const [path, content] of Object.entries(task)) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), content); }
        const inside = (p) => { const full = normalize(join(work, p)); if (!full.startsWith(work + '/')) throw new Error('path outside workspace'); return full; };
        const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
        const runTests = () => { try { return execFileSync(docker[0], [...docker.slice(1), 'run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--memory', '256m', '-v', `${work}:/w:ro`, '-w', '/w', 'router3-mainnet-app', 'node', '--test'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }).slice(-2000); } catch (e) { return `TESTS FAILED\n${String(e.stdout ?? '').slice(-2000)}`; } };
        const tools = { list_files: () => walk(work).join('\n'), read_file: ({ path }) => readFileSync(inside(path), 'utf8'),
          write_file: ({ path, content }) => { if (path.startsWith('test/')) return 'ERROR: tests are read-only'; mkdirSync(dirname(inside(path)), { recursive: true }); writeFileSync(inside(path), content); return 'ok'; }, run_tests: runTests };
        const fn = (name, properties = {}, required = []) => ({ type: 'function', function: { name, parameters: { type: 'object', properties, required } } });
        const defs = [fn('list_files'), fn('read_file', { path: { type: 'string' } }, ['path']), fn('write_file', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']), fn('run_tests')];
        const messages = [{ role: 'system', content: 'You are a coding agent in a small Node.js ESM repository. Use the tools. Stop calling tools once all tests pass.' }, { role: 'user', content: task['TASK.md'] }];
        let turns = 0;
        for (; turns < 20; turns++) {
          const stream = await client.chat.completions.create({ model, messages, tools: defs, stream: true, max_tokens: 8000 });
          const calls = []; let content = '', reasoning = '';
          for await (const chunk of stream) {
            const d = chunk.choices[0]?.delta ?? {}; content += d.content ?? ''; reasoning += d.reasoning_content ?? '';
            for (const tc of d.tool_calls ?? []) { calls[tc.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }; if (tc.id) calls[tc.index].id = tc.id;
              calls[tc.index].function.name += tc.function?.name ?? ''; calls[tc.index].function.arguments += tc.function?.arguments ?? ''; }
          }
          const list = calls.filter(Boolean);
          messages.push({ role: 'assistant', content: content || null, ...(list.length ? { tool_calls: list } : {}), ...(reasoning && list.length ? { reasoning_content: reasoning } : {}) });
          if (!list.length) break;
          for (const call of list) { let out; try { out = String(tools[call.function.name](JSON.parse(call.function.arguments || '{}'))); } catch (e) { out = `ERROR: ${e.message}`; }
            messages.push({ role: 'tool', tool_call_id: call.id, content: out.slice(0, 8000) }); }
        }
        assert(!runTests().startsWith('TESTS FAILED'), 'tests still fail');
        return { turns };
      } finally { rmSync(work, { recursive: true, force: true }); }
    };
    // All agents at once: each of their concurrent calls takes a channel from the pool.
    const models = [DS, OR, TEXT_ONLY];
    const outcomes = await Promise.allSettled(models.map(agent));
    for (const [i, outcome] of outcomes.entries()) {
      await check(`coding agent ${models[i]} (run in parallel with ${models.length - 1} others)`, async () => { if (outcome.status === 'rejected') throw outcome.reason; return outcome.value; });
    }
  }
} finally {
  console.log(`closed: ${JSON.stringify(await payment.close())}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed (${payment.mode})`);
process.exitCode = failed.length ? 1 : 0;
