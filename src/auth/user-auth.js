import { sessionTokenFromRequest } from './wallet-auth.js';

export function buildUserAuth(authService, config) {
  return async function userAuth(request) {
    const session = await authService.authenticate(sessionTokenFromRequest(request, config.AUTH_COOKIE_NAME));
    request.identity = {
      appUserId: session.app_user_id,
      address: session.address,
      chainId: Number(session.chain_id),
      sessionId: session.session_id
    };
  };
}
