import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const env = parseEnv(readFileSync('.env', 'utf8'));
const databaseKeys = [
  ['DATABASE_URL_API', 'REPLACE_API_DB_PASSWORD'],
  ['DATABASE_URL_SETTLER', 'REPLACE_SETTLER_DB_PASSWORD'],
  ['DATABASE_URL_RECONCILER', 'REPLACE_RECONCILER_DB_PASSWORD']
];

let sql = readFileSync('supabase/manual/create_backend_roles.sql.template', 'utf8');
// The historical indexer role is still in the template but nothing connects as
// it, so it gets a throwaway password, as in ops/bootstrap-production-db.mjs.
const secrets = [randomBytes(32).toString('hex')];
sql = sql.replaceAll('REPLACE_INDEXER_DB_PASSWORD', secrets[0]);
for (const [envKey, placeholder] of databaseKeys) {
  const value = env.get(envKey);
  if (!value) throw new Error(`${envKey} is missing from .env`);
  const password = decodeURIComponent(new URL(value).password);
  if (!password) throw new Error(`${envKey} does not contain a password`);
  secrets.push(password);
  sql = sql.replaceAll(placeholder, password.replaceAll("'", "''"));
}

const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');
const projectId = supabaseConfig.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
if (!projectId) throw new Error('supabase/config.toml does not define project_id');
const container = `supabase_db_${projectId}`;
const result = spawnSync(
  'docker',
  ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
);

if (result.status !== 0) {
  let message = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  throw new Error(`Unable to configure local database roles:\n${message.trim()}`);
}

console.log('Configured gateway_api, gateway_indexer, gateway_settler and gateway_reconciler roles');
