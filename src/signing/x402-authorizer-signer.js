import {getAddress} from 'ethers';
import {AUTHORIZER_SIGNER_REF,checkAuthorizerRequest} from '../x402/authorizer.js';
import {signerError} from './settlement-signer.js';

// Signs the two EIP-712 messages the x402BatchSettlement contract accepts from
// a channel's receiver authorizer, and nothing else. A claim batch moves
// charged amounts into the Treasury's claimed balance; a refund returns part
// of a payer's unclaimed deposit. Both are checked against the gateway's
// channel mirror so a compromised API cannot claim more than it billed or
// refund what it is owed.
export class X402AuthorizerSigner {
  constructor({pool,wallet}){Object.assign(this,{pool,wallet});}

  get address(){return getAddress(this.wallet.address);}

  async sign(body) {
    if(body?.signerRef!==AUTHORIZER_SIGNER_REF)throw signerError('SIGNER_REQUEST_NOT_ALLOWED');
    let request;
    try {request=checkAuthorizerRequest(body);} catch(error) {throw signerError(error.message);}
    if(request.primaryType==='ClaimBatch') {
      for(const claim of request.claims) {
        const channel=await this.channel(claim.channelId);
        if(!channel||claim.totalClaimed>channel.charged||claim.maxClaimableAmount<claim.totalClaimed||claim.maxClaimableAmount>channel.signed)
          throw signerError('SIGNER_CLAIM_EXCEEDS_CHARGED',409);
      }
    } else {
      const channel=await this.channel(request.channelId);
      if(!channel||request.amount<=0n||request.amount>channel.balance-channel.charged)throw signerError('SIGNER_REFUND_EXCEEDS_UNCHARGED',409);
    }
    const message=JSON.parse(JSON.stringify(body.message,(_,v)=>typeof v==='bigint'?v.toString():v));
    const signature=await this.wallet.signTypedData(body.domain,body.types,message);
    console.log(JSON.stringify({level:'info',message:'x402_authorizer_signed',primaryType:request.primaryType,
      channels:request.claims?request.claims.map(c=>c.channelId):[request.channelId]}));
    return {signature,address:this.address};
  }

  async channel(channelId) {
    const {rows:[row]}=await this.pool.query(`select charged_cumulative_atomic charged,signed_max_claimable_atomic signed,balance_atomic balance
      from private.x402_channels where channel_id=$1`,[channelId]);
    return row?{charged:BigInt(row.charged),signed:BigInt(row.signed),balance:BigInt(row.balance)}:null;
  }
}
