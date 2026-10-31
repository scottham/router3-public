import { getAddress, toHex } from 'viem';
import { ADD_CHAIN, CHAIN_ID } from './chain.js';
import { t } from './i18n.js';

// Requests accounts and puts the wallet on the expected chain, adding Monad
// mainnet when the wallet does not know it yet.
export async function connectAccount(provider, expectedChainId) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error(t('The wallet returned no account'));
  const chainId = toHex(expectedChainId);
  if (Number(await provider.request({ method: 'eth_chainId' })) !== Number(expectedChainId)) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    } catch (error) {
      if (error?.code !== 4902 || Number(expectedChainId) !== CHAIN_ID) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [ADD_CHAIN] });
    }
  }
  if (Number(await provider.request({ method: 'eth_chainId' })) !== Number(expectedChainId)) throw new Error(t('The wallet did not switch to the required network'));
  return getAddress(accounts[0]);
}
