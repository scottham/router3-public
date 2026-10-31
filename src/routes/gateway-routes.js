import { ZodError } from 'zod';
import { GatewayStream, PROTOCOLS, modelList } from '../services/gateway-service.js';
import { x402ErrorResponse } from '../x402/service.js';
import { apiKeyOf } from '../x402/api-keys.js';
import { sessionTokenFromRequest } from '../auth/wallet-auth.js';

// OpenAI SSE framing: one `data:` line per chunk, a literal `[DONE]` sentinel,
// and a named `error` event (which the OpenAI SDKs surface as an APIError).
export function formatSseEvent({ event, data }) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}

// An SSE comment during silent stretches (long prefill, slow reasoning). Clients
// ignore comment lines; proxies such as Cloudflare drop a stream that stays idle
// for about 100 seconds.
export const SSE_KEEPALIVE = ': keepalive\n\n';

// Writes a GatewayStream as SSE. Shared by every streaming endpoint.
function sendStream(reply, response, keepaliveMs) {
  reply.hijack();
  reply.raw.writeHead(200, {
    ...reply.getHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-model-gateway-request-id': response.requestId
  });
  reply.raw.flushHeaders?.();
  // Keep draining even after the client went away: the generator settles or
  // charges the ceiling in its own catch/finally, and stopping early would
  // skip that bookkeeping.
  const writable = () => !reply.raw.destroyed && !reply.raw.writableEnded;
  let lastWrite = Date.now();
  const keepalive = setInterval(() => {
    if (writable() && Date.now() - lastWrite >= keepaliveMs) { reply.raw.write(SSE_KEEPALIVE); lastWrite = Date.now(); }
  }, keepaliveMs);
  return (async () => {
    try {
      for await (const event of response.events) {
        if (writable()) { reply.raw.write(formatSseEvent(event)); lastWrite = Date.now(); }
      }
    } finally {
      clearInterval(keepalive);
    }
    if (!reply.raw.writableEnded) reply.raw.end();
    return reply;
  })();
}

// A settled JSON response: request id and the x402 receipt header the
// client's SDK reads.
function sendResponse(reply, response) {
  reply.header('x-model-gateway-request-id', response.gateway?.request_id ?? response.id ?? 'unknown');
  if (response.gateway?.x402?.payment_response) {
    reply.header('PAYMENT-RESPONSE', response.gateway.x402.payment_response);
    reply.header('access-control-expose-headers', 'PAYMENT-RESPONSE, x-model-gateway-request-id');
  }
  return response;
}

// Every model call pays through an x402 channel, one of two ways. With an API
// key (`Authorization: Bearer r3_live_…` or `x-api-key`) the gateway charges
// the key's channel and signs the voucher itself. Without one, the client
// signs: the first request answers 402 with the price, the signed retry runs
// the model. Errors raised before the gateway takes over are answered in the
// endpoint's own format.
export async function registerGatewayRoutes(app, { x402, keys = null, userAuth, gatewayRepository, keepaliveMs = 15000, chatBodyLimit = 20971520, sessionCookieName = 'mcg_session' }) {
  async function payWithChannel(name, request, reply) {
    const token = keys ? apiKeyOf(request.headers) : null;
    const outcome = token
      ? await keys.handle({ row: await keys.authenticate(token), protocol: name, body: request.body, signal: request.abortSignal })
      : await x402.service.handle({ protocol: name, headers: request.headers, body: request.body, signal: request.abortSignal });
    if (outcome.response instanceof GatewayStream) return sendStream(reply, outcome.response, keepaliveMs);
    if (outcome.response) return sendResponse(reply, outcome.response);
    return reply.code(outcome.status).headers(outcome.headers).send(outcome.body);
  }

  function abortOnClose(request, reply) {
    // A client disconnect aborts a streaming upstream call; the ledger then
    // charges the ceiling because tokens may already have been generated. A
    // non-streaming call ignores it and is billed on usage (gateway-service).
    const abort = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) abort.abort(); });
    request.abortSignal = abort.signal;
  }

  for (const [path, name] of [['/v1/chat/completions', 'chat'], ['/v1/messages', 'anthropic'], ['/v1/responses', 'responses']]) {
    app.post(path, { bodyLimit: chatBodyLimit }, async (request, reply) => {
      abortOnClose(request, reply);
      try { return await payWithChannel(name, request, reply); }
      catch (error) {
        if (error instanceof ZodError) {
          const detail = { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: error.issues };
          return reply.code(422).send(name === 'chat' ? { error: detail } : PROTOCOLS[name].errorBody(422, detail));
        }
        const result = x402ErrorResponse(name, error);
        if (result.status >= 500) request.log.error({ err: error }, 'request_failed');
        return reply.code(result.status).send(result.body);
      }
    });
  }

  // One path, two audiences. A browser session (cookie or `mcg_session_`
  // bearer) gets the console's catalog with prices. Anyone else gets the
  // OpenAI-compatible list of models a channel can pay for.
  // Only the console's own cookie counts: a browser on another site of the
  // same domain sends unrelated cookies and still gets the public list.
  app.get('/v1/models', async (request) => {
    if (!sessionTokenFromRequest(request, sessionCookieName)) return modelList(await gatewayRepository.listPublicModels());
    await userAuth(request);
    return gatewayRepository.listCatalog();
  });
}
