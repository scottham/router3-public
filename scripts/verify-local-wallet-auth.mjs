import assert from 'node:assert/strict';
import { SiweMessage } from 'siwe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToString } from 'viem';
import { requestWalletSignInProof } from '../web/src/siwe.js';
import { connectAccount } from '../web/src/wallets.js';

const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:8787';
const siteUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';

async function json(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
  return body;
}

const account = privateKeyToAccount(generatePrivateKey());
const appUrl = new URL(siteUrl);
const variants = [
  { uri: appUrl.origin },
  { uri: new URL(appUrl.origin).href },
  ...(appUrl.port ? [{ uri: new URL(appUrl.origin).href, browserFlow: true }] : [])
];
for (const { uri, browserFlow = false } of variants) {
  const challenge = await json(await fetch(`${apiBaseUrl}/v1/auth/challenge`, { method: 'POST' }));
  const fields = {
    scheme: appUrl.protocol.slice(0, -1),
    domain: appUrl.host,
    address: account.address,
    statement: 'Sign in to Router 3',
    uri,
    version: '1',
    chainId: Number(challenge.chain_id),
    nonce: challenge.nonce,
    issuedAt: new Date().toISOString()
  };
  const verify = async (message, signature) => fetch(`${apiBaseUrl}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'mcg-local-auth-check' },
    body: JSON.stringify({
      challengeId: challenge.id, address: account.address,
      message, signature: signature ?? await account.signMessage({ message })
    })
  });

  const wrongOrigin = await verify(new SiweMessage({ ...fields, uri: 'https://wrong-origin.invalid/' }).prepareMessage());
  assert.equal(wrongOrigin.status, 400);
  assert.equal((await wrongOrigin.json()).error.code, 'SIWE_ORIGIN_MISMATCH');

  if (appUrl.port) {
    const droppedPort = await verify(new SiweMessage({ ...fields, domain: appUrl.hostname }).prepareMessage());
    assert.equal(droppedPort.status, 400);
    const error = (await droppedPort.json()).error;
    assert.equal(error.code, 'SIWE_ORIGIN_MISMATCH');
    assert.deepEqual(error.details.mismatchedFields, ['domain']);
  }

  let message = new SiweMessage(fields).prepareMessage();
  let signature;
  if (browserFlow) {
    // Exercise the real frontend orchestration with an unfunded test signer;
    // this does not impersonate or replace the user's wallet.
    const calls = [];
    let chain = '0x1';
    const provider = { async request(input) {
      calls.push(input.method);
      if (['eth_requestAccounts', 'eth_accounts'].includes(input.method)) return [account.address];
      if (input.method === 'eth_chainId') return chain;
      if (input.method === 'wallet_switchEthereumChain') {
        assert.equal(Number(input.params[0].chainId), Number(challenge.chain_id));
        chain = input.params[0].chainId;
        return null;
      }
      assert.equal(input.method, 'personal_sign');
      assert.equal(input.params[1], account.address);
      return account.signMessage({ message: hexToString(input.params[0]) });
    } };
    ({ message, signature } = await requestWalletSignInProof(provider, challenge, siteUrl, connectAccount));
    assert.equal(calls.at(-1), 'personal_sign');
  }
  const verified = await verify(message, signature);
  const identity = await json(verified);
  const cookie = verified.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie ?? '', /^mcg_session=mcg_session_/);
  try {
    assert.equal(identity.address, account.address);
    assert.equal('accessToken' in identity, false);
    const me = await json(await fetch(`${apiBaseUrl}/v1/me`, { headers: { cookie } }));
    assert.equal(me.id, identity.appUserId);
    assert.ok(me.wallets.some((wallet) => wallet.address.toLowerCase() === account.address.toLowerCase()));

    if (process.env.VERIFY_WALLET_READS === 'true' && browserFlow) {
      // Optional integration check: generated unfunded identity, real RPC reads,
      // one isolated organization, no contract registration or transactions.
      const wallet = me.wallets.find((item) => item.address.toLowerCase() === account.address.toLowerCase());
      assert.equal(me.connectedWallet.address.toLowerCase(), account.address.toLowerCase());
      assert.equal(me.connectedWallet.chainId, Number(challenge.chain_id));
      const billingPath = `${apiBaseUrl}/v1/wallets/${wallet.id}/billing`;
      assert.equal((await fetch(billingPath)).status, 401);
      const billing = await json(await fetch(billingPath, { headers: { cookie } }));
      assert.equal(billing.address.toLowerCase(), account.address.toLowerCase());
      console.log('Wallet API read-only integration OK: billing read and authentication. No transactions sent.');
    }

    const replay = await verify(message);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, 'AUTH_CHALLENGE_USED');
  } finally {
    const logout = await fetch(`${apiBaseUrl}/v1/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 204);
  }
  const afterLogout = await fetch(`${apiBaseUrl}/v1/me`, { headers: { cookie } });
  assert.equal(afterLogout.status, 401);
}

console.log('Local SIWE session flow OK: root URI variants, exact-message frontend flow, wrong-origin/dropped-port rejection, replay protection and logout');
