import { z } from 'zod';
import { sessionCookie, sessionTokenFromRequest } from '../auth/wallet-auth.js';
import { CHAIN_ID } from '../chain.js';

// Console sign-in: Sign-In with Ethereum on Monad, a session cookie, and the
// signed-in wallet's profile. The wallet is the account; there is nothing
// else to create.
export async function registerUserRoutes(app, { config, walletAuth, userAuth, accountRepository, x402, keys = null }) {
  app.get('/v1/auth/config', async () => ({
    siteUrl: config.PUBLIC_APP_URL,
    network: { chainId: CHAIN_ID, appName: config.APP_NAME, appLogoUrl: config.APP_LOGO_URL ?? null },
    chains: Object.fromEntries(Object.entries(config.chains).map(([id, chain]) => [id, { name: chain.name, usdcAddress: chain.usdcAddress }])),
    x402: x402.service.describe(),
    apiKeys: keys ? { requestLimitAtomic: String(keys.requestLimitAtomic), maxConcurrency: keys.maxConcurrency, holdOutputTokens: keys.holdOutputTokens } : null
  }));

  app.post('/v1/auth/challenge', async () => walletAuth.createChallenge());

  app.post('/v1/auth/verify', async (request, reply) => {
    const input = z.object({
      challengeId: z.string().uuid(),
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      message: z.string().min(1).max(8192),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(32768)
    }).parse(request.body);
    const result = await walletAuth.verifyAndCreateSession({
      ...input,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : ''
    });
    reply.header('set-cookie', sessionCookie(config, result.accessToken));
    return reply.code(201).send({ appUserId: result.app_user_id, address: result.address, created: result.created, expiresAt: result.expires_at });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    await walletAuth.revoke(sessionTokenFromRequest(request, config.AUTH_COOKIE_NAME));
    reply.header('set-cookie', sessionCookie(config, '', 0));
    return reply.code(204).send();
  });

  app.get('/v1/me', { preHandler: userAuth }, async (request) => ({
    ...await accountRepository.getMe(request.identity.appUserId),
    connectedWallet: { address: request.identity.address, chainId: request.identity.chainId }
  }));
}
