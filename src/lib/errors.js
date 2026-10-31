export class AppError extends Error {
  constructor(code, message, statusCode = 400, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const pgMessageMap = new Map([
  ['AUTH_REQUIRED', 401],
  ['ORG_PERMISSION_DENIED', 403],
  ['PROJECT_PERMISSION_DENIED', 403],
  ['PROJECT_ARCHIVED', 409],
  ['INVALID_PROJECT_POLICY', 422],
  ['UNKNOWN_MODEL', 422],
  ['ORG_BILLING_PERMISSION_DENIED', 403],
  ['PROJECT_KEY_PERMISSION_DENIED', 403],
  ['API_KEY_NOT_ACTIVE', 401],
  ['API_KEY_OWNER_REQUIRED', 403],
  ['PROJECT_NOT_ACTIVE', 403],
  ['BILLING_ACCOUNT_NOT_ACTIVE', 402],
  ['WALLET_BILLING_DISABLED',503],
  ['WALLET_BILLING_NOT_REGISTERED',402],
  ['WALLET_NOT_OWNED',403],
  ['WALLET_SNAPSHOT_STALE',503],
  ['WALLET_FUNDS_OR_ALLOWANCE_INSUFFICIENT',402],
  ['WALLET_COLLECTION_BLOCKED',402],
  ['WALLET_EXPOSURE_LIMIT',402],
  ['PLATFORM_EXPOSURE_LIMIT',503],
  ['WALLET_REQUEST_LIMIT',402],
  ['WALLET_USAGE_RECONCILIATION_REQUIRED',402],
  ['PER_REQUEST_LIMIT_EXCEEDED', 402],
  ['DAILY_LIMIT_EXCEEDED', 402],
  ['MONTHLY_LIMIT_EXCEEDED', 402],
  ['LIFETIME_LIMIT_EXCEEDED', 402],
  ['MODEL_NOT_ALLOWED_FOR_PROJECT', 403],
  ['MODEL_OR_PRICE_NOT_ACTIVE', 404],
  ['IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST', 409],
  ['WALLET_SUSPENDED',402],
  ['WALLET_ROUTER_MISMATCH',409],
  ['WALLET_PERMIT_DEADLINE_INVALID',422],
  ['WALLET_PERMIT_RATE_LIMITED',429],
  ['WALLET_PERMIT_PENDING',409],
  ['WALLET_PERMIT_NONCE_USED',409],
  ['WALLET_POOL_REQUEST_INVALID',422],
  ['WALLET_POOL_REQUEST_PENDING',409],
  ['WALLET_POOL_REQUEST_RATE_LIMITED',429]
]);
const descriptions={
  WALLET_BILLING_DISABLED:'Wallet billing is not enabled',WALLET_BILLING_NOT_REGISTERED:'Connect and authorize your wallet first',
  WALLET_NOT_OWNED:'Only your own verified wallet can be used',WALLET_SNAPSHOT_STALE:'The wallet balance or allowance is stale; refresh and retry',
  WALLET_FUNDS_OR_ALLOWANCE_INSUFFICIENT:'Not enough balance available; retry later or deposit',
  WALLET_COLLECTION_BLOCKED:'A charge is pending recovery; new calls are paused',WALLET_EXPOSURE_LIMIT:'Running and unsettled charges reached the wallet limit; wait for settlement',
  PLATFORM_EXPOSURE_LIMIT:'The platform\'s unsettled limit is full; retry later',WALLET_REQUEST_LIMIT:'The estimated maximum exceeds the per-request limit; shorten the input or set a smaller output limit',
  MODEL_NOT_ALLOWED_FOR_PROJECT:'This project may not call this model',
  WALLET_USAGE_RECONCILIATION_REQUIRED:'A call\'s usage is being reconciled; new calls resume afterwards',
  PER_REQUEST_LIMIT_EXCEEDED:'The estimate exceeds the per-request limit',DAILY_LIMIT_EXCEEDED:'The daily limit is reached',
  MONTHLY_LIMIT_EXCEEDED:'The monthly limit is reached',LIFETIME_LIMIT_EXCEEDED:'The lifetime limit is reached',
  WALLET_SUSPENDED:'Wallet billing is suspended',WALLET_ROUTER_MISMATCH:'The billing contract changed; refresh',
  WALLET_PERMIT_DEADLINE_INVALID:'The authorization signature expired; sign again',WALLET_PERMIT_RATE_LIMITED:'Today\'s gasless authorizations are used up; authorize on-chain instead',
  WALLET_PERMIT_PENDING:'The previous authorization is still being submitted; wait a moment',WALLET_PERMIT_NONCE_USED:'This authorization signature was already used; sign again',
  WALLET_POOL_REQUEST_INVALID:'Invalid pool request',WALLET_POOL_REQUEST_PENDING:'The previous pool operation is still being submitted; wait a moment',
  WALLET_POOL_REQUEST_RATE_LIMITED:'Today\'s pool operations are used up'
};

export function fromPostgresError(error) {
  if (error instanceof AppError) return error;
  if (error?.code === '23505') return new AppError('CONFLICT', 'A unique record already exists', 409, undefined, { cause: error });
  if (error?.code === '23503') return new AppError('REFERENCE_NOT_FOUND', 'A referenced record does not exist', 409, undefined, { cause: error });
  if (error?.code === '23514') return new AppError('CONSTRAINT_VIOLATION', 'A database constraint was violated', 422, undefined, { cause: error });
  // Only messages this gateway raises itself are safe to echo. Anything else is
  // raw PostgreSQL text and must never reach the client as a code or a message.
  const message = String(error?.message ?? 'DATABASE_ERROR').split('\n')[0];
  const statusCode = pgMessageMap.get(message);
  if (statusCode === undefined) {
    return new AppError('DATABASE_ERROR', 'Database operation failed', 500, undefined, { cause: error });
  }
  return new AppError(message, descriptions[message]??message, statusCode, undefined, { cause: error });
}

// Fastify rejects some requests before any handler runs (oversized or
// malformed bodies). Those are the client's mistake and keep their 4xx status.
const FASTIFY_CLIENT_ERRORS = Object.freeze({
  FST_ERR_CTP_BODY_TOO_LARGE: ['REQUEST_BODY_TOO_LARGE', 'The request body is too large'],
  FST_ERR_CTP_INVALID_MEDIA_TYPE: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported Content-Type'],
  FST_ERR_CTP_EMPTY_JSON_BODY: ['INVALID_JSON', 'The request body is not valid JSON'],
  FST_ERR_CTP_INVALID_JSON_BODY: ['INVALID_JSON', 'The request body is not valid JSON']
});

function fromFastifyError(error) {
  const status = Number(error?.statusCode);
  if (!(status >= 400 && status < 500) || typeof error.code !== 'string' && error.name !== 'SyntaxError') return null;
  const [code, message] = FASTIFY_CLIENT_ERRORS[error.code] ?? (error.name === 'SyntaxError' ? ['INVALID_JSON', 'The request body is not valid JSON'] : ['BAD_REQUEST', 'Bad request']);
  return new AppError(code, message, status);
}

export function publicError(error) {
  const appError = error instanceof AppError ? error : fromFastifyError(error) ?? fromPostgresError(error);
  return {
    statusCode: appError.statusCode,
    body: {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details })
      }
    }
  };
}
