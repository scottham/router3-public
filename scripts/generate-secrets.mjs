import { randomBytes } from 'node:crypto';
const hex = () => randomBytes(32).toString('hex');
const b64 = () => randomBytes(32).toString('base64');
console.log(`AUTH_SESSION_HMAC_SECRET=${hex()}`);
console.log(`SETTLER_SIGNER_BEARER_TOKEN=${hex()}`);
console.log(`RESPONSE_ENCRYPTION_KEYS=v1:${b64()}`);
