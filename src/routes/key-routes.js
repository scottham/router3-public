import { z } from 'zod';
import { usdcAtomic as usdc } from '../x402/service.js';

// API key management for the signed-in wallet: create, list (with what each
// key spent from the wallet's pool), set a key's spending limits, revoke.
// Keys made before the pool returned may still refund their x402 channel.
const usdcAmount = z.union([z.string().regex(/^\d+(\.\d{1,6})?$/), z.number().positive()]).nullable().optional();
const limits = { dailyLimitUsdc: usdcAmount, totalLimitUsdc: usdcAmount };
const atomic = (value) => value == null || Number(value) === 0 ? null : usdc(String(value));

export async function registerKeyRoutes(app, { keys, userAuth, pool = null }) {
  const payer = (request) => request.identity.address;
  const send = (reply, outcome) => reply.code(outcome.status).headers(outcome.headers ?? {}).send(outcome.body);

  // Keys have their own per-request limit, not the x402 one.
  app.get('/v1/keys', { preHandler: userAuth }, async (request) => ({
    terms: { requestLimitAtomic: String(keys.requestLimitAtomic), maxConcurrency: keys.maxConcurrency, holdOutputTokens: keys.holdOutputTokens },
    pool: pool ? await pool.view(payer(request).toLowerCase()) : null,
    keys: await keys.list(payer(request))
  }));

  app.post('/v1/keys', { preHandler: userAuth }, async (request, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), ...limits }).strict().parse(request.body ?? {});
    return reply.code(201).send(await keys.create({ payer: payer(request), name: body.name,
      dailyLimitAtomic: atomic(body.dailyLimitUsdc), totalLimitAtomic: atomic(body.totalLimitUsdc) }));
  });

  app.patch('/v1/keys/:id', { preHandler: userAuth }, async (request) => {
    const row = await keys.owned(payer(request), request.params.id);
    const body = z.object(limits).strict().parse(request.body ?? {});
    return { key: await keys.setLimits(row, { dailyLimitAtomic: atomic(body.dailyLimitUsdc), totalLimitAtomic: atomic(body.totalLimitUsdc) }) };
  });

  app.get('/v1/keys/:id/requests', { preHandler: userAuth }, async (request) => {
    const row = await keys.owned(payer(request), request.params.id);
    return { items: pool ? await pool.store.requestsForKey(row.id) : [] };
  });

  // An older key's x402 channel: what is unspent goes back to the wallet.
  app.post('/v1/keys/:id/refund', { preHandler: userAuth }, async (request, reply) => {
    const row = await keys.owned(payer(request), request.params.id);
    return send(reply, await keys.refund(row));
  });

  // Revoking stops calls at once; an older key's channel balance goes back to
  // the wallet in the same step when nothing is in flight.
  app.delete('/v1/keys/:id', { preHandler: userAuth }, async (request) => {
    const row = await keys.owned(payer(request), request.params.id);
    await keys.revoke(row);
    const refund = await keys.refund(row).catch((error) => ({ status: error.statusCode ?? 500, body: { error: { code: error.code, message: error.message } } }));
    return { revoked: true, refund: refund.body };
  });
}
