import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { computeChannelId, signVoucher } from '@x402/evm/batch-settlement/client';
import { BATCH_SETTLEMENT_ADDRESS, ERC3009_DEPOSIT_COLLECTOR_ADDRESS } from '@x402/evm';
import { channelId, decodeHeader, depositDraft, depositNonce, newChannelConfig, paymentHeader, refundDraft, CONTRACT, DEPOSIT_COLLECTOR } from '../web/src/x402.js';
import { X402_NETWORK } from '../src/x402/service.js';

// The console builds channel ids, deposit nonces and vouchers exactly as the
// Foundation SDK does, so a channel opened from the browser is the same
// channel an agent's SDK client continues to use.
const account = privateKeyToAccount(`0x${'77'.repeat(32)}`);
const terms = { payTo: '0x' + '22'.repeat(20), receiverAuthorizer: '0x' + '33'.repeat(20), asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  assetName: 'USDC', assetVersion: '2', withdrawDelaySeconds: 86400, maxTimeoutSeconds: 600 };

test('channel ids, deposit nonces and voucher signatures match the SDK', async () => {
  assert.equal(CONTRACT, BATCH_SETTLEMENT_ADDRESS); assert.equal(DEPOSIT_COLLECTOR, ERC3009_DEPOSIT_COLLECTOR_ADDRESS);
  const salt = `0x${'ab'.repeat(32)}`;
  const config = newChannelConfig({ payer: account.address, walletKind: 'eoa', terms, salt });
  const id = channelId(config, 143);
  assert.equal(id, computeChannelId(config, X402_NETWORK));
  const contractConfig = newChannelConfig({ payer: account.address, walletKind: 'contract', terms, salt });
  assert.equal(contractConfig.payerAuthorizer, '0x0000000000000000000000000000000000000000');
  const { buildErc3009DepositNonce } = await import('../node_modules/@x402/evm/dist/esm/chunk-W6ON4LG2.mjs').catch(() => ({}));
  if (buildErc3009DepositNonce) assert.equal(depositNonce(id, salt), buildErc3009DepositNonce(id, salt));
  // A deposit draft: the wallet signs the USDC authorization and the voucher.
  const draft = depositDraft({ config, id, amountAtomic: 2_000_000n, chargedAtomic: '40', terms, chainId: 143, now: 1_800_000_000, salt });
  assert.equal(draft.authorization.message.to, DEPOSIT_COLLECTOR); assert.equal(draft.authorization.message.validBefore, '1800000600');
  assert.equal(draft.voucher.message.maxClaimableAmount, '41', 'one micro USDC for the deposit route');
  const { EIP712Domain: _d, ...voucherTypes } = draft.voucher.types;
  const signature = await account.signTypedData({ domain: draft.voucher.domain, types: voucherTypes, primaryType: 'Voucher', message: { channelId: id, maxClaimableAmount: 41n } });
  const sdk = await signVoucher(account, id, '41', X402_NETWORK);
  assert.equal(signature, sdk.signature, 'the same bytes the SDK signs');
  const payload = draft.payload({ authorization: '0xaa', voucher: signature });
  assert.equal(payload.type, 'deposit'); assert.equal(payload.deposit.amount, '2000000'); assert.equal(payload.deposit.authorization.erc3009Authorization.salt, salt);
  // A refund draft signs the current cumulative amount.
  const refund = refundDraft({ config, id, chargedAtomic: '41', chainId: 143, amountAtomic: 100n });
  assert.equal(refund.voucher.message.maxClaimableAmount, '41');
  assert.deepEqual(Object.keys(refund.payload('0xbb')), ['type', 'channelConfig', 'voucher', 'amount']);
  assert.ok(await verifyTypedData({ address: account.address, domain: refund.voucher.domain, types: voucherTypes, primaryType: 'Voucher', message: { channelId: id, maxClaimableAmount: 41n }, signature }));
  // The header round-trips.
  const accepted = { scheme: 'batch-settlement', network: X402_NETWORK, amount: '1', asset: terms.asset, payTo: terms.payTo, maxTimeoutSeconds: 600, extra: {} };
  assert.deepEqual(decodeHeader(paymentHeader({ accepted, payload })), { x402Version: 2, accepted, payload });
});
