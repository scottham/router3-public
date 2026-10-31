// Disposable local E2E: Docker (postgres:17-bookworm), Foundry and Node 22+.
// Fault injection only drops signer responses or one snapshot read. All money
// lives on a local Anvil chain; business databases and provider accounts are unused.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
const require=createRequire(new URL('../package.json',import.meta.url));
const {Wallet,ContractFactory,JsonRpcProvider,keccak256,parseEther,parseUnits}=require('ethers');
const pg=require('pg');
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const temporary=mkdtempSync(join(tmpdir(),'router3-recovery-e2e-'));
const artifacts=join(temporary,'contracts');
const {createIsolatedGatewayDatabase}=await import(`${ROOT}/scripts/lib/isolated-gateway-db.mjs`);
const {PgPoolStore}=await import(`${ROOT}/src/pool/store.js`);
const {PoolChain}=await import(`${ROOT}/src/pool/chain.js`);
const {PoolBilling}=await import(`${ROOT}/src/pool/billing.js`);
const {PoolWorker,RemotePoolSender}=await import(`${ROOT}/src/workers/pool-worker.js`);
const {PoolTxSigner}=await import(`${ROOT}/src/signing/pool-tx-signer.js`);
const {createSettlementSignerServer}=await import(`${ROOT}/src/signing/settlement-signer.js`);
const {batchKeyOf,claimKeyOf,usageRootOf}=await import(`${ROOT}/src/pool/contract.js`);
const {buildApp}=await import(`${ROOT}/src/app.js`);
const {loadConfig}=await import(`${ROOT}/src/config.js`);
const {FakeChain,FakeFacilitator}=await import(`${ROOT}/test/helpers/x402-fake-facilitator.js`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const U=1_000_000n;
const container=`router3-recheck-${process.pid}-${randomBytes(3).toString('hex')}`;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let db,anvil,provider,server,appHandle,containerStarted=false,basePg;
const originalError=console.error;
console.error=()=>{};
try{
 execFileSync('forge',['build','--root',join(ROOT,'contracts'),'--out',artifacts,'--cache-path',join(temporary,'cache')],{stdio:'pipe'});
 const password=randomBytes(18).toString('hex');
 docker('run','--pull=never','--rm','-d','--name',container,'-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','postgres:17-bookworm');
 containerStarted=true;
 const binding=JSON.parse(docker('inspect','--format','{{json .NetworkSettings.Ports}}',container));
 const pgPort=Number(binding['5432/tcp'][0].HostPort);
 const pgUrl=`postgresql://postgres:${password}@127.0.0.1:${pgPort}/postgres`;
 for(let i=0;i<80;i++){
  const c=new pg.Client({connectionString:pgUrl,connectionTimeoutMillis:300});
  try{await c.connect();basePg=c;break;}catch{await c.end().catch(()=>{});await sleep(100);}
 }
 assert.ok(basePg,'temporary PostgreSQL did not start');
 await basePg.query('create role anon; create role authenticated; create role service_role;');
 process.env.ROUTER3_ISOLATED_PG_URL=pgUrl;
 db=await createIsolatedGatewayDatabase();
 const signerRole=await db.createRuntimeRole('signer');
 await db.admin.query(`grant usage on schema private,settlement_signing to "${signerRole.role}";
  grant select on private.pool_batches,private.pool_ops,private.pool_accounts to "${signerRole.role}";
  grant select,insert,update on settlement_signing.transactions to "${signerRole.role}";`);
 const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
 const rpcPort=reserve.address().port;await new Promise(r=>reserve.close(r));
 const rpcUrl=`http://127.0.0.1:${rpcPort}`;
 anvil=spawn('anvil',['--host','127.0.0.1','--port',String(rpcPort),'--chain-id','143','--silent'],{stdio:'ignore'});
 provider=new JsonRpcProvider(rpcUrl,143,{staticNetwork:true,cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=20;
 for(let i=0;i<100;i++){try{await provider.send('eth_chainId',[]);break;}catch{await sleep(50);}}
 const admin=await provider.getSigner(0),treasury=await provider.getSigner(9),settler=Wallet.createRandom().connect(provider);
 await provider.send('anvil_setBalance',[settler.address,'0x'+parseEther('100').toString(16)]);
 const tokenArtifact=JSON.parse(readFileSync(join(artifacts,'WalletPrepaidPool.t.sol/PoolTestUSDC.json')));
 const poolArtifact=JSON.parse(readFileSync(`${ROOT}/contracts/artifacts/WalletPrepaidPool.json`));
 const token=await new ContractFactory(tokenArtifact.abi,tokenArtifact.bytecode.object,admin).deploy();await token.waitForDeployment();
 const contract=await new ContractFactory(poolArtifact.abi,poolArtifact.bytecode,admin).deploy(await token.getAddress(),await treasury.getAddress(),await admin.getAddress(),settler.address,1000n*U,1000n*U,10n*U,20n*U,1800);
 await contract.waitForDeployment();
 const poolAddress=await contract.getAddress(),tokenAddress=await token.getAddress();
 const chain=new PoolChain({rpcUrl,poolAddress,usdcAddress:tokenAddress,provider});
 const policy={chainId:143,poolAddress,usdcAddress:tokenAddress,treasuryAddress:await treasury.getAddress(),runtimeCodeHash:keccak256(await provider.getCode(poolAddress)),
  maxDebitAtomic:1000n*U,dailyUsdcAtomic:10000n*U,maxGas:2500000n,maxFeePerGas:parseUnits('1000',9),maxTransactionCostWei:parseEther('1'),dailyCostWei:parseEther('100'),permitDailyCostWei:parseEther('10')};
 const signer=new PoolTxSigner({pool:signerRole.pool,provider,wallet:settler,policy});
 const bearer='isolated-review-only-token-1234567890';
 server=createSettlementSignerServer({pool:signerRole.pool,signAndBroadcast:b=>signer.signAndBroadcast(b)},bearer);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const signerUrl=`http://127.0.0.1:${server.address().port}/sign`;
 const sender=new RemotePoolSender({url:signerUrl,token:bearer});
 const store=new PgPoolStore(db.pools.settler);
 let payerNumber=1;
 async function payer(){
  const wallet=await provider.getSigner(payerNumber++),address=(await wallet.getAddress()).toLowerCase();
  await receipt((await token.mint(address,100n*U)).hash);
  await receipt((await token.connect(wallet).approve(poolAddress,10n*U)).hash);
  await receipt((await contract.connect(wallet).deposit(10n*U)).hash);
  await store.ensureAccount(address);await store.saveSnapshot(address,await chain.snapshot(address));
  return address;
 }
 async function planned(address,n=1){
  const ids=[];
  await store.withAccount(address,async tx=>{
   for(let i=0;i<n;i++)ids.push((await tx.insertRequest({kind:'request',status:'completed',charged_atomic:U,charged_from:'usage',completed_at:new Date()})).id);
   await tx.update({unsettled_atomic:BigInt(n)*U});
  });
  return store.withAccount(address,async tx=>{
   const id=crypto.randomUUID();const b=await tx.insertBatch({id,batch_key:batchKeyOf(id),claim_key:claimKeyOf(id),debit_atomic:U,refill_atomic:0n,usage_root:usageRootOf([ids[0]])});
   await tx.attach(id,[ids[0]]);return b;
  });
 }
 async function receipt(hash){for(let i=0;i<100;i++){const r=await provider.getTransactionReceipt(hash);if(r)return r;await sleep(20);}throw new Error('no local receipt');}
 async function finalize(){await provider.send('anvil_mine',['0x40']);}
 async function submit(b){const hash=await sender.submit({signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${b.id}`});assert.equal((await receipt(hash)).status,1);await store.withAccount(b.payer,tx=>tx.updateBatch(b.id,{state:'submitted',tx_hash:hash}));await finalize();return hash;}
 const row=async id=>(await db.admin.query('select * from private.pool_batches where id=$1',[id])).rows[0];
 console.log(`Setup: ${db.migrationCount} migrations, real PostgreSQL, real PoolTxSigner HTTP server, committed contract on local Anvil`);
 // Case 1: remove only successful HTTP responses; signer, journal and chain are real.
 {
  const address=await payer(),batch=await planned(address);let clock=Date.now(),lost=true;
  const lossy=new RemotePoolSender({url:signerUrl,token:bearer,fetchImpl:async(...args)=>{
   const response=await fetch(...args);
   if(lost){assert.equal(response.status,200);await response.arrayBuffer();throw new TypeError('Simulated loss of signer HTTP response');}
   return response;
  }});
  const worker=new PoolWorker({store,chain,sender:lossy,config:{},now:()=>new Date(clock)});
  for(let i=0;i<8;i++){await worker.resubmitPlanned();clock+=700000;}
  assert.equal((await row(batch.id)).state,'submitted');
  assert.equal((await chain.snapshot(address)).pool_balance_atomic,9n*U);
  const oldHash=(await signerRole.pool.query('select tx_hash from settlement_signing.transactions where idempotency_key=$1',[`pool-settle:${batch.id}`])).rows[0].tx_hash;
  assert.equal((await receipt(oldHash)).status,1);
  lost=false;await worker.collect();await finalize();await worker.confirmBatches();
  assert.equal((await chain.snapshot(address)).pool_balance_atomic,9n*U);
  const payments=(await db.admin.query('select charged_atomic,batch_id from private.pool_requests where payer=$1',[address])).rows;
  assert.equal(payments.length,1);assert.equal(payments[0].charged_atomic,String(U));
  assert.equal((await store.account(address)).unsettled_atomic,0n);
  console.log('ok: eight lost signer responses recover the original transaction; 1 USDC usage is debited exactly once');
 }
 // Control: one lost response, then successful recovery, keeps the original claim.
 {
  const address=await payer(),batch=await planned(address);let clock=Date.now(),lost=true;
  const lossy=new RemotePoolSender({url:signerUrl,token:bearer,fetchImpl:async(...args)=>{const response=await fetch(...args);if(lost){await response.arrayBuffer();lost=false;throw new TypeError('one lost response');}return response;}});
  const worker=new PoolWorker({store,chain,sender:lossy,config:{},now:()=>new Date(clock)});
  await worker.resubmitPlanned();clock+=11000;await worker.resubmitPlanned();await finalize();await worker.confirmBatches();
  assert.equal((await chain.snapshot(address)).pool_balance_atomic,9n*U);
  assert.equal((await row(batch.id)).state,'confirmed');
  console.log('1 CONTROL passed: one lost response followed by recovery charges once, not twice');
 }
 // Case 2: explicitly arrange the valid overlap: both SELECT submitted before either COMMIT.
 {
  const address=await payer(),batch=await planned(address,2);await submit(batch);
  let readers=0,release;const gate=new Promise(r=>release=r);
  const makeStore=()=>{const s=new PgPoolStore(db.pools.settler),read=s.submittedBatches.bind(s);s.submittedBatches=async()=>{const batches=(await read()).filter(b=>b.id===batch.id);if(++readers===2)release();await gate;return batches;};return s;};
  const a=new PoolWorker({store:makeStore(),chain,sender,config:{}}),b=new PoolWorker({store:makeStore(),chain,sender,config:{}});
  await Promise.all([a.confirmBatches(),b.confirmBatches()]);
  assert.equal((await store.account(address)).unsettled_atomic,U);
  const outstanding=(await db.admin.query('select sum(charged_atomic)::text n from private.pool_requests where payer=$1 and batch_id is null',[address])).rows[0].n;
  assert.equal(outstanding,String(U));
  console.log('ok: two concurrent collectors confirm once; 1 USDC unbatched usage stays owed');
 }
 {
  const address=await payer(),batch=await planned(address,2);await submit(batch);
  const worker=new PoolWorker({store,chain,sender,config:{}});
  await worker.confirmBatches();await worker.confirmBatches();
  assert.equal((await store.account(address)).unsettled_atomic,U);
  console.log('2 CONTROL passed: a single sequential collector preserves the other 1 USDC charge');
 }
 // Case 3: fail only the account snapshot RPC after a successful finalized receipt.
 {
  const address=await payer(),batch=await planned(address);await submit(batch);
  const faultChain=new Proxy(chain,{get(target,key){if(key==='snapshot')return async()=>{throw new Error('Injected account RPC outage');};const x=target[key];return typeof x==='function'?x.bind(target):x;}});
  const worker=new PoolWorker({store,chain:faultChain,sender,config:{}});await worker.confirmBatches();
  assert.equal((await chain.snapshot(address)).pool_balance_atomic,9n*U);
  assert.equal((await store.account(address)).pool_balance_atomic,10n*U);
  const apiStore=new PgPoolStore(db.pools.api);
  const k=(await db.pools.api.query(`insert into private.api_keys(payer,name,prefix,token_hash) values($1,'snapshot','snapshot',$2) returning *`,[address,randomBytes(32)])).rows[0];
  const billing=new PoolBilling({store:apiStore,chain,config:{POOL_SNAPSHOT_TTL_SECONDS:60}});
  await assert.rejects(billing.open({key:k,ceilingAtomic:9500000n,request:{protocol:'chat'}}),{code:'INSUFFICIENT_BALANCE'});
  assert.equal((await row(batch.id)).state,'submitted');
  await new PoolWorker({store,chain,sender,config:{}}).confirmBatches();
  assert.equal((await row(batch.id)).state,'confirmed');
  assert.equal((await store.account(address)).pool_balance_atomic,9n*U);
  console.log('ok: failed snapshot never releases receivables; excessive hold rejected, later snapshot confirms');
 }
 // Full production app, real key store and HTTP middleware for cases 4/5.
 // Signing and abandonment contend on the same per-batch advisory lock.
 {
  const address=await payer(),batch=await planned(address);
  let entered,release;const signing=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const pausedWallet={address:settler.address,async signTransaction(tx){entered();await gate;return settler.signTransaction(tx);}};
  const pausedSigner=new PoolTxSigner({pool:signerRole.pool,provider,wallet:pausedWallet,policy});
  const sending=pausedSigner.signAndBroadcast({signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${batch.id}`});
  await signing;
  let finished=false;
  const recovery=store.withAccount(address,tx=>tx.failUnsignedBatch(batch.id,'TEST_UNCERTAIN')).then(b=>{finished=true;return b;});
  try{await sleep(30);assert.equal(finished,false,'recovery must wait until signing commits or rolls back');}
  finally{release();}
  const sent=await sending,recovered=await recovery;
  assert.equal(recovered.state,'submitted');assert.equal(recovered.tx_hash,sent.txHash);
  await receipt(sent.txHash);await finalize();
  await new PoolWorker({store,chain,sender,config:{}}).confirmBatches();
  assert.equal((await chain.snapshot(address)).pool_balance_atomic,9n*U);
  console.log('ok: recovery racing with an in-flight signer waits for its journal and preserves the original claim');
 }
 {
  const address=await payer(),batch=await planned(address);
  const failed=await store.withAccount(address,tx=>tx.failUnsignedBatch(batch.id,'TEST_UNSIGNED'));
  assert.equal(failed.state,'failed');
  await assert.rejects(sender.submit({signerRef:'pool-settle-v1',idempotencyKey:`pool-settle:${batch.id}`}),{code:'SIGNER_BATCH_NOT_AUTHORIZED'});
  assert.equal((await chain.snapshot(address)).pool_balance_atomic,10n*U);
  assert.equal((await db.admin.query('select batch_id from private.pool_requests where payer=$1',[address])).rows[0].batch_id,null);
  console.log('ok: an unsigned failed batch releases its usage and a delayed signer cannot send it');
 }
 const apiRole=(await db.pools.api.query('select current_user r')).rows[0].r;
 const databaseName=(await db.admin.query('select current_database() d')).rows[0].d;
 const apiUrl=`postgresql://postgres:${password}@127.0.0.1:${pgPort}/${databaseName}?options=${encodeURIComponent('-c role='+apiRole)}`;
 const cfg=loadConfig({NODE_ENV:'test',PUBLIC_APP_URL:'https://isolated.test',DATABASE_URL_API:apiUrl,AUTH_SESSION_HMAC_SECRET:'isolated-hmac-secret-over-thirty-two-chars',RESPONSE_ENCRYPTION_KEYS:`test:${Buffer.alloc(32,8).toString('base64')}`,
  TREASURY_ADDRESS:await treasury.getAddress(),SETTLER_ADDRESS:settler.address,SETTLER_SIGNER_URL:signerUrl,SETTLER_SIGNER_BEARER_TOKEN:bearer,MONAD_RPC_URL:rpcUrl,POOL_ADDRESS:poolAddress,
  AUTH_ALLOWED_ADDRESSES:await treasury.getAddress(),LOG_LEVEL:'silent',RATE_LIMIT_MAX:'1000'});
 appHandle=await buildApp(cfg,{x402:{facilitator:new FakeFacilitator(new FakeChain())}});
 appHandle.keys.pool.chain.destroy();appHandle.keys.pool.chain=new PoolChain({rpcUrl,poolAddress,usdcAddress:tokenAddress});
 const model=(await db.admin.query(`insert into public.model_catalog(public_name,provider,provider_model,enabled) values('mock/recheck','mock','mock/recheck',true) returning id`)).rows[0];
 await db.admin.query(`insert into private.model_price_versions(model_id,effective_from,customer_input_usdc_nano_per_million,customer_output_usdc_nano_per_million,provider_input_usd_nano_per_million,provider_output_usd_nano_per_million)
  values($1,now()-interval '1 minute',1000000,15000000000,1000000,15000000000)`,[model.id]);
 const address=await payer();
 const existing=await appHandle.keys.create({payer:address,name:'previously-created'});
 const headers={authorization:`Bearer ${existing.token}`};
 const body={model:'mock/recheck',messages:[{role:'user',content:'hello'}],max_tokens:32};
 {
  assert.ok(!cfg.AUTH_ALLOWED_ADDRESSES.includes(address));
  const result=await appHandle.app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:body});
  assert.equal(result.statusCode,403,result.body);
  assert.equal(result.json().error.code,'ADDRESS_NOT_ALLOWED');
  const dashboard=await appHandle.app.inject({url:'/v1/key',headers});assert.equal(dashboard.statusCode,403);
  console.log('ok: full production API rejects existing keys of excluded wallets, including dashboards');
 }
 {
  // Restart with the payer allowed, exercising the same persisted key.
  await appHandle.app.close();appHandle=null;
  // buildApp closes its PoolChain, so use a fresh RPC provider for API reads.
  const apiConfig={...cfg,AUTH_ALLOWED_ADDRESSES:[address]};
  appHandle=await buildApp(apiConfig,{x402:{facilitator:new FakeFacilitator(new FakeChain())}});
  appHandle.keys.pool.chain.destroy();appHandle.keys.pool.chain=new PoolChain({rpcUrl,poolAddress,usdcAddress:tokenAddress});
  await appHandle.keys.setLimits(await appHandle.keys.authenticate(existing.token),{dailyLimitAtomic:200000n,totalLimitAtomic:200000n});
  const result=await appHandle.app.inject({method:'POST',url:'/v1/chat/completions',headers,payload:{...body,messages:[{role:'user',content:'x'.repeat(80000)}],max_tokens:32000}});
  assert.equal(result.statusCode,200,result.body);
  const r=(await db.admin.query('select charged_atomic,ceiling_atomic from private.pool_requests where api_key_id=$1 order by created_at desc limit 1',[existing.key.id])).rows[0];
  assert.ok(BigInt(r.ceiling_atomic)<200000n);assert.equal(BigInt(r.charged_atomic),200000n);
  console.log(`ok: per-key hard limits: estimated hold=${Number(r.ceiling_atomic)/1e6}, actual debit capped at 0.2 USDC`);
 }
 {
  const key=await appHandle.keys.create({payer:address,name:'concurrent',dailyLimitAtomic:300000n,totalLimitAtomic:300000n});
  const modelProvider=appHandle.keys.service.gateway.providerRegistry.get('mock');
  const invoke=modelProvider.invoke.bind(modelProvider);let entered=0,release;
  const gate=new Promise(r=>release=r);
  modelProvider.invoke=async(...args)=>{entered++;await gate;return invoke(...args);};
  const calls=[false,true].map(stream=>appHandle.app.inject({method:'POST',url:'/v1/chat/completions',
    headers:{authorization:`Bearer ${key.token}`},payload:{...body,messages:[{role:'user',content:'x'.repeat(80000)}],max_tokens:32000,stream}}));
  try{
   const until=Date.now()+10000;while(entered<2&&Date.now()<until)await sleep(5);
   assert.equal(entered,2,'both requests must reserve before either settles');
  }finally{release();}
  const replies=await Promise.all(calls);assert.ok(replies.every(r=>r.statusCode===200));
  assert.ok(replies[1].body.includes('data: [DONE]'),'stream completes with its final receipt');
  const usage=(await db.admin.query('select sum(charged_atomic)::text n,sum(unbilled_overrun_usdc_nano)::text overrun from private.pool_requests where api_key_id=$1',[key.key.id])).rows[0];
  assert.equal(usage.n,'300000');assert.ok(BigInt(usage.overrun)>0n);
  console.log('ok: concurrent JSON and SSE calls share the key hard limit, with overruns recorded and no excess debit');
 }
 // Existing database accounting/role checks run against another disposable DB.
 execFileSync(process.execPath,[join(ROOT,'scripts/verify-pool-db.mjs')],{cwd:ROOT,env:process.env,stdio:'pipe'});
 console.log('ok: pool PostgreSQL accounting and least-privilege checks');
 console.log('Pool recovery E2E passed: real PostgreSQL, signer HTTP, contract, production API; no mainnet funds or provider keys.');
}catch(error){console.log('POOL_RECOVERY_E2E_FAILED',error.code??'',String(error.stack??error.message).slice(0,1500));process.exitCode=1;}
finally{
 console.error=originalError;
 if(appHandle)await appHandle.app.close().catch(()=>{});
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
 provider?.destroy();
 if(anvil&&anvil.exitCode===null){const exit=new Promise(r=>anvil.once('exit',r));anvil.kill('SIGTERM');await exit;}
 if(db)await db.close().catch(e=>console.log('isolated DB cleanup error',e.code??e.message));
 await basePg?.end().catch(()=>{});
 if(containerStarted)try{docker('stop','-t','2',container);}catch{console.log('temporary container cleanup failed:',container);process.exitCode=1;}
 rmSync(temporary,{recursive:true,force:true});
}
