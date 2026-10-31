import { existsSync, readFileSync, readdirSync } from 'node:fs';
const required = [
  'README.md', 'LICENSE', '.env.example', 'package.json', 'package-lock.json', 'docker-compose.yml', 'docker-compose.production.yml',
  'docs/ARCHITECTURE.md', 'docs/API_REFERENCE.md', 'docs/X402.md', 'docs/PROVIDERS.md', 'docs/DATABASE_SCHEMA.md', 'docs/CONFIGURATION_CHECKLIST.md',
  'docs/SECURITY.md', 'docs/KNOWN_LIMITATIONS.md', 'docs/SELF_HOSTING.md', 'docs/LOCAL_MAINNET.md', 'docs/MONITORING.md', 'docs/PREPAID_POOL.md',
  'docs/REDIS_DECISION.md', 'docs/SUPABASE_SETUP.md',
  'src/app.js', 'src/server.js', 'src/runtime.js', 'src/config.js', 'src/chain.js', 'src/config/providers.js',
  'src/auth/wallet-auth.js', 'src/auth/user-auth.js', 'src/repositories/account-repository.js', 'src/repositories/gateway-repository.js',
  'src/routes/user-routes.js', 'src/routes/gateway-routes.js', 'src/routes/x402-routes.js',
  'src/services/gateway-service.js', 'src/services/pricing-service.js', 'src/services/tier-pricing.js', 'src/services/fx.js',
  'src/services/deepseek-catalog.js', 'src/services/openrouter-catalog.js', 'src/services/catalog-publish.js', 'src/services/provider-keys.js',
  'src/providers/direct.js', 'src/providers/registry.js', 'src/providers/chat-stream.js', 'src/providers/usage.js',
  'src/x402/service.js', 'src/x402/storage.js', 'src/x402/authorizer.js', 'src/x402/repository.js', 'src/x402/index.js',
  'src/signing/settlement-server.js', 'src/signing/settlement-signer.js', 'src/signing/x402-authorizer-signer.js',
  'src/workers/x402-settlement-worker.js', 'src/workers/reconciliation-worker.js',
  'src/lib/shared-rate-limit.js', 'src/lib/pg-job-lock.js', 'src/lib/call-fee.js',
  'clients/x402-proxy/index.mjs', 'clients/x402-proxy/cli.mjs',
  'supabase/migrations/202610230001_x402_channels.sql', 'supabase/migrations/202610240001_x402_only.sql',
  'supabase/manual/create_backend_roles.sql.template',
  'ops/bootstrap-production-db.mjs', 'ops/catalog-worker.mjs', 'ops/call-fee-policy.mjs', 'ops/metrics-exporter.mjs', 'ops/grafana-dashboard.mjs',
  'ops/deploy-api.sh', 'ops/nginx.conf', 'providers/providers.mainnet.json',
  'scripts/verify-x402-db.mjs', 'scripts/verify-x402-fork.mjs', 'scripts/verify-x402-live.mjs', 'scripts/verify-openai-sdk-compat.mjs',
  'scripts/verify-pool-recovery-e2e.mjs', 'supabase/migrations/202610310001_pool_batch_recovery.sql', 'test/pool-consistency.test.js',
  'scripts/verify-gateway-e2e.mjs', 'scripts/verify-agent-protocols-e2e.mjs', 'scripts/verify-prompt-cache-e2e.mjs', 'scripts/verify-redis-scaling.mjs',
  'src/providers/prompt-cache.js', 'test/prompt-cache.test.js',
  'scripts/lib/isolated-gateway-db.mjs', 'scripts/lib/monad-fork.mjs', 'scripts/lib/read-only-rpc-proxy.mjs', 'scripts/lib/env-file.mjs',
  'contracts/src/WalletPrepaidPool.sol', 'contracts/test/WalletPrepaidPool.t.sol', 'contracts/foundry.toml', 'contracts/artifacts/WalletPrepaidPool.json', 'contracts/README.md',
  'scripts/verify-pool-bytecode.mjs', 'scripts/deploy-pool.mjs', 'scripts/build-pool-artifact.mjs', 'scripts/lib/pool-artifact.mjs', 'scripts/lib/settler-key.mjs',
  'scripts/complete-local-env.mjs', 'scripts/check-no-local-secrets.mjs', 'scripts/configure-local-db.mjs',
  'scripts/configure-mainnet-local.mjs', 'scripts/backup-mainnet-local.mjs', 'scripts/verify-mainnet-backup.mjs',
  'test/x402.test.js', 'test/x402-proxy.test.js', 'test/web-x402.test.js', 'test/helpers/in-memory-gateway.js', 'test/helpers/x402-fake-facilitator.js',
  'test/gateway-service.test.js', 'test/gateway-stream.test.js', 'test/protocols.test.js', 'test/config.test.js', 'test/app.test.js',
  'test/provider-keys.test.js', 'test/direct-provider.test.js', 'test/openrouter-catalog.test.js', 'test/deepseek-catalog.test.js',
  'test/tier-pricing.test.js', 'test/chat-stream.test.js', 'test/call-fee.test.js', 'test/wallet-auth.test.js', 'test/web-console.test.js',
  'test/read-only-rpc-proxy.test.js',
  'web/package.json', 'web/package-lock.json', 'web/.dockerignore', 'web/index.html', 'web/vite.config.js',
  'web/scripts/prepare-wallet-sdk.mjs', 'web/test/wallet-sdk.test.mjs',
  'web/src/main.jsx', 'web/src/App.jsx', 'web/src/ui.jsx', 'web/src/dialogs.jsx', 'web/src/wallet.jsx', 'web/src/context.js',
  'web/src/auth-client.js', 'web/src/siwe.js', 'web/src/wallets.js', 'web/src/format.js', 'web/src/logic.js', 'web/src/snippets.js',
  'web/src/x402.js', 'web/src/wallet-actions.js', 'web/src/views/Channels.jsx', 'web/src/views/Models.jsx', 'web/src/views/Quickstart.jsx'
];
const missing = required.filter((path) => !existsSync(path));
if (missing.length) {
  console.error(`Missing required package files:
${missing.join('\n')}`);
  process.exit(1);
}
const migrations = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort();
if (migrations.length < 14 || !migrations.includes('202609010009_base_account_auth.sql') ||
    !migrations.includes('202609010010_base_account_only_hardening.sql') ||
    !migrations.includes('202609010011_private_schema_privilege_hardening.sql') ||
    !migrations.includes('202610230001_x402_channels.sql') ||
    migrations.at(-1) < '202610240001_x402_only.sql') {
  throw new Error('Expected the ordered authentication, catalog and x402 migrations');
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!pkg.scripts?.start || !pkg.dependencies?.fastify || !pkg.dependencies?.pg) {
  throw new Error('package.json is incomplete');
}
if (!pkg.dependencies?.['@x402/core'] || !pkg.dependencies?.['@x402/evm'] || !pkg.devDependencies?.supabase) {
  throw new Error('The x402 SDK and the Supabase development dependency are required');
}
if (!pkg.dependencies?.viem || pkg.dependencies?.['@supabase/supabase-js']) {
  throw new Error('API authentication must use viem without the Supabase browser-auth client');
}

const webPackage = JSON.parse(readFileSync('web/package.json', 'utf8'));
if (webPackage.dependencies?.['@supabase/supabase-js']) {
  throw new Error('Web authentication must not use the Supabase browser-auth client');
}

const webSource = [
  readFileSync('web/index.html', 'utf8'),
  readFileSync('web/src/auth-client.js', 'utf8'),
  readFileSync('web/src/siwe.js', 'utf8'),
  readFileSync('web/src/wallets.js', 'utf8'),
  readFileSync('web/src/wallet.jsx', 'utf8'),
  readFileSync('web/src/main.jsx', 'utf8')
].join('\n');
if (!webSource.includes('RainbowKitProvider') || !webSource.includes("method: 'personal_sign'") || !webSource.includes('createSiweMessage')) {
  throw new Error('Wallet Sign-In With Ethereum flow is missing');
}
if (/signInWithOAuth|@supabase\/supabase-js|accounts\.google\.com/.test(webSource)) {
  throw new Error('The web application must not expose legacy OAuth login methods');
}

const supabaseConfig = readFileSync('supabase/config.toml', 'utf8');
if (!supabaseConfig.includes('[auth]\nenabled = false') || supabaseConfig.includes('[auth.external.google]')) {
  throw new Error('Supabase must be PostgreSQL-only; application login belongs to the wallet (SIWE)');
}

const envExample = readFileSync('.env.example', 'utf8');
const requiredDockerSettings = ['MONAD_RPC_URL=', 'AUTH_SESSION_HMAC_SECRET=', 'DATABASE_URL_API_DOCKER=', 'DATABASE_URL_RECONCILER_DOCKER=',
  'TREASURY_ADDRESS=', 'SETTLER_ADDRESS=', 'X402_FACILITATOR_URL='];
if (requiredDockerSettings.some((setting) => !envExample.includes(setting))) {
  throw new Error('.env.example is missing sign-in, Docker database or x402 settings');
}
for (const file of ['docker-compose.yml', 'docker-compose.production.yml', '.env.example', 'src/config.js']) {
  const text = readFileSync(file, 'utf8');
  if (/litellm|LITELLM_|WALLET_CHARGE_ROUTER|API_KEY_HMAC|  (indexer|settler|autofunder|provider):/.test(text)) {
    throw new Error(`${file} still references a removed payment path`);
  }
}

console.log(`Package layout OK: ${required.length} required files, ${migrations.length} migrations`);
