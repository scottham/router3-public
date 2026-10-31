// npm run mainnet:local:configure [-- --public https://your.domain] [-- --port 3000]
//
// Writes .env.mainnet-local, the environment docker-compose.production.yml
// runs from, out of .env: the Treasury, the pool (from pool:deploy), the
// provider keys (moved to a file read by API, collector, catalog and bootstrap),
// the Settler key (generated when missing) and fresh secrets. Reruns preserve
// generated secrets, but source .env can override deployment settings and
// provider keys; --public sets the site URL,
// production mode and real model calls in one go. Ends by checking the
// Settler's MON balance, since the pool's settle transactions need it.
import { readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { JsonRpcProvider, FetchRequest, formatEther, getAddress } from 'ethers';
import { upsertEnv } from './lib/env-file.mjs';
import { ensureSettlerKey, DEFAULT_SETTLER_KEY_FILE } from './lib/settler-key.mjs';
import { CHAIN_ID, CHAIN_KEY, USDC_ADDRESS } from '../src/chain.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const publicUrl = arg('--public');
if (publicUrl && !/^https:\/\/[^/]+$/.test(publicUrl)) throw new Error('--public takes an https origin without a path, e.g. https://router3.example.com');

const source = parseEnv(readFileSync('.env', 'utf8'));
const path = '.env.mainnet-local';
const previous = existsSync(path) ? readFileSync(path, 'utf8') : '';
const env = parseEnv(previous), secret = () => randomBytes(32).toString('hex');
const rpc = source.MONAD_RPC_URL || env.MONAD_RPC_URL || 'https://rpc.monad.xyz';
const rpcRequest = new FetchRequest(rpc); rpcRequest.timeout = 10000;
const provider = new JsonRpcProvider(rpcRequest, CHAIN_ID, { staticNetwork: true });
try {
  if (Number(await provider.send('eth_chainId', [])) !== CHAIN_ID) throw new Error('MAINNET_RPC_REQUIRED');
  const treasury = getAddress(source.TREASURY_ADDRESS || env.TREASURY_ADDRESS || '');
  const keyFile = env.SETTLER_KEY_FILE || source.SETTLER_KEY_FILE || DEFAULT_SETTLER_KEY_FILE;
  const settler = ensureSettlerKey(keyFile);
  if (settler === treasury) throw new Error('SETTLER_MUST_NOT_BE_TREASURY');
  const pgPassword = env.POSTGRES_PASSWORD || secret();
  const redisPassword = env.REDIS_PASSWORD || secret();

  // Provider keys live in a file read by API, collector, catalog and bootstrap.
  const providerFile = env.PROVIDER_ENV_FILE || './.secrets/providers.env';
  const providerKeys = ['DEEPSEEK_API_KEY', 'OPENROUTER_MANAGEMENT_KEY'].filter((key) => source[key]);
  if (providerKeys.length) {
    mkdirSync('.secrets', { recursive: true });
    const current = existsSync(providerFile) ? readFileSync(providerFile, 'utf8') : '';
    writeFileSync(providerFile, upsertEnv(current, new Map(providerKeys.map((key) => [key, source[key]]))), { mode: 0o600 });
    chmodSync(providerFile, 0o600);
  }

  // Loopback port for the website; MAINNET_LOCAL_PORT overrides it when 3000 is taken.
  const port = arg('--port') || process.env.MAINNET_LOCAL_PORT || env.HTTP_PORT || '3000', site = publicUrl || env.PUBLIC_APP_URL || `http://localhost:${port}`;
  const values = new Map(Object.entries({
    // Production needs the real origin for cookies and CORS; without --public an existing choice stays.
    NODE_ENV: publicUrl ? 'production' : env.NODE_ENV || 'development',
    HTTP_PORT: port, PUBLIC_APP_URL: site, CORS_ORIGINS: publicUrl || env.CORS_ORIGINS || site,
    REAL_MODEL_CALLS_ENABLED: publicUrl ? 'true' : source.REAL_MODEL_CALLS_ENABLED || env.REAL_MODEL_CALLS_ENABLED || 'false',
    POSTGRES_PASSWORD: pgPassword, DATABASE_URL_ADMIN: `postgresql://postgres:${pgPassword}@db:5432/router3`,
    REDIS_PASSWORD: redisPassword, REDIS_URL: env.REDIS_URL || `redis://:${redisPassword}@redis:6379/0`, REDIS_NAMESPACE: env.REDIS_NAMESPACE || 'router3-mainnet',
    MONAD_RPC_URL: rpc,
    CHAIN_CONFIG_JSON: JSON.stringify({ [CHAIN_KEY]: { name: 'Monad Mainnet', rpcUrl: rpc, usdcAddress: USDC_ADDRESS, confirmations: 0 } }),
    AUTH_SESSION_HMAC_SECRET: env.AUTH_SESSION_HMAC_SECRET || secret(),
    RESPONSE_ENCRYPTION_KEYS: env.RESPONSE_ENCRYPTION_KEYS || `v1:${randomBytes(32).toString('base64')}`,
    SETTLER_SIGNER_BEARER_TOKEN: env.SETTLER_SIGNER_BEARER_TOKEN || secret(),
    TREASURY_ADDRESS: treasury, SETTLER_ADDRESS: settler,
    SETTLER_KEY_FILE: keyFile, SIGNER_UID: String(process.getuid?.() ?? 1000), SIGNER_GID: String(process.getgid?.() ?? 1000),
    PROVIDER_ENV_FILE: providerFile, PROVIDER_CONFIG_FILE: env.PROVIDER_CONFIG_FILE || './providers/providers.mainnet.json',
    X402_FACILITATOR_URL: env.X402_FACILITATOR_URL || source.X402_FACILITATOR_URL || 'https://x402-facilitator.molandak.org',
    MODEL_MARKUP_BPS: env.MODEL_MARKUP_BPS || source.MODEL_MARKUP_BPS || '0',
    CALL_SERVICE_FEE_BPS: env.CALL_SERVICE_FEE_BPS || source.CALL_SERVICE_FEE_BPS || '100'
  }));
  // The pool, from pool:deploy (or an existing deployment written into .env). Unset = API keys unavailable.
  for (const key of ['POOL_ADDRESS', 'POOL_CODE_HASH', 'AUTH_ALLOWED_ADDRESSES', 'CLOUDFLARE_TUNNEL_TOKEN']) {
    const value = source[key] || env[key];
    if (value) values.set(key, value);
  }
  for (const role of ['api', 'settler', 'reconciler', 'signer', 'catalog']) {
    const key = `DATABASE_URL_${role.toUpperCase()}`;
    values.set(key, env[key] || `postgresql://gateway_${role}:${secret()}@db:5432/router3`);
  }
  const missing = [...values].filter(([, v]) => typeof v !== 'string' || !v).map(([k]) => k);
  if (missing.length) throw new Error(`MISSING_LOCAL_MAINNET_CONFIGURATION:${missing.join(',')}`);
  writeFileSync(path, upsertEnv(previous, values), { mode: 0o600 }); chmodSync(path, 0o600);

  const pool = values.get('POOL_ADDRESS');
  const mon = formatEther(await provider.getBalance(settler));
  console.log(JSON.stringify({ saved: path, site, mode: values.get('NODE_ENV'), realCalls: values.get('REAL_MODEL_CALLS_ENABLED'), treasury, settler, settlerMon: mon, pool: pool ?? null, providers: providerKeys }));
  if (!pool) console.log('No POOL_ADDRESS: API keys stay unavailable, only x402 channels. Run npm run pool:deploy, then this again.');
  if (pool && Number(mon) < 0.5) console.log(`Send about 1 MON to the Settler ${settler}: it pays the gas of the pool's settle transactions (budget SETTLEMENT_SIGNER_DAILY_GAS_MON, default 5 per day).`);
} finally {
  provider.destroy();
}
