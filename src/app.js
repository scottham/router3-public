import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { createPool } from './db/pool.js';
import { publicError, AppError } from './lib/errors.js';
import { createSharedRateLimit } from './lib/shared-rate-limit.js';
import { buildUserAuth } from './auth/user-auth.js';
import { WalletAuthService } from './auth/wallet-auth.js';
import { AccountRepository } from './repositories/account-repository.js';
import { GatewayRepository } from './repositories/gateway-repository.js';
import { GatewayService } from './services/gateway-service.js';
import { createProviderRegistry } from './providers/registry.js';
import { OpenRouterManagement, ProviderKeyService } from './services/provider-keys.js';
import { registerUserRoutes } from './routes/user-routes.js';
import { registerGatewayRoutes } from './routes/gateway-routes.js';
import { registerX402Routes } from './routes/x402-routes.js';
import { createX402 } from './x402/index.js';
import { ApiKeyService, PgApiKeyStore, apiKeyOf } from './x402/api-keys.js';
import { registerKeyRoutes } from './routes/key-routes.js';
import { registerKeySelfRoutes } from './routes/key-self-routes.js';
import { registerPoolRoutes } from './routes/pool-routes.js';
import { PoolBilling } from './pool/billing.js';
import { PoolChain } from './pool/chain.js';
import { PgPoolStore } from './pool/store.js';
import { CHAIN_KEY } from './chain.js';
import { paymentChannelOf } from './x402/service.js';

export async function buildApp(config, { x402: x402Overrides = {} } = {}) {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: config.MAX_REQUEST_BODY_BYTES,
    requestIdHeader: 'x-request-id'
  });
  const pool = createPool(config);
  const sharedLimit = createSharedRateLimit(config);
  app.addHook('onReady', async () => sharedLimit.connect?.());

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      callback(new AppError('CORS_ORIGIN_DENIED', 'Origin is not allowed', 403), false);
    },
    credentials: true
  });
  await app.register(rateLimit, {
    ...sharedLimit.options,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    errorResponseBuilder: () => new AppError('RATE_LIMIT_EXCEEDED', 'Request rate limit exceeded', 429),
    // Paid requests are bucketed per channel (decoded, unverified: it only
    // picks a bucket); everything else per IP.
    keyGenerator(request) {
      const token = apiKeyOf(request.headers);
      if (token) return `key:${token.slice(0, 16)}`;
      const payment = request.headers['payment-signature'];
      if (typeof payment === 'string') { const channel = paymentChannelOf(payment); if (channel) return `x402:${channel}`; }
      return request.ip;
    }
  });

  const accountRepository = new AccountRepository(pool);
  const gatewayRepository = new GatewayRepository(pool, config);
  const walletAuth = new WalletAuthService(pool, config);
  const userAuth = buildUserAuth(walletAuth, config);
  // OpenRouter: one call key per payer wallet, minted from the management key.
  const openrouter = config.providers.find((p) => p.type === 'openrouter');
  const providerKeys = openrouter && process.env[openrouter.managementKeyEnv]
    ? new ProviderKeyService({ pool, config, management: new OpenRouterManagement({ managementKey: process.env[openrouter.managementKeyEnv] }),
      limitUsd: openrouter.payerKeyLimitUsd })
    : null;
  const providerRegistry = createProviderRegistry(config, { providerKeys });
  const gatewayService = new GatewayService({ repository: gatewayRepository, providerRegistry, config });
  // Channel terms come from the facilitator at start-up; until that succeeds
  // model calls answer 503.
  const x402 = createX402({ config, pool, gateway: gatewayService, ...x402Overrides });
  // API keys bill from the wallet's prepaid pool when one is configured.
  const poolBilling = config.POOL_ADDRESS ? new PoolBilling({ store: new PgPoolStore(pool), config, maxConcurrency: config.API_KEY_MAX_CONCURRENCY,
    chain: new PoolChain({ rpcUrl: config.chains?.[CHAIN_KEY]?.rpcUrl ?? config.MONAD_RPC_URL, poolAddress: config.POOL_ADDRESS }) }) : null;
  const keys = new ApiKeyService({ store: new PgApiKeyStore(pool), config, service: x402.service, repository: x402.repository, storage: x402.storage,
    pool: poolBilling, maxConcurrency: config.API_KEY_MAX_CONCURRENCY });
  app.addHook('onReady', async () => { x402.service.initialize({ retries: 0 }).then((ready) => { if (!ready) x402.service.initialize({ delayMs: 15000 }); }); });

  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      await sharedLimit.ready();
      await pool.query('select 1');
      await providerRegistry.ready();
      return { ok: true, runtime: config.MCG_RUNTIME, x402: x402.service.ready };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await registerUserRoutes(app, { config, walletAuth, userAuth, accountRepository, x402, keys });
  await registerGatewayRoutes(app, { x402, keys, userAuth, gatewayRepository, chatBodyLimit: config.MAX_CHAT_BODY_BYTES, sessionCookieName: config.AUTH_COOKIE_NAME });
  await registerKeyRoutes(app, { keys, userAuth, pool: poolBilling });
  await registerKeySelfRoutes(app, { keys, pool: poolBilling });
  if (poolBilling) await registerPoolRoutes(app, { pool: poolBilling, userAuth });
  await registerX402Routes(app, { x402, userAuth, config, pool });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues } });
    }
    request.log.error({ err: error }, 'request_failed');
    const result = publicError(error);
    return reply.code(result.statusCode).send(result.body);
  });

  app.addHook('onClose', async () => {await sharedLimit.close();await pool.end();poolBilling?.chain.destroy();});
  return { app, pool, x402, keys };
}
