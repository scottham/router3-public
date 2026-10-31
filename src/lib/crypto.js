import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalize(value)).digest();
}

export function hmacSha256(secret, value) {
  return createHmac('sha256', secret).update(typeof value === 'string' ? value : canonicalize(value)).digest();
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApiKey(secret, kind = 'mcg_live') {
  const prefix = randomBytes(6).toString('base64url');
  const tokenSecret = randomBytes(32).toString('base64url');
  const token = `${kind}_${prefix}_${tokenSecret}`;
  return { token, prefix: `${kind}_${prefix}`, digest: hmacSha256(secret, token) };
}

export function createSessionToken(secret) {
  const token = `mcg_session_${randomBytes(32).toString('base64url')}`;
  return { token, digest: hmacSha256(secret, token) };
}

export function encryptJson(value, keyId, key) {
  const plaintext = Buffer.from(JSON.stringify(value));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(keyId));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { keyId, nonce, authTag: cipher.getAuthTag(), ciphertext, plaintextSize: plaintext.length };
}

export function decryptJson(record, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, record.nonce);
  decipher.setAAD(Buffer.from(record.keyId));
  decipher.setAuthTag(record.authTag);
  return JSON.parse(Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString('utf8'));
}
