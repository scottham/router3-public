import {usdcAtomic} from '../x402/service.js';
import {available,room} from '../pool/billing.js';
import {batchKeyOf,claimKeyOf,usageRootOf,verifyOpReceipt,verifySettleReceipt} from '../pool/contract.js';
import {sleep} from '../lib/sleep.js';

// Moves prepaid-pool money on-chain. Each tick:
//  1. relays the calls wallets signed (permit, limits, withdrawal requests),
//     and the gateway's own (a matured withdrawal, a sweep to the Treasury);
//  2. confirms submitted settlements against the pool's events, writing the
//     debit and a fresh snapshot together;
//  3. settles wallets that need it: a refill when what is available fell
//     below a share of the refill target or a request is waiting for one (any
//     owed usage rides along), or a debit once enough usage is owed, it has
//     waited long enough, or the wallet is withdrawing. Low-volume wallets
//     cost almost nothing.
const log=(message,extra={})=>console.error(JSON.stringify({level:'error',message,...extra}));
const ZERO=0n;
const min=(a,b)=>a<b?a:b;

// Asks the signer to send a batch or an op it rebuilds from the database.
export class RemotePoolSender {
  constructor({url,token,fetchImpl=fetch}){Object.assign(this,{url,token,fetchImpl});}
  async submit(body) {
    const response=await this.fetchImpl(this.url,{method:'POST',signal:AbortSignal.timeout(35000),
      headers:{'content-type':'application/json',authorization:`Bearer ${this.token}`},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||typeof result.txHash!=='string')throw Object.assign(new Error(result.error??'POOL_SUBMIT_FAILED'),{code:result.error??'POOL_SUBMIT_FAILED',reason:result.reason});
    return result.txHash;
  }
}

export class PoolWorker {
  // `providerKeys` (ProviderKeyService) keeps a wallet's OpenRouter key limit
  // equal to its pool daily limit as soon as a `configure` confirms, instead
  // of waiting for the hourly reconcile.
  constructor({store,chain,sender,config,providerKeys=null,sleepImpl=sleep,now=()=>new Date()}) {
    Object.assign(this,{store,chain,sender,config,providerKeys,sleep:sleepImpl,now});
    this.minAtomic=usdcAtomic(config.POOL_SETTLE_MIN_USDC??'1');
    this.maxWaitMs=(config.POOL_SETTLE_MAX_WAIT_SECONDS??604800)*1000;
    this.refillBelowBps=BigInt(config.POOL_REFILL_BELOW_BPS??5000);
    this.sweepAtomic=usdcAtomic(config.POOL_SWEEP_MIN_USDC??'1');
    this.feeAtomic=usdcAtomic(config.POOL_ACTIVATION_FEE_USDC??'0.05');
    this.maxDebitAtomic=usdcAtomic(config.POOL_MAX_DEBIT_USDC??'1000');
    this.addresses={poolAddress:chain.poolAddress,usdcAddress:chain.usdcAddress};
  }

  async run(signal) {
    while(!signal.aborted) {
      await this.tick().catch(error=>log('POOL_TICK_FAILED',{error:error.message}));
      await this.sleep((this.config.POOL_INTERVAL_SECONDS??3)*1000,signal);
    }
  }

  async tick() {
    await this.relayOps();
    await this.confirmOps();
    await this.confirmBatches();
    await this.resubmitPlanned();
    await this.collect();
    await this.maintain();
  }

  // ------------------------------------------------------------------ ops

  async relayOps() {
    for(const op of await this.store.openOps()) {
      if(op.state!=='queued')continue;
      try {
        const txHash=await this.sender.submit({signerRef:'pool-op-v1',idempotencyKey:`pool-op:${op.id}`});
        await this.store.updateOp(op.id,{state:'submitted',tx_hash:txHash,attempts:(op.attempts??0)+1,error_code:null});
      } catch(error) {
        const attempts=(op.attempts??0)+1;
        // Signatures that expired or ops the signer refuses outright end here.
        const final=['SIGNER_OP_EXPIRED','SIGNER_OP_NOT_AUTHORIZED','SIGNER_REQUEST_NOT_ALLOWED','SIGNER_SIMULATION_REVERTED'].includes(error.code)||attempts>=10;
        const code=error.code==='SIGNER_SIMULATION_REVERTED'?`POOL_OP_REVERTED:${error.reason??'unknown'}`.slice(0,120):error.code??'POOL_SUBMIT_FAILED';
        await this.store.updateOp(op.id,{state:final?'failed':'queued',attempts,error_code:code});
        log('POOL_OP_SUBMIT_FAILED',{id:op.id,kind:op.kind,error:code});
      }
    }
  }

  async confirmOps() {
    const open=(await this.store.openOps()).filter(o=>o.state==='submitted');
    if(!open.length)return;
    const finalized=await this.chain.finalizedBlock();
    for(const op of open) {
      const receipt=await this.chain.receipt(op.tx_hash).catch(()=>null);
      if(!receipt||receipt.blockNumber>finalized)continue;
      let ok=false,code=null;
      try {ok=verifyOpReceipt(receipt,op,this.addresses);if(!ok)code='POOL_OP_REVERTED';} catch(error) {code=error.message;}
      await this.store.updateOp(op.id,{state:ok?'confirmed':'failed',error_code:code});
      if(!ok){log('POOL_OP_FAILED',{id:op.id,kind:op.kind,error:code});continue;}
      // The first permit carries the one-time fee for the gas it cost.
      if(op.kind==='permit'&&this.feeAtomic>ZERO)await this.store.insertFee(op.payer,{chargedAtomic:this.feeAtomic,code:'activation_fee'});
      if(op.payer)await this.refresh(op.payer);
      if(op.kind==='configure'&&op.payer&&this.providerKeys) {
        await this.providerKeys.syncPayer(op.payer).catch(error=>log('PROVIDER_KEY_SYNC_FAILED',{payer:op.payer,error:error.message}));
      }
    }
  }

  // --------------------------------------------------------- settlements

  async refresh(payer) {
    await this.store.saveSnapshot(payer,await this.chain.snapshot(payer)).catch(error=>log('POOL_SNAPSHOT_FAILED',{payer,error:error.message}));
  }

  async confirmBatches() {
    const submitted=await this.store.submittedBatches();
    if(!submitted.length)return;
    const finalized=await this.chain.finalizedBlock();
    for(const batch of submitted) {
      const receipt=await this.chain.receipt(batch.tx_hash).catch(()=>null);
      if(!receipt) {
        // Not seen yet: ask the signer again; it re-sends the same signed bytes.
        if(this.now()-new Date(batch.updated_at??batch.created_at)>60000)
          await this.sender.submit({signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${batch.id}`}).catch(()=>{});
        continue;
      }
      if(receipt.blockNumber>finalized)continue;
      let result;
      try {result=verifySettleReceipt(receipt,batch,this.addresses);}
      catch(error) {log('POOL_RECEIPT_INVALID',{batch:batch.id,error:error.message});continue;}
      const snapshot=result.success?await this.chain.snapshot(batch.payer).catch(()=>null):null;
      // Keep both the batch and its receivable until the matching post-debit
      // balance is available. Clearing only the receivable invents credit.
      if(result.success&&(!snapshot||Number(snapshot.snapshot_block)<receipt.blockNumber))continue;
      await this.store.withAccount(batch.payer,async tx=>{
        const current=await tx.batch(batch.id);
        if(!current||current.state!=='submitted'||current.tx_hash!==batch.tx_hash)return;
        const a=await tx.account();
        if(result.success&&a.snapshot_block!=null&&Number(snapshot.snapshot_block)<Number(a.snapshot_block))return;
        if(result.success) {
          await tx.updateBatch(batch.id,{state:'confirmed',refill_result:result.refill});
          await tx.update({unsettled_atomic:a.unsettled_atomic>batch.debit_atomic?a.unsettled_atomic-batch.debit_atomic:ZERO,
            collection_failures:0,...(result.refill?{refill_wanted_at:null}:{}),...(snapshot??{})});
        } else {
          await tx.updateBatch(batch.id,{state:'failed',error_code:'POOL_SETTLE_REVERTED'});
          await tx.detach(batch.id);
          await tx.update({collection_failures:a.collection_failures+1,last_attempt_at:this.now()});
        }
      });
      if(!result.success)log('POOL_SETTLE_REVERTED',{batch:batch.id,payer:batch.payer});
    }
  }

  // A planned batch that could not be sent is retried on the wallet's
  // backoff, and given up after this many consecutive failures: its charges
  // return to the unbatched set and collect() plans afresh.
  static MAX_SEND_FAILURES=8;

  async resubmitPlanned() {
    for(const batch of await this.store.plannedBatches()) {
      const a=await this.store.account(batch.payer);
      if(a?.last_attempt_at&&this.now()-new Date(a.last_attempt_at)<this.backoffMs(a.collection_failures))continue;
      await this.send(batch);
    }
  }

  async send(batch) {
    try {
      const txHash=await this.sender.submit({signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${batch.id}`});
      await this.store.withAccount(batch.payer,async tx=>{
        if((await tx.batch(batch.id))?.state==='planned')await tx.updateBatch(batch.id,{state:'submitted',tx_hash:txHash});
      });
    } catch(error) {
      const code=error.code??'POOL_SUBMIT_FAILED';
      log('POOL_SETTLE_SUBMIT_FAILED',{batch:batch.id,error:code,...(error.reason?{reason:error.reason}:{})});
      await this.store.withAccount(batch.payer,async tx=>{
        if((await tx.batch(batch.id))?.state!=='planned')return;
        const a=await tx.account();
        const failures=a.collection_failures+1;
        await tx.update({collection_failures:failures,last_attempt_at:this.now()});
        // Refused for good (the signer's policy, or the contract itself on
        // simulation), or failing for too long: free its charges for another batch.
        const permanent=['SIGNER_BATCH_NOT_AUTHORIZED','SIGNER_BATCH_LIMIT','SIGNER_REQUEST_NOT_ALLOWED','SIGNER_SIMULATION_REVERTED'].includes(code);
        if(permanent||failures>=PoolWorker.MAX_SEND_FAILURES) {
          const errorCode=code==='SIGNER_SIMULATION_REVERTED'?`POOL_SETTLE_REVERTED:${error.reason??'unknown'}`:permanent?code:`POOL_SETTLE_GAVE_UP:${code}`;
          const ended=await tx.failUnsignedBatch(batch.id,errorCode.slice(0,120));
          log(ended.state==='submitted'?'POOL_BATCH_RECOVERED':'POOL_BATCH_FAILED',{batch:batch.id,payer:batch.payer,error:errorCode});
        }
      });
    }
  }

  backoffMs(failures){return failures?Math.min(2**failures*5000,600000):0;}

  async collect() {
    for(const listed of await this.store.accountsToCollect()) {
      const payer=listed.payer;
      if(listed.last_attempt_at&&this.now()-new Date(listed.last_attempt_at)<this.backoffMs(listed.collection_failures))continue;
      const open=await this.store.withAccount(payer,tx=>tx.openBatch());
      if(open)continue;
      // Plan from current chain state.
      const stale=!listed.snapshot_at||this.now()-new Date(listed.snapshot_at)>=(this.config.POOL_SNAPSHOT_TTL_SECONDS??60)*500;
      if(stale||listed.refill_wanted_at)await this.refresh(payer);
      const oldest=await this.store.oldestUnbatched(payer);
      const batch=await this.store.withAccount(payer,async tx=>{
        const a=await tx.account();
        if(await tx.openBatch())return null;
        // What owed usage the pool can debit now: oldest charges first, within
        // the pool, today's limit and the largest single debit.
        const owed=await tx.unbatched();
        const cap=min(min(a.pool_balance_atomic,a.daily_remaining_atomic),this.maxDebitAtomic);
        let debitable=ZERO;const debitIds=[];
        for(const charge of owed) {
          if(debitable+charge.charged_atomic>cap)break;
          debitable+=charge.charged_atomic;debitIds.push(charge.id);
        }
        // The contract debits first, then refills up to the target, so a pool
        // that is full but owed can be refilled in the same transaction.
        const pullable=min(BigInt(a.wallet_balance_atomic),BigInt(a.allowance_atomic));
        const lowShare=a.refill_target_atomic*this.refillBelowBps/10000n;
        const wantRefill=a.withdrawal_atomic===ZERO&&a.refill_target_atomic>a.pool_balance_atomic-debitable&&pullable>ZERO
          &&(a.refill_wanted_at!=null||available(a)<lowShare);
        const due=a.unsettled_atomic>=this.minAtomic||(oldest&&this.now()-oldest>=this.maxWaitMs)||a.withdrawal_atomic>ZERO||wantRefill;
        const debit=due?debitable:ZERO,ids=due?debitIds:[];
        const refill=wantRefill?a.refill_target_atomic:ZERO;
        if(debit===ZERO&&refill===ZERO) {
          // A wanted refill that cannot happen: stop asking for it.
          if(a.refill_wanted_at&&!wantRefill)await tx.update({refill_wanted_at:null});
          return null;
        }
        const id=crypto.randomUUID();
        const created=await tx.insertBatch({id,batch_key:batchKeyOf(id),claim_key:debit>ZERO?claimKeyOf(id):null,
          debit_atomic:debit,refill_atomic:refill,usage_root:usageRootOf(ids)});
        await tx.attach(created.id,ids);
        await tx.update({last_attempt_at:this.now()});
        return created;
      });
      if(batch)await this.send(batch);
    }
  }

  // Executes matured withdrawals once owed usage is debited, and sweeps the
  // Treasury's accrual.
  async maintain() {
    const open=await this.store.openOps();
    for(const a of await this.store.accountsToCollect()) {
      if(a.withdrawal_atomic===ZERO||!a.withdrawable_at||new Date(a.withdrawable_at)>this.now())continue;
      if(a.unsettled_atomic>ZERO&&room(a)>ZERO)continue;
      if(open.some(o=>o.payer===a.payer&&o.kind==='withdraw'))continue;
      await this.store.insertOp({payer:a.payer,kind:'withdraw'}).catch(()=>{});
    }
    if(!open.some(o=>o.kind==='sweep')) {
      const accrued=await this.chain.treasuryAccrued().catch(()=>ZERO);
      if(accrued>=this.sweepAtomic)await this.store.insertOp({payer:null,kind:'sweep'}).catch(()=>{});
    }
  }
}
