// The Settler key: the one key the signer holds. It signs x402 claims and
// refunds and sends the pool's settle transactions, so it needs a little
// MON and nothing else; it must never be the Treasury or the deployer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Wallet } from 'ethers';

export const DEFAULT_SETTLER_KEY_FILE = './.secrets/monad-settler.key';

// Creates the key file when missing (mode 600) and returns its address.
export function ensureSettlerKey(path = DEFAULT_SETTLER_KEY_FILE) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Wallet.createRandom().privateKey, { mode: 0o600 });
    console.log(`Settler key generated at ${path}; back it up privately. Fund its address with MON for prepaid-pool transaction gas; keep it separate from the Treasury.`);
  }
  return new Wallet(readFileSync(path, 'utf8').trim()).address;
}
