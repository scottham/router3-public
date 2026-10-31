import { z } from 'zod';
import { apiKeyOf } from '../x402/api-keys.js';
import { refillCouldCover } from '../pool/billing.js';
import { AppError } from '../lib/errors.js';

// What an API key may learn about itself, authenticated by the key alone:
// its spend and limits, the wallet's pool as far as the key is concerned,
// its usage by day and by model, and its recent calls. Read-only; nothing
// here changes limits, revokes, or moves money, and the wallet's address and
// balance are not shown. Dashboards (the dsh plugin) are built on this.
const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const limit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

export async function registerKeySelfRoutes(app, { keys, pool = null }) {
  async function keyAuth(request) {
    const token = apiKeyOf(request.headers);
    if (!token) throw new AppError('API_KEY_REQUIRED', 'An API key is required', 401);
    request.apiKey = await keys.authenticate(token);
  }
  const opts = { ...limit, preHandler: keyAuth };

  // The pool as the key sees it: state, what it can spend today, the limits
  // and whether the wallet could refill it; not the wallet's balance.
  async function poolView(payer) {
    if (!pool) return null;
    const account = await pool.fresh(payer);
    if (!account) return { state: 'none' };
    const { walletBalanceAtomic, ops, ...view } = await pool.view(payer);
    return { ...view, refillable: refillCouldCover(account, 0n) };
  }

  app.get('/v1/key', opts, async (request) => {
    const row = request.apiKey;
    const usage = pool ? (await pool.store.keyTotals(row.payer, startOfUtcDay())).get(row.id) : undefined;
    const { legacyChannel, state, revokedAt, ...key } = keys.view(row, usage);
    return { key: { ...key, requestLimitAtomic: String(keys.requestLimitAtomic), holdOutputTokens: keys.holdOutputTokens }, pool: await poolView(row.payer) };
  });

  app.get('/v1/key/usage', opts, async (request) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(request.query ?? {});
    const since = new Date(startOfUtcDay().getTime() - (days - 1) * 86_400_000);
    const usage = pool ? await pool.store.keyUsage(request.apiKey.id, since) : { daily: [], models: [] };
    return { since: since.toISOString(), days, ...usage };
  });

  // The balance shapes other clients already read (NextChat, Cherry Studio,
  // ChatBox, OpenRouter and DeepSeek tooling), mapped from the same facts:
  // the OpenAI dashboard pair, OpenRouter's key and credits, DeepSeek's
  // balance. "Credits" are what was spent plus what the pool can spend now,
  // so a client's "remaining" is the pool's available amount.
  const usd = (atomic) => Number(atomic ?? 0) / 1e6;
  const minOf = (...values) => values.filter((v) => v != null).reduce((a, b) => (a < b ? a : b), undefined);
  async function balance(row) {
    const usage = pool ? (await pool.store.keyTotals(row.payer, startOfUtcDay())).get(row.id) : undefined;
    const spent = usd(usage?.total ?? 0n), today = usd(usage?.today ?? 0n);
    const account = pool ? await pool.fresh(row.payer) : null;
    const available = account ? usd(await pool.view(row.payer).then((v) => v.availableAtomic)) : 0;
    const keyLeft = minOf(row.total_limit_atomic == null ? null : usd(row.total_limit_atomic) - spent, row.daily_limit_atomic == null ? null : usd(row.daily_limit_atomic) - today);
    return { spent, today, available, limit: row.total_limit_atomic == null ? null : usd(row.total_limit_atomic), remaining: Math.max(0, minOf(available, keyLeft)) };
  }
  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  app.get('/v1/dashboard/billing/subscription', opts, async (request) => {
    const b = await balance(request.apiKey);
    const hard = b.spent + b.remaining;
    return { object: 'billing_subscription', has_payment_method: true, soft_limit_usd: hard, hard_limit_usd: hard, system_hard_limit_usd: hard, access_until: 0 };
  });
  app.get('/v1/dashboard/billing/usage', opts, async (request) => {
    const q = z.object({ start_date: day.optional(), end_date: day.optional() }).parse(request.query ?? {});
    const since = q.start_date ? new Date(`${q.start_date}T00:00:00Z`) : new Date(startOfUtcDay().getTime() - 99 * 86_400_000);
    const { daily } = pool ? await pool.store.keyUsage(request.apiKey.id, since) : { daily: [] };
    const cents = daily.filter((d) => !q.end_date || d.day < q.end_date).reduce((sum, d) => sum + Number(d.charged_atomic) / 1e4, 0);
    return { object: 'list', daily_costs: [], total_usage: cents };
  });
  app.get('/v1/auth/key', opts, async (request) => {
    const b = await balance(request.apiKey);
    return { data: { label: request.apiKey.name, usage: b.spent, limit: b.limit, limit_remaining: b.remaining, is_free_tier: false } };
  });
  app.get('/v1/credits', opts, async (request) => {
    const b = await balance(request.apiKey);
    return { data: { total_credits: b.spent + b.remaining, total_usage: b.spent } };
  });
  for (const path of ['/user/balance', '/v1/user/balance']) app.get(path, opts, async (request) => {
    const b = await balance(request.apiKey);
    const amount = b.remaining.toFixed(2);
    return { is_available: b.remaining > 0, balance_infos: [{ currency: 'USD', total_balance: amount, granted_balance: '0.00', topped_up_balance: amount }] };
  });

  app.get('/v1/key/requests', opts, async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.coerce.date().optional() }).parse(request.query ?? {});
    const items = pool ? await pool.store.requestsForKey(request.apiKey.id, query.limit, query.before ?? null) : [];
    return { items, next: items.length === query.limit ? items[items.length - 1].created_at : null };
  });
}
