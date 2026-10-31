import { monad } from 'viem/chains';

// The gateway authenticates and bills on one network: Monad mainnet, paying in
// Circle's native USDC. Everything chain-specific reads from here.
export const CHAIN_ID = 143;
export const CHAIN_KEY = String(CHAIN_ID);
export const CHAIN = monad;
export const USDC_ADDRESS = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
export const PUBLIC_RPC_URL = 'https://rpc.monad.xyz';
