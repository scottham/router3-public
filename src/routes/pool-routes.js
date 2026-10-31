import { z } from 'zod';

// The signed-in wallet's prepaid pool: its terms and state, and the calls the
// wallet signs in the browser for the gateway to relay (it pays the gas):
// the USDC permit to the pool, the refill target and daily limit, and a
// withdrawal request or its cancellation. A matured withdrawal is executed by
// the collector; the pool only ever pays the wallet back.
const amount = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform(String);
const signed = { nonce: amount, deadline: amount, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) };

export async function registerPoolRoutes(app, { pool, userAuth }) {
  const payer = (request) => request.identity.address.toLowerCase();

  app.get('/v1/pool', { preHandler: userAuth }, async (request) =>
    ({ terms: await pool.terms(), account: await pool.view(payer(request)), nonces: await pool.chain.nonces(payer(request)).then(
      (n) => ({ pool: String(n.pool), usdc: String(n.usdc) })) }));

  // One-time setup: both signatures in one request, permit first.
  app.post('/v1/pool/setup', { preHandler: userAuth }, async (request, reply) => {
    const body = z.object({
      permit: z.object({ value: amount, deadline: amount, signature: signed.signature }).strict(),
      configure: z.object({ refillTarget: amount, dailyLimit: amount, ...signed }).strict()
    }).strict().parse(request.body ?? {});
    const ops = [await pool.permit(payer(request), body.permit), await pool.configure(payer(request), body.configure)];
    return reply.code(202).send({ ops: ops.map((o) => ({ id: o.id, kind: o.kind, state: o.state })) });
  });

  app.post('/v1/pool/permit', { preHandler: userAuth }, async (request, reply) => {
    const body = z.object({ value: amount, deadline: amount, signature: signed.signature }).strict().parse(request.body ?? {});
    const op = await pool.permit(payer(request), body);
    return reply.code(202).send({ op: { id: op.id, kind: op.kind, state: op.state } });
  });

  app.post('/v1/pool/configure', { preHandler: userAuth }, async (request, reply) => {
    const body = z.object({ refillTarget: amount, dailyLimit: amount, ...signed }).strict().parse(request.body ?? {});
    const op = await pool.configure(payer(request), body);
    return reply.code(202).send({ op: { id: op.id, kind: op.kind, state: op.state } });
  });

  app.post('/v1/pool/withdrawal', { preHandler: userAuth }, async (request, reply) => {
    const body = z.object({ amount, ...signed }).strict().parse(request.body ?? {});
    const op = await pool.requestWithdrawal(payer(request), body);
    return reply.code(202).send({ op: { id: op.id, kind: op.kind, state: op.state } });
  });

  app.delete('/v1/pool/withdrawal', { preHandler: userAuth }, async (request, reply) => {
    const body = z.object(signed).strict().parse(request.body ?? {});
    const op = await pool.cancelWithdrawal(payer(request), body);
    return reply.code(202).send({ op: { id: op.id, kind: op.kind, state: op.state } });
  });
}
