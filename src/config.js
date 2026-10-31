import { z } from 'zod';
import { CHAIN_KEY } from './chain.js';
import { loadProvidersConfig } from './config/providers.js';

const bool = z.string().optional().transform((v) => v === 'true');
// Security-relevant switches must stay on unless they are explicitly turned off.
const boolDefaultTrue = z.string().optional().transform((v) => v !== 'false');
const positiveInt = (fallback) => z.coerce.number().int().positive().default(fallback);
const optional = (schema) => z.preprocess((value) => value === '' ? undefined : value, schema.optional());
const usdc = (fallback) => z.string().regex(/^\d+(\.\d{1,6})?$/).default(fallback);

const envSchema = z.object({
  MCG_RUNTIME: z.enum(['api', 'collector', 'reconciler']).default('api'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_APP_URL: optional(z.string().url()),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool,

  MONAD_RPC_URL: z.string().url().default('https://rpc.monad.xyz'),
  APP_NAME: z.string().min(1).max(80).default('Router 3'),
  APP_LOGO_URL: optional(z.string().url()),
  AUTH_SESSION_HMAC_SECRET: optional(z.string().min(32)),
  AUTH_SESSION_TTL_SECONDS: positiveInt(604800),
  AUTH_CHALLENGE_TTL_SECONDS: positiveInt(300),
  AUTH_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default('mcg_session'),
  // Comma-separated wallet addresses; when set, only these may sign in to the
  // console and pay through a channel.
  AUTH_ALLOWED_ADDRESSES: z.string().default('').transform((value) => value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
    .refine((list) => list.every((item) => /^0x[0-9a-f]{40}$/.test(item)), 'AUTH_ALLOWED_ADDRESSES must list 0x addresses'),

  DATABASE_URL_API: optional(z.string().min(1)),
  DATABASE_URL_SETTLER: optional(z.string().min(1)),
  DATABASE_URL_RECONCILER: optional(z.string().min(1)),
  DB_POOL_MAX: positiveInt(12),
  DB_STATEMENT_TIMEOUT_MS: positiveInt(15000),
  DB_IDLE_TIMEOUT_MS: positiveInt(30000),
  DB_APPLICATION_NAME: z.string().default('model-credit-gateway'),
  DB_SSL_REJECT_UNAUTHORIZED: boolDefaultTrue,

  // Encrypts provider call keys at rest (keyId:base64, comma separated).
  RESPONSE_ENCRYPTION_KEYS: optional(z.string().min(1)),

  DEFAULT_REQUEST_TIMEOUT_MS: positiveInt(120000),
  MAX_REQUEST_TIMEOUT_MS: positiveInt(300000),
  // Streams: total budget and the longest silence allowed from the upstream.
  // A channel reservation lives at most 10 minutes in the SDK, so a stream
  // must settle before that.
  STREAM_REQUEST_TIMEOUT_MS: positiveInt(570000),
  STREAM_IDLE_TIMEOUT_MS: positiveInt(90000),
  MAX_REQUEST_BODY_BYTES: positiveInt(1048576),
  // Chat requests only: base64 images make them far larger than other calls.
  MAX_CHAT_BODY_BYTES: positiveInt(20971520),
  // A request still `running` after this long lost its API process; the
  // reconciler closes it (nothing was charged: the reservation expired).
  STALE_REQUEST_AFTER_SECONDS: positiveInt(900),
  RATE_LIMIT_MAX: positiveInt(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  REDIS_URL: optional(z.string().url().refine(value => ['redis:','rediss:'].includes(new URL(value).protocol))),
  REDIS_REQUIRED: bool,
  REDIS_NAMESPACE: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).default('router3'),
  REDIS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(1000),

  CHAIN_CONFIG_JSON: z.preprocess((value) => value === '' ? undefined : value, z.string().default('{}')),
  // Where channel payments go and who signs claims (docs/X402.md).
  TREASURY_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  SETTLER_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  SETTLER_SIGNER_URL: optional(z.string().url()),
  SETTLER_SIGNER_BEARER_TOKEN: optional(z.string().min(1)),
  X402_FACILITATOR_URL: z.string().url().default('https://x402-facilitator.molandak.org'),
  X402_FACILITATOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(90000),
  X402_WITHDRAW_DELAY_SECONDS: z.coerce.number().int().min(900).max(2592000).default(86400),
  X402_MIN_DEPOSIT_USDC: usdc('0.1'),
  X402_REQUEST_LIMIT_USDC: usdc('5'),
  X402_MAX_CHANNELS_PER_PAYER: z.coerce.number().int().min(1).max(10000).default(128),
  // Concurrent requests one API key may run on its channel.
  API_KEY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(10000).default(128),
  // The most one API key request may hold (an estimate; the actual cost is charged).
  API_KEY_REQUEST_LIMIT_USDC: usdc('50'),
  // Output tokens an API key request holds at most; max_tokens is still forwarded.
  API_KEY_HOLD_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(10000000).default(8192),
  // Prepaid pool (docs/PREPAID_POOL.md): API keys bill from the wallet's pool.
  POOL_ADDRESS: optional(z.string().regex(/^0x[0-9a-fA-F]{40}$/)),
  POOL_CODE_HASH: optional(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
  // Settle usage once this much is owed or it has waited this long.
  POOL_SETTLE_MIN_USDC: usdc('1'),
  POOL_SETTLE_MAX_WAIT_SECONDS: z.coerce.number().int().min(60).max(2592000).default(604800),
  // Refill when what is available falls below this share of the refill target.
  POOL_REFILL_BELOW_BPS: z.coerce.number().int().min(0).max(10000).default(5000),
  // How long a request waits for a refill when its hold does not fit.
  POOL_REFILL_WAIT_MS: z.coerce.number().int().min(0).max(60000).default(15000),
  POOL_SNAPSHOT_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  POOL_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(600).default(3),
  // Relayed permits cost the platform gas: a wallet needs this much USDC, and
  // its first permit records a one-time fee settled with its first debit.
  POOL_PERMIT_MIN_BALANCE_USDC: usdc('1'),
  POOL_ACTIVATION_FEE_USDC: usdc('0.05'),
  POOL_SWEEP_MIN_USDC: usdc('1'),
  X402_CLAIM_MIN_USDC: usdc('1'),
  X402_CLAIM_IDLE_SECONDS: z.coerce.number().int().min(60).max(2592000).default(86400),
  X402_CLAIM_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(86400).default(600),

  REAL_MODEL_CALLS_ENABLED: bool,
  // Synced catalogs (DeepSeek) older than this stop serving their models.
  CATALOG_MAX_AGE_SECONDS: positiveInt(129600),
  // providers.json (src/config/providers.js): which model providers this
  // deployment serves and how they are called. Provider keys are read from
  // the environment variables the file names.
  PROVIDER_CONFIG_PATH: optional(z.string().min(1)),
  LOG_LEVEL: z.string().default('info')
});

function parseJson(name, value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function parseEncryptionKeys(value, name = 'RESPONSE_ENCRYPTION_KEYS') {
  const keys = new Map();
  for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = item.indexOf(':');
    if (separator <= 0) throw new Error(`${name} must use keyId:base64Key`);
    const id = item.slice(0, separator);
    const key = Buffer.from(item.slice(separator + 1), 'base64');
    if (key.length !== 32) throw new Error(`Response encryption key ${id} must decode to 32 bytes`);
    if (keys.has(id)) throw new Error(`Duplicate response encryption key id: ${id}`);
    keys.set(id, key);
  }
  if (keys.size === 0) throw new Error('At least one response encryption key is required');
  return keys;
}

export function loadConfig(env = process.env) {
  const raw = envSchema.parse(env);
  if(raw.MCG_RUNTIME==='api' && raw.REDIS_REQUIRED && !raw.REDIS_URL) throw new Error('REDIS_URL_REQUIRED');
  if(raw.STALE_REQUEST_AFTER_SECONDS*1000<=raw.STREAM_REQUEST_TIMEOUT_MS) throw new Error('STALE_REQUEST_AFTER_SECONDS must exceed STREAM_REQUEST_TIMEOUT_MS');
  if (raw.STREAM_REQUEST_TIMEOUT_MS > 570000) throw new Error('STREAM_REQUEST_TIMEOUT_MS must be at most 570000: a channel reservation expires after 10 minutes');
  const databaseUrls = {
    api: raw.DATABASE_URL_API,
    collector: raw.DATABASE_URL_SETTLER,
    reconciler: raw.DATABASE_URL_RECONCILER
  };
  const databaseUrl = databaseUrls[raw.MCG_RUNTIME];
  if (!databaseUrl) throw new Error(`DATABASE_URL_${raw.MCG_RUNTIME === 'collector' ? 'SETTLER' : raw.MCG_RUNTIME.toUpperCase()} is required`);

  const required = {
    api: ['PUBLIC_APP_URL', 'AUTH_SESSION_HMAC_SECRET', 'RESPONSE_ENCRYPTION_KEYS', 'TREASURY_ADDRESS', 'SETTLER_ADDRESS', 'SETTLER_SIGNER_URL', 'SETTLER_SIGNER_BEARER_TOKEN'],
    collector: ['TREASURY_ADDRESS', 'SETTLER_ADDRESS', 'SETTLER_SIGNER_URL', 'SETTLER_SIGNER_BEARER_TOKEN'],
    reconciler: []
  }[raw.MCG_RUNTIME];
  const missing = required.filter((name) => !raw[name]);
  if (missing.length > 0) throw new Error(`${raw.MCG_RUNTIME} runtime requires ${missing.join(', ')}`);

  const chains = parseJson('CHAIN_CONFIG_JSON', raw.CHAIN_CONFIG_JSON);
  if (!chains || Array.isArray(chains) || typeof chains !== 'object') throw new Error('CHAIN_CONFIG_JSON must be an object');
  for (const [key, chain] of Object.entries(chains)) {
    if (!chain || typeof chain !== 'object' || Array.isArray(chain)) throw new Error(`Chain ${key} must be an object`);
    if (!Number.isSafeInteger(Number(key)) || Number(key) <= 0) throw new Error(`Invalid chain id: ${key}`);
    if (!chain.rpcUrl || !chain.usdcAddress) throw new Error(`Chain ${key} requires rpcUrl and usdcAddress`);
    let rpcUrl;
    try { rpcUrl = new URL(chain.rpcUrl); } catch { throw new Error(`Chain ${key} rpcUrl must be a valid URL`); }
    if (!['http:', 'https:'].includes(rpcUrl.protocol)) throw new Error(`Chain ${key} rpcUrl must use HTTP or HTTPS`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(chain.usdcAddress)) throw new Error(`Chain ${key} usdcAddress must be an EVM address`);
    // Extra blocks to wait beyond the finalized head; Monad finality is already irreversible.
    if (!Number.isInteger(chain.confirmations) || chain.confirmations < 0) {
      throw new Error(`Chain ${key} confirmations must be a non-negative integer`);
    }
  }

  // Production spending needs the Monad mainnet chain entry (RPC and USDC).
  if (raw.NODE_ENV === 'production' && raw.REAL_MODEL_CALLS_ENABLED && raw.MCG_RUNTIME === 'api' && !chains[CHAIN_KEY]) {
    throw new Error('Production real model calls require the Monad mainnet chain configuration');
  }

  if (raw.NODE_ENV === 'production') {
    const serialized = JSON.stringify(raw);
    if (/REPLACE_|YOUR_PROJECT_REF/.test(serialized)) {
      throw new Error('Production configuration still contains placeholder values');
    }
    if (raw.MCG_RUNTIME === 'api' && !raw.PUBLIC_APP_URL.startsWith('https://')) {
      throw new Error('PUBLIC_APP_URL must use HTTPS in production');
    }
  }

  const responseEncryptionKeys = raw.RESPONSE_ENCRYPTION_KEYS
    ? parseEncryptionKeys(raw.RESPONSE_ENCRYPTION_KEYS)
    : new Map();
  const providers = raw.PROVIDER_CONFIG_PATH ? loadProvidersConfig(raw.PROVIDER_CONFIG_PATH).providers : [];

  return Object.freeze({
    ...raw,
    databaseUrl,
    corsOrigins: raw.CORS_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean),
    chains,
    providers: Object.freeze(providers),
    responseEncryptionKeys,
    // Derived from the parsed map so the active id always matches a usable key,
    // even when the environment value carries separators or padding whitespace.
    activeResponseEncryptionKeyId: responseEncryptionKeys.keys().next().value
  });
}
