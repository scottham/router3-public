import { getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { poolInterface, usdcInterface, opCall, settleCalldata, POOL_DOMAIN } from '../../src/pool/contract.js';

// A model of WalletPrepaidPool and USDC good enough for the pool worker and
// billing tests: the same rules (refill up to the target from the allowance,
// debit within the daily limit, withdrawal after a delay that turns refills
// off), real event logs, and receipts that land a block later. The deployed
// contract itself is exercised in scripts/verify-pool-fork.mjs.
export const FAKE_POOL = '0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3';
export const FAKE_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
export const FAKE_TREASURY = '0x0061e7958aA1f6bbDA7fFdB4D079fa2d413263dd';
const DAY = 86400;

export class FakePoolChain {
  constructor({ now = () => Math.floor(Date.now() / 1000), withdrawalDelay = 1800, defaultRefillTarget = 2_000_000n, defaultDailyLimit = 20_000_000n } = {}) {
    Object.assign(this, { now, withdrawalDelay, defaultRefillTarget, defaultDailyLimit });
    this.poolAddress = getAddress(FAKE_POOL); this.usdcAddress = getAddress(FAKE_USDC);
    this.accounts = new Map(); this.wallets = new Map(); this.allowances = new Map(); this.nonceOf = new Map(); this.usdcNonce = new Map();
    this.block = 100; this.receipts = new Map(); this.treasuryAccruedAtomic = 0n; this.treasuryBalance = 0n; this.seq = 0;
    this.processedBatches = new Set(); this.processedClaims = new Set(); this.sent = [];
    this.failNext = null;
  }
  key(a) { return a.toLowerCase(); }
  account(owner) {
    const k = this.key(owner);
    if (!this.accounts.has(k)) this.accounts.set(k, { balance: 0n, withdrawalAmount: 0n, withdrawableAt: 0, day: 0, spentToday: 0n, refillTarget: 0n, dailyLimit: 0n, configured: false });
    return this.accounts.get(k);
  }
  mint(owner, amount) { this.wallets.set(this.key(owner), (this.wallets.get(this.key(owner)) ?? 0n) + BigInt(amount)); }
  balanceOf(owner) { return this.wallets.get(this.key(owner)) ?? 0n; }
  limit(a) { return a.configured ? a.dailyLimit : this.defaultDailyLimit; }
  target(a) { return a.configured ? a.refillTarget : this.defaultRefillTarget; }
  roll(a) { const today = Math.floor(this.now() / DAY); if (a.day !== today) { a.day = today; a.spentToday = 0n; } }

  // ------------------------------------------------ reads used by the code
  poolDomain() { return { ...POOL_DOMAIN, chainId: 143, verifyingContract: this.poolAddress }; }
  async usdcDomain() { return { name: 'USDC', version: '2', chainId: 143, verifyingContract: this.usdcAddress }; }
  async terms() {
    return { treasury: getAddress(FAKE_TREASURY), withdrawalDelaySeconds: this.withdrawalDelay, maxDebitAtomic: 1_000_000_000n,
      maxRefillTargetAtomic: 1_000_000_000n, defaultRefillTargetAtomic: this.defaultRefillTarget, defaultDailyLimitAtomic: this.defaultDailyLimit };
  }
  async snapshot(payer) {
    const a = this.account(payer); this.roll(a);
    const limit = this.limit(a);
    return { pool_balance_atomic: a.balance, withdrawal_atomic: a.withdrawalAmount, withdrawable_at: a.withdrawableAt ? new Date(a.withdrawableAt * 1000) : null,
      refill_target_atomic: this.target(a), daily_limit_atomic: limit, daily_remaining_atomic: limit > a.spentToday ? limit - a.spentToday : 0n,
      wallet_balance_atomic: this.balanceOf(payer), allowance_atomic: this.allowances.get(this.key(payer)) ?? 0n, snapshot_block: this.block, snapshot_at: new Date() };
  }
  async nonces(payer) { return { pool: this.nonceOf.get(this.key(payer)) ?? 0n, usdc: this.usdcNonce.get(this.key(payer)) ?? 0n }; }
  async walletBalance(payer) { return this.balanceOf(payer); }
  async treasuryAccrued() { return this.treasuryAccruedAtomic; }
  async receipt(hash) { return this.receipts.get(hash) ?? null; }
  async finalizedBlock() { return this.block; }
  async verifyTypedData({ address, domain, types, message, signature }) {
    try { return getAddress(verifyTypedData(domain, types, message, signature)) === getAddress(address); } catch { return false; }
  }
  destroy() {}

  // ---------------------------------------------- executing transactions
  log(address, name, args) {
    const iface = address === this.usdcAddress ? usdcInterface : poolInterface;
    const { data, topics } = iface.encodeEventLog(name, args);
    return { address, data, topics };
  }
  // Runs a call and records its receipt; mines it one block later.
  execute({ to, data }) {
    const hash = keccak256(toUtf8Bytes(`tx:${++this.seq}`));
    let logs = [], status = 1;
    try {
      if (this.failNext) { const f = this.failNext; this.failNext = null; throw new Error(f); }
      logs = getAddress(to) === this.usdcAddress ? this.usdcCall(data) : this.poolCall(data);
    } catch (error) { status = 0; logs = []; this.lastRevert = error.message; }
    this.block += 1;
    this.receipts.set(hash, { to: getAddress(to), status, logs, blockNumber: this.block, hash });
    return hash;
  }
  usdcCall(data) {
    const p = usdcInterface.parseTransaction({ data });
    if (p.name !== 'permit') throw new Error('UNSUPPORTED');
    const [owner, spender, value, deadline, signature] = p.args;
    const nonce = this.usdcNonce.get(this.key(owner)) ?? 0n;
    const domain = { name: 'USDC', version: '2', chainId: 143, verifyingContract: this.usdcAddress };
    const ok = getAddress(verifyTypedData(domain, { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, { owner, spender, value, nonce, deadline }, signature)) === getAddress(owner);
    if (!ok || Number(deadline) < this.now()) throw new Error('PERMIT_INVALID');
    this.usdcNonce.set(this.key(owner), nonce + 1n);
    this.allowances.set(this.key(owner), value);
    return [this.log(this.usdcAddress, 'Approval', [owner, spender, value])];
  }
  verifyPool(owner, primaryType, types, message, signature) {
    const nonce = this.nonceOf.get(this.key(owner)) ?? 0n;
    if (message.nonce !== nonce || Number(message.deadline) < this.now()) throw new Error('NONCE_OR_DEADLINE');
    if (getAddress(verifyTypedData(this.poolDomain(), { [primaryType]: types }, message, signature)) !== getAddress(owner)) throw new Error('BAD_SIGNATURE');
    this.nonceOf.set(this.key(owner), nonce + 1n);
  }
  poolCall(data) {
    const p = poolInterface.parseTransaction({ data });
    const A = (n, t) => ({ name: n, type: t });
    switch (p.name) {
      case 'configureBySig': {
        const [owner, refillTarget, dailyLimit, nonce, deadline, signature] = p.args;
        this.verifyPool(owner, 'Configure', [A('owner', 'address'), A('refillTarget', 'uint256'), A('dailyLimit', 'uint256'), A('nonce', 'uint256'), A('deadline', 'uint256')],
          { owner, refillTarget, dailyLimit, nonce, deadline }, signature);
        const a = this.account(owner); a.refillTarget = refillTarget; a.dailyLimit = dailyLimit; a.configured = true;
        return [this.log(this.poolAddress, 'Configured', [owner, refillTarget, dailyLimit, BigInt(this.now())])];
      }
      case 'requestWithdrawalBySig': {
        const [owner, amount, nonce, deadline, signature] = p.args;
        this.verifyPool(owner, 'RequestWithdrawal', [A('owner', 'address'), A('amount', 'uint256'), A('nonce', 'uint256'), A('deadline', 'uint256')], { owner, amount, nonce, deadline }, signature);
        const a = this.account(owner); a.withdrawalAmount = amount; a.withdrawableAt = this.now() + this.withdrawalDelay;
        return [this.log(this.poolAddress, 'WithdrawalRequested', [owner, amount, BigInt(a.withdrawableAt)])];
      }
      case 'cancelWithdrawalBySig': {
        const [owner, nonce, deadline, signature] = p.args;
        this.verifyPool(owner, 'CancelWithdrawal', [A('owner', 'address'), A('nonce', 'uint256'), A('deadline', 'uint256')], { owner, nonce, deadline }, signature);
        const a = this.account(owner); if (!a.withdrawalAmount) throw new Error('NoWithdrawal'); a.withdrawalAmount = 0n; a.withdrawableAt = 0;
        return [this.log(this.poolAddress, 'WithdrawalCancelled', [owner])];
      }
      case 'withdraw': {
        const [owner] = p.args; const a = this.account(owner);
        if (!a.withdrawalAmount) throw new Error('NoWithdrawal');
        if (this.now() < a.withdrawableAt) throw new Error('WithdrawalNotReady');
        const amount = a.withdrawalAmount < a.balance ? a.withdrawalAmount : a.balance;
        a.withdrawalAmount = 0n; a.withdrawableAt = 0; if (!a.configured) { a.dailyLimit = this.defaultDailyLimit; a.configured = true; } a.refillTarget = 0n;
        a.balance -= amount; this.mint(owner, amount);
        return [this.log(this.poolAddress, 'Withdrawn', [owner, amount]), this.log(this.poolAddress, 'Configured', [owner, 0n, this.limit(a), BigInt(this.now())])];
      }
      case 'sweep': {
        const amount = this.treasuryAccruedAtomic; if (!amount) return [];
        this.treasuryAccruedAtomic = 0n; this.treasuryBalance += amount;
        return [this.log(this.poolAddress, 'Swept', [amount])];
      }
      case 'settle': {
        const [batchKey, payer, claimKey, debit, refill, usageRoot] = p.args;
        if (this.processedBatches.has(batchKey)) throw new Error('DuplicateBatch');
        this.processedBatches.add(batchKey);
        const a = this.account(payer); const logs = [];
        if (debit > 0n) {
          if (this.processedClaims.has(claimKey)) throw new Error('DuplicateClaim');
          this.processedClaims.add(claimKey); this.roll(a);
          if (a.spentToday + debit > this.limit(a)) throw new Error('DailyLimitExceeded');
          if (debit > a.balance) throw new Error('InsufficientPool');
          a.balance -= debit; a.spentToday += debit; this.treasuryAccruedAtomic += debit;
          logs.push(this.log(this.poolAddress, 'Debited', [batchKey, claimKey, payer, debit, usageRoot]));
        }
        if (refill > 0n) {
          const target = this.target(a); const room = target > a.balance ? target - a.balance : 0n; const amount = refill < room ? refill : room;
          const allowance = this.allowances.get(this.key(payer)) ?? 0n;
          if (a.withdrawalAmount !== 0n || amount === 0n || allowance < amount || this.balanceOf(payer) < amount) {
            logs.push(this.log(this.poolAddress, 'RefillSkipped', [batchKey, payer, refill]));
          } else {
            this.allowances.set(this.key(payer), allowance - amount); this.wallets.set(this.key(payer), this.balanceOf(payer) - amount); a.balance += amount;
            logs.push(this.log(this.usdcAddress, 'Transfer', [payer, this.poolAddress, amount]));
            logs.push(this.log(this.poolAddress, 'Refilled', [batchKey, payer, amount]));
          }
        }
        return logs;
      }
      default: throw new Error('UNSUPPORTED');
    }
  }
}

// The signer in tests: rebuilds the call from the store's rows, as the real one does.
export class FakePoolSender {
  constructor({ chain, store }) { Object.assign(this, { chain, store }); this.journal = new Map(); this.calls = []; }
  async submit({ signerRef, idempotencyKey }) {
    this.calls.push({ signerRef, idempotencyKey });
    if (this.journal.has(idempotencyKey)) return this.journal.get(idempotencyKey);
    const id = idempotencyKey.split(':')[1];
    let call;
    if (signerRef === 'pool-settle-v1') {
      const b = this.store.batches.get(id);
      if (!b || !['planned', 'submitted'].includes(b.state)) throw Object.assign(new Error('SIGNER_BATCH_NOT_AUTHORIZED'), { code: 'SIGNER_BATCH_NOT_AUTHORIZED' });
      call = { to: this.chain.poolAddress, data: settleCalldata(b) };
    } else {
      const op = this.store.ops.get(id);
      if (!op || !['queued', 'submitted'].includes(op.state)) throw Object.assign(new Error('SIGNER_OP_NOT_AUTHORIZED'), { code: 'SIGNER_OP_NOT_AUTHORIZED' });
      call = opCall(op, { poolAddress: this.chain.poolAddress, usdcAddress: this.chain.usdcAddress });
    }
    const hash = this.chain.execute(call);
    if(signerRef==='pool-settle-v1')this.store.signedTransactions.set(id,hash);
    this.journal.set(idempotencyKey, hash);
    return hash;
  }
}
