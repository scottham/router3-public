import { randomBytes } from 'node:crypto';
import { SiweMessage } from 'siwe';
import { createPublicClient, getAddress, http } from 'viem';
import { CHAIN, CHAIN_ID } from '../chain.js';
import { AppError } from '../lib/errors.js';
import { createSessionToken, hmacSha256, sha256 } from '../lib/crypto.js';
import { queryOne, withTransaction } from '../db/pool.js';

function parseSignInUri(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function diagnosticDomain(value) {
  // Only log bounded authority text, never userinfo or other message content.
  return typeof value === 'string' && /^[a-z0-9.:[\]-]{1,255}$/i.test(value)
    ? value : '[invalid authority]';
}

function parseCookieHeader(value) {
  const cookies = new Map();
  for (const part of String(value ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const encoded = part.slice(separator + 1).trim();
    try { cookies.set(name, decodeURIComponent(encoded)); } catch { /* Ignore malformed cookies. */ }
  }
  return cookies;
}

export function sessionTokenFromRequest(request, cookieName) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer mcg_session_')) return authorization.slice(7).trim();
  return parseCookieHeader(request.headers.cookie).get(cookieName) ?? null;
}

export function sessionCookie(config, token, maxAge = config.AUTH_SESSION_TTL_SECONDS) {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  return `${config.AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

// Sign-In with Ethereum on Monad. EOAs are verified by ecrecover; deployed
// smart wallets through ERC-1271 and undeployed ones through ERC-6492.
export class WalletAuthService {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
    this.client = createPublicClient({ chain: CHAIN, transport: http(config.MONAD_RPC_URL) });
  }

  // Checked after the signature and before any account exists, and again on every
  // session, so removing an address ends its sessions too.
  assertAllowed(address) {
    const allowed = this.config.AUTH_ALLOWED_ADDRESSES;
    if (allowed?.length && !allowed.includes(address.toLowerCase())) {
      throw new AppError('ADDRESS_NOT_ALLOWED', 'This wallet is not allowed to use this gateway', 403);
    }
  }

  async createChallenge() {
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + this.config.AUTH_CHALLENGE_TTL_SECONDS * 1000);
    const appUrl = new URL(this.config.PUBLIC_APP_URL);
    return queryOne(this.pool,
      `insert into private.base_auth_challenges(nonce, chain_id, domain, uri, expires_at)
       values ($1,$2,$3,$4,$5)
       returning id, nonce, chain_id, expires_at`,
      [nonce, CHAIN_ID, appUrl.host, new URL(appUrl.origin).href, expiresAt]);
  }

  validateMessage(challenge, claimedAddress, message) {
    let parsed;
    try { parsed = new SiweMessage(message); } catch (error) {
      throw new AppError('INVALID_SIWE_MESSAGE', 'Sign in message is invalid', 400, undefined, { cause: error });
    }

    const address = getAddress(claimedAddress);
    if (getAddress(parsed.address) !== address) throw new AppError('SIWE_ADDRESS_MISMATCH', 'Sign in address does not match the message', 400);
    if (parsed.nonce !== challenge.nonce) throw new AppError('SIWE_NONCE_MISMATCH', 'Sign in nonce does not match', 400);
    if (Number(parsed.chainId) !== Number(challenge.chain_id)) throw new AppError('SIWE_CHAIN_MISMATCH', 'Sign in chain does not match', 400);
    const expectedUri = parseSignInUri(challenge.uri);
    const receivedUri = parseSignInUri(parsed.uri);
    // Compare URL representations, not signed-message bytes. In particular a
    // root URL with or without '/' denotes the same resource. Keep the full
    // path/query/fragment and authority checks; matching just .origin is unsafe.
    const mismatchedFields = [];
    if (parsed.domain !== challenge.domain) mismatchedFields.push('domain');
    if (parsed.scheme && `${parsed.scheme}:` !== expectedUri?.protocol) mismatchedFields.push('scheme');
    if (!expectedUri || !receivedUri || expectedUri.href !== receivedUri.href) mismatchedFields.push('uri');
    if (mismatchedFields.length > 0) {
      throw new AppError('SIWE_ORIGIN_MISMATCH', 'Sign in origin does not match this application', 400, {
        mismatchedFields,
        expectedDomain: diagnosticDomain(challenge.domain),
        receivedDomain: diagnosticDomain(parsed.domain),
        expectedOrigin: expectedUri?.origin ?? null,
        receivedOrigin: receivedUri?.origin ?? null
      });
    }
    if (parsed.version !== '1') throw new AppError('SIWE_VERSION_UNSUPPORTED', 'Only SIWE version 1 is supported', 400);

    const now = Date.now();
    const issuedAt = parsed.issuedAt ? new Date(parsed.issuedAt).getTime() : NaN;
    if (!Number.isFinite(issuedAt) || issuedAt > now + 120_000 || issuedAt < new Date(challenge.created_at).getTime() - 120_000) {
      throw new AppError('SIWE_ISSUED_AT_INVALID', 'Sign in message issue time is invalid', 400);
    }
    if (parsed.expirationTime && new Date(parsed.expirationTime).getTime() <= now) {
      throw new AppError('SIWE_MESSAGE_EXPIRED', 'Sign in message has expired', 401);
    }
    if (parsed.notBefore && new Date(parsed.notBefore).getTime() > now) {
      throw new AppError('SIWE_MESSAGE_NOT_ACTIVE', 'Sign in message is not active yet', 401);
    }
    return { address, parsed };
  }

  async verifyAndCreateSession({ challengeId, address: claimedAddress, message, signature, userAgent = '' }) {
    const challenge = await queryOne(this.pool,
      `select * from private.base_auth_challenges where id = $1`, [challengeId]);
    if (!challenge) throw new AppError('AUTH_CHALLENGE_NOT_FOUND', 'Sign in challenge was not found', 404);
    if (challenge.consumed_at) throw new AppError('AUTH_CHALLENGE_USED', 'Sign in challenge was already used', 409);
    if (new Date(challenge.expires_at) <= new Date()) throw new AppError('AUTH_CHALLENGE_EXPIRED', 'Sign in challenge has expired', 410);

    const { address } = this.validateMessage(challenge, claimedAddress, message);
    let valid = false;
    try {
      valid = await this.client.verifyMessage({ address, message, signature });
    } catch (error) {
      throw new AppError('SIGNATURE_VERIFICATION_UNAVAILABLE', 'Unable to verify the wallet signature', 503, undefined, { cause: error });
    }
    if (!valid) throw new AppError('INVALID_WALLET_SIGNATURE', 'Wallet signature is invalid', 401);
    this.assertAllowed(address);

    const session = createSessionToken(this.config.AUTH_SESSION_HMAC_SECRET);
    const expiresAt = new Date(Date.now() + this.config.AUTH_SESSION_TTL_SECONDS * 1000);
    const userAgentDigest = userAgent ? sha256(userAgent) : null;

    const result = await withTransaction(this.pool, async (client) => {
      const locked = await queryOne(client,
        `select * from private.base_auth_challenges where id = $1 for update`, [challengeId]);
      if (!locked || locked.consumed_at) throw new AppError('AUTH_CHALLENGE_USED', 'Sign in challenge was already used', 409);
      if (new Date(locked.expires_at) <= new Date()) throw new AppError('AUTH_CHALLENGE_EXPIRED', 'Sign in challenge has expired', 410);

      const identity = await queryOne(client,
        `select * from private.resolve_or_create_base_account($1,$2)`,
        [address, challenge.chain_id]);
      const authSession = await queryOne(client,
        `insert into private.base_auth_sessions(
           app_user_id, address_normalized, token_digest, user_agent_digest, expires_at
         ) values ($1,$2,$3,$4,$5)
         returning id, expires_at`,
        [identity.app_user_id, address.toLowerCase(), session.digest, userAgentDigest, expiresAt]);
      await client.query('update private.base_auth_challenges set consumed_at = now() where id = $1', [challengeId]);
      return { ...identity, session_id: authSession.id, expires_at: authSession.expires_at };
    }, { isolation: 'serializable' });

    return { ...result, address, accessToken: session.token };
  }

  async authenticate(token) {
    if (!token) throw new AppError('AUTH_REQUIRED', 'Wallet session is required', 401);
    if (!token.startsWith('mcg_session_')) throw new AppError('INVALID_ACCESS_TOKEN', 'Session token is invalid', 401);
    const digest = hmacSha256(this.config.AUTH_SESSION_HMAC_SECRET, token);
    const row = await queryOne(this.pool,
      `select s.id as session_id, s.app_user_id, s.address_normalized as address,
              b.chain_id, s.expires_at, u.status
       from private.base_auth_sessions s
       join private.base_account_bindings b on b.address_normalized = s.address_normalized
       join public.app_users u on u.id = s.app_user_id
       where s.token_digest = $1 and s.revoked_at is null and s.expires_at > now()`,
      [digest]);
    if (!row) throw new AppError('INVALID_ACCESS_TOKEN', 'Session token is invalid or expired', 401);
    if (row.status !== 'active') throw new AppError('APP_USER_NOT_ACTIVE', 'Application user is not active', 403);
    this.assertAllowed(row.address);
    await this.pool.query(
      `update private.base_auth_sessions set last_seen_at = now()
       where id = $1 and last_seen_at < now() - interval '5 minutes'`, [row.session_id]);
    return row;
  }

  async revoke(token) {
    if (!token?.startsWith('mcg_session_')) return;
    const digest = hmacSha256(this.config.AUTH_SESSION_HMAC_SECRET, token);
    await this.pool.query(
      `update private.base_auth_sessions set revoked_at = coalesce(revoked_at, now()) where token_digest = $1`,
      [digest]);
  }
}
