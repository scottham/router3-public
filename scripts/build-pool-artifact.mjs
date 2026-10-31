// npm run contracts:build — compiles contracts/ with Foundry and refreshes
// contracts/artifacts/WalletPrepaidPool.json, the committed artifact that
// pool:deploy and contracts:verify use. Commit the result.
import { buildArtifact } from './lib/pool-artifact.mjs';

const artifact = buildArtifact();
console.log(`contracts/artifacts/WalletPrepaidPool.json: ${artifact.compiler}, runtime ${(artifact.deployedBytecode.length - 2) / 2} bytes`);
