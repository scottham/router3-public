import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv, upsertEnv } from './lib/env-file.mjs';

const envPath = '.env';
const examplePath = '.env.example';
const webEnvPath = 'web/.env';
const placeholderPattern = /REPLACE_|YOUR_|CHANGE_ME|placeholder/i;

function usable(value) {
  return typeof value === 'string' && value.length > 0 && !placeholderPattern.test(value);
}

const existingText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const existing = parseEnv(existingText);
const example = readFileSync(examplePath, 'utf8');
const generated = new Set();

function keepOrCreate(key, create) {
  const current = existing.get(key);
  if (usable(current)) return current;
  generated.add(key);
  return create();
}

const apiDbPassword = randomBytes(24).toString('hex');
const settlerDbPassword = randomBytes(24).toString('hex');
const reconcilerDbPassword = randomBytes(24).toString('hex');

const apiDatabaseUrl = keepOrCreate('DATABASE_URL_API', () => `postgresql://gateway_api:${apiDbPassword}@127.0.0.1:54322/postgres`);
const settlerDatabaseUrl = keepOrCreate('DATABASE_URL_SETTLER', () => `postgresql://gateway_settler:${settlerDbPassword}@127.0.0.1:54322/postgres`);
const reconcilerDatabaseUrl = keepOrCreate('DATABASE_URL_RECONCILER', () => `postgresql://gateway_reconciler:${reconcilerDbPassword}@127.0.0.1:54322/postgres`);


function dockerHostUrl(value) {
  const url = new URL(value);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.toString().replace(/\/$/, '');
}

const redisPassword=keepOrCreate('REDIS_PASSWORD',()=>randomBytes(32).toString('hex'));
const replacements = new Map([
  ['REDIS_PASSWORD',redisPassword],
  ['REDIS_URL',existing.get('REDIS_URL') || `redis://:${redisPassword}@127.0.0.1:6379/0`],
  ['REDIS_NAMESPACE',existing.get('REDIS_NAMESPACE') || 'router3-dev'],
  ['PUBLIC_APP_URL', existing.get('PUBLIC_APP_URL') || 'http://localhost:3000'],
  ['VITE_API_BASE_URL', existing.get('VITE_API_BASE_URL') || 'http://localhost:8787'],
  ['CORS_ORIGINS', existing.get('CORS_ORIGINS') || 'http://localhost:3000'],
  ['MONAD_RPC_URL', existing.get('MONAD_RPC_URL') || 'https://rpc.monad.xyz'],
  ['AUTH_SESSION_HMAC_SECRET', keepOrCreate('AUTH_SESSION_HMAC_SECRET', () => randomBytes(32).toString('hex'))],
  ['DATABASE_URL_API', apiDatabaseUrl],
  ['DATABASE_URL_SETTLER', settlerDatabaseUrl],
  ['DATABASE_URL_RECONCILER', reconcilerDatabaseUrl],
  ['DATABASE_URL_API_DOCKER', existing.get('DATABASE_URL_API_DOCKER') || dockerHostUrl(apiDatabaseUrl)],
  ['DATABASE_URL_RECONCILER_DOCKER', existing.get('DATABASE_URL_RECONCILER_DOCKER') || dockerHostUrl(reconcilerDatabaseUrl)],
  ['SETTLER_SIGNER_BEARER_TOKEN', keepOrCreate('SETTLER_SIGNER_BEARER_TOKEN', () => randomBytes(32).toString('hex'))],
  ['SETTLER_SIGNER_URL', existing.get('SETTLER_SIGNER_URL') || 'http://127.0.0.1:8790/sign'],
  ['X402_FACILITATOR_URL', existing.get('X402_FACILITATOR_URL') || 'https://x402-facilitator.molandak.org'],
  ['RESPONSE_ENCRYPTION_KEYS', keepOrCreate('RESPONSE_ENCRYPTION_KEYS', () => `v1:${randomBytes(32).toString('base64')}`)],
  ['MODEL_MARKUP_BPS', existing.get('MODEL_MARKUP_BPS') || '0'],
  ['REAL_MODEL_CALLS_ENABLED', existing.get('REAL_MODEL_CALLS_ENABLED') || 'false']
]);

// Existing files are edited in place. Unknown keys, comments, ordering, casing,
// blank lines and values that this script does not own remain byte-for-byte in
// their original lines. This is important for locally added wallet/provider keys.
const completed = upsertEnv(existingText || example, replacements);

if (existsSync(envPath)) {
  copyFileSync(envPath, `${envPath}.backup-before-complete`);
  chmodSync(`${envPath}.backup-before-complete`, 0o600);
}
writeFileSync(envPath, completed, { mode: 0o600 });
const webExisting = existsSync(webEnvPath) ? readFileSync(webEnvPath, 'utf8') : '';
if (existsSync(webEnvPath)) {
  copyFileSync(webEnvPath, `${webEnvPath}.backup-before-complete`);
  chmodSync(`${webEnvPath}.backup-before-complete`, 0o600);
}
writeFileSync(webEnvPath, upsertEnv(webExisting, new Map([
  ['VITE_API_BASE_URL', replacements.get('VITE_API_BASE_URL')]
])), { mode: 0o600 });
chmodSync(envPath, 0o600);
chmodSync(webEnvPath, 0o600);

const pending = [...replacements.entries()]
  .filter(([, value]) => !usable(value))
  .map(([key]) => key);
console.log(`Local environment completed; generated=${generated.size}, pending=${pending.join(',') || 'none'}`);
