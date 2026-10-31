import {getAddress} from 'ethers';
import {BATCH_SETTLEMENT_ADDRESS,BATCH_SETTLEMENT_DOMAIN,claimBatchTypes,refundTypes} from '@x402/evm';
import {CHAIN_ID} from '../chain.js';

// The receiver authorizer of every channel: the key that signs claim batches
// (moving charged amounts to the Treasury's claimed balance) and cooperative
// refunds (returning the payer's unused deposit). The settlement signer holds
// it; the API and the collector only ask for signatures over the two typed
// data shapes the x402BatchSettlement contract understands.
export const AUTHORIZER_SIGNER_REF='x402-authorizer-v1';
export const AUTHORIZER_TYPES=Object.freeze({ClaimBatch:claimBatchTypes,Refund:refundTypes});

export function authorizerDomain() {
  return {...BATCH_SETTLEMENT_DOMAIN,chainId:CHAIN_ID,verifyingContract:getAddress(BATCH_SETTLEMENT_ADDRESS)};
}

const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);

// Checks a signing request against the only shapes the authorizer ever signs.
// Shared by the signer service (the enforcing side) and the client (fail fast).
export function checkAuthorizerRequest({domain,types,primaryType,message}) {
  const expected=authorizerDomain();
  if(!domain||domain.name!==expected.name||domain.version!==expected.version||Number(domain.chainId)!==expected.chainId
    ||getAddress(String(domain.verifyingContract))!==expected.verifyingContract)throw new Error('SIGNER_TYPED_DATA_DOMAIN_NOT_ALLOWED');
  if(!AUTHORIZER_TYPES[primaryType]||json(types)!==json(AUTHORIZER_TYPES[primaryType]))throw new Error('SIGNER_TYPED_DATA_TYPE_NOT_ALLOWED');
  if(primaryType==='ClaimBatch') {
    const claims=message?.claims;
    if(!Array.isArray(claims)||claims.length<1||claims.length>100)throw new Error('SIGNER_CLAIM_BATCH_INVALID');
    return {primaryType,claims:claims.map(c=>({channelId:String(c.channelId).toLowerCase(),maxClaimableAmount:BigInt(c.maxClaimableAmount),totalClaimed:BigInt(c.totalClaimed)}))};
  }
  return {primaryType,channelId:String(message.channelId).toLowerCase(),nonce:BigInt(message.nonce),amount:BigInt(message.amount)};
}

// Asks the settlement signer for an authorizer signature.
export class RemoteAuthorizerSigner {
  constructor({url,token,address,fetchImpl=fetch}) {
    if(!url||!token||!address)throw new Error('X402_AUTHORIZER_CONFIG_REQUIRED');
    Object.assign(this,{url,token,address:getAddress(address),fetchImpl});
  }
  async signTypedData({domain,types,primaryType,message}) {
    checkAuthorizerRequest({domain,types,primaryType,message});
    const response=await this.fetchImpl(this.url,{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{'content-type':'application/json',authorization:`Bearer ${this.token}`},
      body:json({signerRef:AUTHORIZER_SIGNER_REF,domain,types,primaryType,message})});
    const body=await response.json().catch(()=>({}));
    if(!response.ok||typeof body.signature!=='string')throw new Error(body.error??'X402_AUTHORIZER_SIGNING_FAILED');
    if(getAddress(body.address)!==this.address)throw new Error('X402_AUTHORIZER_ADDRESS_MISMATCH');
    return body.signature;
  }
}

// Signs with a key held in this process: tests and single-process self-hosting.
export class LocalAuthorizerSigner {
  constructor(wallet){this.wallet=wallet;this.address=getAddress(wallet.address);}
  async signTypedData({domain,types,primaryType,message}) {
    checkAuthorizerRequest({domain,types,primaryType,message});
    return this.wallet.signTypedData(domain,types,JSON.parse(json(message)));
  }
}
