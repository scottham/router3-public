import { JsonRpcProvider } from 'ethers';

// Workers poll the same few chains forever. Building a provider per pass (or per
// settlement row) rebuilt the network detection and connection state on every
// iteration, so providers are created once per chain and reused.
export function createRpcProviderCache() {
  const providers = new Map();
  return {
    get(chainId, rpcUrl) {
      const key = `${Number(chainId)}:${rpcUrl}`;
      let provider = providers.get(key);
      if (!provider) {
        provider = new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true });
        providers.set(key, provider);
      }
      return provider;
    },
    destroy() {
      for (const provider of providers.values()) provider.destroy();
      providers.clear();
    }
  };
}
