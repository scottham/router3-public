// npm run pool:deploy — deploys a WalletPrepaidPool for this gateway and
// writes POOL_ADDRESS and POOL_CODE_HASH into .env, where
// mainnet:local:configure picks them up. Reads .env:
//
//   TREASURY_ADDRESS        where settled usage goes (required)
//   DEPLOYER_PRIVATE_KEY    pays this one transaction; needs ~0.5 MON (required)
//   MONAD_RPC_URL           default: the public Monad RPC
//   POOL_ADMIN_ADDRESS      can pause settlements, nothing else; default: the Treasury
//   SETTLER_KEY_FILE        the signer's key; generated here when missing
//   POOL_DEBIT_LIMIT_USDC, POOL_REFILL_CEILING_USDC, POOL_DEFAULT_REFILL_USDC,
//   POOL_DEFAULT_DAILY_USDC, POOL_WITHDRAWAL_DELAY_SECONDS
//                           contract constants; defaults 1000, 1000, 2, 20, 1800
//
// Refuses to replace an existing POOL_ADDRESS unless --force: the pool holds
// users' money, and a new one starts empty. The deployer key is only needed
// for this call; keep it out of the server afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { ContractFactory, FetchRequest, JsonRpcProvider, Wallet, formatEther, getAddress, parseUnits } from 'ethers';
import { upsertEnv } from './lib/env-file.mjs';
import { ensureSettlerKey, DEFAULT_SETTLER_KEY_FILE } from './lib/settler-key.mjs';
import { codeHash, describeImmutables, loadArtifact, sameRuntimeCode } from './lib/pool-artifact.mjs';
import { normalizeHexPrivateKey } from './lib/testnet-private-key.mjs';
import { CHAIN_ID, PUBLIC_RPC_URL, USDC_ADDRESS } from '../src/chain.js';

const envPath = process.env.ENV_FILE || '.env';
const text = readFileSync(envPath, 'utf8');
const env = parseEnv(text);
const usdc = (name, fallback) => parseUnits(env[name] || fallback, 6);

if (env.POOL_ADDRESS && !process.argv.includes('--force')) {
  throw new Error(`POOL_ADDRESS is already ${env.POOL_ADDRESS} in ${envPath}; a new pool starts empty. Pass --force to replace it anyway.`);
}
const treasury = getAddress(env.TREASURY_ADDRESS || '');
const admin = getAddress(env.POOL_ADMIN_ADDRESS || treasury);
const settler = ensureSettlerKey(env.SETTLER_KEY_FILE || DEFAULT_SETTLER_KEY_FILE);
if (settler === treasury || settler === admin) throw new Error('SETTLER_MUST_NOT_BE_TREASURY_OR_ADMIN');
const args = [USDC_ADDRESS, treasury, admin, settler,
  usdc('POOL_DEBIT_LIMIT_USDC', '1000'), usdc('POOL_REFILL_CEILING_USDC', '1000'), usdc('POOL_DEFAULT_REFILL_USDC', '2'), usdc('POOL_DEFAULT_DAILY_USDC', '20'),
  BigInt(env.POOL_WITHDRAWAL_DELAY_SECONDS || '1800')];

const rpc = env.MONAD_RPC_URL || PUBLIC_RPC_URL;
const request = new FetchRequest(rpc); request.timeout = 20000;
const provider = new JsonRpcProvider(request, CHAIN_ID, { staticNetwork: true });
try {
  if (Number(await provider.send('eth_chainId', [])) !== CHAIN_ID) throw new Error('MONAD_MAINNET_RPC_REQUIRED');
  const deployer = new Wallet(normalizeHexPrivateKey(env.DEPLOYER_PRIVATE_KEY, 'DEPLOYER_PRIVATE_KEY'), provider);
  if (deployer.address === settler) throw new Error('DEPLOYER_MUST_NOT_BE_SETTLER');
  const artifact = loadArtifact();
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const tx = await factory.getDeployTransaction(...args);
  const [balance, gas, fee] = await Promise.all([provider.getBalance(deployer.address), provider.estimateGas({ ...tx, from: deployer.address }), provider.getFeeData()]);
  const cost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
  console.log(`deployer    ${deployer.address}  ${formatEther(balance)} MON (this deployment needs about ${formatEther(cost)})`);
  if (balance < cost) throw new Error('DEPLOYER_NEEDS_MON');
  console.log(`treasury    ${treasury}\nadmin       ${admin}\nsettler     ${settler}`);

  const contract = await factory.deploy(...args);
  console.log(`sent        ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const onchain = await provider.getCode(address);
  if (!sameRuntimeCode(artifact, onchain)) throw new Error(`DEPLOYED_CODE_MISMATCH at ${address}: the artifact and the chain disagree`);
  const hash = codeHash(onchain);
  for (const line of describeImmutables(artifact, onchain)) console.log(`immutable   ${line}`);

  writeFileSync(envPath, upsertEnv(text, new Map([['POOL_ADDRESS', address], ['POOL_CODE_HASH', hash]])));
  console.log(`\npool        ${address}\ncode hash   ${hash}\nsaved to ${envPath}: POOL_ADDRESS, POOL_CODE_HASH. Next: npm run mainnet:local:configure`);
} finally {
  provider.destroy();
}
