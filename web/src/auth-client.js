import { requestWalletSignInProof } from './siwe.js';
import { connectAccount } from './wallets.js';
import { errorText, t } from './i18n.js';

export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function readJson(response) {
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(errorText(body.error?.code, body.error?.message) ?? `${t('Request failed')} (${response.status})`, {
      status: response.status,
      code: body.error?.code,
      details: body.error?.details
    });
  }
  return body;
}

export async function createAuthClient(apiBaseUrl) {
  const config = await readJson(await fetch(`${apiBaseUrl}/v1/auth/config`, { credentials: 'include' }));

  async function api(path, options = {}) {
    return readJson(await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(30000),
      credentials: 'include',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {})
      }
    }));
  }

  const send = (method, path, body) => api(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

  return {
    config,
    // `provider` is the connected wallet's EIP-1193 provider.
    async signIn(provider) {
      const challenge = await api('/v1/auth/challenge', { method: 'POST' });
      const proof = await requestWalletSignInProof(provider, challenge, config.siteUrl, connectAccount);
      await send('POST', '/v1/auth/verify', { challengeId: challenge.id, ...proof });
      return api('/v1/me');
    },
    signOut() {
      return send('POST', '/v1/auth/logout');
    },
    getMe: () => api('/v1/me'),
    listModels: () => api('/v1/models'),
    // x402 channels: terms are public; deposits and refunds carry the payer's
    // signed payload in the PAYMENT-SIGNATURE header, as any x402 client does.
    // API keys: each owns one channel the wallet funds; calls with the key
    // need no signature from the client.
    listKeys: () => api('/v1/keys'),
    createKey: (name, limits = {}) => api('/v1/keys', { method: 'POST', body: JSON.stringify({ name, ...limits }) }),
    keyRefund: (id) => api(`/v1/keys/${id}/refund`, { method: 'POST', body: '{}' }),
    revokeKey: (id) => api(`/v1/keys/${id}`, { method: 'DELETE' }),
    listKeyRequests: (id) => api(`/v1/keys/${id}/requests`),
    updateKey: (id, limits) => api(`/v1/keys/${id}`, { method: 'PATCH', body: JSON.stringify(limits) }),
    // The wallet's prepaid pool: state, and the calls it signs for the gateway to relay.
    getPool: () => api('/v1/pool'),
    poolSetup: (body) => api('/v1/pool/setup', { method: 'POST', body: JSON.stringify(body) }),
    poolPermit: (body) => api('/v1/pool/permit', { method: 'POST', body: JSON.stringify(body) }),
    poolConfigure: (body) => api('/v1/pool/configure', { method: 'POST', body: JSON.stringify(body) }),
    poolWithdraw: (body) => api('/v1/pool/withdrawal', { method: 'POST', body: JSON.stringify(body) }),
    poolCancelWithdrawal: (body) => api('/v1/pool/withdrawal', { method: 'DELETE', body: JSON.stringify(body) }),
    listChannels: () => api('/v1/x402/channels'),
    listChannelRequests: (channelId) => api(`/v1/x402/channels/${channelId}/requests`),
    async x402Terms(kind) {
      const response = await fetch(`${apiBaseUrl}/v1/x402/${kind}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' });
      const header = response.headers.get('payment-required');
      if (response.status !== 402 || !header) throw new ApiError(t('x402 settlement is unavailable'), { status: response.status });
      const required = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header), (c) => c.charCodeAt(0))));
      return required.accepts.find((a) => a.scheme === 'batch-settlement');
    },
    x402Deposit: (header) => api('/v1/x402/deposit', { method: 'POST', body: '{}', headers: { 'payment-signature': header } }),
    x402Refund: (header) => api('/v1/x402/refund', { method: 'POST', body: '{}', headers: { 'payment-signature': header } })
  };
}
