import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryPoolStore} from '../src/pool/store.js';
import {PoolBilling,available} from '../src/pool/billing.js';
import {PoolWorker} from '../src/workers/pool-worker.js';
import {batchKeyOf,claimKeyOf,usageRootOf,settleCalldata} from '../src/pool/contract.js';
import {FakePoolChain} from './helpers/fake-pool-chain.js';

const PAYER='0x00000000000000000000000000000000000000a1',U=1_000_000n;
async function fixture(charges=1) {
  const store=new InMemoryPoolStore(),chain=new FakePoolChain();
  await store.ensureAccount(PAYER);
  Object.assign(chain.account(PAYER),{balance:10n*U,configured:true,refillTarget:10n*U,dailyLimit:20n*U});
  await store.saveSnapshot(PAYER,await chain.snapshot(PAYER));
  const ids=[];
  await store.withAccount(PAYER,async tx=>{
    for(let i=0;i<charges;i++)ids.push((await tx.insertRequest({status:'completed',charged_atomic:U,completed_at:new Date()})).id);
    await tx.update({unsettled_atomic:BigInt(charges)*U});
  });
  const batch=await store.withAccount(PAYER,async tx=>{
    const id=crypto.randomUUID(),b=await tx.insertBatch({id,batch_key:batchKeyOf(id),claim_key:claimKeyOf(id),debit_atomic:U,refill_atomic:0n,usage_root:usageRootOf([ids[0]])});
    await tx.attach(id,[ids[0]]);return b;
  });
  const hash=chain.execute({to:chain.poolAddress,data:settleCalldata(batch)});
  store.signedTransactions.set(batch.id,hash);
  const submitted=()=>store.withAccount(PAYER,tx=>tx.updateBatch(batch.id,{state:'submitted',tx_hash:hash}));
  const worker=(options={})=>new PoolWorker({store,chain,sender:{},config:{},...options});
  return {store,chain,batch,hash,ids,submitted,worker};
}

test('two collectors confirm the same receipt once, preserving other unsettled usage',async()=>{
  const h=await fixture(2);await h.submitted();
  await Promise.all([h.worker().confirmBatches(),h.worker().confirmBatches()]);
  assert.equal((await h.store.account(PAYER)).unsettled_atomic,U);
  assert.equal(h.store.requests.get(h.ids[1]).batch_id,null);
  assert.equal((await h.store.account(PAYER)).pool_balance_atomic,9n*U);
});

test('a missing or pre-receipt snapshot retains the batch and receivable until a valid snapshot arrives',async()=>{
  const h=await fixture();await h.submitted();
  const real=h.chain.snapshot.bind(h.chain),worker=h.worker();
  const before=available(await h.store.account(PAYER));
  h.chain.snapshot=async()=>{throw new Error('RPC temporarily down');};
  await worker.confirmBatches();
  assert.equal(h.store.batches.get(h.batch.id).state,'submitted');
  assert.equal(available(await h.store.account(PAYER)),before);
  const billing=new PoolBilling({store:h.store,chain:h.chain,config:{POOL_REFILL_WAIT_MS:0}});
  await assert.rejects(billing.open({key:{id:'key',payer:PAYER},ceilingAtomic:9_500_000n,request:{protocol:'chat'}}),{code:'INSUFFICIENT_BALANCE'});
  h.chain.snapshot=async()=>({...await real(PAYER),snapshot_block:1});
  await worker.confirmBatches();
  assert.equal(h.store.batches.get(h.batch.id).state,'submitted');
  h.chain.snapshot=real;await worker.confirmBatches();
  assert.equal(h.store.batches.get(h.batch.id).state,'confirmed');
  assert.equal((await h.store.account(PAYER)).unsettled_atomic,0n);
  assert.equal(available(await h.store.account(PAYER)),9n*U);
});

test('a snapshot read concurrently with settlement cannot overwrite an open batch or regress the confirmed block',async()=>{
  const h=await fixture();
  const stale={...await h.store.account(PAYER),snapshot_block:99,pool_balance_atomic:10n*U};
  // Only chain snapshot fields are passed by real readers.
  const snap={pool_balance_atomic:stale.pool_balance_atomic,snapshot_block:stale.snapshot_block,snapshot_at:new Date()};
  assert.equal(await h.store.saveSnapshot(PAYER,snap),false);
  await h.submitted();await h.worker().confirmBatches();
  assert.equal(await h.store.saveSnapshot(PAYER,snap),false);
  assert.equal((await h.store.account(PAYER)).pool_balance_atomic,9n*U);
});

test('the retry limit recovers a signed transaction instead of detaching and billing its usage again',async()=>{
  const h=await fixture();
  await h.store.withAccount(PAYER,tx=>tx.update({collection_failures:7}));
  const worker=h.worker({sender:{async submit(){throw new Error('lost signer response');}}});
  await worker.send(h.batch);
  assert.equal(h.store.batches.get(h.batch.id).state,'submitted');
  assert.equal(h.store.batches.get(h.batch.id).tx_hash,h.hash);
  assert.equal(h.store.requests.get(h.ids[0]).batch_id,h.batch.id);
  await worker.confirmBatches();await worker.collect();
  assert.equal(h.store.batches.size,1);
  assert.equal(h.chain.account(PAYER).balance,9n*U);
});

test('a delayed successful response cannot change a confirmed batch back to submitted',async()=>{
  const h=await fixture();await h.submitted();await h.worker().confirmBatches();
  await h.worker({sender:{async submit(){return h.hash;}}}).send(h.batch);
  assert.equal(h.store.batches.get(h.batch.id).state,'confirmed');
  assert.equal((await h.store.account(PAYER)).unsettled_atomic,0n);
});

test('a request finishing after midnight uses its creation-day key budget, without consuming the next day',async()=>{
  let clock=new Date('2026-10-30T23:59:59Z');
  const key={id:'key',payer:PAYER,daily_limit_atomic:100n,total_limit_atomic:null};
  const store=new InMemoryPoolStore({keyStore:{async get(){return key;}}});
  await store.ensureAccount(PAYER);
  await store.saveSnapshot(PAYER,{pool_balance_atomic:1000n,daily_remaining_atomic:1000n,snapshot_at:clock,snapshot_block:1});
  const billing=new PoolBilling({store,chain:null,config:{},now:()=>clock});
  const first=await billing.open({key,ceilingAtomic:30n,request:{created_at:clock}});
  clock=new Date('2026-10-31T00:00:01Z');
  const second=await billing.open({key,ceilingAtomic:30n,request:{created_at:clock}});
  const fields=()=>({});
  assert.equal(await billing.close(PAYER,second,{atomic:100n,fields}),100n);
  assert.equal(await billing.close(PAYER,first,{atomic:100n,fields}),100n);
  assert.equal((await store.account(PAYER)).unsettled_atomic,200n);
});
