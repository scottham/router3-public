import { z } from 'zod';
import { AppError, publicError } from '../lib/errors.js';
import { canonicalize, sha256 } from '../lib/crypto.js';
import { PricingService } from './pricing-service.js';
import { ProviderError } from '../providers/provider-error.js';
import { completionToChunk } from '../providers/chat-stream.js';
import { reportedCostUsdNano } from '../providers/direct.js';
import * as anthropic from '../protocols/anthropic.js';
import * as responses from '../protocols/responses.js';
import {cacheRequestSchema,hasLongCacheWrite} from '../providers/prompt-cache.js';

export const PROTOCOLS = Object.freeze({ anthropic, responses });

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.any(),
  name: z.string().optional(),
  tool_call_id: z.string().optional()
}).passthrough();

const requestSchema = z.object({
  ...cacheRequestSchema,
  model: z.string().min(1).max(200),
  messages: z.array(messageSchema).min(1).max(1000),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  max_completion_tokens: z.number().int().positive().max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  thinking: z.object({type:z.enum(['enabled','disabled'])}).strict().optional(),
  reasoning_effort: z.enum(['none','minimal','low','medium','high','xhigh','max','ultra']).optional(),
  enable_thinking: z.boolean().optional(),
  thinking_budget: z.number().int().nonnegative().max(1_000_000).optional(),
  tools: z.array(z.any()).max(128).optional(),
  tool_choice: z.any().optional(),
  response_format: z.any().optional(),
  user: z.string().max(256).optional()
}).passthrough();

// Returned by `execute` for `stream:true` requests once the upstream has
// accepted the request. `events` yields `{event?, data}` records: `data` is a
// Chat Completions chunk object, the literal '[DONE]', or for `event:'error'`
// a `{error:{...}}` body. Everything that can still be answered with an HTTP
// status happens before this object is created.
export class GatewayStream {
  constructor({ requestId, events }) {
    this.requestId = requestId;
    this.events = events;
  }
}

function streamIncomplete(message) {
  return new ProviderError(message, { code: 'PROVIDER_STREAM_INCOMPLETE', statusCode: 502, chargeCertainty: 'unknown' });
}

function streamTimeout(message) {
  return new ProviderError(message, { code: 'PROVIDER_TIMEOUT', statusCode: 504, chargeCertainty: 'unknown' });
}

// Why a stream was cut off: idle or total timeout, otherwise the client left.
function abortCause(reason) {
  if (reason instanceof ProviderError) return reason;
  if (reason?.name === 'TimeoutError') return streamTimeout('The stream exceeded its time limit');
  return streamIncomplete('Stream aborted before usage was reported');
}

// Aborts when the upstream sends nothing for `ms`; `touch()` starts or restarts
// the clock. It is first touched when the upstream answers: uploading a large
// image to a provider in China can take minutes from this server, and only the
// total limit applies until then.
function idleTimer(ms) {
  const controller = new AbortController();
  let timer;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(streamTimeout(`No data from the model for ${ms / 1000} seconds`)), ms);
    timer.unref?.();
  };
  return { signal: controller.signal, touch, stop: () => clearTimeout(timer) };
}

// Yields upstream chunks until the signal fires, even when the provider never
// notices the signal and its iterator would otherwise wait forever.
async function* untilAborted(iterable, signal) {
  const iterator = iterable[Symbol.asyncIterator]();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  let done = false;
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) { done = true; return; }
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!done) Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

// The provider result settle() expects, from an aggregated Messages or
// Responses body.
function protocolResult({ protocol, name, aggregator }, model) {
  const body = aggregator.toBody();
  return {
    providerRequestId: body.id ?? null,
    usageSource: `direct:${model.provider}:${name}`,
    usage: protocol.usage(body),
    providerCostUsdNano: reportedCostUsdNano(body.usage),
    rawUsageRedacted: { ...body.usage, protocol: name, upstream_model: model.provider_model,
      ...(typeof body.model === 'string' ? { upstream_response_model: body.model } : {}) },
    body: { ...body, model: model.public_name }
  };
}

// Validates and prices a request (`prepare`), then runs it against the
// provider (`execute`): streaming, timeouts and failure classification live
// here. Money is the ledger's business (src/x402/service.js):
//   settle({requestId, model, providerResult, gatewayBase}) -> gateway block
//   fail(requestId, error) -> the error to surface
//   abandon(requestId)     -> the stream consumer left before settlement
export class GatewayService {
  constructor({ repository, providerRegistry, config }) {
    this.repository = repository;
    this.providerRegistry = providerRegistry;
    this.config = config;
    this.pricing = new PricingService();
  }

  // Validates a request and prices its hold without touching any ledger.
  // `protocol` is null for Chat Completions. With `budgetNano`, an output
  // limit the client left out is set to the largest that keeps the hold
  // within it (and forwarded, so the provider enforces it). `bytesPerToken` and
  // `holdOutputTokens`: see PricingService.
  async prepare({ protocol: name = null, body, budgetNano = null, bytesPerToken = 1, holdOutputTokens = null }) {
    const protocol = name ? PROTOCOLS[name] : null;
    const request = protocol ? protocol.parse(body) : requestSchema.parse(body);
    const model = await this.repository.getModelAndPrice(request.model);
    if (!model) throw new AppError('MODEL_NOT_FOUND', 'Requested model or active price version was not found', 404);
    model.capabilities = model.capabilities ?? {};
    let outputField = null;
    if (protocol) {
      // Only providers with a native endpoint and a synced quote are served.
      const provider = this.providerRegistry.get(model.provider);
      if (!model.bailian_quote || !provider.protocolPath?.(name)) throw new AppError('MODEL_PROTOCOL_UNSUPPORTED', `${model.public_name} does not support the ${protocol.label} API`, 422);
      outputField = protocol.applyDefaults?.(request, model) ?? null;
    } else {
      if(!model.bailian_quote && !request.max_tokens && !request.max_completion_tokens) {
        throw new AppError('MAX_TOKENS_REQUIRED','max_tokens or max_completion_tokens is required for this model',422);
      }
      if(request.max_tokens && request.max_completion_tokens)throw new AppError('OUTPUT_LIMIT_CONFLICT','Set only one of max_tokens and max_completion_tokens',422);
      outputField = model.bailian_quote && !request.max_tokens && !request.max_completion_tokens ? 'max_tokens' : null;
    }
    // Publishing a catalog or restarting services must not enable spending.
    if (this.config.REAL_MODEL_CALLS_ENABLED !== true && model.provider !== 'mock') {
      throw new AppError('REAL_MODEL_CALLS_DISABLED', 'Real model calls are disabled; this environment only supports mock requests', 503);
    }
    const cacheWriteTtl=hasLongCacheWrite(request)?'1h':null;
    const estimateFor = () => this.pricing.estimateMaximum(protocol ? protocol.view(request) : request, model, { bytesPerToken, holdOutputTokens, cacheWriteTtl });
    let estimate = estimateFor();
    if (budgetNano != null && outputField && BigInt(estimate.maxChargeUsdcNano) > budgetNano) {
      let low = 1, high = Number(request[outputField] ?? model.bailian_quote.maxOutputTokens);
      const fits = (n) => { request[outputField] = n; return BigInt(estimateFor().maxChargeUsdcNano) <= budgetNano; };
      if (fits(low)) {
        while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
        request[outputField] = low;
        estimate = estimateFor();
      } else {
        request[outputField] = high;
      }
    }
    const requestDigest = sha256(canonicalize(protocol ? { protocol: name, request } : request));
    return { protocol: name, request, model, estimate, requestDigest };
  }

  // Calls the provider for a request whose payment is verified, settles
  // through the ledger and classifies failures. Returns the response body or
  // a GatewayStream; throws the error the ledger decided to surface.
  async execute({ ledger, requestId, request, model, protocol: name, signal, gatewayBase, context }) {
    // Time-of-use tariffs bill by when the request started.
    model.started_at = new Date();
    let idle = null;
    try {
      const provider = this.providerRegistry.get(model.provider);
      // Streams get a longer total budget plus an idle limit: long reasoning
      // output keeps flowing, a stalled upstream is cut off.
      const timeout = request.stream
        ? this.config.STREAM_REQUEST_TIMEOUT_MS ?? 570000
        : Math.min(this.config.DEFAULT_REQUEST_TIMEOUT_MS, this.config.MAX_REQUEST_TIMEOUT_MS);
      idle = request.stream ? idleTimer(this.config.STREAM_IDLE_TIMEOUT_MS ?? 90000) : null;
      // A caller who leaves mid-stream stops the model; what it generated is
      // unknown and the ceiling is charged. A non-streaming call keeps running
      // when the caller leaves (a proxy such as Cloudflare drops idle
      // connections after about 100 seconds): the model finishes within the
      // timeout and the call is billed on its reported usage, not the ceiling.
      const abortSignal = AbortSignal.any([request.stream ? signal : null, AbortSignal.timeout(timeout), idle?.signal].filter(Boolean));

      if (name) {
        const protocol = PROTOCOLS[name];
        // Explicit cache writes are forwarded only where the quote prices them.
        const keepCacheControl = model.bailian_quote.tiers?.every((t) => t.cacheWrite != null) ?? false;
        const events = await provider.openProtocol(name, protocol.upstreamBody(request, model.provider_model, { keepCacheControl }), abortSignal, context, model);
        const upstream = { protocol, name, events, aggregator: new protocol.Aggregator() };
        if (request.stream) {
          idle.touch();
          return new GatewayStream({ requestId,
            events: this.forwardProtocolStream({ ledger, requestId, model, upstream, gatewayBase, signal: abortSignal, idle }) });
        }
        for await (const event of untilAborted(events, abortSignal)) upstream.aggregator.push(event);
        const providerResult = protocolResult(upstream, model);
        const gateway = await ledger.settle({ requestId, model, providerResult, gatewayBase });
        return { ...providerResult.body, gateway };
      }

      if (request.stream) {
        // Adapters without a streaming transport still serve streaming clients:
        // the synchronous completion is replayed as a single chunk. Billing is
        // identical either way because both paths settle from the same receipt.
        const upstream = typeof provider.stream === 'function'
          ? await provider.stream(request, model, abortSignal, context)
          : await provider.invoke(request, model, abortSignal, context).then((result) => ({
            chunks: (async function* () { yield completionToChunk(result.body); })(),
            result: () => result
          }));
        idle.touch();
        return new GatewayStream({
          requestId,
          events: this.forwardStream({ ledger, requestId, model, upstream, gatewayBase, signal: abortSignal, idle })
        });
      }

      const providerResult = await provider.invoke(request, model, abortSignal, context);
      const gateway = await ledger.settle({ requestId, model, providerResult, gatewayBase });
      return { ...providerResult.body, gateway };
    } catch (error) {
      idle?.stop();
      throw await ledger.fail(requestId, error);
    }
  }

  // Like forwardStream: upstream events pass through as they arrive (model
  // renamed), except the closing events, which are sent only once the charge
  // is final and then carry the settled usage and the gateway block. Any other
  // ending settles what the ledger decides and closes with the format's error event.
  async *forwardProtocolStream({ ledger, requestId, model, upstream, gatewayBase, signal, idle }) {
    const { protocol, aggregator } = upstream;
    let settled = false;
    try {
      for await (const event of untilAborted(upstream.events, signal)) {
        idle.touch();
        aggregator.push(event);
        if (!protocol.held(event.data.type)) yield protocol.forwardEvent(event, model.public_name);
      }
      idle.stop();
      if (signal.aborted) throw streamIncomplete('Stream aborted before usage was reported');
      const providerResult = protocolResult(upstream, model);
      const gateway = await ledger.settle({ requestId, model, providerResult, gatewayBase });
      settled = true;
      for (const event of protocol.finalEvents(providerResult.body, gateway, aggregator)) yield event;
    } catch (error) {
      settled = true;
      const cause = signal.aborted ? abortCause(signal.reason) : error;
      const failure = await ledger.fail(requestId, cause).catch(() => cause);
      const { statusCode, body } = failure instanceof AppError ? publicError(failure)
        : { statusCode: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'The request failed before usage was settled' } } };
      yield protocol.errorEvent(statusCode, body.error, requestId);
    } finally {
      idle.stop();
      if (!settled) await ledger.abandon(requestId).catch(() => undefined);
    }
  }

  // Forwards upstream chunks to the client. The final usage chunk (OpenAI
  // `include_usage` shape, `choices:[]`) is only sent after the charge is
  // settled, so a client that sees it knows the charge is final. A stream that
  // ends any other way — upstream disconnect, no usage, client abort — is
  // handed to the ledger as unknown usage and ends with an `error` event; it is
  // never treated as free.
  async *forwardStream({ ledger, requestId, model, upstream, gatewayBase, signal, idle = null }) {
    let settled = false;
    try {
      const chunks = signal ? untilAborted(upstream.chunks, signal) : upstream.chunks;
      for await (const chunk of chunks) {
        idle?.touch();
        if (signal?.aborted) throw streamIncomplete('Stream aborted before usage was reported');
        // The gateway emits its own usage chunk once billing is final, so
        // upstream usage never reaches the client ahead of settlement.
        const { usage: _usage, ...forwarded } = chunk;
        if (!forwarded.choices?.length) continue;
        yield { data: { ...forwarded, model: model.public_name } };
      }
      idle?.stop();
      if (signal?.aborted) throw streamIncomplete('Stream aborted before usage was reported');
      const providerResult = upstream.result();
      const gateway = await ledger.settle({ requestId, model, providerResult, gatewayBase });
      settled = true;
      const { id, created } = providerResult.body;
      yield { data: { id, object: 'chat.completion.chunk', created, model: model.public_name, choices: [], usage: providerResult.body.usage, gateway } };
      yield { data: '[DONE]' };
    } catch (error) {
      settled = true;
      const cause = signal?.aborted ? abortCause(signal.reason) : error;
      const failure = await ledger.fail(requestId, cause).catch(() => cause);
      const detail = failure instanceof AppError
        ? publicError(failure).body.error
        : { code: 'INTERNAL_ERROR', message: 'The request failed before usage was settled' };
      yield { event: 'error', data: { error: { ...detail, request_id: requestId } } };
    } finally {
      idle?.stop();
      // The consumer stopped iterating before the stream settled (for example
      // the HTTP connection closed). Usage may have been consumed upstream.
      if (!settled) await ledger.abandon(requestId).catch(() => undefined);
    }
  }
}

// OpenAI `GET /v1/models` shape.
export function modelList(rows) {
  return {
    object: 'list',
    data: rows.map((row) => ({
      id: row.public_name,
      object: 'model',
      created: Math.floor(new Date(row.created_at).getTime() / 1000),
      owned_by: row.provider
    }))
  };
}
