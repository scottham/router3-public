// Typed data the wallet signs for its prepaid pool, in the shape
// eth_signTypedData_v4 takes. The gateway relays each one and pays the gas.
const DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const field = (name, type) => ({ name, type });
const TYPES = {
  Permit: [field('owner', 'address'), field('spender', 'address'), field('value', 'uint256'), field('nonce', 'uint256'), field('deadline', 'uint256')],
  Configure: [field('owner', 'address'), field('refillTarget', 'uint256'), field('dailyLimit', 'uint256'), field('nonce', 'uint256'), field('deadline', 'uint256')],
  RequestWithdrawal: [field('owner', 'address'), field('amount', 'uint256'), field('nonce', 'uint256'), field('deadline', 'uint256')],
  CancelWithdrawal: [field('owner', 'address'), field('nonce', 'uint256'), field('deadline', 'uint256')]
};
const typed = (domain, primaryType, message) => ({ types: { EIP712Domain: DOMAIN, [primaryType]: TYPES[primaryType] }, primaryType, domain,
  message: Object.fromEntries(Object.entries(message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) });

// Signatures stay valid for an hour; the gateway relays them within seconds.
export const signatureDeadline = (now = Date.now()) => BigInt(Math.floor(now / 1000) + 3600);

export const permitTyped = ({ terms, owner, value, nonce, deadline }) =>
  typed(terms.usdcDomain, 'Permit', { owner, spender: terms.poolAddress, value, nonce, deadline });
export const configureTyped = ({ terms, owner, refillTarget, dailyLimit, nonce, deadline }) =>
  typed(terms.poolDomain, 'Configure', { owner, refillTarget, dailyLimit, nonce, deadline });
export const withdrawalTyped = ({ terms, owner, amount, nonce, deadline }) =>
  typed(terms.poolDomain, 'RequestWithdrawal', { owner, amount, nonce, deadline });
export const cancelWithdrawalTyped = ({ terms, owner, nonce, deadline }) =>
  typed(terms.poolDomain, 'CancelWithdrawal', { owner, nonce, deadline });

// What the pool's settings allow at a typical hold (about 0.15 USDC per coding-agent call).
export const TYPICAL_HOLD_ATOMIC = 150_000n;
export const concurrentAt = (refillTargetAtomic) => Number(BigInt(refillTargetAtomic ?? 0) / TYPICAL_HOLD_ATOMIC);
