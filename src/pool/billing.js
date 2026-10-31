import {getAddress} from 'ethers';
import {AppError} from '../lib/errors.js';
import {usdcAtomic} from '../x402/service.js';
import {OP_PRIMARY_TYPE,PERMIT_TYPES,POOL_TYPES} from './contract.js';

// Billing from a wallet's prepaid pool. Every key of a wallet shares the pool.
//
// What a request may hold is what the pool can still pay today:
//   room      = min(pool balance, today's remaining debit limit) − charged but not yet debited
//   available = room − requested withdrawal − holds of running requests
// A request whose hold does not fit waits briefly for a refill when the
// wallet's allowance could cover it. When it ends it is charged its actual
// cost, up to `room` (the hold is an estimate); what does not fit is unbilled.
const ZERO=0n;
const max0=v=>v>ZERO?v:ZERO;
const min=(a,b)=>a<b?a:b;
export const room=a=>max0(min(a.pool_balance_atomic,a.daily_remaining_atomic)-a.unsettled_atomic);
export const available=a=>max0(room(a)-a.withdrawal_atomic-a.held_atomic);
const startOfUtcDay=(now=new Date())=>new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));
export const usdc=value=>value==null?null:usdcAtomic(String(value));

// A refill could make room for `ceiling`: no withdrawal, refills on, and the
// wallet's balance and allowance reach far enough. The same settlement first
// debits what is owed (as far as the pool and today's limit allow), then
// refills up to the target.
export function refillCouldCover(a,ceiling) {
  if(a.withdrawal_atomic>ZERO||a.refill_target_atomic===ZERO)return false;
  const pullable=min(BigInt(a.wallet_balance_atomic),BigInt(a.allowance_atomic));
  if(pullable===ZERO)return false;
  const debit=min(a.unsettled_atomic,min(a.pool_balance_atomic,a.daily_remaining_atomic));
  const balanceAfter=min(a.refill_target_atomic,a.pool_balance_atomic-debit+pullable);
  return min(balanceAfter,a.daily_remaining_atomic-debit)-(a.unsettled_atomic-debit)-a.held_atomic>=ceiling;
}

export class PoolBilling {
  constructor({store,chain,config,maxConcurrency=128,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date(),logger=console}) {
    Object.assign(this,{store,chain,config,maxConcurrency,sleep,now,logger});
    this.snapshotTtlMs=(config.POOL_SNAPSHOT_TTL_SECONDS??60)*1000;
    this.refillWaitMs=config.POOL_REFILL_WAIT_MS??15000;
    this.permitMinAtomic=usdcAtomic(config.POOL_PERMIT_MIN_BALANCE_USDC??'1');
    this.activationFeeAtomic=usdcAtomic(config.POOL_ACTIVATION_FEE_USDC??'0.05');
  }

  // Re-reads the pool when the snapshot is old, unless a settlement is in
  // flight (its confirmation writes the snapshot and the debit together).
  async fresh(payer) {
    let account=await this.store.account(payer);
    if(!account)return null;
    const age=account.snapshot_at?this.now()-new Date(account.snapshot_at):Infinity;
    if(age>=this.snapshotTtlMs&&this.chain) {
      if(!await this.store.hasOpenBatch(payer)) {
        await this.store.saveSnapshot(payer,await this.chain.snapshot(payer)).catch(error=>
          this.logger.error(JSON.stringify({level:'error',message:'POOL_SNAPSHOT_FAILED',payer,error:error.message})));
        account=await this.store.account(payer);
      }
    }
    return account;
  }

  // Opens a request: holds `ceilingAtomic` against the pool, within the key's
  // concurrency and spending limits. Waits for a refill when one could help.
  async open({key,ceilingAtomic,request}) {
    const payer=key.payer;
    const deadline=this.now().getTime()+this.refillWaitMs;
    let asked=false;
    for(;;) {
      const account=await this.fresh(payer);
      if(!account||(account.refill_target_atomic===ZERO&&account.pool_balance_atomic===ZERO))
        throw new AppError('POOL_NOT_SET_UP','Turn on automatic payment in the console before calling with this key',402);
      const outcome=await this.store.withAccount(payer,async tx=>{
        const a=await tx.account();
        const currentKey=await tx.key(key.id)??key;
        if(currentKey.state==='revoked')return {error:new AppError('API_KEY_INVALID','Invalid or revoked API key',401)};
        const usage=await tx.keyUsage(key.id,startOfUtcDay(this.now()));
        if(usage.running>=this.maxConcurrency)return {error:new AppError('API_KEY_CONCURRENCY_LIMIT',`At most ${this.maxConcurrency} requests at once per API key`,429)};
        if(currentKey.daily_limit_atomic!=null&&usage.today+usage.dayHeld+ceilingAtomic>BigInt(currentKey.daily_limit_atomic))
          return {error:new AppError('API_KEY_DAILY_LIMIT','This API key reached its daily spending limit',402,{limitAtomic:String(currentKey.daily_limit_atomic),spentAtomic:String(usage.today)})};
        if(currentKey.total_limit_atomic!=null&&usage.total+usage.held+ceilingAtomic>BigInt(currentKey.total_limit_atomic))
          return {error:new AppError('API_KEY_TOTAL_LIMIT','This API key reached its spending limit',402,{limitAtomic:String(currentKey.total_limit_atomic),spentAtomic:String(usage.total)})};
        const free=available(a);
        if(free<ceilingAtomic)return {short:true,account:a,free};
        const row=await tx.insertRequest({...request,api_key_id:key.id,ceiling_atomic:ceilingAtomic});
        await tx.update({held_atomic:a.held_atomic+ceilingAtomic,running:a.running+1});
        return {id:row.id};
      });
      if(outcome.error)throw outcome.error;
      if(outcome.id)return outcome.id;
      const a=outcome.account;
      if(a.withdrawal_atomic>ZERO)throw new AppError('POOL_WITHDRAWING','The pool is being withdrawn; calls resume after you cancel the withdrawal or turn automatic payment on again',402);
      if(!refillCouldCover(a,ceilingAtomic)||this.now().getTime()>=deadline)
        throw new AppError('INSUFFICIENT_BALANCE','The pool cannot hold this request; raise the refill target or daily limit, or lower max_tokens',402,
          {requiredAtomic:String(ceilingAtomic),availableAtomic:String(outcome.free),refillTargetAtomic:String(a.refill_target_atomic),dailyRemainingAtomic:String(a.daily_remaining_atomic)});
      if(!asked){await this.store.wantRefill(payer);asked=true;}
      await this.sleep(400);
    }
  }

  // Ends a request: releases its hold and charges `atomic`, bounded by what
  // the pool can pay. `fields(charged)` gives the rest of the record. Returns
  // what was charged.
  async close(payer,requestId,{atomic,fields}) {
    return this.store.withAccount(payer,async tx=>{
      const r=tx&&await tx.request(requestId);
      if(!r||r.status!=='running')return null;
      const a=await tx.account();
      let cap=room(a);
      const key=r.api_key_id?await tx.key(r.api_key_id):null;
      if(key&&(key.daily_limit_atomic!=null||key.total_limit_atomic!=null)) {
        const usage=await tx.keyUsage(key.id,startOfUtcDay(new Date(r.created_at)));
        const otherHeld=max0(usage.held-r.ceiling_atomic);
        if(key.daily_limit_atomic!=null)cap=min(cap,max0(BigInt(key.daily_limit_atomic)-usage.today-max0(usage.dayHeld-r.ceiling_atomic)));
        if(key.total_limit_atomic!=null)cap=min(cap,max0(BigInt(key.total_limit_atomic)-usage.total-otherHeld));
      }
      const charged=atomic==null?ZERO:min(atomic,cap);
      await tx.updateRequest(requestId,{status:'completed',charged_atomic:charged,completed_at:this.now(),...fields(charged)});
      await tx.update({held_atomic:max0(a.held_atomic-r.ceiling_atomic),running:Math.max(a.running-1,0),unsettled_atomic:a.unsettled_atomic+charged});
      return charged;
    });
  }

  async release(payer,requestId,{status,failureCode}) {
    await this.store.withAccount(payer,async tx=>{
      const r=tx&&await tx.request(requestId);
      if(!r||r.status!=='running')return;
      const a=await tx.account();
      await tx.updateRequest(requestId,{status,failure_code:failureCode,completed_at:this.now()});
      await tx.update({held_atomic:max0(a.held_atomic-r.ceiling_atomic),running:Math.max(a.running-1,0)});
    });
  }

  // ----------------------------------------------------------- account view

  async view(payer) {
    const account=await this.fresh(payer)??null;
    const ops=account?await this.store.openOps(payer):[];
    if(!account)return {state:'none',ops:[]};
    const state=account.withdrawal_atomic>ZERO?'withdrawing'
      :ops.some(o=>['permit','configure'].includes(o.kind))?'pending'
      :account.refill_target_atomic>ZERO&&BigInt(account.allowance_atomic)>ZERO?'active'
      :account.pool_balance_atomic>ZERO?'paused':'none';
    const s=v=>v==null?null:String(v);
    return {state,poolBalanceAtomic:s(account.pool_balance_atomic),availableAtomic:s(available(account)),unsettledAtomic:s(account.unsettled_atomic),
      heldAtomic:s(account.held_atomic),running:account.running,refillTargetAtomic:s(account.refill_target_atomic),dailyLimitAtomic:s(account.daily_limit_atomic),
      dailyRemainingAtomic:s(account.daily_remaining_atomic),walletBalanceAtomic:s(account.wallet_balance_atomic),allowanceAtomic:s(account.allowance_atomic),
      withdrawalAtomic:s(account.withdrawal_atomic),withdrawableAt:account.withdrawable_at,snapshotAt:account.snapshot_at,
      ops:ops.map(o=>({id:o.id,kind:o.kind,state:o.state,createdAt:o.created_at}))};
  }

  async terms() {
    const t=await this.chain.terms();
    return {poolAddress:this.chain.poolAddress,usdcAddress:this.chain.usdcAddress,chainId:this.chain.poolDomain().chainId,treasury:t.treasury,
      withdrawalDelaySeconds:t.withdrawalDelaySeconds,maxRefillTargetAtomic:String(t.maxRefillTargetAtomic),
      defaultRefillTargetAtomic:String(usdcAtomic('5')),defaultDailyLimitAtomic:String(usdcAtomic('20')),
      activationFeeAtomic:String(this.activationFeeAtomic),permitMinBalanceAtomic:String(this.permitMinAtomic),
      poolDomain:this.chain.poolDomain(),usdcDomain:await this.chain.usdcDomain()};
  }

  // ------------------------------------------------- calls the wallet signed

  async checkSignature(payer,{domain,types,primaryType,message,signature}) {
    const ok=await this.chain.verifyTypedData({address:payer,domain,types,primaryType,message,signature}).catch(()=>false);
    if(!ok)throw new AppError('POOL_SIGNATURE_INVALID','The wallet signature does not match',422);
  }

  checkDeadline(deadline) {
    const now=Math.floor(this.now().getTime()/1000);
    if(!(Number(deadline)>now+60))throw new AppError('POOL_SIGNATURE_EXPIRED','The signature has expired; sign again',422);
  }

  async queue(payer,kind,payload) {
    try {return await this.store.insertOp({payer,kind,payload});}
    catch(error) {
      if(error.code==='23505')throw new AppError('POOL_OP_PENDING','The previous request of this kind is still being submitted; wait a moment',409);
      throw error;
    }
  }

  // The USDC permit: lets the pool pull up to `value` from the wallet for refills.
  async permit(payer,{value,deadline,signature}) {
    this.checkDeadline(deadline);
    const owner=getAddress(payer);
    // The contract refuses to settle for the Treasury itself (payer == treasury
    // is InvalidSettlement); say so here instead of failing every batch later.
    if(owner===(await this.chain.terms()).treasury)throw new AppError('POOL_PAYER_IS_TREASURY','The Treasury wallet cannot pay into its own pool; use another wallet',422);
    const nonces=await this.chain.nonces(owner);
    const message={owner,spender:this.chain.poolAddress,value:BigInt(value),nonce:nonces.usdc,deadline:BigInt(deadline)};
    await this.checkSignature(owner,{domain:await this.chain.usdcDomain(),types:PERMIT_TYPES,primaryType:'Permit',message,signature});
    if(BigInt(value)>0n&&BigInt(await this.chain.walletBalance(owner))<this.permitMinAtomic)
      throw new AppError('POOL_PERMIT_BALANCE_LOW','Gasless setup needs at least the minimum USDC in the wallet; top it up first',422,{minAtomic:String(this.permitMinAtomic)});
    await this.store.ensureAccount(payer);
    return this.queue(payer,'permit',{value:String(value),deadline:String(deadline),nonce:String(nonces.usdc),signature});
  }

  async signedPoolOp(payer,kind,{nonce,deadline,signature,...fields}) {
    this.checkDeadline(deadline);
    const owner=getAddress(payer);
    const message={owner,...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,BigInt(v)])),nonce:BigInt(nonce),deadline:BigInt(deadline)};
    const primaryType=OP_PRIMARY_TYPE[kind];
    await this.checkSignature(owner,{domain:this.chain.poolDomain(),types:{[primaryType]:POOL_TYPES[primaryType]},primaryType,message,signature});
    await this.store.ensureAccount(payer);
    return this.queue(payer,kind,{...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,String(v)])),nonce:String(nonce),deadline:String(deadline),signature});
  }

  async configure(payer,{refillTarget,dailyLimit,nonce,deadline,signature}) {
    const t=await this.chain.terms();
    if(BigInt(refillTarget)>t.maxRefillTargetAtomic||BigInt(dailyLimit)<=0n)throw new AppError('POOL_LIMITS_INVALID','The refill target or daily limit is out of range',422);
    return this.signedPoolOp(payer,'configure',{refillTarget,dailyLimit,nonce,deadline,signature});
  }
  requestWithdrawal(payer,input){return this.signedPoolOp(payer,'request_withdrawal',input);}
  cancelWithdrawal(payer,input){return this.signedPoolOp(payer,'cancel_withdrawal',input);}
}
