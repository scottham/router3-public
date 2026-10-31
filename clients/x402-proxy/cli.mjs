#!/usr/bin/env node
// router3 x402 proxy: pay for model calls from a local wallet.
//
//   node clients/x402-proxy/cli.mjs serve  [--port 8402] [--gateway https://router3.ai] [--max-channels 128] [--dir ~/.router3]
//   node clients/x402-proxy/cli.mjs refund --all      cooperative refund of every channel this proxy opened
//   node clients/x402-proxy/cli.mjs status            channels this proxy knows and their on-chain balances
//
// The payer key comes from ROUTER3_PAYER_KEY or a file named by
// ROUTER3_PAYER_KEY_FILE; it never leaves this process. ROUTER3_RPC_URL (default
// https://rpc.monad.xyz) is read only to recover channel state.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { monad } from 'viem/chains';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';
import { createProxy, normalizePrivateKey, NETWORK } from './index.mjs';

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) ?? 'serve';
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const env = process.env;
const gatewayUrl = option('gateway', env.ROUTER3_GATEWAY_URL ?? 'https://router3.ai');
const directory = option('dir', env.ROUTER3_DIR ?? join(homedir(), '.router3'));
const rpcUrl = env.ROUTER3_RPC_URL ?? 'https://rpc.monad.xyz';
const privateKey = env.ROUTER3_PAYER_KEY ?? (env.ROUTER3_PAYER_KEY_FILE ? readFileSync(env.ROUTER3_PAYER_KEY_FILE, 'utf8') : null);
if (!privateKey) { console.error('ROUTER3_PAYER_KEY or ROUTER3_PAYER_KEY_FILE is required'); process.exit(2); }
normalizePrivateKey(privateKey);

// ROUTER3_MAX_PAYMENT_USD: the most one request may hold (default 5, the gateway's limit).
const proxy = createProxy({ gatewayUrl, privateKey, rpcUrl, directory, maxChannels: Number(option('max-channels', env.ROUTER3_MAX_CHANNELS ?? 128)),
  maxPaymentUsd: Number(env.ROUTER3_MAX_PAYMENT_USD ?? 5) });

if (command === 'serve') {
  const address = await proxy.listen(Number(option('port', env.ROUTER3_PROXY_PORT ?? 8402)), option('host', '127.0.0.1'));
  console.log(JSON.stringify({ message: 'x402_proxy_listening', url: `http://${address.address}:${address.port}`, gateway: proxy.gateway, payer: proxy.account.address,
    channels: proxy.pool.size, maxChannels: proxy.pool.maxChannels, hint: `OPENAI_BASE_URL=http://127.0.0.1:${address.port}/v1 OPENAI_API_KEY=x402` }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => proxy.close().then(() => process.exit(0)));
} else if (command === 'refund') {
  if (!args.includes('--all')) { console.error('refund takes --all: every channel this proxy opened is refunded'); process.exit(2); }
  const results = await proxy.refundAll();
  for (const r of results) console.log(JSON.stringify(r));
  const failed = results.filter((r) => !r.success);
  console.log(JSON.stringify({ message: 'x402_refund_done', channels: results.length, refunded: results.length - failed.length }));
  process.exit(failed.length ? 1 : 0);
} else if (command === 'status') {
  const terms = await (await fetch(`${proxy.gateway}/v1/x402`)).json();
  const rpc = createPublicClient({ chain: monad, transport: http(rpcUrl) });
  const abi = parseAbi(['function channels(bytes32) view returns (uint128 balance,uint128 totalClaimed)']);
  const config = (salt) => ({ payer: proxy.account.address, payerAuthorizer: proxy.account.address, receiver: terms.payTo, receiverAuthorizer: terms.receiverAuthorizer,
    token: terms.asset, withdrawDelay: terms.withdrawDelaySeconds, salt });
  for (const salt of proxy.pool.salts) {
    const channelId = computeChannelId(config(salt), NETWORK);
    const [balance, claimed] = await rpc.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi, functionName: 'channels', args: [channelId] });
    console.log(JSON.stringify({ channelId, balanceAtomic: String(balance), claimedAtomic: String(claimed), unspentAtomic: String(balance - claimed) }));
  }
  console.log(JSON.stringify({ message: 'x402_status', payer: proxy.account.address, gateway: proxy.gateway, channels: proxy.pool.size }));
  process.exit(0);
} else {
  console.error(`unknown command ${command}`); process.exit(2);
}
