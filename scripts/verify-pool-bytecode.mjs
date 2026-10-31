// npm run contracts:verify [-- --pool 0x… --rpc https://… --build]
//
// Checks that a deployed pool is contracts/src/WalletPrepaidPool.sol: fetches
// its runtime code and compares it with the committed artifact, immutables
// (the constructor arguments) masked. Prints the code hash, which is what
// POOL_CODE_HASH must hold, and the immutables as deployed. --build
// recompiles the artifact first (needs Foundry). Exit 0 is a match.
//
// Defaults: POOL_ADDRESS and MONAD_RPC_URL from the environment, else the
// router3.ai mainnet pool and the public Monad RPC.
import { buildArtifact, codeHash, describeImmutables, fetchCode, loadArtifact, sameRuntimeCode } from './lib/pool-artifact.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const pool = arg('--pool', process.env.POOL_ADDRESS || '0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3');
const rpc = arg('--rpc', process.env.MONAD_RPC_URL || 'https://rpc.monad.xyz');

const artifact = process.argv.includes('--build') ? buildArtifact() : loadArtifact();
const onchain = await fetchCode(rpc, pool);
const same = sameRuntimeCode(artifact, onchain);
console.log(`pool        ${pool}`);
console.log(`rpc         ${rpc}`);
console.log(`artifact    ${artifact.contract} (solc ${artifact.compiler})`);
console.log(`code hash   ${codeHash(onchain)}   (POOL_CODE_HASH)`);
for (const line of describeImmutables(artifact, onchain)) console.log(`immutable   ${line}`);
console.log(same ? 'MATCH: the deployed runtime code is this source, compiled with these settings' : 'MISMATCH: the deployed code differs from this source beyond its immutables');
process.exit(same ? 0 : 1);
