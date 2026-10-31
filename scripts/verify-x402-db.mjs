import assert from 'node:assert/strict';
import {createIsolatedGatewayDatabase} from './lib/isolated-gateway-db.mjs';
import {PgChannelStorage} from '../src/x402/storage.js';
import {X402Repository} from '../src/x402/repository.js';
import {PgApiKeyStore} from '../src/x402/api-keys.js';
import {publishCatalog} from '../src/services/catalog-publish.js';
import {deepseekTestEntries} from '../test/helpers/deepseek-catalog.js';

// The x402 ledger on a fresh database: every migration up to the x402-only
// cut, the channel storage contract the SDK relies on (atomic update,
// unchanged/updated/deleted), role grants, per-payer provider keys, lost
// request recovery and the reporting functions.
const db=await createIsolatedGatewayDatabase();
const id='0x'+'ab'.repeat(32),payer='0x'+'11'.repeat(20);
const channel=(over={})=>({channelId:id,channelConfig:{payer,payerAuthorizer:payer,receiver:'0x'+'22'.repeat(20),receiverAuthorizer:'0x'+'33'.repeat(20),
  token:'0x754704Bc059F8C67012fEd69BC8A327a5aafb603',withdrawDelay:86400,salt:'0x'+'00'.repeat(32)},
  chargedCumulativeAmount:'0',signedMaxClaimable:'0',signature:'0x',balance:'2000000',totalClaimed:'0',withdrawRequestedAt:0,refundNonce:0,
  lastRequestTimestamp:Date.now(),...over});
try {
  const api=db.pools.api,settler=db.pools.settler;
  const storage=new PgChannelStorage(api);
  assert.equal(await storage.get(id),undefined);
  assert.deepEqual(await storage.list(),[]);
  // Create, leave unchanged, update, delete: the statuses the SDK branches on.
  let result=await storage.updateChannel(id.toUpperCase(),current=>{assert.equal(current,undefined);return channel();});
  assert.equal(result.status,'updated');assert.equal(result.channel.channelId,id);
  result=await storage.updateChannel(id,current=>current);
  assert.equal(result.status,'unchanged');assert.equal(result.channel.balance,'2000000');
  result=await storage.updateChannel(id,current=>({...current,chargedCumulativeAmount:'1500',signedMaxClaimable:'2500',signature:'0xaa'}));
  assert.equal(result.status,'updated');
  const row=(await db.admin.query('select * from private.x402_channels where channel_id=$1',[id])).rows[0];
  assert.equal(row.payer,payer);assert.equal(row.charged_cumulative_atomic,'1500');assert.equal(row.signed_max_claimable_atomic,'2500');
  assert.equal(row.balance_atomic,'2000000');assert.equal(row.state.signature,'0xaa');
  assert.deepEqual((await storage.list()).map(c=>c.chargedCumulativeAmount),['1500']);
  // Concurrent updates serialize on the row lock: both increments land.
  await Promise.all([0,1].map(()=>storage.updateChannel(id,current=>({...current,chargedCumulativeAmount:String(BigInt(current.chargedCumulativeAmount)+100n)}))));
  assert.equal((await storage.get(id)).chargedCumulativeAmount,'1700');
  // The collector role updates claims on the same table.
  const settlerStorage=new PgChannelStorage(settler);
  assert.equal((await settlerStorage.updateChannel(id,current=>({...current,totalClaimed:'1700'}))).status,'updated');
  // The request ledger.
  await publishCatalog(db.admin,deepseekTestEntries(),0,{replaceProvider:'deepseek'});
  const model=(await db.admin.query(`select m.id,p.id price,f.id fee from public.model_catalog m join private.model_price_versions p on p.model_id=m.id
    cross join private.call_fee_policies f where m.public_name='deepseek/deepseek-flash' and p.effective_until is null and p.bailian_quote is not null
    order by p.effective_from desc limit 1`)).rows[0];
  const ledger=new X402Repository(api);
  const requestId=await ledger.openRequest({channelId:id,payer,protocol:'chat',modelId:model.id,priceVersionId:model.price,callFeePolicyId:model.fee,
    requestDigest:Buffer.alloc(32,1),maxChargeUsdcNano:123456789n,ceilingAtomic:123457n});
  await ledger.complete(requestId,{actualChargeUsdcNano:10100000n,unbilledOverrunUsdcNano:0n,chargedAtomic:10100n,cumulativeAtomic:1700n,chargedFrom:'usage',
    modelCostUsdcNano:10000000n,serviceFeeUsdcNano:100000n,serviceFeeBps:100,providerCostUsdNano:10000000n,providerRequestId:'p1',usageSource:'direct:deepseek',
    normalizedUsage:{inputTokens:10,outputTokens:9},rawUsageRedacted:{billed_from:'price_table'},settlementTransaction:null});
  await ledger.complete(requestId,{actualChargeUsdcNano:1n,chargedAtomic:1n,chargedFrom:'usage'});
  const stored=(await db.admin.query('select * from private.x402_requests where id=$1',[requestId])).rows[0];
  assert.equal(stored.status,'completed');assert.equal(stored.actual_charge_usdc_nano,'10100000','a completed row is final');
  assert.equal(stored.charged_atomic,'10100');assert.equal(stored.service_fee_bps,100);
  const lost=await ledger.openRequest({channelId:id,payer,protocol:'chat',modelId:model.id,priceVersionId:model.price,maxChargeUsdcNano:5n,ceilingAtomic:1n});
  await ledger.fail(lost,'settlement_failed','invalid_batch_settlement_evm_channel_busy');
  assert.equal((await db.admin.query('select status,failure_code from private.x402_requests where id=$1',[lost])).rows[0].failure_code,'invalid_batch_settlement_evm_channel_busy');
  await ledger.recordSettlement({kind:'claim',transaction:'0x'+'cc'.repeat(32),vouchers:1,amountAtomic:1700n,detail:{channels:[id]}});
  assert.equal(await ledger.hasUnsettledClaims(),true);
  await new X402Repository(settler).recordSettlement({kind:'settle',transaction:'0x'+'dd'.repeat(32)});
  assert.equal(await ledger.hasUnsettledClaims(),false);
  const [listed]=await ledger.channelsForPayers([payer.toUpperCase()]);
  assert.equal(listed.channel_id,id);assert.equal(listed.requests,1);assert.equal(listed.claimed_atomic,'1700');
  assert.equal((await ledger.requestsForChannel(id,[payer])).length,2);
  assert.equal(await ledger.countChannels(payer.toUpperCase()),1);assert.equal(await ledger.countChannels('0x'+'99'.repeat(20)),0);
  // A request whose API process died is closed by the reconciler, uncharged.
  const running=await ledger.openRequest({channelId:id,payer,protocol:'chat',modelId:model.id,priceVersionId:model.price,maxChargeUsdcNano:5n,ceilingAtomic:1n});
  await db.admin.query("update private.x402_requests set started_at=now()-interval '20 minutes' where id=$1",[running]);
  assert.equal((await db.pools.reconciler.query("select private.recover_lost_x402_requests(now()-interval '15 minutes') n")).rows[0].n,1);
  assert.equal((await db.admin.query('select status,failure_code from private.x402_requests where id=$1',[running])).rows[0].failure_code,'REQUEST_LOST');
  await db.pools.reconciler.query('select * from private.cleanup_expired_base_auth_data()');
  // Per-payer provider keys: the API mints, the catalog syncs.
  await api.query(`insert into private.provider_payer_keys(payer,provider,remote_name,remote_hash,state,limit_usd_nano) values($1,'openrouter','router3:test:'||$1,'h1','active',50000000000)`,[payer]);
  await assert.rejects(api.query("insert into private.provider_payer_keys(payer,provider,remote_name,state) values('bad','openrouter','x','active')"),{code:'23514'});
  assert.equal((await db.admin.query("select private.metrics_snapshot() m")).rows[0].m.provider_keys[0].n,1);
  // API keys: the API role writes them; a key's requests carry its id and the
  // running ones are the channel's holds.
  const keyStore=new PgApiKeyStore(api);
  const keyRow=await keyStore.insert({payer,name:'k',prefix:'r3_live_abcdefgh',token_hash:Buffer.alloc(32,9),authorizer:'0x'+'12'.repeat(20),
    encrypted_authorizer:{keyId:'k',nonce:'',authTag:'',ciphertext:''},salt:'0x'+'34'.repeat(32),channel_id:id});
  assert.equal((await keyStore.useToken(Buffer.alloc(32,9))).id,keyRow.id);
  assert.equal((await keyStore.listByPayer(payer)).length,1);
  const held=await ledger.openRequest({channelId:id,payer,protocol:'chat',modelId:model.id,priceVersionId:model.price,maxChargeUsdcNano:5n,ceilingAtomic:700n,apiKeyId:keyRow.id});
  assert.deepEqual(await ledger.runningOnChannel(id),{count:1,ceilingAtomic:700n});
  assert.equal((await ledger.requestsForApiKey(keyRow.id)).length,1);
  await ledger.fail(held,'failed','TEST');
  assert.deepEqual(await ledger.runningOnChannel(id),{count:0,ceilingAtomic:0n});
  await keyStore.revoke(keyRow.id);
  assert.equal(await keyStore.useToken(Buffer.alloc(32,9)),null,'a revoked key no longer authenticates');
  await assert.rejects(api.query('delete from private.api_keys'),{code:'42501'});
  // The prepaid-pool and project generations are gone.
  assert.equal((await db.admin.query("select count(*)::int n from information_schema.tables where table_schema in ('public','private') and (table_name like 'wallet_%' or table_name in ('projects','organizations','model_requests','project_api_keys'))")).rows[0].n,0);
  assert.equal((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname like '%wallet%'")).rows[0].n,0);
  // Reporting folds x402 calls in: the provider balance check counts their cost
  // once they are older than five minutes, and the metrics function reads.
  await db.admin.query("update private.x402_requests set completed_at=now()-interval '10 minutes' where id=$1",[requestId]);
  const balance=(await db.admin.query("select private.record_provider_balance('deepseek',100,'CNY') r")).rows[0].r;
  assert.equal(Number(balance.recorded_cost),0.08,'10,000,000 nano USD at 8 CNY per USD');
  const metrics=(await db.admin.query('select private.metrics_x402() m')).rows[0].m;
  assert.equal(metrics.channels.n,1);assert.equal(metrics.channels.unclaimed_atomic,'0');assert.equal(metrics.ceiling_charges,0);
  assert.deepEqual(metrics.settlements.map(s=>s.kind).sort(),['claim','settle']);
  assert.equal((await db.admin.query('select private.metrics_snapshot() m')).rows[0].m.users,0);
  // Least privilege: only the API writes requests; the reconciler reads.
  await assert.rejects(db.pools.reconciler.query("insert into private.x402_settlements(kind) values('settle')"),{code:'42501'});
  await assert.rejects(api.query('delete from private.x402_requests'),{code:'42501'});
  // A refunded channel disappears; its requests stay.
  assert.equal((await storage.updateChannel(id,()=>undefined)).status,'deleted');
  assert.equal((await storage.updateChannel(id,()=>undefined)).status,'unchanged');
  assert.equal((await db.admin.query('select count(*)::int n from private.x402_requests')).rows[0].n,4);
  console.log(JSON.stringify({ok:true,migrations:db.migrationCount}));
} finally {await db.close();}
