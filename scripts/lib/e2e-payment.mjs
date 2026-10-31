// How the live e2e scripts pay. Default: an API key on the wallet's prepaid
// pool (signed in with SIWE; automatic payment turned on if it is not). `--proxy`:
// the local x402 proxy signs each call with the wallet key instead.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { hexToString } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createProxy, normalizePrivateKey } from '../../clients/x402-proxy/index.mjs';
import { requestWalletSignInProof } from '../../web/src/siwe.js';
import { connectAccount } from '../../web/src/wallets.js';
import { configureTyped, permitTyped, signatureDeadline, withdrawalTyped } from '../../web/src/pool.js';

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// API keys bill from the wallet's prepaid pool: turned on once with two
// signatures (USDC permit to the pool, refill target and daily limit), then
// every key spends from it. At the end the key is revoked and, unless
// MCG_KEEP_POOL is set, a withdrawal is requested; the collector returns the
// pool to the wallet after the delay.
async function apiKeyPayment({ gatewayUrl, privateKey, refillUsdc, dailyUsdc, allowanceUsdc }) {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey));
  const challenge = await json(await fetch(`${gatewayUrl}/v1/auth/challenge`, { method: 'POST' }));
  let chain = '0x1';
  const provider = { async request({ method, params }) {
    if (['eth_requestAccounts', 'eth_accounts'].includes(method)) return [account.address];
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_switchEthereumChain') { chain = params[0].chainId; return null; }
    if (method === 'personal_sign') return account.signMessage({ message: hexToString(params[0]) });
    throw new Error(`unexpected wallet call ${method}`);
  } };
  const proof = await requestWalletSignInProof(provider, challenge, gatewayUrl, connectAccount);
  const verified = await fetch(`${gatewayUrl}/v1/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.id, address: account.address, ...proof }) });
  await json(verified);
  const cookie = verified.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const session = (path, init = {}) => fetch(`${gatewayUrl}${path}`, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } }).then(json);
  const atomic = (usdc) => BigInt(Math.round(usdc * 1e6));
  // The builders give the wallet-RPC shape (numbers as strings); viem wants bigints.
  const signTyped = ({ domain, types, primaryType, message }) => account.signTypedData({ domain, types: { [primaryType]: types[primaryType] }, primaryType,
    message: Object.fromEntries(types[primaryType].map(({ name, type }) => [name, type === 'uint256' ? BigInt(message[name]) : message[name]])) });
  const poolState = async () => (await session('/v1/keys')).pool;
  let setup = null;
  if ((await poolState())?.state !== 'active') {
    const { terms, nonces } = await session('/v1/pool');
    const deadline = signatureDeadline();
    const owner = account.address;
    const permit = permitTyped({ terms, owner, value: atomic(allowanceUsdc), nonce: BigInt(nonces.usdc), deadline });
    const configure = configureTyped({ terms, owner, refillTarget: atomic(refillUsdc), dailyLimit: atomic(dailyUsdc), nonce: BigInt(nonces.pool), deadline });
    await session('/v1/pool/setup', { method: 'POST', body: JSON.stringify({
      permit: { value: String(atomic(allowanceUsdc)), deadline: String(deadline), signature: await signTyped(permit) },
      configure: { refillTarget: String(atomic(refillUsdc)), dailyLimit: String(atomic(dailyUsdc)), nonce: nonces.pool, deadline: String(deadline), signature: await signTyped(configure) } }) });
    setup = { allowanceUsdc, refillUsdc, dailyUsdc };
  }
  const started = Date.now();
  let pool;
  while ((pool = await poolState())?.state !== 'active' || BigInt(pool.poolBalanceAtomic ?? 0) === 0n) {
    if (Date.now() - started > 180_000) throw new Error(`automatic payment did not start: ${JSON.stringify(pool)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const { token, key } = await session('/v1/keys', { method: 'POST', body: JSON.stringify({ name: `e2e ${new Date().toISOString()}` }) });
  return {
    mode: 'api-key', base: gatewayUrl, token, payer: account.address,
    describe: `API key ${key.prefix}_… on the pool (${setup ? `set up: refill ${refillUsdc}, daily ${dailyUsdc}, allowance ${allowanceUsdc} USDC` : 'already on'}; pool ${Number(pool.poolBalanceAtomic) / 1e6} USDC)`,
    charged: (gateway) => BigInt(gateway?.billed_usdc_nano ?? 0) > 0n ? gateway.billed_usdc_nano : null,
    view: async () => {
      const listed = await session('/v1/keys');
      const k = listed.keys.find((x) => x.id === key.id);
      return { ...k, chargedAtomic: k.spentAtomic, unspentAtomic: listed.pool.availableAtomic, pool: listed.pool };
    },
    async close() {
      await session(`/v1/keys/${key.id}`, { method: 'DELETE' });
      if (process.env.MCG_KEEP_POOL) return { revoked: true, pool: 'kept on' };
      const { terms, nonces } = await session('/v1/pool');
      const deadline = signatureDeadline(), amount = 10n ** 15n;
      const typed = withdrawalTyped({ terms, owner: account.address, amount, nonce: BigInt(nonces.pool), deadline });
      await session('/v1/pool/withdrawal', { method: 'POST', body: JSON.stringify({ amount: String(amount), nonce: nonces.pool, deadline: String(deadline), signature: await signTyped(typed) }) });
      return { revoked: true, pool: `withdrawal requested; returns to the wallet after ${terms.withdrawalDelaySeconds} s` };
    }
  };
}

async function proxyPayment({ gatewayUrl, privateKey, maxChannels, directory }) {
  const proxy = createProxy({ gatewayUrl, privateKey, rpcUrl: process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz', maxChannels, directory });
  const address = await proxy.listen(0);
  return {
    mode: 'proxy', base: `http://127.0.0.1:${address.port}`, token: 'x402', payer: proxy.account.address, proxy,
    describe: `proxy → ${gatewayUrl}, channels ${proxy.pool.size}`,
    charged: (gateway) => BigInt(gateway?.x402?.charged_atomic ?? 0) > 0n ? gateway.x402.charged_atomic : null,
    view: async () => ({ channels: proxy.pool.size }),
    async close() { await proxy.close(); return { channels: proxy.pool.size }; }
  };
}

export function openPayment({ gatewayUrl, privateKey, maxChannels = 16 }) {
  // Allows client compatibility tests against an isolated gateway without
  // signing wallet operations or touching an existing production pool.
  if(process.env.MCG_API_KEY_FILE) {
    const token=readFileSync(process.env.MCG_API_KEY_FILE,'utf8').trim();
    if(!/^r3_live_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/.test(token))throw new Error('INVALID_E2E_API_KEY_FILE');
    return Promise.resolve({mode:'api-key',base:gatewayUrl,token,payer:'existing API key',describe:'provided API key (no wallet operations)',
      charged:gateway=>BigInt(gateway?.billed_usdc_nano??0)>0n?gateway.billed_usdc_nano:null,
      async view(){const {key,pool}=await json(await fetch(`${gatewayUrl}/v1/key`,{headers:{authorization:`Bearer ${token}`}}));
        return {...key,chargedAtomic:key.spentAtomic,unspentAtomic:pool?.availableAtomic??'0',pool};},
      async close(){return {providedKey:true};}});
  }
  if (process.argv.includes('--proxy')) {
    return proxyPayment({ gatewayUrl, privateKey, maxChannels: Number(process.env.MCG_MAX_CHANNELS ?? maxChannels),
      directory: process.env.MCG_PROXY_DIR ?? join(tmpdir(), 'router3-e2e-proxy') });
  }
  return apiKeyPayment({ gatewayUrl, privateKey, refillUsdc: Number(process.env.MCG_POOL_REFILL_USDC ?? 3), dailyUsdc: Number(process.env.MCG_POOL_DAILY_USDC ?? 10),
    allowanceUsdc: Number(process.env.MCG_POOL_ALLOWANCE_USDC ?? 20) });
}
