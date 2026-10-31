import {createHash} from 'node:crypto';
import {Contract,getAddress,keccak256} from 'ethers';
import {opCall,poolInterface,settleCalldata} from '../pool/contract.js';
import {signerError as fail} from './settlement-signer.js';

// Transactions the Settler sends for the prepaid pool. The collector names a
// planned batch or a queued op by id; the signer rebuilds the calldata from
// that database row itself, so nothing else chooses what it signs:
//   pool-settle-v1  settle(batch): a debit of recorded charges and/or a refill
//   pool-op-v1      the wallet's signed permit / limits / withdrawal request or
//                   cancellation, executing a matured withdrawal, or a sweep
// None can move a wallet's money to anyone but that wallet's pool and the
// fixed Treasury. Nonce and signed bytes are journaled before the first
// broadcast, so a restart re-sends the same transaction; gas has daily budgets.
const hash=value=>createHash('sha256').update(value).digest('hex');
const SIGNED_OPS=new Set(['permit','configure','request_withdrawal','cancel_withdrawal']);

// A revert while estimating gas is the contract refusing this call on the
// current chain state: resending the same bytes cannot succeed, so the
// caller gets a code of its own and the contract's error name, where the
// pool declares one. Anything else (RPC down, timeout) stays retryable.
export function simulationError(error) {
  if(error?.code!=='CALL_EXCEPTION'&&!/execution reverted/i.test(String(error?.message??'')))return error;
  const data=typeof error.data==='string'?error.data:typeof error.info?.error?.data==='string'?error.info.error.data:null;
  let reason=error.reason??null;
  if(!reason&&data&&data!=='0x'){try{reason=poolInterface.parseError(data)?.name??null;}catch{reason=null;}}
  if(!reason&&data)reason=`selector ${data.slice(0,10)}`;
  return Object.assign(fail('SIGNER_SIMULATION_REVERTED',409),{reason:reason??'unknown'});
}

export class PoolTxSigner {
  constructor({pool,provider,wallet,policy}) {Object.assign(this,{pool,provider,wallet,policy});}

  async verifyChain() {
    const p=this.policy,provider=this.provider;
    if(Number(await provider.send('eth_chainId',[]))!==p.chainId)throw fail('SIGNER_CHAIN_MISMATCH',503);
    if(keccak256(await provider.getCode(p.poolAddress)).toLowerCase()!==p.runtimeCodeHash.toLowerCase())throw fail('SIGNER_POOL_CODE_MISMATCH',503);
    const contract=new Contract(p.poolAddress,poolInterface,provider);
    const [treasury,usdc,role]=await Promise.all([contract.treasury(),contract.usdc(),contract.SETTLER_ROLE()]);
    if(getAddress(treasury)!==getAddress(p.treasuryAddress)||getAddress(usdc)!==getAddress(p.usdcAddress)
      ||!await contract.hasRole(role,this.wallet.address))throw fail('SIGNER_POOL_POLICY_MISMATCH',503);
  }

  // The call a request names, checked against the database: {to,data,amount,budget}.
  async authorized(client,body) {
    const p=this.policy;
    const id=String(body.idempotencyKey??'').replace(/^pool-(settle|op):/,'');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw fail('SIGNER_REQUEST_NOT_ALLOWED');
    if(body.signerRef==='pool-settle-v1'&&body.idempotencyKey===`pool-settle:${id}`) {
      const {rows:[b]}=await client.query('select * from private.pool_batches where id=$1',[id]);
      if(!b||!['planned','submitted'].includes(b.state))throw fail('SIGNER_BATCH_NOT_AUTHORIZED',409);
      const debit=BigInt(b.debit_atomic);
      if(debit>p.maxDebitAtomic)throw fail('SIGNER_BATCH_LIMIT');
      return {to:p.poolAddress,data:settleCalldata(b),amount:debit,budget:'settle'};
    }
    if(body.signerRef==='pool-op-v1'&&body.idempotencyKey===`pool-op:${id}`) {
      const {rows:[op]}=await client.query('select * from private.pool_ops where id=$1',[id]);
      if(!op||!['queued','submitted'].includes(op.state))throw fail('SIGNER_OP_NOT_AUTHORIZED',409);
      if(SIGNED_OPS.has(op.kind)&&!(Number(op.payload?.deadline)>Math.floor(Date.now()/1000)))throw fail('SIGNER_OP_EXPIRED',409);
      const call=opCall(op,{poolAddress:p.poolAddress,usdcAddress:p.usdcAddress});
      return {...call,amount:0n,budget:op.kind==='permit'?'permit':'settle'};
    }
    throw fail('SIGNER_REQUEST_NOT_ALLOWED');
  }

  async signAndBroadcast(body) {
    const p=this.policy,sender=this.wallet.address.toLowerCase();
    const client=await this.pool.connect();let journal;
    try {
      await client.query('begin');
      // Cross-process lock; nonce and signed bytes commit together before the
      // first broadcast. No private key in this database.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`settlement-signer:${p.chainId}:${sender}`]);
      if(body.signerRef==='pool-settle-v1') {
        const id=String(body.idempotencyKey??'').replace(/^pool-settle:/,'');
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`pool-batch:${id}`]);
      }
      const call=await this.authorized(client,body);
      // Permit relays are marked so their own daily gas slice can be summed.
      const digest=`${call.budget==='permit'?'permit:':''}${hash(JSON.stringify([p.chainId,call.to.toLowerCase(),call.data.toLowerCase(),body.idempotencyKey]))}`;
      journal=(await client.query('select * from settlement_signing.transactions where idempotency_key=$1',[body.idempotencyKey])).rows[0];
      if(journal) {
        if(journal.request_digest!==digest)throw fail('SIGNER_IDEMPOTENCY_CONFLICT',409);
      } else {
        await this.verifyChain();
        const tx={from:this.wallet.address,to:call.to,data:call.data,value:0n};
        const [estimate,fees,networkNonce,balance]=await Promise.all([this.provider.estimateGas(tx).catch(error=>{throw simulationError(error);}),this.provider.getFeeData(),
          this.provider.getTransactionCount(this.wallet.address,'pending'),this.provider.getBalance(this.wallet.address)]);
        // Monad charges the whole gas limit, so the margin over the estimate stays small.
        const gasLimit=estimate*11n/10n;
        const maxPriorityFeePerGas=fees.maxPriorityFeePerGas??0n,maxFeePerGas=fees.maxFeePerGas??fees.gasPrice;
        if(!maxFeePerGas||gasLimit>p.maxGas||maxFeePerGas>p.maxFeePerGas)throw fail('SIGNER_GAS_LIMIT',503);
        const maxCost=gasLimit*maxFeePerGas;
        if(maxCost>p.maxTransactionCostWei||balance<maxCost)throw fail('SIGNER_GAS_BUDGET_OR_BALANCE',503);
        const today=`created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`;
        const spent=(await client.query(`select coalesce(sum(max_cost_wei),0) cost,coalesce(sum(amount_usdc_atomic),0) amount,
            coalesce(sum(max_cost_wei) filter(where request_digest like 'permit:%'),0) permit
          from settlement_signing.transactions where chain_id=$1 and sender=$2 and ${today}`,[p.chainId,sender])).rows[0];
        if(BigInt(spent.cost)+maxCost>p.dailyCostWei||BigInt(spent.amount)+call.amount>p.dailyUsdcAtomic)throw fail('SIGNER_DAILY_LIMIT',503);
        // Permit relays have their own slice, so new wallets cannot starve settlements.
        if(call.budget==='permit'&&BigInt(spent.permit)+maxCost>p.permitDailyCostWei)throw fail('SIGNER_PERMIT_DAILY_LIMIT',503);
        const last=(await client.query('select max(nonce) nonce from settlement_signing.transactions where chain_id=$1 and sender=$2',[p.chainId,sender])).rows[0];
        const nonce=Math.max(networkNonce,last.nonce==null?0:Number(last.nonce)+1);
        const raw=await this.wallet.signTransaction({type:2,chainId:p.chainId,nonce,to:call.to,data:call.data,value:0n,gasLimit,maxFeePerGas,maxPriorityFeePerGas});
        journal=(await client.query(`insert into settlement_signing.transactions(idempotency_key,request_digest,chain_id,sender,nonce,raw_transaction,tx_hash,max_cost_wei,amount_usdc_atomic)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,[body.idempotencyKey,digest,p.chainId,sender,nonce,raw,
          keccak256(raw),maxCost.toString(),call.amount.toString()])).rows[0];
      }
      await client.query('commit');
    } catch(error) {await client.query('rollback').catch(()=>{});throw error;}
    finally {client.release();}
    const receipt=await this.provider.getTransactionReceipt(journal.tx_hash);
    if(!receipt) {
      // A recovered transaction may predate a Treasury or role change: recheck first.
      await this.verifyChain();
      try {await this.provider.broadcastTransaction(journal.raw_transaction);}
      catch {
        const known=await this.provider.getTransaction(journal.tx_hash);
        if(!known&&!await this.provider.getTransactionReceipt(journal.tx_hash))throw fail('SIGNER_BROADCAST_UNCERTAIN',503);
      }
    }
    await this.pool.query('update settlement_signing.transactions set broadcast_at=coalesce(broadcast_at,now()) where idempotency_key=$1',[body.idempotencyKey]);
    return {txHash:journal.tx_hash};
  }
}
