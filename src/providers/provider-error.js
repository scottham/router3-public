export class ProviderError extends Error {
  // `details` is echoed to the customer, `cause` is not: it stays in the error
  // chain for the request log. Anything naming internal hosts, credentials or
  // upstream account state belongs in `cause`.
  constructor(message, { code = 'PROVIDER_ERROR', statusCode = 502, chargeCertainty = 'unknown', details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderError';
    this.code = code;
    this.statusCode = statusCode;
    this.chargeCertainty = chargeCertainty;
    this.details = details;
  }
}
