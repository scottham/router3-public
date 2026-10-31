import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import { PERMIT_TYPES, POOL_TYPES } from '../src/pool/contract.js';
import { createInMemoryGateway, chatBody, TEST_SESSION_TOKEN } from './helpers/in-memory-gateway.js';

// A key reads its own dashboard with nothing but the key: spend and limits,
// the pool as it concerns the key, usage by day and model, recent calls.
// Never the wallet's address or balance; never a write.
const session = { authorization: `Bearer ${TEST_SESSION_TOKEN}` };
const USDC = 1_000_000n;

async function setup(t) {
  const wallet = Wallet.createRandom();
  const h = await createInMemoryGateway({ sessionWallet: wallet.address });
  t.after(() => h.app.close());
  h.poolChain.mint(wallet.address, 50n * USDC);
  const created = (await h.app.inject({ method: 'POST', url: '/v1/keys', headers: session, payload: { name: 'dsh', dailyLimitUsdc: '3' } })).json();
  const { terms, nonces } = (await h.app.inject({ method: 'GET', url: '/v1/pool', headers: session })).json();
  const deadline = String(Math.floor(Date.now() / 1000) + 3600);
  const allowance = 100n * USDC, refillTarget = 5n * USDC, dailyLimit = 20n * USDC;
  const payload = {
    permit: { value: String(allowance), deadline, signature: await wallet.signTypedData(terms.usdcDomain, PERMIT_TYPES,
      { owner: wallet.address, spender: terms.poolAddress, value: allowance, nonce: BigInt(nonces.usdc), deadline: BigInt(deadline) }) },
    configure: { refillTarget: String(refillTarget), dailyLimit: String(dailyLimit), nonce: nonces.pool, deadline,
      signature: await wallet.signTypedData(terms.poolDomain, { Configure: POOL_TYPES.Configure },
        { owner: wallet.address, refillTarget, dailyLimit, nonce: BigInt(nonces.pool), deadline: BigInt(deadline) }) }
  };
  assert.equal((await h.app.inject({ method: 'POST', url: '/v1/pool/setup', headers: session, payload })).statusCode, 202);
  for (let i = 0; i < 4; i++) await h.poolWorker.tick();
  const auth = { authorization: `Bearer ${created.token}` };
  const get = (url, headers = auth) => h.app.inject({ method: 'GET', url, headers });
  return { h, wallet, token: created.token, key: created.key, auth, get };
}

test('GET /v1/key: the key, its spend today and the pool as the key sees it; no wallet address or balance', async (t) => {
  const { h, wallet, auth, get } = await setup(t);
  for (let i = 0; i < 3; i++) assert.equal((await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: chatBody() })).statusCode, 200);
  const response = await get('/v1/key');
  assert.equal(response.statusCode, 200, response.body);
  const { key, pool } = response.json();
  assert.equal(key.name, 'dsh'); assert.equal(key.dailyLimitAtomic, String(3n * USDC)); assert.equal(key.running, 0);
  assert.ok(BigInt(key.spentTodayAtomic) > 0n); assert.equal(key.spentTodayAtomic, key.spentAtomic);
  assert.equal(key.maxConcurrency, 128); assert.ok(key.requestLimitAtomic); assert.equal(key.holdOutputTokens, 8192);
  assert.equal(pool.state, 'active'); assert.equal(pool.refillTargetAtomic, String(5n * USDC)); assert.equal(pool.dailyLimitAtomic, String(20n * USDC));
  assert.ok(BigInt(pool.availableAtomic) > 0n); assert.equal(pool.refillable, true);
  assert.equal(pool.walletBalanceAtomic, undefined); assert.equal(pool.ops, undefined);
  assert.ok(!response.body.toLowerCase().includes(wallet.address.toLowerCase()), 'the wallet address is not in the response');
});

test('GET /v1/key/usage and /v1/key/requests: by day, by model, and the recent calls with tokens and latency', async (t) => {
  const { h, auth, get } = await setup(t);
  for (let i = 0; i < 2; i++) await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: chatBody() });
  const failed = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: chatBody({ model: 'mock/missing' }) });
  assert.notEqual(failed.statusCode, 200);
  const usage = (await get('/v1/key/usage?days=7')).json();
  assert.equal(usage.days, 7);
  assert.equal(usage.daily.length, 1); assert.equal(usage.daily[0].day, new Date().toISOString().slice(0, 10));
  assert.equal(usage.daily[0].requests, 2); assert.equal(usage.daily[0].failed, 0);
  assert.ok(BigInt(usage.daily[0].input_tokens) > 0n); assert.ok(BigInt(usage.daily[0].output_tokens) > 0n);
  assert.deepEqual(usage.models.map((m) => m.model), ['mock/echo']);
  assert.equal(usage.models[0].requests, 2); assert.equal(usage.models[0].charged_atomic, usage.daily[0].charged_atomic);
  assert.equal(typeof usage.models[0].avg_latency_ms, 'number');
  const requests = (await get('/v1/key/requests?limit=1')).json();
  assert.equal(requests.items.length, 1); assert.ok(requests.next);
  const [item] = requests.items;
  assert.equal(item.model, 'mock/echo'); assert.equal(item.status, 'completed'); assert.equal(item.charged_from, 'usage');
  assert.ok(item.usage.inputTokens > 0); assert.equal(typeof item.latency_ms, 'number');
  const page = (await get(`/v1/key/requests?limit=5&before=${encodeURIComponent(requests.next)}`)).json();
  assert.equal(page.items.length, 1); assert.equal(page.next, null);
  assert.notEqual(page.items[0].id, item.id);
  assert.equal((await get('/v1/key/usage?days=0')).statusCode, 422);
});

test('the key alone authenticates; a wallet session, a bad key or a revoked key do not', async (t) => {
  const { h, key, get } = await setup(t);
  assert.equal((await get('/v1/key', {})).statusCode, 401);
  assert.equal((await get('/v1/key', session)).statusCode, 401);
  assert.equal((await get('/v1/key', { 'x-api-key': 'r3_live_nope' })).statusCode, 401);
  assert.equal((await get('/v1/key', { authorization: 'Bearer r3_live_' + 'a'.repeat(43) })).statusCode, 401);
  await h.app.inject({ method: 'DELETE', url: `/v1/keys/${key.id}`, headers: session });
  const revoked = await get('/v1/key');
  assert.equal(revoked.statusCode, 401); assert.equal(revoked.json().error.code, 'API_KEY_INVALID');
});

test('the balance shapes other clients read: OpenAI dashboard, OpenRouter key and credits, DeepSeek balance', async (t) => {
  const { h, auth, get } = await setup(t);
  await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: auth, payload: chatBody() });
  const { key, pool } = (await get('/v1/key')).json();
  const spent = Number(key.spentAtomic) / 1e6, available = Number(pool.availableAtomic) / 1e6;
  assert.ok(spent > 0 && available > 0);
  // The key's daily limit of 3 USDC is below the pool's available amount.
  const remaining = Math.min(available, 3 - spent);
  const subscription = (await get('/v1/dashboard/billing/subscription')).json();
  assert.equal(subscription.object, 'billing_subscription'); assert.ok(Math.abs(subscription.hard_limit_usd - (spent + remaining)) < 1e-9);
  const today = new Date().toISOString().slice(0, 10);
  const usage = (await get(`/v1/dashboard/billing/usage?start_date=${today}&end_date=2099-01-01`)).json();
  assert.ok(Math.abs(usage.total_usage - spent * 100) < 1e-6, 'cents');
  assert.equal((await get(`/v1/dashboard/billing/usage?start_date=2099-01-01`)).json().total_usage, 0);
  assert.equal((await get('/v1/dashboard/billing/usage?start_date=yesterday')).statusCode, 422);
  const authKey = (await get('/v1/auth/key')).json().data;
  assert.equal(authKey.label, 'dsh'); assert.equal(authKey.usage, spent); assert.equal(authKey.limit, null);
  assert.ok(Math.abs(authKey.limit_remaining - remaining) < 1e-9);
  const credits = (await get('/v1/credits')).json().data;
  assert.equal(credits.total_usage, spent); assert.ok(Math.abs(credits.total_credits - (spent + authKey.limit_remaining)) < 1e-9);
  for (const path of ['/user/balance', '/v1/user/balance']) {
    const b = (await get(path)).json();
    assert.equal(b.is_available, true); assert.equal(b.balance_infos[0].currency, 'USD'); assert.equal(b.balance_infos[0].total_balance, authKey.limit_remaining.toFixed(2));
  }
  assert.equal((await get('/v1/credits', {})).statusCode, 401);
});
