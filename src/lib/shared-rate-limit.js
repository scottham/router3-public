import Redis from 'ioredis';
import { AppError } from './errors.js';

// Redis holds disposable coordination state only. No money, credentials, prompts
// or model responses enter this store. Financial authorization remains in PG.
const increment = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then return redis.error_reply('RATE_WINDOW_MISSING') end
return {n, ttl}`;
const unavailable = () => new AppError('RATE_LIMIT_UNAVAILABLE', 'Shared request limits are temporarily unavailable', 503);

export function createSharedRateLimit(config) {
  if (!config.REDIS_URL) {
    if (config.REDIS_REQUIRED) throw new Error('REDIS_URL_REQUIRED');
    return { options: {}, ready: async () => {}, close: async () => {} };
  }
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
    connectTimeout: config.REDIS_TIMEOUT_MS ?? 1000, commandTimeout: config.REDIS_TIMEOUT_MS ?? 1000,
    retryStrategy: attempt => Math.min(attempt * 100, 2000)
  });
  // Never log transport errors: Redis URLs may contain credentials.
  redis.on('error', () => {});
  redis.defineCommand('router3RateLimit', { numberOfKeys: 1, lua: increment });
  const prefix = `${config.REDIS_NAMESPACE ?? 'router3'}:api-rate:v1:`;
  class Store {
    constructor(_options, suffix = '') { this.prefix = prefix + suffix; }
    incr(key, callback, timeWindow) {
      redis.router3RateLimit(this.prefix + key, timeWindow)
        .then(([current, ttl]) => callback(null, { current, ttl }), () => callback(unavailable()));
    }
    child(options) { return new Store(options, `${options.routeInfo.method}:${options.routeInfo.url}:`); }
  }
  return {
    options: { store: Store, skipOnError: false },
    async connect() { try { await redis.connect(); } catch { /* readiness and requests fail closed */ } },
    async ready() { try { if (await redis.ping() !== 'PONG') throw unavailable(); } catch { throw unavailable(); } },
    async close() { redis.disconnect(); }
  };
}
