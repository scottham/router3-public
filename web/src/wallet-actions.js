import { formatUnits, getAddress, parseUnits } from 'viem';
import { connectAccount } from './wallets.js';
import { t } from './i18n.js';

export function tokenAmount(value, decimals) {
  const text = String(value ?? '').trim();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36 || !/^\d+(?:\.\d+)?$/.test(text) || (text.split('.')[1]?.length ?? 0) > decimals) {
    throw new Error(t('Enter a valid amount with at most {0} decimals', decimals));
  }
  const amount = parseUnits(text, decimals);
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error(t('The amount must be above 0 and within the token range'));
  return amount;
}

export function displayTokenAmount(value, decimals = 6) {
  return value == null ? '—' : formatUnits(BigInt(value), decimals);
}

// The console only ever asks the signed-in wallet for signatures (deposit
// authorizations and channel vouchers); it never sends a transaction.
export async function connectOwnedWallet(provider, owner, expectedChainId) {
  const address = await connectAccount(provider, expectedChainId);
  const addresses = await provider.request({ method: 'eth_accounts' });
  if (address !== owner || !addresses?.some((item) => getAddress(item) === owner)) throw new Error(t('The wallet account differs from the signed-in one; switch back to it'));
}
