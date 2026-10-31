// A database-free gateway paid through x402 channels: the real GatewayService,
// routes, x402 service and channel ledger, wired to an in-memory catalog, an
// in-memory channel mirror, the fake facilitator (real signatures over a fake
// chain) and the deterministic mock provider. Used by the unit tests, the
// proxy test and scripts/verify-openai-sdk-compat.mjs, so none of them needs
// PostgreSQL, a provider key or a facilitator. Nothing here moves money;
// amounts are plain integers on the fake chain.
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { Wallet } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { BatchSettlementEvmScheme as ClientScheme } from '@x402/evm/batch-settlement/client';
import { toClientEvmSigner } from '@x402/evm';
import { InMemoryChannelStorage } from '@x402/evm/batch-settlement/server';
import { AppError, publicError } from '../../src/lib/errors.js';
import { GatewayService } from '../../src/services/gateway-service.js';
import { registerGatewayRoutes } from '../../src/routes/gateway-routes.js';
import { registerX402Routes } from '../../src/routes/x402-routes.js';
import { registerKeyRoutes } from '../../src/routes/key-routes.js';
import { registerKeySelfRoutes } from '../../src/routes/key-self-routes.js';
import { ApiKeyService } from '../../src/x402/api-keys.js';
import { X402Service, X402_NETWORK } from '../../src/x402/service.js';
import { LocalAuthorizerSigner } from '../../src/x402/authorizer.js';
import { MockProvider } from '../../src/providers/mock.js';
import { FakeChain, FakeFacilitator, InMemoryX402Repository } from './x402-fake-facilitator.js';
import { registerPoolRoutes } from '../../src/routes/pool-routes.js';
import { PoolBilling } from '../../src/pool/billing.js';
import { InMemoryPoolStore } from '../../src/pool/store.js';
import { PoolWorker } from '../../src/workers/pool-worker.js';
import { FakePoolChain, FakePoolSender } from './fake-pool-chain.js';

const key = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
export const TREASURY = new Wallet(key(9001));
export const SETTLER = new Wallet(key(9002));
export const PAYER_KEY = key(9003);
export const OTHER_PAYER_KEY = key(9004);
export const TEST_SESSION_TOKEN = 'mcg_session_inmemory_browser_session_token_0123456789';
export const SESSION_WALLET = '0x' + 'ab'.repeat(20);
export const GATEWAY_URL = 'https://gateway.test';

export function mockModel(overrides = {}) {
  return {
    model_id: '00000000-0000-4000-8000-000000000100',
    price_version_id: '00000000-0000-4000-8000-000000000101',
    public_name: 'mock/echo',
    provider: 'mock',
    provider_model: 'mock/echo',
    modality: 'text',
    capabilities: { reasoningIncludedInOutput: true },
    created_at: '2026-01-01T00:00:00.000Z',
    customer_input_usdc_nano_per_million: '1000000',
    customer_cached_input_usdc_nano_per_million: '500000',
    customer_output_usdc_nano_per_million: '2000000',
    customer_reasoning_usdc_nano_per_million: '0',
    provider_input_usd_nano_per_million: '800000',
    provider_cached_input_usd_nano_per_million: '400000',
    provider_output_usd_nano_per_million: '1600000',
    provider_reasoning_usd_nano_per_million: '0',
    ...overrides
  };
}

export class InMemoryGatewayRepository {
  constructor({ models = [mockModel()] } = {}) { this.models = models; }
  async getModelAndPrice(publicName) { const model = this.models.find((m) => m.public_name === publicName); return model ? { ...model } : null; }
  async listPublicModels() { return this.models.map((m) => ({ id: m.model_id, public_name: m.public_name, provider: m.provider, created_at: m.created_at })); }
  async listCatalog() {
    return this.models.map((m) => ({ id: m.model_id, public_name: m.public_name, provider: m.provider, modality: m.modality, capabilities: m.capabilities,
      price_version_id: m.price_version_id, customer_input_usdc_nano_per_million: m.customer_input_usdc_nano_per_million,
      customer_output_usdc_nano_per_million: m.customer_output_usdc_nano_per_million }));
  }
}

// API key rows without a database.
export class InMemoryApiKeyStore {
  constructor() { this.rows = []; }
  async insert(row) { const created = { id: crypto.randomUUID(), state: 'active', created_at: new Date().toISOString(), last_used_at: null, revoked_at: null, ...row }; this.rows.push(created); return { ...created }; }
  async listByPayer(payer) { return this.rows.filter((r) => r.payer === payer).map((r) => ({ ...r })); }
  async get(id, payer) { const row = this.rows.find((r) => r.id === id && r.payer === payer); return row ? { ...row } : null; }
  async useToken(hash) { const row = this.rows.find((r) => r.state === 'active' && Buffer.compare(r.token_hash, hash) === 0); if (!row) return null; row.last_used_at = new Date().toISOString(); return { ...row }; }
  async revoke(id) { const row = this.rows.find((r) => r.id === id); if (row?.state === 'active') Object.assign(row, { state: 'revoked', revoked_at: new Date().toISOString() }); }
  async setLimits(id, { daily, total }) { const row = this.rows.find((r) => r.id === id); if (!row) return null; Object.assign(row, { daily_limit_atomic: daily, total_limit_atomic: total }); return { ...row }; }
}

export function testConfig(overrides = {}) {
  return {
    REAL_MODEL_CALLS_ENABLED: false, PUBLIC_APP_URL: GATEWAY_URL, TREASURY_ADDRESS: TREASURY.address, SETTLER_ADDRESS: SETTLER.address,
    X402_WITHDRAW_DELAY_SECONDS: 3600, X402_MIN_DEPOSIT_USDC: '1', X402_REQUEST_LIMIT_USDC: '5', X402_MAX_CHANNELS_PER_PAYER: 128,
    X402_CLAIM_MIN_USDC: '0.001', X402_CLAIM_IDLE_SECONDS: 86400, X402_CLAIM_INTERVAL_SECONDS: 60, AUTH_ALLOWED_ADDRESSES: [],
    POOL_SETTLE_MIN_USDC: '1', POOL_REFILL_WAIT_MS: 3000, POOL_SNAPSHOT_TTL_SECONDS: 60, POOL_ACTIVATION_FEE_USDC: '0.05', POOL_PERMIT_MIN_BALANCE_USDC: '1',
    DEFAULT_REQUEST_TIMEOUT_MS: 5000, MAX_REQUEST_TIMEOUT_MS: 5000, STREAM_REQUEST_TIMEOUT_MS: 5000, STREAM_IDLE_TIMEOUT_MS: 5000,
    AUTH_SESSION_HMAC_SECRET: 'test-session-secret-0123456789abcdef', activeResponseEncryptionKeyId: 'test', responseEncryptionKeys: new Map([['test', Buffer.alloc(32, 7)]]),
    ...overrides
  };
}

// A reader for the fake chain, as the SDK client needs for recovery after a
// corrective 402 (a real client passes a viem public client).
export function fakeChainReader(chain) {
  return { async readContract({ functionName, args }) {
    const state = chain.channel(args[0]);
    if (functionName === 'channels') return [state.balance, state.totalClaimed];
    if (functionName === 'refundNonce') return state.refundNonce;
    if (functionName === 'pendingWithdrawals') return [0n, 0n];
    throw new Error(`unexpected read ${functionName}`);
  } };
}

// `sessionWallet`: the signed-in address (a real wallet's when the test signs pool calls).
export async function createInMemoryGateway({ repository = new InMemoryGatewayRepository(), providers, config, logger = false, sessionWallet = SESSION_WALLET } = {}) {
  const chain = new FakeChain();
  const facilitator = new FakeFacilitator(chain);
  const registry = providers ?? { get(name) { if (name !== 'mock') throw new AppError('PROVIDER_NOT_SUPPORTED', `Provider ${name} is not supported`, 503); return new MockProvider(); } };
  const cfg = testConfig(config);
  const gateway = new GatewayService({ repository, providerRegistry: registry, config: cfg });
  const ledger = new InMemoryX402Repository();
  const storage = new InMemoryChannelStorage();
  const logs = [];
  const service = new X402Service({ config: cfg, gateway, repository: ledger, storage, authorizer: new LocalAuthorizerSigner(SETTLER), facilitator,
    logger: { error: (line) => logs.push(JSON.parse(line)) } });
  if (!await service.initialize({ retries: 0 })) throw new Error('fake facilitator did not initialize');
  const app = Fastify({ logger });
  const x402 = { service, repository: ledger, storage, scheme: service.scheme, facilitator };
  async function userAuth(request) {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${TEST_SESSION_TOKEN}` && !request.headers.cookie?.includes(TEST_SESSION_TOKEN)) throw new AppError('AUTH_REQUIRED', 'Wallet session is required', 401);
    request.identity = { appUserId: 'u1', address: sessionWallet.toLowerCase() };
  }
  // The prepaid pool on a model of the contract; `poolWorker.tick()` moves money.
  const poolChain = new FakePoolChain();
  const keyStore = new InMemoryApiKeyStore();
  const poolStore = new InMemoryPoolStore({ keyStore });
  for (const m of repository.models ?? []) poolStore.modelNames.set(m.model_id, m.public_name);
  const pool = new PoolBilling({ store: poolStore, chain: poolChain, config: cfg, maxConcurrency: cfg.API_KEY_MAX_CONCURRENCY ?? 128,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))), logger: { error: (line) => logs.push(JSON.parse(line)) } });
  const poolSender = new FakePoolSender({ chain: poolChain, store: poolStore });
  const poolWorker = new PoolWorker({ store: poolStore, chain: poolChain, sender: poolSender, config: cfg });
  const keys = new ApiKeyService({ store: keyStore, config: cfg, service, repository: ledger, storage, pool,
    maxConcurrency: cfg.API_KEY_MAX_CONCURRENCY ?? 128, logger: { error: (line) => logs.push(JSON.parse(line)) } });
  await registerGatewayRoutes(app, { x402, keys, userAuth, gatewayRepository: repository });
  await registerKeyRoutes(app, { keys, userAuth, pool });
  await registerKeySelfRoutes(app, { keys, pool });
  await registerPoolRoutes(app, { pool, userAuth });
  await registerX402Routes(app, { x402, userAuth, config: { chains: {}, MONAD_RPC_URL: 'http://127.0.0.1:9' },
    pool: { async query() { return { rows: [{ address: SESSION_WALLET }] }; } } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues } });
    const result = publicError(error);
    return reply.code(result.statusCode).send(result.body);
  });
  // fetch over app.inject, so the Foundation's client SDK drives the gateway.
  const calls = [];
  const fetchImpl = async (input, init) => {
    const request = new Request(input, init);
    const headers = Object.fromEntries(request.headers);
    calls.push({ url: request.url, headers });
    const response = await app.inject({ method: request.method, url: new URL(request.url).pathname, headers, payload: await request.text() });
    return new Response(response.body, { status: response.statusCode, headers: Object.entries(response.headers).map(([k, v]) => [k, String(v)]) });
  };
  // A paying client: a wallet with USDC on the fake chain and the SDK's
  // batch-settlement scheme over `fetchImpl`.
  function client(privateKey = PAYER_KEY, { salt = `0x${'11'.repeat(32)}`, mint = 5_000_000n, fetch: base = fetchImpl } = {}) {
    const account = toClientEvmSigner(privateKeyToAccount(privateKey), fakeChainReader(chain));
    if (mint) chain.mint(account.address, mint);
    const scheme = new ClientScheme(account, { salt });
    const x402 = new x402Client().register(X402_NETWORK, scheme);
    return { account, scheme, x402, fetch: wrapFetchWithPayment(base, x402) };
  }
  return { app, chain, facilitator, service, ledger, storage, gateway, repository, keys, logs, calls, fetchImpl, client, config: cfg,
    pool, poolChain, poolStore, poolSender, poolWorker };
}

export const chatBody = (extra = {}) => ({ model: 'mock/echo', messages: [{ role: 'user', content: 'hello channel' }], max_tokens: 32, ...extra });
export const post = (path, body, headers = {}) => new Request(path.startsWith('http') ? path : `${GATEWAY_URL}${path}`,
  { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
export async function ok(response) { if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`); return response.json(); }

// Parses an SSE body into `{event, data}` records (data JSON-parsed when possible).
export function parseSse(text) {
  return text.split('\n\n').filter((block) => block.trim()).map((block) => {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? null;
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    let parsed = data;
    try { parsed = JSON.parse(data); } catch { /* [DONE] or raw text */ }
    return { event, data: parsed };
  });
}
