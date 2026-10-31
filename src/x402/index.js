import {PgChannelStorage} from './storage.js';
import {RemoteAuthorizerSigner} from './authorizer.js';
import {X402Repository} from './repository.js';
import {X402Service} from './service.js';

// Wires the x402 pieces for a runtime. `overrides` lets tests and single
// process self-hosting supply their own facilitator, storage or signer.
export function createX402({config,pool,gateway,fetchImpl=fetch,logger=console,...overrides}) {
  const storage=overrides.storage??new PgChannelStorage(pool);
  const repository=overrides.repository??new X402Repository(pool);
  const authorizer=overrides.authorizer??new RemoteAuthorizerSigner({url:config.SETTLER_SIGNER_URL,token:config.SETTLER_SIGNER_BEARER_TOKEN,
    address:config.SETTLER_ADDRESS,fetchImpl});
  const service=new X402Service({config,gateway,repository,storage,authorizer,facilitator:overrides.facilitator,fetchImpl,logger});
  return {service,storage,repository,authorizer,scheme:service.scheme,facilitator:service.facilitator};
}
