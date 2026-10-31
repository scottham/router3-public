import assert from 'node:assert/strict';
import {Contract,Wallet,keccak256,parseEther,toBeHex,ZeroHash} from 'ethers';
import {createIsolatedGatewayDatabase} from './lib/isolated-gateway-db.mjs';
import {startMonadFork} from './lib/monad-fork.mjs';
import {PgPoolStore} from '../src/pool/store.js';
import {PoolBilling} from '../src/pool/billing.js';
import {PoolChain} from '../src/pool/chain.js';
import {PERMIT_TYPES,POOL_TYPES,poolInterface} from '../src/pool/contract.js';
import {PoolWorker} from '../src/workers/pool-worker.js';
import {PoolTxSigner} from '../src/signing/pool-tx-signer.js';
import {USDC_ADDRESS} from '../src/chain.js';

// The prepaid pool end to end on a Monad mainnet fork, against the deployed
// WalletPrepaidPool: a wallet with no MON signs a USDC permit and its limits,
// the signer relays them and refills the pool, requests are held and charged
// against it, a refill carries the owed debit, the Treasury is swept, and a
// signed withdrawal is completed for the wallet after the delay. The real
// signer (journal, gas budgets, code-hash check), worker, Postgres ledger and
// chain reads; synthetic keys and minted fork USDC.
const POOL='0x5f60ee99757C09222B5F0bD058857e9Cbe6D1Fb3',ADMIN='0x8E5d1Ef824E54648cE19f7f0CC0853DF345c91cF';
const TREASURY='0x0061e7958aA1f6bbDA7fFdB4D079fa2d413263dd';
const USDC=1_000_000n;
let fork,db,phase='fork';
try {
  fork=await startMonadFork();const rpc=fork.provider;
  phase='database';db=await createIsolatedGatewayDatabase();
  const {pool:signerDb}=await db.createRuntimeRole('signer');
  const signerRole=(await signerDb.query('select current_user u')).rows[0].u;
  await db.admin.query(`grant usage on schema private,settlement_signing to "${signerRole}";
    grant select on private.pool_accounts,private.pool_batches,private.pool_ops to "${signerRole}";
    grant select,insert,update on settlement_signing.transactions to "${signerRole}";`);

  phase='setup';
  await rpc.send('evm_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);await rpc.send('anvil_mine',['0x1']);
  const payer=Wallet.createRandom(),settler=Wallet.createRandom().connect(rpc);
  await rpc.send('anvil_setBalance',[settler.address,toBeHex(parseEther('10'))]);
  // The deployed pool's admin grants the test settler the role.
  const pool=new Contract(POOL,[...poolInterface.fragments,'function grantRole(bytes32,address)','function DEFAULT_ADMIN_ROLE() view returns(bytes32)'],rpc);
  await rpc.send('anvil_impersonateAccount',[ADMIN]);await rpc.send('anvil_setBalance',[ADMIN,toBeHex(parseEther('1'))]);
  await (await pool.connect(await rpc.getSigner(ADMIN)).grantRole(await pool.SETTLER_ROLE(),settler.address)).wait();
  await rpc.send('anvil_stopImpersonatingAccount',[ADMIN]);
  const usdc=new Contract(USDC_ADDRESS,['function masterMinter() view returns(address)','function configureMinter(address,uint256) returns(bool)',
    'function mint(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'],rpc);
  const master=await usdc.masterMinter();await rpc.send('anvil_impersonateAccount',[master]);await rpc.send('anvil_setBalance',[master,toBeHex(parseEther('1'))]);
  const m=await rpc.getSigner(master);
  await (await usdc.connect(m).configureMinter(master,1_000_000n*USDC)).wait();await (await usdc.connect(m).mint(payer.address,30n*USDC)).wait();
  await rpc.send('anvil_stopImpersonatingAccount',[master]);
  assert.equal(await rpc.getBalance(payer.address),0n,'the wallet holds no MON');
  const accruedBefore=await pool.treasuryAccrued(),treasuryBefore=await usdc.balanceOf(TREASURY);

  const config={POOL_SETTLE_MIN_USDC:'1',POOL_REFILL_WAIT_MS:20000,POOL_SNAPSHOT_TTL_SECONDS:1,POOL_PERMIT_MIN_BALANCE_USDC:'1',POOL_ACTIVATION_FEE_USDC:'0.05',POOL_SWEEP_MIN_USDC:'0.1'};
  const chain=new PoolChain({rpcUrl:fork.url,poolAddress:POOL});
  const txSigner=new PoolTxSigner({pool:signerDb,provider:rpc,wallet:settler,policy:{chainId:143,poolAddress:POOL,usdcAddress:USDC_ADDRESS,treasuryAddress:TREASURY,
    runtimeCodeHash:keccak256(await rpc.getCode(POOL)),maxDebitAtomic:1000n*USDC,dailyUsdcAtomic:10_000n*USDC,maxGas:2_500_000n,maxFeePerGas:10n**13n,
    maxTransactionCostWei:parseEther('0.5'),dailyCostWei:parseEther('5'),permitDailyCostWei:parseEther('1')}});
  const sender={submit:async body=>(await txSigner.signAndBroadcast(body)).txHash};
  const billing=new PoolBilling({store:new PgPoolStore(db.pools.api),chain,config,maxConcurrency:128});
  const worker=new PoolWorker({store:new PgPoolStore(db.pools.settler),chain,sender,config});
  // Anvil's finalized head trails latest by 64 blocks (Monad's by about 2).
  const settle=async(n=3)=>{for(let i=0;i<n;i++){await rpc.send('anvil_mine',['0x41']);await worker.tick();}};
  const payerAddr=payer.address.toLowerCase();

  phase='setup-signatures';
  const terms=await billing.terms(),nonces=await chain.nonces(payer.address);
  const deadline=BigInt(Math.floor(Date.now()/1000)+3600);
  const permitSig=await payer.signTypedData(terms.usdcDomain,PERMIT_TYPES,{owner:payer.address,spender:POOL,value:100n*USDC,nonce:nonces.usdc,deadline});
  await billing.permit(payerAddr,{value:100n*USDC,deadline,signature:permitSig});
  const configSig=await payer.signTypedData(terms.poolDomain,{Configure:POOL_TYPES.Configure},{owner:payer.address,refillTarget:3n*USDC,dailyLimit:20n*USDC,nonce:nonces.pool,deadline});
  await billing.configure(payerAddr,{refillTarget:3n*USDC,dailyLimit:20n*USDC,nonce:nonces.pool,deadline,signature:configSig});
  await settle(4);
  let account=await billing.store.account(payerAddr);
  assert.equal(account.refill_target_atomic,3n*USDC);assert.equal(account.daily_limit_atomic,20n*USDC);
  assert.equal(account.pool_balance_atomic,3n*USDC,'refilled to the target from the wallet');
  assert.equal(await usdc.balanceOf(payer.address),27n*USDC);
  assert.equal(account.unsettled_atomic,50_000n,'the one-time activation fee is owed');

  phase='requests';
  const key={id:null,payer:payerAddr,daily_limit_atomic:null,total_limit_atomic:null};
  // Twelve requests at once of 0.2 USDC each: 2.4 of the 2.95 available.
  const ids=await Promise.all(Array.from({length:12},()=>billing.open({key,ceilingAtomic:200_000n,request:{protocol:'chat'}})));
  account=await billing.store.account(payerAddr);
  assert.equal(account.running,12);assert.equal(account.held_atomic,2_400_000n);
  // Each costs 0.15 USDC.
  for(const id of ids)await billing.close(payerAddr,id,{atomic:150_000n,fields:got=>({actual_charge_usdc_nano:got*1000n,charged_from:'usage'})});
  account=await billing.store.account(payerAddr);
  assert.equal(account.unsettled_atomic,50_000n+12n*150_000n);
  // Owed 1.85 USDC: debited, and the pool refilled back to 3 in the same transaction.
  await settle(3);
  account=await billing.store.account(payerAddr);
  assert.equal(account.unsettled_atomic,0n);assert.equal(account.pool_balance_atomic,3n*USDC);
  const [onchain]=await Promise.all([pool.accountOf(payer.address)]);
  assert.equal(onchain.balance,3n*USDC);
  const batches=(await db.admin.query("select * from private.pool_batches where payer=$1 order by created_at",[payerAddr])).rows;
  assert.ok(batches.every(b=>b.state==='confirmed'));
  const debit=batches.find(b=>BigInt(b.debit_atomic)>0n);
  assert.equal(debit.debit_atomic,String(1_850_000n));assert.equal(debit.refill_result,'refilled');
  assert.equal(await usdc.balanceOf(payer.address),27n*USDC-1_850_000n);

  phase='refill-wait';
  // A request bigger than what is available waits for a refill: hold 2.9 USDC against 3 − 0.6 held.
  const busy=await billing.open({key,ceilingAtomic:600_000n,request:{protocol:'chat'}});
  const timer=setInterval(()=>{rpc.send('anvil_mine',['0x41']).then(()=>worker.tick()).catch(()=>{});},300);
  try {
    // Charge 2 USDC first so the pool needs one.
    await billing.close(payerAddr,busy,{atomic:2_000_000n,fields:got=>({actual_charge_usdc_nano:got*1000n,charged_from:'usage'})});
    const big=await billing.open({key,ceilingAtomic:2_900_000n,request:{protocol:'chat'}});
    await billing.close(payerAddr,big,{atomic:100_000n,fields:got=>({actual_charge_usdc_nano:got*1000n,charged_from:'usage'})});
  } finally {clearInterval(timer);}
  await settle(4);

  phase='sweep';
  assert.ok(await pool.treasuryAccrued()===0n||await pool.treasuryAccrued()<accruedBefore+100_000n,'the Treasury accrual was swept');
  const swept=await usdc.balanceOf(TREASURY)-treasuryBefore;
  assert.ok(swept>=1_850_000n,`swept ${swept}`);

  phase='withdrawal';
  const n=await chain.nonces(payer.address);
  const wd=await payer.signTypedData(terms.poolDomain,{RequestWithdrawal:POOL_TYPES.RequestWithdrawal},{owner:payer.address,amount:1000n*USDC,nonce:n.pool,deadline});
  await billing.requestWithdrawal(payerAddr,{amount:1000n*USDC,nonce:n.pool,deadline,signature:wd});
  await settle(3);
  await assert.rejects(billing.open({key,ceilingAtomic:1000n,request:{protocol:'chat'}}),e=>e.code==='POOL_WITHDRAWING');
  await rpc.send('evm_increaseTime',[1801]);await rpc.send('anvil_mine',['0x1']);
  const later=(await rpc.getBlock('latest')).timestamp*1000;
  worker.now=()=>new Date(later);
  await settle(5);
  const final=await pool.accountOf(payer.address);
  assert.equal(final.balance,0n);assert.equal(final.refillTarget,0n,'refills are off after a withdrawal');
  const debitedTotal=(await db.admin.query("select coalesce(sum(debit_atomic),0)::text s from private.pool_batches where payer=$1 and state='confirmed'",[payerAddr])).rows[0].s;
  assert.equal(await usdc.balanceOf(payer.address),30n*USDC-BigInt(debitedTotal),'the wallet got back everything but what it was charged');
  const journal=(await db.admin.query('select count(*)::int n,count(distinct nonce)::int nonces from settlement_signing.transactions')).rows[0];
  assert.equal(journal.n,journal.nonces);
  console.log(JSON.stringify({passed:true,debitedAtomic:debitedTotal,sweptAtomic:String(swept),transactions:journal.n,
    gasPerSettle:String((await rpc.getTransactionReceipt(debit.tx_hash)).gasUsed)}));
} catch(error) {
  console.error(JSON.stringify({passed:false,phase,error:error.message?.slice(0,400)}));process.exitCode=1;
} finally {await db?.close().catch(()=>{});await fork?.close().catch(()=>{});}
