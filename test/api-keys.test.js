import assert from 'node:assert/strict';
import test from 'node:test';
import { Wallet } from 'ethers';
import { MockProvider } from '../src/providers/mock.js';
import { PERMIT_TYPES, POOL_TYPES } from '../src/pool/contract.js';
import { createInMemoryGateway, chatBody, InMemoryGatewayRepository, mockModel, TEST_SESSION_TOKEN } from './helpers/in-memory-gateway.js';

// API keys bill from the wallet's prepaid pool. The wallet signs a USDC permit
// to the pool and its limits once; the collector relays them, refills the pool
// from the wallet and debits settled usage; every key of the wallet shares it.
const session = { authorization: `Bearer ${TEST_SESSION_TOKEN}` };
const USDC = 1_000_000n;
const deadline = () => String(Math.floor(Date.now() / 1000) + 3600);

async function setup(t, { provider, config, models, mint = 50n * USDC } = {}) {
  const wallet = Wallet.createRandom();
  const repository = new InMemoryGatewayRepository({ models: models ?? [mockModel({ customer_output_usdc_nano_per_million: '2000000000' })] });
  const h = await createInMemoryGateway({ repository, ...(provider ? { providers: { get: () => provider } } : {}), config, sessionWallet: wallet.address });
  t.after(() => h.app.close());
  if (mint) h.poolChain.mint(wallet.address, mint);
  const created = await h.app.inject({ method: 'POST', url: '/v1/keys', headers: session, payload: { name: 'laptop' } });
  assert.equal(created.statusCode, 201, created.body);
  const { token, key } = created.json();
  const call = (body = chatBody(), headers = { authorization: `Bearer ${token}` }) => h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: body });
  const listed = async () => (await h.app.inject({ method: 'GET', url: '/v1/keys', headers: session })).json();
  const signSetup = async ({ allowance = 100n * USDC, refillTarget = 5n * USDC, dailyLimit = 20n * USDC } = {}) => {
    const { terms, nonces } = (await h.app.inject({ method: 'GET', url: '/v1/pool', headers: session })).json();
    const d = deadline();
    const permit = { value: String(allowance), deadline: d, signature: await wallet.signTypedData(terms.usdcDomain, PERMIT_TYPES,
      { owner: wallet.address, spender: terms.poolAddress, value: allowance, nonce: BigInt(nonces.usdc), deadline: BigInt(d) }) };
    const configure = { refillTarget: String(refillTarget), dailyLimit: String(dailyLimit), nonce: nonces.pool, deadline: d,
      signature: await wallet.signTypedData(terms.poolDomain, { Configure: POOL_TYPES.Configure },
        { owner: wallet.address, refillTarget, dailyLimit, nonce: BigInt(nonces.pool), deadline: BigInt(d) }) };
    return { permit, configure };
  };
  const turnOn = async (options) => {
    const response = await h.app.inject({ method: 'POST', url: '/v1/pool/setup', headers: session, payload: await signSetup(options) });
    assert.equal(response.statusCode, 202, response.body);
    for (let i = 0; i < 4; i++) await h.poolWorker.tick();
  };
  const signPool = async (primaryType, message) => {
    const { terms, nonces } = (await h.app.inject({ method: 'GET', url: '/v1/pool', headers: session })).json();
    const d = deadline();
    const signature = await wallet.signTypedData(terms.poolDomain, { [primaryType]: POOL_TYPES[primaryType] },
      { owner: wallet.address, ...message, nonce: BigInt(nonces.pool), deadline: BigInt(d) });
    return { ...Object.fromEntries(Object.entries(message).map(([k, v]) => [k, String(v)])), nonce: nonces.pool, deadline: d, signature };
  };
  return { h, wallet, token, key, call, listed, signSetup, turnOn, signPool, payer: wallet.address.toLowerCase() };
}

function gatedProvider() {
  const mock = new MockProvider();
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let waiting = 0;
  return { release: () => open(), waiting: () => waiting, async invoke(request, model) { waiting++; await gate; return mock.invoke(request, model); } };
}

test('a new key works once automatic payment is on: one setup, the pool refills from the wallet, no deposit per key', async (t) => {
  const { h, call, listed, turnOn, payer, wallet } = await setup(t);
  const before = await call();
  assert.equal(before.statusCode, 402); assert.equal(before.json().error.code, 'POOL_NOT_SET_UP');
  await turnOn();
  const pool = (await listed()).pool;
  assert.equal(pool.state, 'active');
  assert.equal(pool.poolBalanceAtomic, String(5n * USDC), 'refilled to the target from the wallet');
  assert.equal(h.poolChain.balanceOf(wallet.address), 45n * USDC);
  const ok = await call();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().gateway.payment, 'api_key');
  // A second key of the same wallet needs nothing more.
  const second = (await h.app.inject({ method: 'POST', url: '/v1/keys', headers: session, payload: { name: 'ci' } })).json();
  assert.equal((await call(chatBody(), { 'x-api-key': second.token })).statusCode, 200);
  const account = await h.poolStore.account(payer);
  assert.ok(account.unsettled_atomic > 50_000n, 'the activation fee and both calls are owed');
  assert.equal(account.held_atomic, 0n); assert.equal(account.running, 0);
});

test('many requests at once share the pool; holds stop at what is available and at the concurrency limit', async (t) => {
  const provider = gatedProvider();
  const { call, listed, turnOn } = await setup(t, { provider, config: { API_KEY_MAX_CONCURRENCY: 40, REAL_MODEL_CALLS_ENABLED: true, POOL_REFILL_WAIT_MS: 0,
    // Hold all of max_tokens here, so one request can outgrow the pool.
    API_KEY_HOLD_OUTPUT_TOKENS: 2_000_000 } });
  await turnOn({ refillTarget: 2n * USDC });
  const pending = Array.from({ length: 30 }, (_, i) => call(chatBody({ messages: [{ role: 'user', content: `call ${i}` }] })));
  while (provider.waiting() < 30) await new Promise((r) => setTimeout(r, 5));
  assert.equal((await listed()).pool.running, 30);
  // 1M output tokens at 2 USDC per million: more than the pool has left.
  const big = await call(chatBody({ max_tokens: 1_000_000 }));
  assert.equal(big.statusCode, 402); assert.equal(big.json().error.code, 'INSUFFICIENT_BALANCE');
  provider.release();
  assert.deepEqual((await Promise.all(pending)).filter((r) => r.statusCode !== 200).map((r) => r.body), []);
  assert.equal((await listed()).pool.running, 0);
});

test('the concurrency limit answers 429', async (t) => {
  const provider = gatedProvider();
  const { call, turnOn } = await setup(t, { provider, config: { API_KEY_MAX_CONCURRENCY: 2, REAL_MODEL_CALLS_ENABLED: true } });
  await turnOn();
  const pending = [call(), call()];
  while (provider.waiting() < 2) await new Promise((r) => setTimeout(r, 5));
  const third = await call();
  assert.equal(third.statusCode, 429); assert.equal(third.json().error.code, 'API_KEY_CONCURRENCY_LIMIT');
  provider.release();
  assert.ok((await Promise.all(pending)).every((r) => r.statusCode === 200));
});

test('a request that does not fit waits for a refill and then runs; usage is debited to the Treasury and swept', async (t) => {
  // 100 USDC per million output tokens: each call holds and costs about 0.8 USDC.
  const priced = mockModel({ customer_output_usdc_nano_per_million: '100000000000' });
  const mock = new MockProvider();
  const provider = { async invoke(request, model) { const r = await mock.invoke(request, model); return { ...r, usage: { ...r.usage, outputTokens: 8000 } }; } };
  const { h, call, turnOn, payer } = await setup(t, { models: [priced], provider, config: { REAL_MODEL_CALLS_ENABLED: true, POOL_SWEEP_MIN_USDC: '1' } });
  await turnOn({ refillTarget: 2n * USDC });
  const timer = setInterval(() => h.poolWorker.tick().catch(() => {}), 20);
  t.after(() => clearInterval(timer));
  for (let i = 0; i < 8; i++) {
    const r = await call(chatBody({ max_tokens: 8000 }));
    assert.equal(r.statusCode, 200, `call ${i}: ${r.body}`);
  }
  clearInterval(timer);
  for (let i = 0; i < 6; i++) await h.poolWorker.tick();
  const batches = [...h.poolStore.batches.values()].filter((b) => b.state === 'confirmed');
  assert.ok(batches.some((b) => b.refill_result === 'refilled' && b.debit_atomic > 0n), 'a refill carried a debit');
  const debited = batches.reduce((s, b) => s + b.debit_atomic, 0n);
  const covered = [...h.poolStore.requests.values()].filter((r) => r.batch_id && h.poolStore.batches.get(r.batch_id).state === 'confirmed')
    .reduce((s, r) => s + r.charged_atomic, 0n);
  assert.equal(debited, covered, 'every debit is exactly the charges it covers');
  assert.ok(debited >= 5n * USDC);
  assert.equal(h.poolChain.treasuryBalance + h.poolChain.treasuryAccruedAtomic, debited);
  assert.ok(h.poolChain.treasuryBalance > 0n, 'swept to the Treasury');
  assert.equal((await h.poolStore.account(payer)).pool_balance_atomic, h.poolChain.account(payer).balance);
});

test('charges are bounded by the pool and today\'s limit; what does not fit is recorded as unbilled', async (t) => {
  const priced = mockModel({ customer_input_usdc_nano_per_million: '1000000000', customer_output_usdc_nano_per_million: '2000000000' });
  const mock = new MockProvider();
  // Reports 3M input tokens: 3 USDC each, far above the hold.
  const provider = { async invoke(request, model) { const r = await mock.invoke(request, model);
    return { ...r, usage: { inputTokens: 3_000_000, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 } }; } };
  const { h, call, turnOn, payer } = await setup(t, { models: [priced], provider, config: { REAL_MODEL_CALLS_ENABLED: true } });
  await turnOn({ refillTarget: 5n * USDC, dailyLimit: 4n * USDC });
  const first = await call();
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(BigInt(first.json().gateway.billed_usdc_nano) >= 3_000_000_000n, 'charged in full above the hold');
  const second = await call();
  assert.equal(second.statusCode, 200, second.body);
  const last = [...h.poolStore.requests.values()].filter((r) => r.kind === 'request').at(-1);
  assert.ok(last.unbilled_overrun_usdc_nano > 0n, 'the second charge hit today\'s 4 USDC limit');
  const account = await h.poolStore.account(payer);
  assert.ok(account.unsettled_atomic <= account.daily_remaining_atomic, 'never owed more than today can debit');
});

test('a key\'s own daily and total limits stop it; other keys keep working', async (t) => {
  const { h, call, turnOn, key } = await setup(t, { config: { REAL_MODEL_CALLS_ENABLED: true } });
  await turnOn();
  const patched = await h.app.inject({ method: 'PATCH', url: `/v1/keys/${key.id}`, headers: session, payload: { dailyLimitUsdc: '0.00005' } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json().key.dailyLimitAtomic, '50');
  const r = await call();
  assert.equal(r.statusCode, 402); assert.equal(r.json().error.code, 'API_KEY_DAILY_LIMIT');
  const other = (await h.app.inject({ method: 'POST', url: '/v1/keys', headers: session, payload: { name: 'other', totalLimitUsdc: 1 } })).json();
  assert.equal(other.key.totalLimitAtomic, String(USDC));
  assert.equal((await call(chatBody(), { authorization: `Bearer ${other.token}` })).statusCode, 200);
});

test('withdrawing stops calls; owed usage is debited first, then the pool goes back to the wallet and refills stop', async (t) => {
  const { h, call, turnOn, signPool, payer, wallet } = await setup(t, { config: { REAL_MODEL_CALLS_ENABLED: true } });
  await turnOn();
  assert.equal((await call()).statusCode, 200);
  const request = await h.app.inject({ method: 'POST', url: '/v1/pool/withdrawal', headers: session, payload: await signPool('RequestWithdrawal', { amount: 1000n * USDC }) });
  assert.equal(request.statusCode, 202, request.body);
  for (let i = 0; i < 3; i++) await h.poolWorker.tick();
  const refused = await call();
  assert.equal(refused.statusCode, 402); assert.equal(refused.json().error.code, 'POOL_WITHDRAWING');
  // The delay passes.
  const later = Math.floor(Date.now() / 1000) + 3600;
  h.poolChain.now = () => later; h.poolWorker.now = () => new Date(later * 1000);
  for (let i = 0; i < 6; i++) await h.poolWorker.tick();
  const account = await h.poolStore.account(payer);
  assert.equal(account.pool_balance_atomic, 0n);
  assert.equal(account.refill_target_atomic, 0n, 'refills are off until the wallet turns them on again');
  assert.equal(account.unsettled_atomic, 0n, 'everything owed was debited before the withdrawal');
  const debited = [...h.poolStore.batches.values()].filter((b) => b.state === 'confirmed').reduce((s, b) => s + b.debit_atomic, 0n);
  assert.equal(h.poolChain.balanceOf(wallet.address), 50n * USDC - debited);
});

test('signatures that do not match the wallet are refused before anything is queued', async (t) => {
  const { h, signSetup } = await setup(t);
  const body = await signSetup();
  body.configure.dailyLimit = String(1000n * USDC);
  const response = await h.app.inject({ method: 'POST', url: '/v1/pool/setup', headers: session, payload: body });
  assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'POOL_SIGNATURE_INVALID');
  assert.ok([...h.poolStore.ops.values()].every((o) => o.kind === 'permit'), 'only the valid permit was queued');
});

test('a wallet without the minimum USDC cannot have a gasless permit relayed', async (t) => {
  const { h, signSetup } = await setup(t, { mint: 0n });
  const response = await h.app.inject({ method: 'POST', url: '/v1/pool/setup', headers: session, payload: await signSetup() });
  assert.equal(response.statusCode, 422); assert.equal(response.json().error.code, 'POOL_PERMIT_BALANCE_LOW');
});

test('an API key request may hold up to the key limit; the same request signed by a wallet is refused above 5 USDC', async (t) => {
  // 20 USDC per million input tokens: 1.2 MB of text (about 400k tokens) holds 8 USDC.
  const priced = mockModel({ customer_input_usdc_nano_per_million: '20000000000' });
  const { h, call, turnOn } = await setup(t, { models: [priced], config: { API_KEY_REQUEST_LIMIT_USDC: '50' } });
  await turnOn({ refillTarget: 20n * USDC, dailyLimit: 50n * USDC });
  const body = chatBody({ messages: [{ role: 'user', content: 'x'.repeat(1_200_000) }], max_tokens: 100 });
  const viaKey = await call(body);
  assert.equal(viaKey.statusCode, 200, viaKey.body);
  const unpaid = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
  assert.equal(unpaid.statusCode, 402); assert.equal(unpaid.json().error.code, 'X402_REQUEST_LIMIT');
});

test('an API key request holds at most 8192 output tokens; max_tokens is forwarded unchanged and a longer answer is charged in full', async (t) => {
  // 15 USDC per million output tokens (Kimi K3): max_tokens 32000 would hold 0.48 USDC of output.
  const priced = mockModel({ customer_output_usdc_nano_per_million: '15000000000' });
  const mock = new MockProvider();
  const forwarded = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const provider = { async invoke(request, model) { forwarded.push(request.max_tokens); await gate; const result = await mock.invoke(request, model);
    return { ...result, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20_000, reasoningTokens: 0 } }; } };
  const { h, call, turnOn } = await setup(t, { models: [priced], provider, config: { REAL_MODEL_CALLS_ENABLED: true } });
  await turnOn({ refillTarget: 6n * USDC });
  const body = chatBody({ max_tokens: 32_000 });
  // 6 USDC: holds of 0.48 USDC would let only 12 run at once; at 8192 tokens (about 0.12 USDC) all 16 do.
  const pending = Array.from({ length: 16 }, () => call(body));
  while (forwarded.length < 16) await new Promise((r) => setTimeout(r, 5));
  open();
  const calls = await Promise.all(pending);
  assert.deepEqual(calls.filter((r) => r.statusCode !== 200).map((r) => r.body), []);
  assert.deepEqual([...new Set(forwarded)], [32_000]);
  for (const row of [...h.poolStore.requests.values()].filter((r) => r.kind === 'request')) {
    // 8192 × 15 per million = 0.12288 USDC of output, plus a little input.
    assert.ok(row.ceiling_atomic >= 122_880n && row.ceiling_atomic < 130_000n, `hold ${row.ceiling_atomic}`);
    assert.ok(row.charged_atomic >= 300_000n || row.unbilled_overrun_usdc_nano > 0n, `charged ${row.charged_atomic}`);
  }
  // Signed by a wallet, the hold is the voucher ceiling and covers all of max_tokens.
  const plan = await h.service.plan('chat', body);
  assert.ok(plan.ceilingAtomic >= 480_000n, `x402 hold ${plan.ceilingAtomic}`);
});

test('keys are private to their wallet', async (t) => {
  const { h, key } = await setup(t);
  const other = await createInMemoryGateway({ sessionWallet: Wallet.createRandom().address });
  t.after(() => other.app.close());
  assert.equal((await h.app.inject({ method: 'GET', url: `/v1/keys/${key.id}/requests`, headers: session })).statusCode, 200);
  const foreign = await other.app.inject({ method: 'PATCH', url: `/v1/keys/${key.id}`, headers: session, payload: { dailyLimitUsdc: 1 } });
  assert.equal(foreign.statusCode, 404);
});

test('a database hiccup while writing the usage charge is retried; the ceiling is charged only when the usage write keeps failing', async (t) => {
  const { h, call, turnOn } = await setup(t);
  await turnOn();
  h.keys.settleRetryMs = 1;
  const close = h.pool.close.bind(h.pool);
  let failures = 0;
  h.pool.close = async (...args) => { if (failures > 0) { failures--; throw new Error('database unavailable'); } return close(...args); };
  const rows = () => [...h.poolStore.requests.values()].filter((r) => r.kind === 'request');
  // Two failures: settle() retries and the response is normal.
  failures = 2;
  const ok = await call();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(rows().at(-1).charged_from, 'usage');
  // Three: execute() gives up, but fail() writes the usage charge instead of the ceiling.
  failures = 3;
  const late = await call();
  assert.equal(late.statusCode, 500, late.body);
  assert.equal(rows().at(-1).charged_from, 'usage');
  // Four: nothing could record the usage, so the hold is charged.
  failures = 4;
  await call();
  assert.equal(rows().at(-1).charged_from, 'ceiling');
  assert.equal(rows().length, 3);
  const account = await h.poolStore.account((await h.poolStore.accountsToCollect())[0].payer);
  assert.equal(account.running, 0); assert.equal(account.held_atomic, 0n);
});

test('a confirmed configure syncs the wallet\'s OpenRouter key limit at once', async (t) => {
  const { h, turnOn, payer } = await setup(t);
  const synced = [];
  h.poolWorker.providerKeys = { async syncPayer(p) { synced.push(p); return null; } };
  await turnOn();
  assert.deepEqual(synced, [payer]);
});

test('actual charges above their holds respect both per-key hard limits under concurrency',async(t)=>{
  const mock=new MockProvider();let release,waiting=0;
  const gate=new Promise(r=>release=r);
  const provider={async invoke(request,model){waiting++;await gate;const r=await mock.invoke(request,model);
    return {...r,usage:{inputTokens:100,cachedInputTokens:0,outputTokens:20000,reasoningTokens:0}};}};
  const {h,call,turnOn,key}=await setup(t,{provider,models:[mockModel({customer_output_usdc_nano_per_million:'15000000000'})]});
  await turnOn();
  await h.keys.setLimits(await h.keys.owned((await h.poolStore.accountsToCollect())[0].payer,key.id),{dailyLimitAtomic:300000n,totalLimitAtomic:300000n});
  const pending=[call(chatBody({max_tokens:32000})),call(chatBody({max_tokens:32000}))];
  while(waiting<2)await new Promise(r=>setTimeout(r,1));
  release();
  assert.ok((await Promise.all(pending)).every(r=>r.statusCode===200));
  const rows=[...h.poolStore.requests.values()].filter(r=>r.api_key_id===key.id);
  assert.equal(rows.reduce((s,r)=>s+r.charged_atomic,0n),300000n);
  assert.ok(rows.every(r=>r.unbilled_overrun_usdc_nano>0n));
  assert.equal((await call()).json().error.code,'API_KEY_DAILY_LIMIT');
});

test('a changed key limit is read again when an in-flight request settles',async(t)=>{
  const mock=new MockProvider();let release,waiting=false;const gate=new Promise(r=>release=r);
  const provider={async invoke(request,model){waiting=true;await gate;const r=await mock.invoke(request,model);
    return {...r,usage:{inputTokens:100,cachedInputTokens:0,outputTokens:20000,reasoningTokens:0}};}};
  const {h,call,turnOn,key,payer}=await setup(t,{provider,models:[mockModel({customer_output_usdc_nano_per_million:'15000000000'})]});
  await turnOn();
  const pending=call(chatBody({max_tokens:32000}));while(!waiting)await new Promise(r=>setTimeout(r,1));
  await h.keys.setLimits(await h.keys.owned(payer,key.id),{dailyLimitAtomic:null,totalLimitAtomic:200000n});
  release();assert.equal((await pending).statusCode,200);
  assert.equal((await h.poolStore.keyTotals(payer,new Date(0))).get(key.id).total,200000n);
});

test('removing a payer from the allowlist rejects its existing key for calls and dashboards',async(t)=>{
  const {h,call,turnOn,token}=await setup(t);await turnOn();
  assert.equal((await call()).statusCode,200);
  h.config.AUTH_ALLOWED_ADDRESSES=['0x00000000000000000000000000000000000000b1'];
  const refused=await call();assert.equal(refused.statusCode,403);assert.equal(refused.json().error.code,'ADDRESS_NOT_ALLOWED');
  const dashboard=await h.app.inject({url:'/v1/key',headers:{authorization:`Bearer ${token}`}});
  assert.equal(dashboard.statusCode,403);
});
