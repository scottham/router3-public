// The compiled WalletPrepaidPool, as the deploy and verify scripts use it.
// contracts/artifacts/WalletPrepaidPool.json is committed so that deploying
// and verifying need no Foundry; `npm run contracts:build` regenerates it
// from the source and must be rerun (and committed) after any contract
// change. Verification masks the immutables, which differ per deployment.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { keccak256 } from 'ethers';

const contracts = new URL('../../contracts/', import.meta.url);
export const artifactPath = new URL('artifacts/WalletPrepaidPool.json', contracts);

export function loadArtifact() {
  return JSON.parse(readFileSync(artifactPath, 'utf8'));
}

// forge build → the subset the scripts need.
export function buildArtifact() {
  execFileSync('forge', ['build'], { cwd: contracts, stdio: 'inherit' });
  const full = JSON.parse(readFileSync(new URL('out/WalletPrepaidPool.sol/WalletPrepaidPool.json', contracts), 'utf8'));
  const artifact = {
    contract: 'contracts/src/WalletPrepaidPool.sol:WalletPrepaidPool',
    compiler: full.metadata?.compiler?.version ?? null,
    settings: { optimizer: full.metadata?.settings?.optimizer ?? null, evmVersion: full.metadata?.settings?.evmVersion ?? null },
    abi: full.abi,
    bytecode: full.bytecode.object,
    deployedBytecode: full.deployedBytecode.object,
    immutableReferences: full.deployedBytecode.immutableReferences ?? {}
  };
  mkdirSync(new URL('artifacts/', contracts), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

const strip0x = (hex) => hex.replace(/^0x/, '').toLowerCase();

function masked(hex, references) {
  const chars = strip0x(hex).split('');
  for (const slots of Object.values(references)) for (const { start, length } of slots) chars.fill('0', start * 2, (start + length) * 2);
  return chars.join('');
}

// True when `onchain` is this artifact's runtime code, immutables aside.
export function sameRuntimeCode(artifact, onchain) {
  const compiled = strip0x(artifact.deployedBytecode);
  onchain = strip0x(onchain);
  return compiled.length === onchain.length && masked(compiled, artifact.immutableReferences) === masked(onchain, artifact.immutableReferences);
}

export const codeHash = (onchain) => keccak256(onchain.startsWith('0x') ? onchain : `0x${onchain}`);

// The immutables as deployed, one line each: addresses, small numbers
// (USDC atomic units, seconds) or raw words (the EIP-712 domain parts).
export function describeImmutables(artifact, onchain) {
  onchain = strip0x(onchain);
  return Object.entries(artifact.immutableReferences).map(([id, slots]) => {
    const { start, length } = slots[0];
    const value = onchain.slice(start * 2, (start + length) * 2);
    const number = BigInt(`0x${value}`);
    return `${id.padEnd(6)}  ${number < 2n ** 64n ? number.toString() : number < 2n ** 160n ? `0x${value.slice(-40)}` : `0x${value}`}`;
  });
}

export async function fetchCode(rpc, address) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }) });
  const { result, error } = await response.json();
  if (error || !result || result === '0x') throw new Error(`no code at ${address}: ${error?.message ?? 'empty'}`);
  return result;
}
