// A local proxy that pays for model calls with x402 channels, so unmodified
// OpenAI, Anthropic and Responses clients (the OpenAI SDK, Claude Code, Codex)
// can use the gateway. It holds the payer key, keeps a pool of channels and
// gives every concurrent request its own channel: the batch-settlement scheme
// handles one request per channel at a time, so the pool size is the
// concurrency. Channels open lazily (first use deposits) up to `maxChannels`;
// `refundAll` signs a cooperative refund on each so the deposits come back.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPublicClient, http as viemHttp } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { BatchSettlementEvmScheme, InMemoryClientChannelStorage } from '@x402/evm/batch-settlement/client';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { toClientEvmSigner } from '@x402/evm';

export const PAID_PATHS = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
export const NETWORK = 'eip155:143';
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-model-gateway-request-id', 'payment-response', 'retry-after'];

export function normalizePrivateKey(value) {
  const hex = String(value ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('PAYER_KEY_INVALID');
  return `0x${hex}`;
}

// The channels a payer uses, each a salt. Persisted beside the SDK's channel
// records so a restart continues the same channels instead of opening new ones.
export class ChannelPool {
  constructor({ account, network = NETWORK, storage, salts = [], maxChannels = 128, fetchImpl = fetch, depositPolicy, maxPaymentUsd = 5, onSalts = () => {} }) {
    Object.assign(this, { account, network, storage, maxChannels, fetchImpl, depositPolicy, maxPaymentUsd, onSalts });
    this.channels = salts.map((salt) => this.channel(salt));
    this.waiting = [];
  }

  channel(salt) {
    const scheme = new BatchSettlementEvmScheme(this.account, { salt, storage: this.storage, ...(this.depositPolicy ? { depositPolicy: this.depositPolicy } : {}) });
    // The SDK refuses to sign more than $1 per payment by default; a request's
    // ceiling may reach the gateway's per-request limit (5 USDC by default).
    const client = new x402Client().register(this.network, scheme).setSpendControls({ maxAmountPerPayment: this.maxPaymentUsd });
    return { salt, scheme, fetch: wrapFetchWithPayment(this.fetchImpl, client), busy: false };
  }

  get size() { return this.channels.length; }
  get salts() { return this.channels.map((c) => c.salt); }

  // An idle channel, a new one while under the limit, else the next released.
  async acquire() {
    const idle = this.channels.find((c) => !c.busy);
    if (idle) { idle.busy = true; return idle; }
    if (this.channels.length < this.maxChannels) {
      const created = this.channel(`0x${randomBytes(32).toString('hex')}`);
      created.busy = true;
      this.channels.push(created);
      this.onSalts(this.salts);
      return created;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(channel) {
    const next = this.waiting.shift();
    if (next) next(channel); else channel.busy = false;
  }

  // Cooperative refunds, one per channel: the gateway claims what it is owed
  // and returns the rest in the same transaction. Channels that were never
  // opened have nothing to refund.
  async refundAll(gatewayUrl) {
    const results = [];
    for (const channel of this.channels) {
      try {
        const result = await channel.scheme.refund(`${gatewayUrl}/v1/x402/refund`, { fetch: this.fetchImpl });
        results.push({ salt: channel.salt, success: result.success, transaction: result.transaction ?? null, amount: result.amount ?? null, error: result.errorReason ?? null });
      } catch (error) {
        results.push({ salt: channel.salt, success: false, error: error.message });
      }
    }
    return results;
  }
}

function saltsFile(directory) { return join(directory, 'salts.json'); }
function loadSalts(directory) {
  try { return JSON.parse(readFileSync(saltsFile(directory), 'utf8')).salts.filter((s) => /^0x[0-9a-f]{64}$/.test(s)); } catch { return []; }
}

export function createProxy({ gatewayUrl, privateKey, rpcUrl = 'https://rpc.monad.xyz', reader = null, network = NETWORK, directory = null,
  maxChannels = 128, maxPaymentUsd = 5, fetchImpl = fetch, depositPolicy, logger = console }) {
  const gateway = String(gatewayUrl).replace(/\/+$/, '');
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const signer = toClientEvmSigner(account, reader ?? createPublicClient({ chain: monad, transport: viemHttp(rpcUrl) }));
  let storage, salts = [], onSalts = () => {};
  if (directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    storage = new FileClientChannelStorage({ directory });
    salts = loadSalts(directory);
    onSalts = (list) => writeFileSync(saltsFile(directory), JSON.stringify({ payer: account.address, salts: list }, null, 2), { mode: 0o600 });
  } else {
    storage = new InMemoryClientChannelStorage();
  }
  const pool = new ChannelPool({ account: signer, network, storage, salts, maxChannels, maxPaymentUsd, fetchImpl, depositPolicy, onSalts });

  async function forward(req, res) {
    const url = new URL(req.url, 'http://proxy.local');
    const paid = req.method === 'POST' && PAID_PATHS.includes(url.pathname);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const headers = {};
    for (const name of FORWARDED_REQUEST_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
    const init = { method: req.method, headers, ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }) };
    const channel = paid ? await pool.acquire() : null;
    try {
      const target = `${gateway}${url.pathname}${url.search}`;
      let response;
      try {
        response = await (channel ? channel.fetch : fetchImpl)(target, init);
      } catch (error) {
        // A 402 that is not a payment request (the gateway refused the request
        // itself, e.g. X402_REQUEST_LIMIT): ask again unpaid and pass it on.
        if (!channel || !/^Failed to parse payment requirements/.test(error.message)) throw error;
        response = await fetchImpl(target, init);
      }
      const out = {};
      for (const name of FORWARDED_RESPONSE_HEADERS) { const value = response.headers.get(name); if (value) out[name] = value; }
      res.writeHead(response.status, out);
      if (response.body) await new Promise((resolve, reject) => Readable.fromWeb(response.body).on('error', reject).on('end', resolve).pipe(res));
      else res.end();
    } catch (error) {
      logger.error(JSON.stringify({ level: 'error', message: 'x402_proxy_request_failed', path: url.pathname, error: error.message }));
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'X402_PROXY_FAILED', message: error.message } })); }
      else res.end();
    } finally {
      if (channel) pool.release(channel);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, payer: account.address, channels: pool.size })); return; }
    forward(req, res).catch(() => { if (!res.writableEnded) res.end(); });
  });
  return {
    server, pool, account, gateway,
    listen: (port = 8402, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    refundAll: () => pool.refundAll(gateway)
  };
}
