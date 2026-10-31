export const NANO_PER_UNIT = 1_000_000_000n;
export const USDC_ATOMIC_PER_UNIT = 1_000_000n;
export const NANO_PER_USDC_ATOMIC = 1_000n;
export const TOKENS_PER_MILLION = 1_000_000n;

export function assertNonNegativeBigInt(value, name = 'value') {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${name} must be a non-negative bigint`);
  return value;
}

export function parseDecimalToNano(value) {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(text)) throw new TypeError('Amount must be a non-negative decimal with at most 9 places');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * NANO_PER_UNIT + BigInt(fraction.padEnd(9, '0'));
}

export function formatNano(value, places = 9) {
  assertNonNegativeBigInt(value);
  const whole = value / NANO_PER_UNIT;
  const fraction = (value % NANO_PER_UNIT).toString().padStart(9, '0').slice(0, places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function usdcAtomicToNano(value) {
  return assertNonNegativeBigInt(BigInt(value)) * NANO_PER_USDC_ATOMIC;
}

export function nanoToUsdcAtomicExact(value) {
  assertNonNegativeBigInt(value);
  if (value % NANO_PER_USDC_ATOMIC !== 0n) throw new RangeError('USDC_NANO value is not exactly representable on-chain');
  return value / NANO_PER_USDC_ATOMIC;
}

export function nanoToUsdcAtomicFloor(value) {
  return assertNonNegativeBigInt(value) / NANO_PER_USDC_ATOMIC;
}

export function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
}

export function tokenCostNano(tokens, nanoPerMillion) {
  const tokenCount = assertNonNegativeBigInt(BigInt(tokens), 'tokens');
  const rate = assertNonNegativeBigInt(BigInt(nanoPerMillion), 'nanoPerMillion');
  return ceilDiv(tokenCount * rate, TOKENS_PER_MILLION);
}

export function applyBasisPoints(value, basisPoints) {
  const amount = assertNonNegativeBigInt(value);
  const bps = BigInt(basisPoints);
  if (bps < 0n) throw new RangeError('basisPoints must be non-negative');
  return ceilDiv(amount * (10_000n + bps), 10_000n);
}

// Decimal strings or JSON numbers from a provider's price or cost fields,
// scaled to integer units (default nano) without binary floating point:
// "0.000002" at scale 15 is the nano-per-million rate of a per-token price,
// 1.344e-5 at scale 9 a cost in nano USD. Rounds up unless told otherwise.
export function decimalUnits(value, scale = 9, rounding = 'ceil') {
  const text = String(value);
  const match = text.match(/^(\d{1,40})(?:\.(\d{1,40}))?(?:[eE]([+-]?\d{1,3}))?$/);
  if (!match || !Number.isInteger(scale) || scale < 0 || scale > 18) throw new TypeError('INVALID_DECIMAL_AMOUNT');
  const fraction = match[2] ?? '';
  const exponent = scale + Number(match[3] ?? 0) - fraction.length;
  const digits = BigInt(match[1] + fraction);
  const result = exponent >= 0 ? digits * 10n ** BigInt(exponent)
    : rounding === 'floor' ? digits / 10n ** BigInt(-exponent)
      : (digits + 10n ** BigInt(-exponent) - 1n) / 10n ** BigInt(-exponent);
  if (result > 9223372036854775807n) throw new RangeError('DECIMAL_AMOUNT_OVERFLOW');
  return result;
}
