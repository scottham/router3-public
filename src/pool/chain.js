import {Contract,JsonRpcProvider,getAddress} from 'ethers';
import {createPublicClient,http} from 'viem';
import {CHAIN,CHAIN_ID,USDC_ADDRESS} from '../chain.js';
import {POOL_DOMAIN,poolInterface,usdcInterface} from './contract.js';

// Reads the pool and the wallet's USDC on Monad, and checks the wallet's
// typed-data signatures (EOA or ERC-1271 smart wallets) before they are queued.
export class PoolChain {
  constructor({rpcUrl,poolAddress,usdcAddress=USDC_ADDRESS,provider=null,client=null}) {
    this.poolAddress=getAddress(poolAddress);this.usdcAddress=getAddress(usdcAddress);
    this.provider=provider??new JsonRpcProvider(rpcUrl,CHAIN_ID,{staticNetwork:true});
    this.client=client??createPublicClient({chain:CHAIN,transport:http(rpcUrl)});
    this.pool=new Contract(this.poolAddress,poolInterface,this.provider);
    this.usdc=new Contract(this.usdcAddress,usdcInterface,this.provider);
  }

  poolDomain(){return {...POOL_DOMAIN,chainId:CHAIN_ID,verifyingContract:this.poolAddress};}
  async usdcDomain() {
    this.usdcDomainCache??=Promise.all([this.usdc.name(),this.usdc.version()]).then(([name,version])=>({name,version,chainId:CHAIN_ID,verifyingContract:this.usdcAddress}));
    return this.usdcDomainCache;
  }

  async terms() {
    this.termsCache??=(async()=>{
      const [treasury,withdrawalDelay,maxDebit,maxRefillTarget,defaultRefillTarget,defaultDailyLimit]=await Promise.all([
        this.pool.treasury(),this.pool.withdrawalDelay(),this.pool.maxDebit(),this.pool.maxRefillTarget(),this.pool.defaultRefillTarget(),this.pool.defaultDailyLimit()]);
      return {treasury:getAddress(treasury),withdrawalDelaySeconds:Number(withdrawalDelay),maxDebitAtomic:maxDebit,maxRefillTargetAtomic:maxRefillTarget,
        defaultRefillTargetAtomic:defaultRefillTarget,defaultDailyLimitAtomic:defaultDailyLimit};
    })().catch(error=>{this.termsCache=null;throw error;});
    return this.termsCache;
  }

  // The pool account and the wallet's balance and allowance at one block.
  async snapshot(payer) {
    const block=await this.provider.getBlockNumber();
    const owner=getAddress(payer),tag={blockTag:block};
    const [account,balance,allowance]=await Promise.all([this.pool.accountOf(owner,tag),this.usdc.balanceOf(owner,tag),this.usdc.allowance(owner,this.poolAddress,tag)]);
    return {pool_balance_atomic:account.balance,withdrawal_atomic:account.withdrawalAmount,
      withdrawable_at:account.withdrawableAt>0n?new Date(Number(account.withdrawableAt)*1000):null,
      refill_target_atomic:account.refillTarget,daily_limit_atomic:account.dailyLimit,daily_remaining_atomic:account.dailyRemaining,
      wallet_balance_atomic:balance,allowance_atomic:allowance,snapshot_block:block,snapshot_at:new Date()};
  }

  async nonces(payer) {
    const owner=getAddress(payer);
    const [pool,usdc]=await Promise.all([this.pool.nonces(owner),this.usdc.nonces(owner)]);
    return {pool,usdc};
  }
  walletBalance(payer){return this.usdc.balanceOf(getAddress(payer));}
  treasuryAccrued(){return this.pool.treasuryAccrued();}
  receipt(hash){return this.provider.getTransactionReceipt(hash);}
  async finalizedBlock(){return Number(BigInt((await this.provider.send('eth_getBlockByNumber',['finalized',false])).number));}

  verifyTypedData({address,domain,types,primaryType,message,signature}) {
    return this.client.verifyTypedData({address:getAddress(address),domain,types,primaryType,message,signature});
  }
  destroy(){this.provider.destroy?.();}
}
