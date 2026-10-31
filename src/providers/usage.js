import { ProviderError } from './provider-error.js';

function readPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function usageError(path, value) {
  return new ProviderError('Provider response did not include reliable token usage', {
    code: 'PROVIDER_USAGE_UNAVAILABLE',
    statusCode: 502,
    chargeCertainty: 'unknown',
    details: {
      field: path,
      reason: value == null ? 'missing' : 'not_a_non_negative_safe_integer'
    }
  });
}

export function requiredUsageCounter(usage, path) {
  const value = readPath(usage, path);
  if (!Number.isSafeInteger(value) || value < 0) throw usageError(path, value);
  return value;
}

export function optionalUsageCounter(usage, path) {
  const value = readPath(usage, path);
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw usageError(path, value);
  return value;
}
