import { locale, t } from './i18n.js';
const NANO_PER_UNIT = 1_000_000_000n;
const GROUP = /\B(?=(\d{3})+(?!\d))/g;

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  const text = String(value ?? '0').trim();
  if (!/^-?\d+$/.test(text)) return 0n;
  return BigInt(text);
}

// Balances and prices arrive as integer nano strings. They are never converted
// through Number, so a large treasury balance cannot lose its last digits.
export function formatNanoUsdc(value, { minimumFractionDigits = 2, maximumFractionDigits = 6 } = {}) {
  const nano = toBigInt(value);
  const sign = nano < 0n ? '-' : '';
  const absolute = nano < 0n ? -nano : nano;
  const whole = (absolute / NANO_PER_UNIT).toString().replace(GROUP, ',');
  const nineDigits = (absolute % NANO_PER_UNIT).toString().padStart(9, '0');
  let fraction = nineDigits.slice(0, maximumFractionDigits).replace(/0+$/, '');
  // Truncating a dust balance to two places would render a non-zero amount as
  // 0.00. Exactness matters more than column width here, so keep every digit.
  if (!fraction && absolute > 0n && absolute < NANO_PER_UNIT) fraction = nineDigits.replace(/0+$/, '');
  fraction = fraction.padEnd(minimumFractionDigits, '0');
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export function formatPricePerMillion(value) {
  return formatNanoUsdc(value, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function shortAddress(value, lead = 6, tail = 4) {
  const text = String(value ?? '');
  return text.length > lead + tail + 1 ? `${text.slice(0, lead)}…${text.slice(-tail)}` : (text || '—');
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 3600_000],
  ['month', 30 * 24 * 3600_000],
  ['day', 24 * 3600_000],
  ['hour', 3600_000],
  ['minute', 60_000],
  ['second', 1000]
];

export function formatRelativeTime(value, now = Date.now()) {
  if (!value) return t('never');
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const delta = time - now;
  const formatter = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms || unit === 'second') {
      return formatter.format(Math.round(delta / ms), unit);
    }
  }
  return '—';
}

// Token counts in tables and stat tiles: exact below 10k, compact above.
export function formatTokens(value) {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 10_000) return n.toLocaleString('en-US');
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (Math.abs(n) >= size) return `${(n / size).toFixed(n / size >= 100 ? 0 : 1).replace(/\.0$/, '')}${suffix}`;
  }
  return String(n);
}

export function formatLatency(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

// Short currency for charts and tiles: never rounds a non-zero amount to zero.
export function formatUsdcShort(value) {
  const nano = toBigInt(value);
  if (nano === 0n) return '0';
  const absolute = nano < 0n ? -nano : nano;
  if (absolute >= 1000n * NANO_PER_UNIT) return formatNanoUsdc(nano, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (absolute >= NANO_PER_UNIT) return formatNanoUsdc(nano, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (absolute >= 10_000_000n) return formatNanoUsdc(nano, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return formatNanoUsdc(nano, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}

export function formatLimit(value) {
  return value == null ? t('No limit') : `${formatNanoUsdc(value)} USDC`;
}
