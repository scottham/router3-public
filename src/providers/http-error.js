import { ProviderError } from './provider-error.js';

// An upstream HTTP status says two different things at once: whether the
// customer can act on the failure, and whether the attempt may already have
// been charged. Passing the raw status straight through conflates them — an
// expired platform provider key would reach the customer as a 401, which reads
// as "your Router3 key is invalid" and invites an infinite retry loop.
//
// `forwardMessage` is set only where the upstream text describes the customer's
// own request. Auth, quota and outage messages routinely name the platform
// account, its tier or its billing state and must never be echoed.
const POLICIES = new Map([
  [400, { code: 'PROVIDER_REQUEST_REJECTED', statusCode: 400, chargeCertainty: 'not_charged', forwardMessage: true }],
  [402, { code: 'PROVIDER_CREDIT_UNAVAILABLE', statusCode: 503, chargeCertainty: 'not_charged' }],
  [404, { code: 'PROVIDER_MODEL_UNAVAILABLE', statusCode: 503, chargeCertainty: 'not_charged' }],
  [401, { code: 'PROVIDER_AUTH_FAILED', statusCode: 502, chargeCertainty: 'not_charged' }],
  [403, { code: 'PROVIDER_AUTH_FAILED', statusCode: 502, chargeCertainty: 'not_charged' }],
  [408, { code: 'PROVIDER_TIMEOUT', statusCode: 504, chargeCertainty: 'unknown' }],
  [413, { code: 'PROVIDER_REQUEST_REJECTED', statusCode: 413, chargeCertainty: 'not_charged', forwardMessage: true }],
  [422, { code: 'PROVIDER_REQUEST_REJECTED', statusCode: 422, chargeCertainty: 'not_charged', forwardMessage: true }],
  [429, { code: 'PROVIDER_RATE_LIMITED', statusCode: 429, chargeCertainty: 'not_charged' }]
]);

const FALLBACK_MESSAGES = {
  PROVIDER_CREDIT_UNAVAILABLE: 'The model provider credit limit is unavailable; try again later',
  PROVIDER_AUTH_FAILED: 'The gateway could not authenticate with the model provider',
  PROVIDER_MODEL_UNAVAILABLE: 'The requested model is not available upstream',
  PROVIDER_TIMEOUT: 'The model provider did not respond in time',
  PROVIDER_RATE_LIMITED: 'The model provider is rate limiting this gateway',
  PROVIDER_HTTP_ERROR: 'The model provider returned an error'
};

const MAX_FORWARDED_MESSAGE = 500;

function upstreamMessage(body) {
  const message = body?.error?.message ?? body?.message;
  return typeof message === 'string' && message.trim()
    ? message.trim().slice(0, MAX_FORWARDED_MESSAGE)
    : null;
}

export function providerHttpError(status, body) {
  if(status===403&&(body?.error?.code==='Model.AccessDenied'||/Model access denied\./i.test(body?.error?.message??''))) {
    return new ProviderError('This model is not enabled for the gateway at the provider; ask the operator to enable it',{
      code:'PROVIDER_MODEL_ACCESS_DENIED',statusCode:503,chargeCertainty:'not_charged',details:{providerStatus:403}
    });
  }
  const policy = POLICIES.get(status) ?? (status >= 500
    ? { code: 'PROVIDER_HTTP_ERROR', statusCode: 502, chargeCertainty: 'unknown' }
    : { code: 'PROVIDER_HTTP_ERROR', statusCode: status, chargeCertainty: 'not_charged' });

  const forwarded = policy.forwardMessage ? upstreamMessage(body) : null;
  return new ProviderError(forwarded ?? FALLBACK_MESSAGES[policy.code] ?? FALLBACK_MESSAGES.PROVIDER_HTTP_ERROR, {
    code: policy.code,
    statusCode: policy.statusCode,
    chargeCertainty: policy.chargeCertainty,
    // Only the upstream status is disclosed. The routing topology behind the
    // gateway is not a customer-facing detail.
    details: { providerStatus: status }
  });
}
