import assert from 'node:assert/strict';
import test from 'node:test';
import { SiweMessage } from 'siwe';
import { WalletAuthService, sessionCookie, sessionTokenFromRequest } from '../src/auth/wallet-auth.js';

const config = Object.freeze({
  NODE_ENV: 'test',
  PUBLIC_APP_URL: 'http://localhost:3000',
  MONAD_RPC_URL: 'https://rpc.monad.xyz',
  AUTH_SESSION_HMAC_SECRET: 's'.repeat(32),
  AUTH_SESSION_TTL_SECONDS: 3600,
  AUTH_CHALLENGE_TTL_SECONDS: 300,
  AUTH_COOKIE_NAME: 'mcg_session'
});

function request(headers) {
  return { headers };
}

test('session token prefers a gateway session bearer and otherwise reads the cookie', () => {
  assert.equal(sessionTokenFromRequest(request({ authorization: 'Bearer mcg_session_cli' }), 'mcg_session'), 'mcg_session_cli');
  assert.equal(sessionTokenFromRequest(request({ cookie: 'theme=dark; mcg_session=mcg_session_browser' }), 'mcg_session'), 'mcg_session_browser');
  assert.equal(sessionTokenFromRequest(request({ authorization: 'Bearer mcg_live_project' }), 'mcg_session'), null);
});

test('browser session cookie is HttpOnly, strict and only secure in production', () => {
  assert.match(sessionCookie(config, 'mcg_session_test'), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(sessionCookie(config, 'mcg_session_test'), /; Secure/);
  assert.match(sessionCookie({ ...config, NODE_ENV: 'production' }, 'mcg_session_test'), /; Secure$/);
});

test('SIWE validation binds address, nonce, Monad chain and application origin', () => {
  const auth = new WalletAuthService({}, config);
  const address = '0x000000000000000000000000000000000000dEaD';
  const challenge = {
    nonce: '0123456789abcdef',
    chain_id: 143,
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    created_at: new Date(Date.now() - 1000)
  };
  const message = new SiweMessage({
    domain: challenge.domain,
    address,
    statement: 'Sign in to Router 3',
    uri: challenge.uri,
    version: '1',
    chainId: challenge.chain_id,
    nonce: challenge.nonce,
    issuedAt: new Date().toISOString()
  }).prepareMessage();

  assert.equal(auth.validateMessage(challenge, address, message).address, address);
  assert.throws(
    () => auth.validateMessage({ ...challenge, nonce: 'fedcba9876543210' }, address, message),
    /nonce does not match/
  );
  assert.throws(
    () => auth.validateMessage({ ...challenge, domain: 'evil.example' }, address, message),
    /origin does not match/
  );
});

function originFixture({ expectedUri = 'http://localhost:3000', ...messageFields } = {}) {
  const auth = new WalletAuthService({}, config);
  const address = '0x000000000000000000000000000000000000dEaD';
  const challenge = {
    nonce: '0123456789abcdef',
    chain_id: 143,
    domain: 'localhost:3000',
    uri: expectedUri,
    created_at: new Date(Date.now() - 1000),
    expires_at: new Date(Date.now() + 300_000)
  };
  const message = new SiweMessage({
    domain: challenge.domain,
    address,
    statement: 'Sign in to Router 3',
    uri: challenge.uri,
    version: '1',
    chainId: challenge.chain_id,
    nonce: challenge.nonce,
    issuedAt: new Date().toISOString(),
    ...messageFields
  }).prepareMessage();
  return { auth, address, challenge, message };
}

test('SIWE accepts equivalent root URLs with or without the trailing slash', () => {
  for (const expectedUri of ['http://localhost:3000', 'http://localhost:3000/']) {
    for (const uri of ['http://localhost:3000', 'http://localhost:3000/']) {
      const { auth, address, challenge, message } = originFixture({ expectedUri, uri });
      assert.equal(auth.validateMessage(challenge, address, message).address, address);
    }
  }
});

test('SIWE still rejects different protocols, hosts, ports, paths, queries and fragments', () => {
  for (const uri of [
    'https://localhost:3000/',
    'http://127.0.0.1:3000/',
    'http://localhost:3001/',
    'http://localhost.evil.example:3000/',
    'http://localhost:3000/login',
    'http://localhost:3000/?token=do-not-log-this',
    'http://localhost:3000/#/funding',
    'http://user:password@localhost:3000/',
    'ftp://localhost:3000/'
  ]) {
    const { auth, address, challenge, message } = originFixture({ uri });
    assert.throws(() => auth.validateMessage(challenge, address, message), {
      code: 'SIWE_ORIGIN_MISMATCH'
    }, uri);
  }
});

test('SIWE binds the first-line domain and any explicit scheme independently of its URI', () => {
  for (const fields of [
    { domain: 'localhost' },
    { domain: 'localhost:3001' },
    { domain: 'evil.example' },
    { scheme: 'https' }
  ]) {
    const { auth, address, challenge, message } = originFixture(fields);
    assert.throws(() => auth.validateMessage(challenge, address, message), {
      code: 'SIWE_ORIGIN_MISMATCH'
    });
  }
  const { auth, address, challenge, message } = originFixture({ scheme: 'http', uri: 'http://localhost:3000/' });
  assert.equal(auth.validateMessage(challenge, address, message).address, address);
});

test('SIWE origin diagnostics omit signed messages, query strings and credentials', () => {
  const { auth, address, challenge, message } = originFixture({
    uri: 'http://localhost:3000/?token=do-not-log-this'
  });
  assert.throws(() => auth.validateMessage(challenge, address, message), (error) => {
    assert.deepEqual(error.details, {
      mismatchedFields: ['uri'],
      expectedDomain: 'localhost:3000',
      receivedDomain: 'localhost:3000',
      expectedOrigin: 'http://localhost:3000',
      receivedOrigin: 'http://localhost:3000'
    });
    assert.doesNotMatch(JSON.stringify(error.details), /do-not-log-this|Nonce|Issued At/);
    return true;
  });
});

test('new SIWE challenges use the canonical root URI', async () => {
  let values;
  const auth = new WalletAuthService({
    async query(_sql, input) { values = input; return { rows: [{ id: 'test-challenge' }] }; }
  }, config);
  await auth.createChallenge();
  assert.equal(values[2], 'localhost:3000');
  assert.equal(values[3], 'http://localhost:3000/');
});

test('SIWE domain diagnostics redact userinfo in malformed authority fields', () => {
  const { auth, address, challenge, message } = originFixture({ domain: 'user:do-not-log-this@localhost:3000' });
  assert.throws(() => auth.validateMessage(challenge, address, message), (error) => {
    assert.equal(error.code, 'SIWE_ORIGIN_MISMATCH');
    assert.equal(error.details.receivedDomain, '[invalid authority]');
    assert.doesNotMatch(JSON.stringify(error.details), /do-not-log-this/);
    return true;
  });
});

test('URI comparison never rewrites the message passed to signature verification', async () => {
  const { auth, address, challenge, message } = originFixture({ uri: 'http://localhost:3000/' });
  auth.pool = { async query() { return { rows: [challenge] }; } };
  let verifiedMessage;
  auth.client = {
    async verifyMessage(input) { verifiedMessage = input.message; return false; }
  };
  await assert.rejects(auth.verifyAndCreateSession({
    challengeId: 'test-challenge', address, message, signature: '0x1234'
  }), { code: 'INVALID_WALLET_SIGNATURE' });
  assert.equal(verifiedMessage, message);
});

test('address allowlist admits listed wallets in any case and is open when empty', () => {
  const listed = '0x000000000000000000000000000000000000dEaD';
  const auth = new WalletAuthService({}, { ...config, AUTH_ALLOWED_ADDRESSES: [listed.toLowerCase()] });
  assert.doesNotThrow(() => auth.assertAllowed(listed));
  assert.throws(() => auth.assertAllowed(`0x${'1'.repeat(40)}`), (error) => error.code === 'ADDRESS_NOT_ALLOWED' && error.statusCode === 403);
  assert.doesNotThrow(() => new WalletAuthService({}, config).assertAllowed(`0x${'1'.repeat(40)}`));
});
