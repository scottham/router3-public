import { t } from './i18n.js';
// The only network the console works with: Monad mainnet.
export const CHAIN_ID = 143;
export const NETWORK = { name: t('Monad Mainnet'), testnet: false, explorer: 'https://monadscan.com', nativeSymbol: 'MON' };
export const ADD_CHAIN = {
  chainId: '0x8f', chainName: 'Monad', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: ['https://rpc.monad.xyz'], blockExplorerUrls: ['https://monadscan.com']
};
