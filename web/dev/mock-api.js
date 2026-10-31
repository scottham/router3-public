// Development-only fake API for previewing the console without a wallet,
// database or provider. It is loaded by web/preview.html, which the production
// build does not include, and it never sends a transaction.
const usdc = (value) => (BigInt(Math.round(value * 1e6)) * 1000n).toString();
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const DAY = 86_400_000;

const wallet = { id: 'w-1', address: '0x6Bd1C3f1e3B2a6d8e0F49a2c5D7e1B90a4C3e2F1', chain_id: 143, label: 'Monad 钱包' };
const user = { id: 'u-1', wallets: [wallet], connectedWallet: { address: wallet.address, chainId: 143 } };
const TREASURY = '0x0061e7958aA1f6bbDA7fFdB4D079fa2d413263dd', SETTLER = '0x30d84f1E3eb03529ccfe01d76A11D51407989D0A';
const terms = { scheme: 'batch-settlement', network: 'eip155:143', chainId: 143, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', assetName: 'USDC', assetVersion: '2',
  payTo: TREASURY, receiverAuthorizer: SETTLER, withdrawDelaySeconds: 86400, minDepositAtomic: '100000', requestLimitAtomic: '5000000', maxChannelsPerPayer: 128,
  maxTimeoutSeconds: 600, contract: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003', depositCollector: '0x4020806089470a89826cB9fB1f4059150b550004',
  facilitator: 'https://x402-facilitator.molandak.org', paths: { chat: '/v1/chat/completions', anthropic: '/v1/messages', responses: '/v1/responses', deposit: '/v1/x402/deposit', refund: '/v1/x402/refund' }, ready: true };

const price = (input, cached, output, extra = {}) => ({
  customer_input_usdc_nano_per_million: usdc(input),
  customer_cached_input_usdc_nano_per_million: cached == null ? null : usdc(cached),
  customer_output_usdc_nano_per_million: usdc(output),
  customer_reasoning_usdc_nano_per_million: null,
  service_fee_bps: 100, ...extra
});
const models = [
  { id: 'm-1', public_name: 'deepseek/deepseek-v4-pro', provider: 'deepseek', modality: 'text',
    capabilities: { contextLength: 1_000_000, maxOutputTokens: 393_216, tools: true, imageInput: true }, ...price(1.32, 0.044, 3.96) },
  { id: 'm-2', public_name: 'deepseek/deepseek-flash', provider: 'deepseek', modality: 'text',
    capabilities: { contextLength: 1_000_000, maxOutputTokens: 393_216, tools: true, imageInput: true, offPeakRates: { input: usdc(0.07), cachedInput: usdc(0.007), output: usdc(0.14) }, peakHoursUtc: [[0, 10]] }, ...price(0.14, 0.014, 0.28) },
  { id: 'm-3', public_name: 'openrouter/anthropic/claude-sonnet-5.5', provider: 'openrouter', modality: 'text',
    capabilities: { contextLength: 1_000_000, maxOutputTokens: 128_000, tools: true, imageInput: true }, ...price(3, 0.3, 15) },
  { id: 'm-4', public_name: 'openrouter/moonshotai/kimi-k3', provider: 'openrouter', modality: 'text',
    capabilities: { contextLength: 1_048_576, maxOutputTokens: 65_536, tools: true, imageInput: true }, ...price(1.2, 0.12, 6) },
  { id: 'm-5', public_name: 'openrouter/z-ai/glm-5.3', provider: 'openrouter', modality: 'text',
    capabilities: { contextLength: 1_048_576, maxOutputTokens: 131_072, tools: true }, ...price(0.6, 0.06, 2.2) }
];

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'default';
let signedIn = scenario !== 'signed-out';
const channel = (n, { charged, balance, claimed, withdrawing = false, requests = 12 }) => ({
  channel_id: '0x' + n.toString(16).padStart(2, '0').repeat(32), payer: wallet.address.toLowerCase(), payer_authorizer: wallet.address.toLowerCase(),
  config: { payer: wallet.address, payerAuthorizer: wallet.address, receiver: TREASURY, receiverAuthorizer: SETTLER, token: terms.asset, withdrawDelay: 86400, salt: '0x' + n.toString(16).padStart(2, '0').repeat(32) },
  charged_atomic: String(charged), balance_atomic: String(balance), claimed_atomic: String(claimed), withdraw_requested_at: withdrawing ? Math.floor(now / 1000) - 600 : 0,
  refund_nonce: '0', last_request_at: iso(n * 5 * 60_000), created_at: iso(n * DAY), requests
});
let channels = scenario === 'new' ? [] : [channel(1, { charged: 412350, balance: 5_000_000, claimed: 400000 }), channel(2, { charged: 61, balance: 100000, claimed: 0, requests: 4 }),
  channel(3, { charged: 1550, balance: 100000, claimed: 0, requests: 9 }), channel(4, { charged: 90000, balance: 100000, claimed: 90000, withdrawing: true, requests: 30 })];

// API keys: every key of the wallet spends from its prepaid pool.
const apiKey = (n, { name, today = 0, spent = 0, running = 0, state = 'active', daily = null, legacy = 0 }) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, name, prefix: `r3_live_prev${n}abc`, state,
  createdAt: iso(n * DAY), lastUsedAt: spent ? iso(n * 3 * 60_000) : null, revokedAt: state === 'revoked' ? iso(DAY) : null,
  dailyLimitAtomic: daily, totalLimitAtomic: null, running, spentTodayAtomic: String(today), spentAtomic: String(spent), maxConcurrency: 128,
  legacyChannel: legacy ? { channelId: '0x' + (n + 8).toString(16).padStart(2, '0').repeat(32), balanceAtomic: String(legacy), chargedAtomic: '1', unspentAtomic: String(legacy - 1) } : null });
let keys = scenario === 'new' ? [] : [apiKey(1, { name: 'laptop', today: 412_000, spent: 1_234_567, running: 3 }), apiKey(2, { name: 'ci', daily: '2000000', legacy: 2_000_000 }),
  apiKey(3, { name: 'old', spent: 100000, state: 'revoked' })];
let pool = scenario === 'new' ? { state: 'none', ops: [] } : { state: 'active', poolBalanceAtomic: '4210000', availableAtomic: '3618000', unsettledAtomic: '412000', heldAtomic: '180000',
  running: 3, refillTargetAtomic: '5000000', dailyLimitAtomic: '20000000', dailyRemainingAtomic: '19588000', walletBalanceAtomic: '37210000', allowanceAtomic: '95000000',
  withdrawalAtomic: '0', withdrawableAt: null, snapshotAt: iso(20_000), ops: [] };
const poolTerms = { poolAddress: '0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3', usdcAddress: terms.asset, chainId: 143, treasury: TREASURY, withdrawalDelaySeconds: 1800,
  maxRefillTargetAtomic: '1000000000', defaultRefillTargetAtomic: '5000000', defaultDailyLimitAtomic: '20000000', activationFeeAtomic: '50000', permitMinBalanceAtomic: '1000000',
  poolDomain: { name: 'Router3 Prepaid Pool', version: '1', chainId: 143, verifyingContract: '0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3' },
  usdcDomain: { name: 'USDC', version: '2', chainId: 143, verifyingContract: terms.asset } };

const routes = [
  ['GET', /^\/v1\/keys$/, () => ({ terms: { requestLimitAtomic: '50000000', maxConcurrency: 128, holdOutputTokens: 8192 }, pool, keys })],
  ['POST', /^\/v1\/keys$/, (_match, _params, init) => {
    const created = apiKey(keys.length + 4, { name: JSON.parse(init.body).name });
    keys = [created, ...keys];
    return { token: `${created.prefix}_previewsecretpreviewsecretpreviewsecret12345`, key: created };
  }],
  ['PATCH', /^\/v1\/keys\/([^/]+)$/, (match, _params, init) => {
    const body = JSON.parse(init.body);
    const atomic = (v) => v == null ? null : String(Math.round(Number(v) * 1e6));
    keys = keys.map((k) => k.id === match[1] ? { ...k, dailyLimitAtomic: atomic(body.dailyLimitUsdc), totalLimitAtomic: atomic(body.totalLimitUsdc) } : k);
    return { key: keys.find((k) => k.id === match[1]) };
  }],
  ['POST', /^\/v1\/keys\/([^/]+)\/refund$/, (match) => {
    const key = keys.find((k) => k.id === match[1]);
    keys = keys.map((k) => k.id === match[1] ? { ...k, legacyChannel: null } : k);
    return { refunded: true, amountAtomic: key?.legacyChannel?.unspentAtomic ?? '0', transaction: '0x' + 'f2'.repeat(32) };
  }],
  ['DELETE', /^\/v1\/keys\/([^/]+)$/, (match) => {
    keys = keys.map((k) => k.id === match[1] ? { ...k, state: 'revoked' } : k);
    return { revoked: true, refund: { refunded: false, amountAtomic: '0' } };
  }],
  ['GET', /^\/v1\/pool$/, () => ({ terms: poolTerms, account: pool, nonces: { pool: '0', usdc: '0' } })],
  ['POST', /^\/v1\/pool\/setup$/, () => { pool = { ...pool, state: 'pending', ops: [{ id: 'o1', kind: 'permit', state: 'queued' }, { id: 'o2', kind: 'configure', state: 'queued' }] }; return { ops: pool.ops }; }],
  ['POST', /^\/v1\/pool\/(permit|configure|withdrawal)$/, (match) => ({ op: { id: 'o3', kind: match[1], state: 'queued' } })],
  ['DELETE', /^\/v1\/pool\/withdrawal$/, () => ({ op: { id: 'o4', kind: 'cancel_withdrawal', state: 'queued' } })],
  ['GET', /^\/v1\/keys\/[^/]+\/requests$/, () => ({ items: Array.from({ length: 6 }, (_, i) => ({ id: `k-${i}`, created_at: iso((i + 1) * 4 * 60_000), status: i === 0 ? 'running' : 'completed',
    protocol: 'chat', model: models[i % 2].public_name, charge_nano: i === 0 ? null : String(900_000 + i * 70_000), ceiling_atomic: String(6_000), charged_from: 'usage', settled: i > 2 })) })],
  ['GET', /^\/v1\/auth\/config$/, () => ({ siteUrl: location.origin, network: { appName: 'Router 3', chainId: 143 }, chains: { 143: { name: 'Monad', usdcAddress: terms.asset } }, x402: terms, apiKeys: { requestLimitAtomic: '50000000', maxConcurrency: 128, holdOutputTokens: 8192 } })],
  ['GET', /^\/v1\/me$/, () => (signedIn ? user : { status: 401 })],
  ['POST', /^\/v1\/auth\/challenge$/, () => ({ id: 'c-1', nonce: 'previewnonce1234', chain_id: 143, expires_at: new Date(Date.now() + 300_000).toISOString() })],
  // The preview accepts any signature and adopts the signing wallet's address.
  ['POST', /^\/v1\/auth\/verify$/, (_match, _params, init) => {
    const { address } = JSON.parse(init.body);
    wallet.address = address; user.connectedWallet.address = address; signedIn = true;
    return { appUserId: user.id, address, created: false };
  }],
  ['GET', /^\/v1\/models$/, () => models],
  ['GET', /^\/v1\/x402$/, () => terms],
  ['GET', /^\/v1\/x402\/channels$/, () => ({ terms, payer: wallet.address, walletKind: 'eoa', channels })],
  ['GET', /^\/v1\/x402\/channels\/[^/]+\/requests$/, () => ({ items: Array.from({ length: 8 }, (_, i) => ({ id: `x-${i}`, created_at: iso((i + 1) * 7 * 60_000), status: i === 6 ? 'failed' : 'completed',
    failure_code: i === 6 ? 'PROVIDER_REQUEST_REJECTED' : null, protocol: 'chat', model: models[i % 2].public_name, latency_ms: 800 + i * 120,
    charge_nano: i === 6 ? null : String(1_200_000 + i * 90_000), max_charge_nano: String(8_400_000), charged_from: i === 5 ? 'ceiling' : 'usage' })) })],
  // Deposits and refunds: the preview pretends the facilitator settled them.
  ['POST', /^\/v1\/x402\/(deposit|refund)$/, (match, _params, init) => {
    if (!init.headers?.['payment-signature']) return { status: 402 };
    if (match[1] === 'refund') { channels = channels.slice(1); return { transaction: '0x' + 'f1'.repeat(32) }; }
    return { channel: { channelId: channels[0]?.channel_id, balanceAtomic: '5100000' }, request_id: 'x-dep', transaction: '0x' + 'd1'.repeat(32) };
  }],
  ['POST', /^\/v1\/auth\/logout$/, () => { signedIn = false; return null; }]
];

export function installMockFetch() {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
    if (!url.pathname.startsWith('/v1/')) return realFetch(input, init);
    const method = (init.method ?? 'GET').toUpperCase();
    for (const [verb, pattern, handler] of routes) {
      const match = verb === method && url.pathname.match(pattern);
      if (!match) continue;
      await new Promise((resolve) => setTimeout(resolve, 120));
      const body = handler(match, url.searchParams, init);
      if (body && body.status === 401) {
        return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '未登录' } }), { status: 401 });
      }
      if (body && body.status === 402) {
        const required = btoa(JSON.stringify({ x402Version: 2, error: 'Payment required', accepts: [{ scheme: 'batch-settlement', network: 'eip155:143', amount: match[1] === 'deposit' ? '1' : '0',
          asset: terms.asset, payTo: TREASURY, maxTimeoutSeconds: 600, extra: { name: 'USDC', version: '2', minDeposit: terms.minDepositAtomic, receiverAuthorizer: SETTLER, withdrawDelay: 86400 } }] }));
        return new Response(JSON.stringify({ error: { code: 'PAYMENT_REQUIRED', message: 'Payment required' } }), { status: 402, headers: { 'payment-required': required } });
      }
      return body === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `预览未模拟 ${method} ${url.pathname}` } }), { status: 404 });
  };
}
