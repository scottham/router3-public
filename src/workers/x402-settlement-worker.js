import {Contract,JsonRpcProvider} from 'ethers';
import {BATCH_SETTLEMENT_ADDRESS} from '@x402/evm';
import {sleep} from '../lib/sleep.js';
import {withJobLock} from '../lib/pg-job-lock.js';
import {usdcAtomic,X402_NETWORK} from '../x402/service.js';
import {CHAIN_KEY,USDC_ADDRESS} from '../chain.js';

const logError=(message,extra={})=>console.error(JSON.stringify({level:'error',message,...extra}));
const contractAbi=['function pendingWithdrawals(bytes32) view returns(uint128 amount,uint40 initiatedAt)',
  'function channels(bytes32) view returns(uint128 balance,uint128 totalClaimed)'];

// Moves what channels owe on-chain, in batches, through the facilitator:
// claim vouchers whose unclaimed charge is worth a transaction, or whose
// payer has gone idle or started a withdrawal, then settle the claimed total
// to the Treasury. The receiver authorizer (the settlement signer) signs the
// claim batch; the facilitator pays the gas. A payer's timed withdrawal is
// read from the contract itself, so what was charged is claimed before the
// withdrawal delay elapses even when the payer never calls again.
export class X402SettlementWorker {
  constructor(pool,config,{scheme,facilitator,storage,repository,rpc=null}) {
    Object.assign(this,{pool,config,storage,repository});
    this.manager=scheme.createChannelManager(facilitator,X402_NETWORK,USDC_ADDRESS);
    this.minAtomic=usdcAtomic(config.X402_CLAIM_MIN_USDC);
    this.idleMs=config.X402_CLAIM_IDLE_SECONDS*1000;
    const rpcUrl=config.chains?.[CHAIN_KEY]?.rpcUrl??config.MONAD_RPC_URL;
    this.contract=rpc===false?null:new Contract(BATCH_SETTLEMENT_ADDRESS,contractAbi,rpc??new JsonRpcProvider(rpcUrl,Number(CHAIN_KEY),{staticNetwork:true}));
  }

  async run(signal) {
    while(!signal.aborted) {
      await withJobLock(this.pool,'x402-settlement',()=>this.tick()).catch(error=>logError('X402_SETTLEMENT_TICK_FAILED',{error:error.message}));
      await sleep(this.config.X402_CLAIM_INTERVAL_SECONDS*1000,signal);
    }
  }

  unclaimed(channel){return BigInt(channel.chargedCumulativeAmount)-BigInt(channel.totalClaimed);}

  // Channels worth claiming now.
  async due(channels,now=Date.now()) {
    const due=[];
    for(const c of channels) {
      const unclaimed=this.unclaimed(c);
      if(unclaimed<=0n)continue;
      let withdrawing=Number(c.withdrawRequestedAt??0)>0;
      if(!withdrawing&&this.contract) {
        try {withdrawing=Number((await this.contract.pendingWithdrawals(c.channelId)).initiatedAt)>0;}
        catch(error) {logError('X402_WITHDRAWAL_READ_FAILED',{channelId:c.channelId,error:error.message});}
      }
      if(unclaimed>=this.minAtomic||now-(c.lastRequestTimestamp??0)>=this.idleMs||withdrawing)due.push(c);
    }
    return due;
  }

  // Raises a channel's recorded balance to the chain's when a deposit was
  // recorded short (the facilitator read the channel before the deposit
  // landed): vouchers above the recorded balance are refused until then.
  // Never lowers it; refunds and withdrawals update the record themselves.
  async syncBalances(channels) {
    if(!this.contract)return channels;
    const out=[];
    for(const c of channels) {
      try {
        const {balance}=await this.contract.channels(c.channelId);
        if(BigInt(balance)>BigInt(c.balance??'0')) {
          const {channel}=await this.storage.updateChannel(c.channelId,current=>
            current&&BigInt(balance)>BigInt(current.balance??'0')?{...current,balance:balance.toString()}:current);
          logError('X402_BALANCE_RAISED',{channelId:c.channelId,from:c.balance,to:balance.toString()});
          out.push(channel??c);continue;
        }
      } catch(error) {logError('X402_BALANCE_READ_FAILED',{channelId:c.channelId,error:error.message});}
      out.push(c);
    }
    return out;
  }

  async tick() {
    const due=await this.due(await this.syncBalances(await this.storage.list()));
    const claims=[];
    if(due.length) {
      const amount=due.reduce((sum,c)=>sum+this.unclaimed(c),0n);
      for(const claim of await this.manager.claim({selectClaimChannels:()=>due})) {
        claims.push(claim);
        await this.repository.recordSettlement({kind:'claim',transaction:claim.transaction,vouchers:claim.vouchers,amountAtomic:amount,
          detail:{channels:due.map(c=>c.channelId)}});
      }
    }
    let settle=null;
    if(claims.length||await this.repository.hasUnsettledClaims()) {
      settle=await this.manager.settle();
      await this.repository.recordSettlement({kind:'settle',transaction:settle.transaction});
    }
    return {claims,settle};
  }
}
