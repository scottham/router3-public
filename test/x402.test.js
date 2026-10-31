import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePaymentSignatureHeader, decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { signVoucher } from '@x402/evm/batch-settlement/client';
import { X402_NETWORK, usdcAtomic } from '../src/x402/service.js';
import { checkAuthorizerRequest } from '../src/x402/authorizer.js';
import { X402AuthorizerSigner } from '../src/signing/x402-authorizer-signer.js';
import { X402SettlementWorker } from '../src/workers/x402-settlement-worker.js';
import { MockProvider } from '../src/providers/mock.js';
import { ProviderError } from '../src/providers/provider-error.js';
import { USDC_ADDRESS } from '../src/chain.js';
import { createInMemoryGateway, chatBody, ok, parseSse, post, PAYER_KEY, SETTLER, TREASURY, TEST_SESSION_TOKEN } from './helpers/in-memory-gateway.js';

test('an unpaid request answers 402 with the request ceiling in PAYMENT-REQUIRED and a readable error body', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const response = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatBody() });
  assert.equal(response.statusCode, 402);
  const required = decodePaymentRequiredHeader(response.headers['payment-required']);
  const [accept] = required.accepts;
  assert.equal(accept.scheme, 'batch-settlement'); assert.equal(accept.network, X402_NETWORK);
  assert.equal(accept.payTo, TREASURY.address); assert.equal(accept.asset, USDC_ADDRESS);
  assert.equal(accept.extra.receiverAuthorizer, SETTLER.address); assert.equal(accept.extra.withdrawDelay, 3600);
  assert.equal(accept.extra.minDeposit, '1000000', 'the configured minimum deposit, in micro USDC');
  // The hold for 32 output tokens at 2 USDC/M plus input bytes, rounded up to a micro USDC.
  const plan = await h.service.plan('chat', chatBody());
  assert.equal(accept.amount, String(plan.ceilingAtomic));
  assert.ok(BigInt(accept.amount) >= 1n && BigInt(accept.amount) < 10000n);
  const body = response.json();
  assert.equal(body.error.code, 'PAYMENT_REQUIRED');
  assert.equal(body.error.details.x402.accepts[0].amount, accept.amount);
  // Messages format for the Anthropic endpoint.
  const messages = await h.app.inject({ method: 'POST', url: '/v1/messages', payload: { model: 'mock/echo', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } });
  assert.equal(messages.statusCode, 422, 'the mock provider has no Messages endpoint: priced before paid, errors stay in the protocol format');
  assert.equal(messages.json().type, 'error');
  // Validation errors come before any payment.
  const invalid = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'mock/echo' } });
  assert.equal(invalid.statusCode, 422);
  // Public model listing for keyless clients; the catalog for a session.
  const models = await h.app.inject({ method: 'GET', url: '/v1/models' });
  assert.deepEqual(models.json().data.map((m) => m.id), ['mock/echo']);
  const terms = await h.app.inject({ method: 'GET', url: '/v1/x402' });
  assert.equal(terms.json().receiverAuthorizer, SETTLER.address); assert.equal(terms.json().ready, true); assert.equal(terms.json().maxChannelsPerPayer, 128);
});

test('the first paid call deposits and charges the actual cost; later calls ride on vouchers with no deposit and no corrective round trip', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const c = h.client();
  const first = await c.fetch(post('/v1/chat/completions', chatBody()));
  const body = await ok(first);
  assert.equal(body.choices[0].message.content, 'mock:hello channel');
  assert.equal(body.gateway.payment, 'x402');
  const charged = BigInt(body.gateway.x402.charged_atomic);
  assert.ok(charged >= 1n && charged <= BigInt(body.gateway.x402.ceiling_atomic));
  assert.equal(body.gateway.x402.cumulative_atomic, String(charged));
  assert.equal(body.gateway.x402.payment_response, first.headers.get('payment-response'));
  const receipt = decodePaymentResponseHeader(first.headers.get('payment-response'));
  assert.equal(receipt.success, true); assert.equal(receipt.extra.chargedAmount, String(charged));
  // The deposit went on-chain through the facilitator; the channel mirror and ledger agree.
  const [channel] = await h.storage.list();
  assert.equal(channel.chargedCumulativeAmount, String(charged));
  assert.equal(h.chain.channel(channel.channelId).balance, BigInt(channel.balance));
  assert.ok(BigInt(channel.balance) >= 1_000_000n, 'the deposit honours the announced minimum');
  assert.deepEqual(h.facilitator.calls, [['verify', 'deposit'], ['settle', 'deposit']]);
  const [row] = h.ledger.requests.values();
  assert.equal(row.status, 'completed'); assert.equal(row.chargedFrom, 'usage'); assert.equal(row.chargedAtomic, charged);
  assert.equal(row.payer, c.account.address.toLowerCase()); assert.equal(row.protocol, 'chat');
  assert.equal(h.ledger.settlements[0].kind, 'deposit');
  // Second call: voucher only, verified locally, state stays in sync (402 + paid = two fetches).
  h.calls.length = 0; h.facilitator.calls.length = 0;
  const second = await c.fetch(post('/v1/chat/completions', chatBody({ messages: [{ role: 'user', content: 'again' }] })));
  const secondBody = await ok(second);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.facilitator.calls, [], 'a fresh channel mirror verifies vouchers without the facilitator');
  assert.equal(BigInt(secondBody.gateway.x402.cumulative_atomic), charged + BigInt(secondBody.gateway.x402.charged_atomic));
  // A replayed voucher is rejected as stale, not charged twice.
  const replay = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatBody({ messages: [{ role: 'user', content: 'again' }] }),
    headers: { 'payment-signature': h.calls[1].headers['payment-signature'] } });
  assert.equal(replay.statusCode, 402);
});

test('streams settle in the final chunk; the next voucher resyncs through one corrective 402', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const c = h.client();
  const response = await c.fetch(post('/v1/chat/completions', chatBody({ stream: true })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('payment-response'), null, 'a stream cannot carry the receipt header');
  const events = parseSse(await response.text());
  const final = events.find((e) => e.data?.gateway);
  assert.ok(final.data.gateway.x402.payment_response, 'the receipt rides in the final chunk instead');
  assert.equal(final.data.choices.length, 0);
  assert.equal(events.at(-1).data, '[DONE]');
  const charged = BigInt(final.data.gateway.x402.charged_atomic);
  // The SDK client did not see the receipt: its next voucher is one request behind.
  h.calls.length = 0;
  const next = await c.fetch(post('/v1/chat/completions', chatBody()));
  const body = await ok(next);
  assert.equal(h.calls.length, 3, '402, stale voucher (corrective 402), resynced voucher');
  assert.equal(BigInt(body.gateway.x402.cumulative_atomic), charged + BigInt(body.gateway.x402.charged_atomic));
});

test('failures: a rejected call costs nothing, unknown usage costs the ceiling, over-limit requests and strangers are refused', async (t) => {
  let mode = 'rejected';
  const providers = { get: () => ({
    async invoke(request, model) {
      if (mode === 'rejected') throw new ProviderError('bad request', { code: 'PROVIDER_REQUEST_REJECTED', statusCode: 400, chargeCertainty: 'not_charged' });
      if (mode === 'lost') throw new ProviderError('socket closed', { code: 'PROVIDER_STREAM_INCOMPLETE', statusCode: 502, chargeCertainty: 'unknown' });
      return new MockProvider().invoke(request, model);
    }
  }) };
  const h = await createInMemoryGateway({ providers, config: { X402_REQUEST_LIMIT_USDC: '0.001' } });
  t.after(() => h.app.close());
  const c = h.client();
  // Rejected before any tokens: the reservation is cancelled, nothing is charged. The
  // deposit payload was not settled either, so the client still owes a deposit.
  const rejected = await c.fetch(post('/v1/chat/completions', chatBody()));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.code, 'PROVIDER_REQUEST_REJECTED');
  assert.equal(h.facilitator.calls.filter(([kind]) => kind === 'settle').length, 0);
  assert.equal([...h.ledger.requests.values()][0].status, 'failed');
  mode = 'ok';
  const paid = await c.fetch(post('/v1/chat/completions', chatBody()));
  const after = BigInt((await ok(paid)).gateway.x402.cumulative_atomic);
  // Usage unknown after the provider boundary: the ceiling the payer signed is charged.
  mode = 'lost';
  const lost = await c.fetch(post('/v1/chat/completions', chatBody()));
  assert.equal(lost.status, 502);
  const [channel] = await h.storage.list();
  const plan = await h.service.plan('chat', chatBody());
  assert.equal(BigInt(channel.chargedCumulativeAmount), after + plan.ceilingAtomic);
  const ceilingRow = [...h.ledger.requests.values()].at(-1);
  assert.equal(ceilingRow.status, 'completed'); assert.equal(ceilingRow.chargedFrom, 'ceiling'); assert.equal(ceilingRow.failureCode, 'PROVIDER_STREAM_INCOMPLETE');
  // Ceiling above the per-request limit.
  const big = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatBody({ max_tokens: 900000 }) });
  assert.equal(big.statusCode, 402); assert.equal(big.json().error.code, 'X402_REQUEST_LIMIT');
  // Payer not on the allowlist: refused before any channel state is touched.
  h.service.allowedPayers = new Set(['0x' + 'cd'.repeat(20)]);
  const direct = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatBody(),
    headers: { 'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted: await requirementsFor(h, chatBody()), payload: await voucherPayload(c, h, chatBody()) }) } });
  assert.equal(direct.statusCode, 402); assert.equal(direct.json().error.code, 'ADDRESS_NOT_ALLOWED');
  assert.equal(BigInt((await h.storage.list())[0].chargedCumulativeAmount), after + plan.ceilingAtomic);
});

async function requirementsFor(h, body, path = '/v1/chat/completions') {
  const response = await h.app.inject({ method: 'POST', url: path, payload: body });
  return decodePaymentRequiredHeader(response.headers['payment-required']).accepts[0];
}

async function voucherPayload(c, h, body) {
  const [channel] = await h.storage.list();
  const requirements = await requirementsFor(h, body);
  const max = (BigInt(channel.chargedCumulativeAmount) + BigInt(requirements.amount)).toString();
  return { type: 'voucher', channelConfig: channel.channelConfig, voucher: await signVoucher(c.account, channel.channelId, max, X402_NETWORK) };
}

test('a payer may open channels up to the limit; one more is refused before any state changes', async (t) => {
  const h = await createInMemoryGateway({ config: { X402_MAX_CHANNELS_PER_PAYER: 2 } });
  t.after(() => h.app.close());
  const salts = ['11', '22', '33'].map((s) => `0x${s.repeat(32)}`);
  const [a, b, c] = salts.map((salt, i) => h.client(PAYER_KEY, { salt, mint: i === 0 ? 10_000_000n : 0n }));
  await ok(await a.fetch(post('/v1/chat/completions', chatBody())));
  await ok(await b.fetch(post('/v1/chat/completions', chatBody())));
  assert.equal(await h.ledger.countChannels(a.account.address.toLowerCase()), 2);
  const third = await c.fetch(post('/v1/chat/completions', chatBody()));
  assert.equal(third.status, 402);
  assert.equal((await third.json()).error.code, 'X402_CHANNEL_LIMIT');
  assert.equal((await h.storage.list()).length, 2);
  // Existing channels keep working, and a different payer is not counted.
  await ok(await a.fetch(post('/v1/chat/completions', chatBody())));
  const other = h.client(`0x${'77'.repeat(32)}`, { salt: salts[2] });
  await ok(await other.fetch(post('/v1/chat/completions', chatBody())));
});

test('the collector claims charged vouchers in one batch, settles them to the Treasury, and a payer can take the rest back', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const c = h.client();
  for (let i = 0; i < 3; i++) await ok(await c.fetch(post('/v1/chat/completions', chatBody())));
  const [channel] = await h.storage.list();
  const charged = BigInt(channel.chargedCumulativeAmount);
  const worker = new X402SettlementWorker(null, h.config, { scheme: h.service.scheme, facilitator: h.facilitator, storage: h.storage, repository: h.ledger, rpc: false });
  // Below the claim threshold and not idle: nothing moves yet.
  worker.minAtomic = 10_000_000n;
  assert.deepEqual(await worker.tick(), { claims: [], settle: null });
  worker.minAtomic = usdcAtomic('0.000001');
  const { claims, settle } = await worker.tick();
  assert.equal(claims.length, 1); assert.equal(claims[0].vouchers, 1);
  assert.equal(h.chain.channel(channel.channelId).totalClaimed, charged);
  assert.equal(h.chain.balanceOf(TREASURY.address), charged, 'settle moved exactly the claimed amount to the Treasury');
  assert.ok(settle.transaction);
  assert.equal((await h.storage.get(channel.channelId)).totalClaimed, String(charged));
  assert.deepEqual(h.ledger.settlements.filter((s) => s.kind !== 'deposit').map((s) => s.kind), ['claim', 'settle']);
  assert.deepEqual(await worker.tick(), { claims: [], settle: null }, 'nothing left to claim or settle');
  // One more call, then a cooperative refund of everything unspent: the
  // gateway claims what it is owed in the same transaction.
  await ok(await c.fetch(post('/v1/chat/completions', chatBody())));
  const before = await h.storage.get(channel.channelId);
  const owed = BigInt(before.chargedCumulativeAmount) - BigInt(before.totalClaimed);
  assert.ok(owed > 0n);
  const refund = await c.scheme.refund('https://gateway.test/v1/x402/refund', { fetch: h.fetchImpl });
  assert.equal(refund.success, true); assert.ok(refund.transaction);
  const state = h.chain.channel(channel.channelId);
  assert.equal(state.totalClaimed, BigInt(before.chargedCumulativeAmount));
  assert.equal(state.balance, state.totalClaimed, 'everything unclaimed went back');
  assert.equal(h.chain.balanceOf(c.account.address), 5_000_000n - state.totalClaimed);
  assert.equal(await h.storage.get(channel.channelId), undefined, 'a refunded channel is forgotten');
  assert.equal(h.ledger.settlements.at(-1).kind, 'refund');
  // The payer can keep using the channel afterwards: the client knows its balance is gone and deposits again.
  const again = await ok(await c.fetch(post('/v1/chat/completions', chatBody())));
  assert.ok(BigInt(again.gateway.x402.cumulative_atomic) > BigInt(before.chargedCumulativeAmount));
  assert.equal(h.ledger.settlements.at(-1).kind, 'deposit');
});

test('a deposit read back short is floored at the deposit, and the collector raises the balance to the chain', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  h.facilitator.staleReads = true;
  const c = h.client();
  await ok(await c.fetch(post('/v1/chat/completions', chatBody())));
  const [first] = await h.storage.list();
  const onChain = h.chain.channel(first.channelId).balance;
  assert.equal(first.balance, String(onChain), 'a new channel holds exactly its deposit');
  // A top-up read back short: the record lags the chain until the collector syncs it.
  await h.storage.updateChannel(first.channelId, (cur) => ({ ...cur, balance: '1' }));
  const worker = new X402SettlementWorker(null, h.config, { scheme: h.service.scheme, facilitator: h.facilitator, storage: h.storage, repository: h.ledger, rpc: false });
  worker.contract = { channels: async (id) => ({ balance: h.chain.channel(id).balance }), pendingWithdrawals: async () => ({ initiatedAt: 0n }) };
  worker.minAtomic = 10_000_000n;
  await worker.tick();
  assert.equal((await h.storage.get(first.channelId)).balance, String(onChain));
  // Never lowered: a record above the chain stays as it is.
  h.chain.channel(first.channelId).balance = 5n;
  await worker.tick();
  assert.equal((await h.storage.get(first.channelId)).balance, String(onChain));
});

test('a deposit without a model call opens or tops up the channel for one micro USDC', async (t) => {
  const h = await createInMemoryGateway();
  t.after(() => h.app.close());
  const c = h.client();
  const body = await ok(await c.fetch(post('/v1/x402/deposit', {})));
  assert.equal(body.channel.chargedCumulativeAtomic, '1');
  assert.ok(BigInt(body.channel.balanceAtomic) >= 1_000_000n);
  assert.ok(body.transaction);
  const [row] = h.ledger.requests.values();
  assert.equal(row.protocol, 'deposit'); assert.equal(row.chargedAtomic, 1n);
  // The console lists the signed-in wallet's channels.
  const list = await h.app.inject({ method: 'GET', url: '/v1/x402/channels', headers: { authorization: `Bearer ${TEST_SESSION_TOKEN}` } });
  assert.equal(list.statusCode, 200); assert.equal(list.json().walletKind, 'eoa'); assert.equal(list.json().terms.payTo, TREASURY.address);
});

test('the settlement signer signs only claim batches within what was charged and refunds within what was not', async () => {
  const rows = new Map([['0x' + 'aa'.repeat(32), { charged: '500', signed: '900', balance: '2000' }]]);
  const pool = { async query(_sql, [id]) { const r = rows.get(id); return { rows: r ? [{ charged: r.charged, signed: r.signed, balance: r.balance }] : [] }; } };
  const signer = new X402AuthorizerSigner({ pool, wallet: SETTLER });
  const domain = { name: 'x402 Batch Settlement', version: '1', chainId: 143, verifyingContract: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003' };
  const { claimBatchTypes, refundTypes } = await import('@x402/evm');
  const claim = (totalClaimed, maxClaimableAmount = '900') => ({ signerRef: 'x402-authorizer-v1', domain, types: claimBatchTypes, primaryType: 'ClaimBatch',
    message: { claims: [{ channelId: '0x' + 'aa'.repeat(32), maxClaimableAmount, totalClaimed }] } });
  const signed = await signer.sign(claim('500'));
  assert.equal(signed.address, SETTLER.address); assert.match(signed.signature, /^0x[0-9a-f]{130}$/);
  await assert.rejects(signer.sign(claim('501')), (e) => e.code === 'SIGNER_CLAIM_EXCEEDS_CHARGED');
  await assert.rejects(signer.sign(claim('500', '1000')), (e) => e.code === 'SIGNER_CLAIM_EXCEEDS_CHARGED', 'a voucher we never saw');
  await assert.rejects(signer.sign({ ...claim('500'), message: { claims: [{ channelId: '0x' + 'bb'.repeat(32), maxClaimableAmount: '1', totalClaimed: '1' }] } }), (e) => e.code === 'SIGNER_CLAIM_EXCEEDS_CHARGED');
  const refund = (amount) => ({ signerRef: 'x402-authorizer-v1', domain, types: refundTypes, primaryType: 'Refund', message: { channelId: '0x' + 'aa'.repeat(32), nonce: '0', amount } });
  assert.ok((await signer.sign(refund('1500'))).signature);
  await assert.rejects(signer.sign(refund('1501')), (e) => e.code === 'SIGNER_REFUND_EXCEEDS_UNCHARGED');
  await assert.rejects(signer.sign({ ...refund('1'), domain: { ...domain, chainId: 1 } }), (e) => e.code === 'SIGNER_TYPED_DATA_DOMAIN_NOT_ALLOWED');
  await assert.rejects(signer.sign({ ...refund('1'), primaryType: 'Voucher', types: { Voucher: [] } }), (e) => e.code === 'SIGNER_TYPED_DATA_TYPE_NOT_ALLOWED');
  await assert.rejects(signer.sign({ ...refund('1'), signerRef: 'wallet-v1' }), (e) => e.code === 'SIGNER_REQUEST_NOT_ALLOWED');
  assert.throws(() => checkAuthorizerRequest({ domain, types: refundTypes, primaryType: 'ClaimBatch', message: {} }), /TYPE_NOT_ALLOWED/);
});
