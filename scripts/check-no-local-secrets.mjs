import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv as parseNodeEnv } from 'node:util';
const parseEnv=text=>new Map(Object.entries(parseNodeEnv(text)));

const secretNames = [
  'REDIS_PASSWORD','REDIS_URL',
  'OPENROUTER_MANAGEMENT_KEY', 'openrouter_management_key', 'OPENROUTER_KEY_ENCRYPTION_KEYS',
  'DATABASE_URL_PROVIDER', 'DATABASE_URL_PROVIDER_DOCKER',
  'PRIVATE_KEY', 'BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY', 'BASE_MAINNET_DEPLOYER_PRIVATE_KEY',
  'deepseek_api_key', 'DEEPSEEK_API_KEY',
  'glm_api_key', 'GLM_API_KEY', 'ZAI_API_KEY',
  'OPENROUTER_MANAGEMENT_KEY', 'AUTH_SESSION_HMAC_SECRET', 'API_KEY_HMAC_SECRET',
  'INTERNAL_HMAC_SECRET', 'RESPONSE_ENCRYPTION_KEYS', 'AUTO_FUNDING_ENCRYPTION_KEYS',
  'AUTO_FUNDER_SIGNER_BEARER_TOKEN', 'CDP_PAYMASTER_RPC_URL', 'SETTLER_SIGNER_BEARER_TOKEN',
  'BASE_MAINNET_RPC_URL', 'BASE_ACCOUNT_RPC_URL', 'MONAD_RPC_URL', 'MONAD_FORK_RPC_URL'
];
const PUBLIC_VALUES = new Set(['https://rpc.monad.xyz', 'https://rpc1.monad.xyz', 'https://mainnet.base.org', 'https://sepolia.base.org']);
const env = existsSync('.env')?parseEnv(readFileSync('.env', 'utf8')):new Map();
if(existsSync('.env.mainnet-local')) for(const [key,value] of parseEnv(readFileSync('.env.mainnet-local','utf8'))) {
  if(/PASSWORD|SECRET|DATABASE_URL|API_KEY|MASTER_KEY|ENCRYPTION_KEYS|BEARER_TOKEN|TUNNEL_TOKEN|SA_TOKEN|PROM_TOKEN|RPC_URL/.test(key)) {
    const name=`MAINNET_${key}`;secretNames.push(name);env.set(name,value);
  }
}
for(const [name,path] of [['SETTLER_PRIVATE_KEY','.secrets/mainnet-settler.key'],['MONAD_SETTLER_PRIVATE_KEY','.secrets/monad-settler.key']])if(existsSync(path)) {
  secretNames.push(name);env.set(name,readFileSync(path,'utf8').trim());
}
for(const path of ['.router3/runtime.env','.router3/providers.env'])if(existsSync(path)) {
  for(const [key,value] of parseEnv(readFileSync(path,'utf8')))if(/PASSWORD|SECRET|DATABASE_URL|API_KEY|MASTER_KEY|ENCRYPTION_KEYS|BEARER_TOKEN|RPC_URL|REDIS_URL/.test(key)) {
    const name=`SELFHOST_${key}`;secretNames.push(name);env.set(name,value);
  }
}
if(existsSync('.router3/settler.key')) {
  secretNames.push('SELFHOST_SETTLER_PRIVATE_KEY');env.set('SELFHOST_SETTLER_PRIVATE_KEY',readFileSync('.router3/settler.key','utf8').trim());
}
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8'
}).split('\n').filter((path) => path && existsSync(path));
const leaks = [];
for (const name of secretNames) {
  const value = env.get(name);
  // Keyless public endpoints are configuration, not secrets, and are expected in the code.
  if (!value || value.length < 12 || PUBLIC_VALUES.has(value)) continue;
  for (const path of files) {
    if (readFileSync(path).includes(value)) leaks.push({ variable: name, file: path });
  }
}
if (leaks.length > 0) {
  console.error(JSON.stringify({ message: 'Local secret value found in deliverable file', leaks }, null, 2));
  process.exit(1);
}
console.log(`Local secret scan OK: ${secretNames.filter((name) => env.has(name)).length} configured variables checked`);
