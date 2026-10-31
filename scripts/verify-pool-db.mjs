import assert from 'node:assert/strict';
import {createIsolatedGatewayDatabase} from './lib/isolated-gateway-db.mjs';
import {PgApiKeyStore} from '../src/x402/api-keys.js';
import {PgPoolStore} from '../src/pool/store.js';
import {PoolBilling} from '../src/pool/billing.js';
import {PoolWorker} from '../src/workers/pool-worker.js';
import {PoolTxSigner} from '../src/signing/pool-tx-signer.js';
import {settleCalldata,usageRootOf} from '../src/pool/contract.js';
import {FakePoolChain} from '../test/helpers/fake-pool-chain.js';

// The prepaid pool ledger on a fresh database: the migration, every role's
// grants, holds and charges under the account lock with many requests at
// once, charges bounded by the pool, batch planning by the collector role,
// calldata rebuilt by the signer role from the same rows, the signer's
// journal kept from everyone else, and lost-request recovery.
const db=await createIsolatedGatewayDatabase();
const payer='0x'+'11'.repeat(20);
const USDC=1_000_000n;
try {
  const api=db.pools.api,settler=db.pools.settler;
  const {pool:signer}=await db.createRuntimeRole('signer');
  await db.admin.query(`grant usage on schema private,settlement_signing to ${(await signer.query('select current_user u')).rows[0].u};`);
  const signerRole=(await signer.query('select current_user u')).rows[0].u;
  await db.admin.query(`grant select on private.x402_channels,private.pool_accounts,private.pool_batches,private.pool_ops to "${signerRole}";
    grant select,insert,update on settlement_signing.transactions to "${signerRole}";`);

  // A key without a channel: the pool pays.
  const keyStore=new PgApiKeyStore(api);
  const key=await keyStore.insert({payer,name:'k',prefix:'r3_live_abcdefgh',token_hash:Buffer.alloc(32,1),authorizer:null,encrypted_authorizer:null,salt:null,channel_id:null});
  assert.equal(key.channel_id,null);
  const limited=await keyStore.setLimits(key.id,{daily:2n*USDC,total:null});
  assert.equal(limited.daily_limit_atomic,'2000000');
  await keyStore.setLimits(key.id,{daily:null,total:null});

  const store=new PgPoolStore(api);
  await store.ensureAccount(payer);
  await store.saveSnapshot(payer,{pool_balance_atomic:5n*USDC,withdrawal_atomic:0n,refill_target_atomic:5n*USDC,daily_limit_atomic:20n*USDC,
    daily_remaining_atomic:20n*USDC,wallet_balance_atomic:40n*USDC,allowance_atomic:100n*USDC,snapshot_block:1,snapshot_at:new Date()});
  const billing=new PoolBilling({store,chain:null,config:{POOL_REFILL_WAIT_MS:0,POOL_SNAPSHOT_TTL_SECONDS:600},maxConcurrency:128});
  const row={...key,daily_limit_atomic:null,total_limit_atomic:null};

  // 60 requests at once, 0.1 USDC each, against 5 USDC: exactly 50 fit.
  const opened=await Promise.allSettled(Array.from({length:60},()=>billing.open({key:row,ceilingAtomic:100_000n,request:{protocol:'chat',max_charge_usdc_nano:100_000_000n}})));
  const ids=opened.filter(o=>o.status==='fulfilled').map(o=>o.value);
  assert.equal(ids.length,50);
  assert.ok(opened.filter(o=>o.status==='rejected').every(o=>o.reason.code==='INSUFFICIENT_BALANCE'));
  let account=await store.account(payer);
  assert.equal(account.held_atomic,5n*USDC);assert.equal(account.running,50);

  // Each ends costing 0.12 USDC, above its hold: charged until the pool is spent, exactly.
  const charged=await Promise.all(ids.map(id=>billing.close(payer,id,{atomic:120_000n,fields:got=>({actual_charge_usdc_nano:got*1000n,charged_from:'usage'})})));
  assert.equal(charged.reduce((s,v)=>s+v,0n),5n*USDC);
  account=await store.account(payer);
  assert.equal(account.unsettled_atomic,5n*USDC);assert.equal(account.held_atomic,0n);assert.equal(account.running,0);
  assert.equal((await store.keyTotals(payer,new Date(0))).get(key.id).total,5n*USDC);
  assert.equal((await store.requestsForKey(key.id)).length,50);
  // The key's own dashboard reads: paging, and the day and model aggregates.
  const page=await store.requestsForKey(key.id,10);
  const rest=await store.requestsForKey(key.id,100,page[9].created_at);
  assert.equal(page.length,10);assert.equal(rest.length,40);assert.ok(!rest.some(r=>page.some(p=>p.id===r.id)));
  const usage=await store.keyUsage(key.id,new Date(Date.now()-86_400_000));
  assert.equal(usage.daily.length,1);assert.equal(usage.daily[0].requests,50);assert.equal(usage.daily[0].charged_atomic,String(5n*USDC));
  assert.equal(usage.models.length,1);assert.equal(usage.models[0].model,null);assert.equal(usage.models[0].input_tokens,'0');

  // The collector plans a debit of the charges (and a refill: the pool is spent).
  const chain=new FakePoolChain();
  chain.snapshot=async()=>({pool_balance_atomic:5n*USDC,withdrawal_atomic:0n,withdrawable_at:null,refill_target_atomic:5n*USDC,daily_limit_atomic:20n*USDC,
    daily_remaining_atomic:20n*USDC,wallet_balance_atomic:40n*USDC,allowance_atomic:100n*USDC,snapshot_block:2,snapshot_at:new Date()});
  const sent=[];
  const worker=new PoolWorker({store:new PgPoolStore(settler),chain,config:{POOL_SETTLE_MIN_USDC:'1'},sender:{async submit(body){sent.push(body);return '0x'+'aa'.repeat(32);}}});
  await worker.collect();
  const [batch]=(await db.admin.query("select * from private.pool_batches where payer=$1",[payer])).rows;
  assert.equal(batch.state,'submitted');assert.equal(batch.debit_atomic,String(5n*USDC));assert.equal(batch.refill_atomic,String(5n*USDC));
  const covered=(await db.admin.query('select id from private.pool_requests where batch_id=$1',[batch.id])).rows.map(r=>r.id);
  // 41 charges of 0.12 and one of 0.08 spent the 5 USDC; the eight charged nothing have nothing to debit.
  assert.equal(covered.length,42);assert.equal(batch.usage_root,usageRootOf(covered));
  assert.deepEqual(sent,[{signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${batch.id}`}]);
  // One open batch per wallet.
  await assert.rejects(settler.query(`insert into private.pool_batches(payer,batch_key,debit_atomic,refill_atomic,usage_root) values($1,$2,0,1,$3)`,
    [payer,'0x'+'bb'.repeat(32),'0x'+'cc'.repeat(32)]),{code:'23505'});

  // The signer rebuilds exactly that call from its own read of the row.
  const txSigner=new PoolTxSigner({pool:signer,provider:null,wallet:null,policy:{chainId:143,poolAddress:chain.poolAddress,usdcAddress:chain.usdcAddress,maxDebitAtomic:1000n*USDC}});
  const client=await signer.connect();
  try {
    const call=await txSigner.authorized(client,{signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${batch.id}`});
    assert.equal(call.data,settleCalldata({...batch,debit_atomic:BigInt(batch.debit_atomic),refill_atomic:BigInt(batch.refill_atomic)}));
    assert.equal(call.amount,5n*USDC);
    await assert.rejects(txSigner.authorized(client,{signerRef:'pool-settle-v1',idempotencyKey:'pool-settle:00000000-0000-4000-8000-000000000000'}),{code:'SIGNER_BATCH_NOT_AUTHORIZED'});
    await client.query(`insert into settlement_signing.transactions(idempotency_key,request_digest,chain_id,sender,nonce,raw_transaction,tx_hash,max_cost_wei,amount_usdc_atomic)
      values('pool-settle:x','d',143,'0x1',1,'0x','0x01',1,0)`);
  } finally {client.release();}
  // Only the signer reads its journal; the API cannot write batches.
  await assert.rejects(api.query('select * from settlement_signing.transactions'),{code:'42501'});
  await assert.rejects(settler.query('select * from settlement_signing.transactions'),{code:'42501'});
  await assert.rejects(api.query('select * from private.fail_unsigned_pool_batch($1,$2,$3)',[payer,batch.id,'TEST']),{code:'42501'});
  await assert.rejects(signer.query('select * from private.fail_unsigned_pool_batch($1,$2,$3)',[payer,batch.id,'TEST']),{code:'42501'});
  await assert.rejects(api.query(`update private.pool_batches set state='confirmed'`),{code:'42501'});
  await assert.rejects(signer.query(`update private.pool_batches set state='confirmed'`),{code:'42501'});

  // Signed calls: one open op of a kind per wallet.
  await store.insertOp({payer,kind:'permit',payload:{value:'1'}});
  await assert.rejects(store.insertOp({payer,kind:'permit',payload:{value:'2'}}),{code:'23505'});
  assert.equal((await store.openOps(payer)).length,1);
  await store.insertOp({payer:null,kind:'sweep'});

  // A request a crashed API left running is charged its hold, bounded by the pool.
  await db.admin.query('update private.pool_accounts set unsettled_atomic=0 where payer=$1',[payer]);
  const lost=await billing.open({key:row,ceilingAtomic:300_000n,request:{protocol:'chat'}});
  await db.admin.query("update private.pool_requests set started_at=now()-interval '1 hour' where id=$1",[lost]);
  const {rows:[{n}]}=await db.pools.reconciler.query('select private.recover_lost_pool_requests(now()-interval \'10 minutes\') n');
  assert.equal(n,1);
  const recovered=(await db.admin.query('select status,charged_atomic,charged_from from private.pool_requests where id=$1',[lost])).rows[0];
  assert.deepEqual(recovered,{status:'completed',charged_atomic:'300000',charged_from:'ceiling'});
  account=await store.account(payer);
  assert.equal(account.held_atomic,0n);assert.equal(account.running,0);assert.equal(account.unsettled_atomic,300_000n);
  // An API that dies after a key limit was lowered must not evade the cap.
  const capped=await keyStore.insert({payer,name:'recover-cap',prefix:'r3_live_recover1',token_hash:Buffer.alloc(32,2),authorizer:null,encrypted_authorizer:null,salt:null,channel_id:null});
  const cappedId=await billing.open({key:capped,ceilingAtomic:300000n,request:{protocol:'chat'}});
  await keyStore.setLimits(capped.id,{daily:100000n,total:100000n});
  await db.admin.query("update private.pool_requests set started_at=now()-interval '1 hour' where id=$1",[cappedId]);
  await db.pools.reconciler.query('select private.recover_lost_pool_requests(now()-interval \'10 minutes\')');
  const cappedResult=(await db.admin.query('select charged_atomic,status from private.pool_requests where id=$1',[cappedId])).rows[0];
  assert.deepEqual(cappedResult,{charged_atomic:'100000',status:'completed'});
  account=await store.account(payer);assert.equal(account.running,0);assert.equal(account.held_atomic,0n);
  console.log(JSON.stringify({ok:true,migrations:db.migrationCount}));
} finally {await db.close();}
