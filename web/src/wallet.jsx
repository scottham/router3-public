import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { RainbowKitProvider, connectorsForWallets, darkTheme, lightTheme, useConnectModal } from '@rainbow-me/rainbowkit';
import {
  coinbaseWallet, injectedWallet, metaMaskWallet, okxWallet, rabbyWallet, rainbowWallet, walletConnectWallet
} from '@rainbow-me/rainbowkit/wallets';
import { WagmiProvider, createConfig, http, useAccount, useDisconnect } from 'wagmi';
import { monad } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { locale, t } from './i18n.js';
import '@rainbow-me/rainbowkit/styles.css';

// RainbowKit owns wallet discovery and connection. Once connected, the console
// talks to the wallet's EIP-1193 provider directly for signing and sending.
const PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '';
const MONAD_ACCENT = { accentColor: '#836ef9', accentColorForeground: '#ffffff', borderRadius: 'medium' };

export function walletGroups(projectId = PROJECT_ID) {
  // Mobile wallets connect through WalletConnect, which needs a project ID.
  // Without one, offer only wallets that work as browser extensions.
  return projectId
    ? [{ groupName: t('Popular'), wallets: [metaMaskWallet, rabbyWallet, okxWallet, rainbowWallet, coinbaseWallet, walletConnectWallet] },
      { groupName: t('Other'), wallets: [injectedWallet] }]
    : [{ groupName: t('Browser wallets'), wallets: [injectedWallet, rabbyWallet, coinbaseWallet] }];
}

const WalletContext = createContext(null);
export const useWallet = () => useContext(WalletContext);

function WalletBridge({ children }) {
  const account = useAccount();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const { disconnectAsync } = useDisconnect();
  const latest = useRef({});
  latest.current = { account, openConnectModal };
  const pending = useRef(null);

  // Resolve a pending request once a wallet connects; reject if the user
  // closes the modal without choosing one.
  useEffect(() => {
    if (account.status === 'connected' && pending.current) {
      const { resolve, reject } = pending.current;
      pending.current = null;
      account.connector.getProvider().then(resolve, reject);
    }
  }, [account.status, account.connector]);
  useEffect(() => {
    if (connectModalOpen || !pending.current) return undefined;
    const timer = setTimeout(() => {
      if (pending.current && latest.current.account.status !== 'connected') {
        pending.current.reject(new Error(t('Wallet connection cancelled')));
        pending.current = null;
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [connectModalOpen]);

  const value = useMemo(() => ({
    // A provider for the connected wallet; asks the user to pick one if needed.
    // `fresh` forces a new choice (sign-in), so a stale connection is not reused.
    async requestProvider({ fresh = false } = {}) {
      if (fresh && latest.current.account.status === 'connected') await disconnectAsync().catch(() => undefined);
      else if (latest.current.account.status === 'connected') return latest.current.account.connector.getProvider();
      for (let i = 0; i < 50 && !latest.current.openConnectModal; i++) await new Promise((r) => setTimeout(r, 20));
      if (!latest.current.openConnectModal) throw new Error(t('The wallet module is not ready; reload the page'));
      pending.current?.reject(new Error(t('Wallet connection cancelled')));
      return new Promise((resolve, reject) => {
        pending.current = { resolve, reject };
        latest.current.openConnectModal();
      });
    },
    disconnect: () => disconnectAsync().catch(() => undefined)
  }), [disconnectAsync]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function WalletProvider({ appName, dark, children }) {
  const { config, queryClient, chain } = useMemo(() => {
    const target = monad;
    return {
      chain: target,
      queryClient: new QueryClient(),
      config: createConfig({
        chains: [target],
        transports: { [target.id]: http() },
        connectors: connectorsForWallets(walletGroups(), { appName, projectId: PROJECT_ID || 'unset' }),
        ssr: false
      })
    };
  }, [appName]);
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider initialChain={chain} modalSize="compact" locale={locale()} theme={dark ? darkTheme(MONAD_ACCENT) : lightTheme(MONAD_ACCENT)}>
          <WalletBridge>{children}</WalletBridge>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
