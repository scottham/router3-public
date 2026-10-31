import assert from 'node:assert/strict';
import test from 'node:test';
import { hexToString, verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SiweMessage } from 'siwe';
import { buildSignInFields, buildSignInMessage, requestWalletSignInProof } from '../web/src/siwe.js';
import { connectAccount } from '../web/src/wallets.js';
import { WalletAuthService } from '../src/auth/wallet-auth.js';

test('SIWE fields include every field required by EIP-4361', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');
  const capability = buildSignInFields({
    nonce: '0123456789abcdef',
    chain_id: '143',
    expires_at: '2026-09-02T12:05:00.000Z'
  }, 'http://localhost:3000', now);

  assert.deepEqual(capability, {
    nonce: '0123456789abcdef',
    chainId: '0x8f',
    scheme: 'http',
    domain: 'localhost:3000',
    uri: 'http://localhost:3000/',
    version: '1',
    statement: 'Sign in to Router 3',
    issuedAt: '2026-09-02T12:00:00.000Z',
    expirationTime: '2026-09-02T12:05:00.000Z'
  });
});

test('sign-in uses a canonical root URI and the explicit application scheme', () => {
  const now = new Date('2026-09-02T12:00:00.000Z');
  const challenge = { nonce: '0123456789abcdef', chain_id: 143, expires_at: '2026-09-02T12:05:00.000Z' };
  for (const siteUrl of ['http://localhost:3000', 'http://localhost:3000/', 'http://localhost:3000/#/funding']) {
    const capability = buildSignInFields(challenge, siteUrl, now);
    assert.equal(capability.uri, 'http://localhost:3000/');
    assert.equal(capability.domain, 'localhost:3000');
    assert.equal(capability.scheme, 'http');
  }
  const secure = buildSignInFields(challenge, 'https://example.com', now);
  assert.equal(secure.scheme, 'https');
  assert.equal(secure.uri, 'https://example.com/');
});

test('does not ask the wallet to sign an expired challenge', () => {
  assert.throws(() => buildSignInFields({
    nonce: '0123456789abcdef',
    chain_id: '143',
    expires_at: '2026-09-02T11:59:59.000Z'
  }, 'http://localhost:3000', new Date('2026-09-02T12:00:00.000Z')), /expired/);
});

function freshChallenge(siteUrl = 'http://localhost:3000') {
  const url = new URL(siteUrl);
  return {
    nonce: '0123456789abcdef', chain_id: 143,
    created_at: new Date(Date.now() - 1000),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    domain: url.host, uri: new URL(url.origin).href
  };
}

test('exact SIWE message preserves the port, scheme, checksum address and expiry', () => {
  const challenge = freshChallenge();
  const message = buildSignInMessage(challenge, challenge.uri, '0x000000000000000000000000000000000000dead');
  const parsed = new SiweMessage(message);
  assert.equal(parsed.domain, 'localhost:3000');
  assert.equal(parsed.scheme, 'http');
  assert.equal(parsed.address, '0x000000000000000000000000000000000000dEaD');
  assert.equal(parsed.chainId, 143);
  assert.equal(parsed.expirationTime, challenge.expires_at);
});

const walletFor = (account, chainId, { onSign, fail } = {}) => {
  const calls = [];
  let chain = '0x1';
  return { calls, provider: { async request(input) {
    calls.push(input.method);
    if (input.method === fail) throw Object.assign(new Error('User denied request'), { code: 4001 });
    switch (input.method) {
      case 'eth_requestAccounts': case 'eth_accounts': return [account.address];
      case 'eth_chainId': return chain;
      case 'wallet_switchEthereumChain': chain = input.params[0].chainId; assert.equal(Number(chain), chainId); return null;
      case 'personal_sign': return onSign(input);
      default: throw new Error(`Unexpected RPC ${input.method}`);
    }
  } } };
};

test('any wallet connects, switches chain and signs the exact message the server verifies', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  for (const siteUrl of ['http://localhost:3000/', 'https://app.example:8443/', 'https://app.example']) {
    const challenge = freshChallenge(siteUrl);
    let signedMessage;
    const { calls, provider } = walletFor(account, 143, { onSign(input) {
      assert.equal(input.params[1], account.address);
      signedMessage = hexToString(input.params[0]);
      return account.signMessage({ message: signedMessage });
    } });
    const proof = await requestWalletSignInProof(provider, challenge, siteUrl, connectAccount);
    assert.ok(calls.includes('wallet_switchEthereumChain'));
    assert.equal(calls.at(-1), 'personal_sign');
    assert.equal(proof.message, signedMessage);
    assert.equal(await verifyMessage(proof), true);
    const auth = new WalletAuthService({}, {
      MONAD_RPC_URL: 'https://rpc.monad.xyz'
    });
    assert.equal(auth.validateMessage(challenge, proof.address, proof.message).address, account.address);
    // A wallet that rewrites the domain to the bare hostname is still rejected.
    const rewritten = new SiweMessage({ ...new SiweMessage(proof.message), domain: new URL(siteUrl).hostname }).prepareMessage();
    if (new URL(siteUrl).port) assert.throws(() => auth.validateMessage(challenge, proof.address, rewritten), (error) => error.code === 'SIWE_ORIGIN_MISMATCH');
  }
});

test('wallet cancellation or chain-switch failure never triggers another sign-in path', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  for (const fail of ['eth_requestAccounts', 'wallet_switchEthereumChain', 'personal_sign']) {
    const { calls, provider } = walletFor(account, 143, { fail, onSign: () => '0x12' });
    await assert.rejects(requestWalletSignInProof(provider, freshChallenge(), 'http://localhost:3000', connectAccount), (error) => error.code === 4001);
    assert.equal(calls.at(-1), fail);
  }
});

test('a challenge expiring during wallet connection is not signed', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = freshChallenge();
  const { provider } = walletFor(account, 143, { onSign: () => assert.fail('must not sign') });
  const connect = async (wallet, chainId) => {
    const address = await connectAccount(wallet, chainId);
    challenge.expires_at = new Date(Date.now() - 1000).toISOString();
    return address;
  };
  await assert.rejects(requestWalletSignInProof(provider, challenge, 'http://localhost:3000', connect), /expired/);
});
