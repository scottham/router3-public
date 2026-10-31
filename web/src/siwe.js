import { getAddress, stringToHex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { t } from './i18n.js';

// EIP-4361 fields for this site and challenge.
export function buildSignInFields(challenge, siteUrl, now = new Date()) {
  const appUrl = new URL(siteUrl);
  const expiresAt = new Date(challenge.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error('Sign-in challenge has expired');
  }
  return {
    nonce: challenge.nonce,
    chainId: `0x${Number(challenge.chain_id).toString(16)}`,
    scheme: appUrl.protocol.slice(0, -1),
    domain: appUrl.host,
    uri: new URL(appUrl.origin).href,
    version: '1',
    statement: 'Sign in to Router 3',
    issuedAt: now.toISOString(),
    expirationTime: expiresAt.toISOString()
  };
}

export function buildSignInMessage(challenge, siteUrl, address, now = new Date()) {
  const capability = buildSignInFields(challenge, siteUrl, now);
  return createSiweMessage({
    ...capability,
    address: getAddress(address),
    chainId: Number(challenge.chain_id),
    issuedAt: new Date(capability.issuedAt),
    expirationTime: new Date(capability.expirationTime)
  });
}

// Any EIP-1193 wallet: connect, switch to the challenge chain, then sign the
// exact EIP-4361 message the server will verify.
export async function requestWalletSignInProof(provider, challenge, siteUrl, connect) {
  const address = await connect(provider, Number(challenge.chain_id));
  // Recheck expiration after the wallet prompt, and never alter signed bytes.
  const message = buildSignInMessage(challenge, siteUrl, address);
  const signature = await provider.request({ method: 'personal_sign', params: [stringToHex(message), address] });
  if (typeof signature !== 'string' || !/^0x[0-9a-f]+$/i.test(signature)) throw new Error(t('The wallet returned no valid sign-in signature'));
  return { address, message, signature };
}
