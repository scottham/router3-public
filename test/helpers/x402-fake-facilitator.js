// An in-memory facilitator for the x402 batch-settlement scheme: the same
// verify/settle contract as the Foundation facilitator, over a fake chain that
// keeps USDC balances and the x402BatchSettlement channel state. Signatures
// are verified for real (vouchers, claim batches, refunds); only the ERC-3009
// deposit authorization is trusted. The fork acceptance script runs the real
// facilitator scheme against the real contract instead.
import { randomBytes } from 'node:crypto';
import { getAddress, recoverTypedDataAddress, verifyTypedData } from 'viem';
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, claimBatchTypes, refundTypes, voucherTypes } from '@x402/evm';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { X402_NETWORK } from '../../src/x402/service.js';
import { CHAIN_ID } from '../../src/chain.js';

const lower = (value) => String(value).toLowerCase();
const domain = { ...BATCH_SETTLEMENT_DOMAIN, chainId: CHAIN_ID, verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS) };
const failure = (reason, network, payer) => ({ success: false, errorReason: reason, errorMessage: reason, transaction: '', network, payer });

export class FakeChain {
  constructor() { this.usdc = new Map(); this.channels = new Map(); this.receivers = new Map(); this.txs = []; }
  balanceOf(address) { return this.usdc.get(lower(address)) ?? 0n; }
  mint(address, amount) { this.usdc.set(lower(address), this.balanceOf(address) + BigInt(amount)); }
  channel(id) {
    const key = lower(id);
    if (!this.channels.has(key)) this.channels.set(key, { balance: 0n, totalClaimed: 0n, withdrawRequestedAt: 0, refundNonce: 0n });
    return this.channels.get(key);
  }
  receiver(address, token) {
    const key = `${lower(address)}:${lower(token)}`;
    if (!this.receivers.has(key)) this.receivers.set(key, { claimed: 0n, settled: 0n });
    return this.receivers.get(key);
  }
  tx(kind, detail) { const hash = `0x${randomBytes(32).toString('hex')}`; this.txs.push({ hash, kind, ...detail }); return hash; }
  state(id) {
    const c = this.channel(id);
    return { channelId: lower(id), balance: c.balance.toString(), totalClaimed: c.totalClaimed.toString(), withdrawRequestedAt: c.withdrawRequestedAt, refundNonce: c.refundNonce.toString() };
  }
}

export class FakeFacilitator {
  constructor(chain, { network = X402_NETWORK } = {}) { this.chain = chain; this.network = network; this.calls = []; }

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: this.network }], extensions: [], signers: { [this.network]: ['0x7f6a2850669202519f0FE8aa912451238820Db86'] } };
  }

  configError(config, channelId, requirements) {
    if (lower(computeChannelId(config, this.network)) !== lower(channelId)) return 'invalid_batch_settlement_evm_channel_id_mismatch';
    if (lower(config.receiver) !== lower(requirements.payTo)) return 'invalid_batch_settlement_evm_receiver_mismatch';
    if (lower(config.receiverAuthorizer) !== lower(requirements.extra?.receiverAuthorizer ?? '')) return 'invalid_batch_settlement_evm_receiver_authorizer_mismatch';
    if (lower(config.token) !== lower(requirements.asset)) return 'invalid_batch_settlement_evm_token_mismatch';
    if (requirements.extra?.withdrawDelay !== undefined && Number(config.withdrawDelay) !== Number(requirements.extra.withdrawDelay)) return 'invalid_batch_settlement_evm_withdraw_delay_mismatch';
    return null;
  }

  async voucherValid(config, voucher) {
    return verifyTypedData({ address: getAddress(config.payerAuthorizer), domain, types: voucherTypes, primaryType: 'Voucher',
      message: { channelId: voucher.channelId, maxClaimableAmount: BigInt(voucher.maxClaimableAmount) }, signature: voucher.signature }).catch(() => false);
  }

  async verify(payment, requirements) {
    this.calls.push(['verify', payment.payload.type]);
    return this.check(payment, requirements);
  }

  async check(payment, requirements) {
    const raw = payment.payload;
    const payer = raw.channelConfig.payer;
    const invalid = (reason) => ({ isValid: false, invalidReason: reason, payer });
    const configError = this.configError(raw.channelConfig, raw.voucher.channelId, requirements);
    if (configError) return invalid(configError);
    if (!await this.voucherValid(raw.channelConfig, raw.voucher)) return invalid('invalid_batch_settlement_evm_voucher_signature');
    const state = this.chain.channel(raw.voucher.channelId);
    const deposit = raw.type === 'deposit' ? BigInt(raw.deposit.amount) : 0n;
    if (raw.type === 'deposit' && this.chain.balanceOf(payer) < deposit) return invalid('invalid_batch_settlement_evm_insufficient_balance');
    const max = BigInt(raw.voucher.maxClaimableAmount);
    if (max > state.balance + deposit) return invalid('invalid_batch_settlement_evm_cumulative_exceeds_balance');
    if (raw.type === 'refund' ? max < state.totalClaimed : max <= state.totalClaimed) return invalid('invalid_batch_settlement_evm_cumulative_below_claimed');
    return { isValid: true, payer, extra: this.chain.state(raw.voucher.channelId) };
  }

  async applyClaims(claims, signature) {
    if (!claims.length) return 0n;
    const message = { claims: claims.map((c) => ({ channelId: computeChannelId(c.voucher.channel, this.network), maxClaimableAmount: BigInt(c.voucher.maxClaimableAmount), totalClaimed: BigInt(c.totalClaimed) })) };
    const signer = await recoverTypedDataAddress({ domain, types: claimBatchTypes, primaryType: 'ClaimBatch', message, signature });
    let moved = 0n;
    for (const claim of claims) {
      const config = claim.voucher.channel;
      if (lower(signer) !== lower(config.receiverAuthorizer)) throw new Error('invalid_batch_settlement_evm_authorizer_address_mismatch');
      const channelId = computeChannelId(config, this.network);
      if (!await this.voucherValid(config, { channelId, maxClaimableAmount: claim.voucher.maxClaimableAmount, signature: claim.signature })) throw new Error('invalid_batch_settlement_evm_voucher_signature');
      const state = this.chain.channel(channelId);
      const target = BigInt(claim.totalClaimed) < BigInt(claim.voucher.maxClaimableAmount) ? BigInt(claim.totalClaimed) : BigInt(claim.voucher.maxClaimableAmount);
      if (target > state.balance) throw new Error('invalid_batch_settlement_evm_cumulative_exceeds_balance');
      if (target > state.totalClaimed) { moved += target - state.totalClaimed; this.chain.receiver(config.receiver, config.token).claimed += target - state.totalClaimed; state.totalClaimed = target; }
    }
    return moved;
  }

  async settle(payment, requirements) {
    const raw = payment.payload;
    this.calls.push(['settle', raw.type]);
    const network = this.network;
    try {
      if (raw.type === 'deposit') {
        const verified = await this.check(payment, requirements);
        if (!verified.isValid) return failure(verified.invalidReason, network, verified.payer);
        const payer = raw.channelConfig.payer, amount = BigInt(raw.deposit.amount);
        this.chain.usdc.set(lower(payer), this.chain.balanceOf(payer) - amount);
        // `staleReads`: answer with the channel as it was before the deposit,
        // as a lagging RPC node does.
        const before = this.chain.state(raw.voucher.channelId);
        this.chain.channel(raw.voucher.channelId).balance += amount;
        return { success: true, transaction: this.chain.tx('deposit', { channelId: lower(raw.voucher.channelId), amount }), network, payer,
          extra: { channelState: this.staleReads ? before : this.chain.state(raw.voucher.channelId) } };
      }
      if (raw.type === 'claim') {
        const moved = await this.applyClaims(raw.claims, raw.claimAuthorizerSignature);
        return { success: true, transaction: this.chain.tx('claim', { vouchers: raw.claims.length, amount: moved }), network };
      }
      if (raw.type === 'settle') {
        const receiver = this.chain.receiver(raw.receiver, raw.token);
        const amount = receiver.claimed - receiver.settled;
        if (amount <= 0n) return failure('invalid_batch_settlement_evm_nothing_to_settle', network);
        receiver.settled = receiver.claimed;
        this.chain.mint(raw.receiver, amount);
        return { success: true, transaction: this.chain.tx('settle', { receiver: lower(raw.receiver), amount }), network };
      }
      if (raw.type === 'refund') {
        const channelId = computeChannelId(raw.channelConfig, network);
        const state = this.chain.channel(channelId);
        const amount = BigInt(raw.amount), nonce = BigInt(raw.refundNonce);
        const signer = await recoverTypedDataAddress({ domain, types: refundTypes, primaryType: 'Refund', message: { channelId, nonce, amount }, signature: raw.refundAuthorizerSignature });
        if (lower(signer) !== lower(raw.channelConfig.receiverAuthorizer)) return failure('invalid_batch_settlement_evm_authorizer_address_mismatch', network);
        if (nonce !== state.refundNonce) return failure('invalid_batch_settlement_evm_refund_payload', network);
        await this.applyClaims(raw.claims ?? [], raw.claimAuthorizerSignature);
        state.refundNonce += 1n;
        const refundable = state.balance - state.totalClaimed;
        const paid = amount < refundable ? amount : refundable;
        state.balance -= paid;
        this.chain.mint(raw.channelConfig.payer, paid);
        return { success: true, transaction: this.chain.tx('refund', { channelId, amount: paid }), network, payer: raw.channelConfig.payer,
          extra: { channelState: this.chain.state(channelId) } };
      }
      return failure('invalid_batch_settlement_evm_payload_type', network);
    } catch (error) { return failure(error.message, network); }
  }
}

// The x402 ledger without a database.
export class InMemoryX402Repository {
  constructor() { this.requests = new Map(); this.settlements = []; }
  async openRequest(input) { const id = `req-${this.requests.size + 1}`; this.requests.set(id, { id, status: 'running', ...input }); return id; }
  async complete(id, input) { const row = this.requests.get(id); if (row.status === 'running') Object.assign(row, { status: 'completed', ...input }); }
  async fail(id, status, failureCode) { const row = this.requests.get(id); if (row.status === 'running') Object.assign(row, { status, failureCode }); }
  async recordSettlement(input) { this.settlements.push(input); }
  async hasUnsettledClaims() {
    const lastClaim = this.settlements.findLastIndex((s) => s.kind === 'claim' || s.kind === 'refund'), lastSettle = this.settlements.findLastIndex((s) => s.kind === 'settle');
    return lastClaim > lastSettle;
  }
  async runningOnChannel(channelId) {
    const running = [...this.requests.values()].filter((r) => r.channelId === channelId && r.status === 'running');
    return { count: running.length, ceilingAtomic: running.reduce((sum, r) => sum + BigInt(r.ceilingAtomic), 0n) };
  }
  async requestsForApiKey(apiKeyId) { return [...this.requests.values()].filter((r) => r.apiKeyId === apiKeyId); }
  async countChannels(payer) { return [...new Set([...this.requests.values()].filter((r) => r.payer === payer).map((r) => r.channelId))].length; }
  async channelsForPayers() { return []; }
  async requestsForChannel() { return []; }
}
