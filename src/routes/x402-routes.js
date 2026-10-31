import { z } from 'zod';
import { getAddress } from 'ethers';
import { createRpcProviderCache } from '../lib/rpc.js';
import { CHAIN_ID, CHAIN_KEY } from '../chain.js';

// x402 channel endpoints: public terms for clients, deposit and refund
// payloads (signed by the payer, relayed by the facilitator), and the
// console's view of the signed-in wallet's channels.
export async function registerX402Routes(app, { x402, userAuth, config, pool }) {
  const { service, repository } = x402;
  const providers = createRpcProviderCache();
  app.addHook('onClose', async () => providers.destroy());

  app.get('/v1/x402', async () => service.describe());

  const send = (reply, outcome) => reply.code(outcome.status).headers(outcome.headers ?? {}).send(outcome.body);
  app.post('/v1/x402/deposit', async (request, reply) => send(reply, await service.handleDeposit({ headers: request.headers, body: request.body ?? {} })));
  for (const method of ['get', 'post']) {
    app[method]('/v1/x402/refund', async (request, reply) =>
      send(reply, await service.handleRefund({ headers: request.headers, body: request.body ?? {}, method: method.toUpperCase() })));
  }

  // The user's verified wallets are the payers whose channels they may see.
  async function payersOf(appUserId) {
    const { rows } = await pool.query(`select u.address_normalized address from public.user_wallets u
      join private.base_account_bindings b on b.address_normalized=u.address_normalized and b.app_user_id=u.app_user_id
      where u.app_user_id=$1 and u.status='active' and u.chain_id=$2`, [appUserId, CHAIN_ID]);
    return rows.map((row) => row.address);
  }

  app.get('/v1/x402/channels', { preHandler: userAuth }, async (request) => {
    const payers = await payersOf(request.identity.appUserId);
    const channels = payers.length ? await repository.channelsForPayers(payers) : [];
    // Whether the signed-in wallet signs as a key (EOA) or a contract, so the
    // console can build a channel config the facilitator will verify.
    const rpc = providers.get(CHAIN_ID, config.chains[CHAIN_KEY]?.rpcUrl ?? config.MONAD_RPC_URL);
    const code = await rpc.getCode(request.identity.address).catch(() => '0x');
    return { terms: service.describe(), payer: getAddress(request.identity.address), walletKind: code && code !== '0x' ? 'contract' : 'eoa', channels };
  });

  app.get('/v1/x402/channels/:channelId/requests', { preHandler: userAuth }, async (request) => {
    const channelId = z.string().regex(/^0x[0-9a-fA-F]{64}$/).parse(request.params.channelId);
    const payers = await payersOf(request.identity.appUserId);
    return { items: payers.length ? await repository.requestsForChannel(channelId, payers) : [] };
  });
}
