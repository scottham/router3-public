import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { ReconciliationWorker } from './workers/reconciliation-worker.js';
import { X402SettlementWorker } from './workers/x402-settlement-worker.js';
import { createX402 } from './x402/index.js';
import { PoolWorker, RemotePoolSender } from './workers/pool-worker.js';
import { PoolChain } from './pool/chain.js';
import { PgPoolStore } from './pool/store.js';
import { CHAIN_KEY } from './chain.js';
import { OpenRouterManagement, ProviderKeyService } from './services/provider-keys.js';

const config = loadConfig();
if (config.MCG_RUNTIME === 'api') throw new Error('Use src/server.js for the API runtime');
const pool = createPool(config);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

// collector: claims and settles x402 channels on-chain through the
// facilitator, and debits and refills prepaid pools through the signer.
// reconciler: closes lost requests and expires sign-in data.
const workers = [];
if (config.MCG_RUNTIME === 'collector') {
  workers.push(new X402SettlementWorker(pool, config, createX402({ config, pool, gateway: null })));
  if (config.POOL_ADDRESS) {
    const chain = new PoolChain({ rpcUrl: config.chains?.[CHAIN_KEY]?.rpcUrl ?? config.MONAD_RPC_URL, poolAddress: config.POOL_ADDRESS });
    // The wallet's OpenRouter key follows its pool daily limit (see app.js).
    const openrouter = config.providers.find((p) => p.type === 'openrouter');
    const providerKeys = openrouter && process.env[openrouter.managementKeyEnv]
      ? new ProviderKeyService({ pool, config, management: new OpenRouterManagement({ managementKey: process.env[openrouter.managementKeyEnv] }),
        limitUsd: openrouter.payerKeyLimitUsd })
      : null;
    workers.push(new PoolWorker({ store: new PgPoolStore(pool), chain, config, providerKeys,
      sender: new RemotePoolSender({ url: config.SETTLER_SIGNER_URL, token: config.SETTLER_SIGNER_BEARER_TOKEN }) }));
  }
} else {
  workers.push(new ReconciliationWorker(pool, config));
}

try {
  await Promise.all(workers.map((worker) => worker.run(controller.signal)));
} finally {
  await pool.end();
}
