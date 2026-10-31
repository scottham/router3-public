import { encodeAbiParameters, getAddress, hashTypedData, keccak256, toHex, zeroAddress } from 'viem';

// x402 payment channels from the console: builds the typed data the wallet
// signs (a USDC ReceiveWithAuthorization for a deposit, a batch-settlement
// Voucher for a deposit or refund) and the payloads the gateway's x402
// endpoints accept. Pure functions, mirrored by the server-side tests.
export const CONTRACT = '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
export const DEPOSIT_COLLECTOR = '0x4020806089470a89826cB9fB1f4059150b550004';
const EIP712_DOMAIN = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const CHANNEL_CONFIG = [
  { name: 'payer', type: 'address' }, { name: 'payerAuthorizer', type: 'address' }, { name: 'receiver', type: 'address' },
  { name: 'receiverAuthorizer', type: 'address' }, { name: 'token', type: 'address' }, { name: 'withdrawDelay', type: 'uint40' }, { name: 'salt', type: 'bytes32' }
];
export const VOUCHER_TYPES = { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'maxClaimableAmount', type: 'uint128' }] };
const RECEIVE_TYPES = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
] };

export const channelDomain = (chainId) => ({ name: 'x402 Batch Settlement', version: '1', chainId, verifyingContract: CONTRACT });

// The channel id is the EIP-712 hash of its config under the contract's domain.
export function channelId(config, chainId) {
  return hashTypedData({ domain: channelDomain(chainId), types: { ChannelConfig: CHANNEL_CONFIG }, primaryType: 'ChannelConfig',
    message: { ...config, withdrawDelay: Number(config.withdrawDelay) } });
}

// A new channel for the signed-in wallet. A contract wallet signs vouchers
// through ERC-1271, which the scheme expresses as a zero payer authorizer.
export function newChannelConfig({ payer, walletKind, terms, salt }) {
  return {
    payer: getAddress(payer), payerAuthorizer: walletKind === 'contract' ? zeroAddress : getAddress(payer),
    receiver: getAddress(terms.payTo), receiverAuthorizer: getAddress(terms.receiverAuthorizer), token: getAddress(terms.asset),
    withdrawDelay: Number(terms.withdrawDelaySeconds), salt
  };
}

const randomBytes32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

// The ERC-3009 nonce the deposit collector expects: keccak256(channelId, salt).
export function depositNonce(id, salt) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, BigInt(salt)]));
}

export function voucherTypedData({ id, maxClaimableAmount, chainId }) {
  return { domain: channelDomain(chainId), types: { EIP712Domain: EIP712_DOMAIN, ...VOUCHER_TYPES }, primaryType: 'Voucher',
    message: { channelId: id, maxClaimableAmount: String(maxClaimableAmount) } };
}

// Everything a deposit needs the wallet to sign, plus the payload to send.
export function depositDraft({ config, id, amountAtomic, chargedAtomic, terms, chainId, now = Math.floor(Date.now() / 1000), salt = randomBytes32() }) {
  const validBefore = now + Number(terms.maxTimeoutSeconds ?? 600);
  const authorization = { domain: { name: terms.assetName, version: terms.assetVersion, chainId, verifyingContract: getAddress(terms.asset) },
    types: { EIP712Domain: EIP712_DOMAIN, ...RECEIVE_TYPES }, primaryType: 'ReceiveWithAuthorization',
    message: { from: config.payer, to: DEPOSIT_COLLECTOR, value: String(amountAtomic), validAfter: '0', validBefore: String(validBefore), nonce: depositNonce(id, salt) } };
  // The deposit route charges one micro USDC, so the voucher moves by one.
  const maxClaimableAmount = BigInt(chargedAtomic ?? 0) + 1n;
  return { authorization, voucher: voucherTypedData({ id, maxClaimableAmount, chainId }), salt, validBefore,
    payload: (signatures) => ({ type: 'deposit', channelConfig: config, voucher: { channelId: id, maxClaimableAmount: String(maxClaimableAmount), signature: signatures.voucher },
      deposit: { amount: String(amountAtomic), authorization: { erc3009Authorization: { validAfter: '0', validBefore: String(validBefore), salt, signature: signatures.authorization } } } }) };
}

// A cooperative refund: a zero-charge voucher at the current cumulative amount.
export function refundDraft({ config, id, chargedAtomic, chainId, amountAtomic = null }) {
  return { voucher: voucherTypedData({ id, maxClaimableAmount: BigInt(chargedAtomic), chainId }),
    payload: (signature) => ({ type: 'refund', channelConfig: config, voucher: { channelId: id, maxClaimableAmount: String(chargedAtomic), signature },
      ...(amountAtomic == null ? {} : { amount: String(amountAtomic) }) }) };
}

// The PAYMENT-SIGNATURE header: base64 JSON of the x402 v2 payment envelope.
export function paymentHeader({ accepted, payload, resource }) {
  const bytes = new TextEncoder().encode(JSON.stringify({ x402Version: 2, ...(resource ? { resource } : {}), accepted, payload }));
  return btoa(String.fromCharCode(...bytes));
}

export function decodeHeader(value) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))));
}
