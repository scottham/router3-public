import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {ZodError} from 'zod';
import {Wallet,Contract,toBeHex,parseEther} from 'ethers';
import {createWalletClient,encodeFunctionData,http,publicActions} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {monad} from 'viem/chains';
import {x402Facilitator} from '@x402/core/facilitator';
import {x402Client} from '@x402/core/client';
import {wrapFetchWithPayment} from '@x402/fetch';
import {BatchSettlementEvmScheme as FacilitatorScheme} from '@x402/evm/batch-settlement/facilitator';
import {BatchSettlementEvmScheme as ClientScheme} from '@x402/evm/batch-settlement/client';
import {BATCH_SETTLEMENT_ADDRESS,toClientEvmSigner,toFacilitatorEvmSigner} from '@x402/evm';
import {createIsolatedGatewayDatabase} from './lib/isolated-gateway-db.mjs';
import {startMonadFork} from './lib/monad-fork.mjs';
import {GatewayService} from '../src/services/gateway-service.js';
import {GatewayRepository} from '../src/repositories/gateway-repository.js';
import {registerGatewayRoutes} from '../src/routes/gateway-routes.js';
import {registerX402Routes} from '../src/routes/x402-routes.js';
import {X402Service,X402_NETWORK} from '../src/x402/service.js';
import {PgChannelStorage} from '../src/x402/storage.js';
import {X402Repository} from '../src/x402/repository.js';
import {LocalAuthorizerSigner} from '../src/x402/authorizer.js';
import {X402SettlementWorker} from '../src/workers/x402-settlement-worker.js';
import {MockProvider} from '../src/providers/mock.js';
import {publicError} from '../src/lib/errors.js';
import {publishCatalog} from '../src/services/catalog-publish.js';
import {USDC_ADDRESS} from '../src/chain.js';

// x402 channels end to end on a fresh Monad mainnet fork, against the real
// x402BatchSettlement contract and the real Foundation facilitator code (run
// in-process with a funded relay wallet): a payer with USDC and no MON opens a
// channel inside its first call, pays per request with vouchers, streams, the
// collector claims and settles to the Treasury, the payer takes the rest back
// cooperatively, and a payer who starts a timed withdrawal on-chain is claimed
// before the delay elapses. Synthetic keys, minted fork USDC, no broadcast.
const DELAY=900; // the contract's minimum withdraw delay
let fork,db,app,phase='fork';
const sent=async promise=>{const receipt=await(await promise).wait();assert.equal(receipt.status,1);return receipt;};
try {
  fork=await startMonadFork();const rpc=fork.provider;
  phase='database';db=await createIsolatedGatewayDatabase();
  const key=()=>Wallet.createRandom().connect(rpc);
  const operator=key(),relay=key(),settler=key(),treasury=key(),payerWallet=key(),withdrawer=key(),keyWallet=key();
  for(const w of [operator,relay,withdrawer])await rpc.send('anvil_setBalance',[w.address,toBeHex(parseEther('10'))]);
  await rpc.send('evm_setNextBlockTimestamp',[Math.floor(Date.now()/1000)]);await rpc.send('anvil_mine',['0x1']);
  const usdc=new Contract(USDC_ADDRESS,['function masterMinter() view returns(address)','function configureMinter(address,uint256) returns(bool)',
    'function mint(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'],operator);
  const master=await usdc.masterMinter();await rpc.send('anvil_impersonateAccount',[master]);
  await rpc.send('anvil_setBalance',[master,toBeHex(parseEther('1'))]);
  await sent(usdc.connect(await rpc.getSigner(master)).configureMinter(operator.address,100000000n));
  await rpc.send('anvil_stopImpersonatingAccount',[master]);
  await sent(usdc.mint(payerWallet.address,10000000n));await sent(usdc.mint(withdrawer.address,5000000n));await sent(usdc.mint(keyWallet.address,5000000n));
  assert.equal(await rpc.getBalance(payerWallet.address),0n,'the payer holds no MON');
  const contract=new Contract(BATCH_SETTLEMENT_ADDRESS,['function channels(bytes32) view returns(uint128 balance,uint128 totalClaimed)',
    'function pendingWithdrawals(bytes32) view returns(uint128 amount,uint40 initiatedAt)','function receivers(address,address) view returns(uint128 totalClaimed,uint128 totalSettled)',
    'function initiateWithdraw((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt),uint128)',
    'function finalizeWithdraw((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt))'],rpc);
  assert.notEqual(await rpc.getCode(BATCH_SETTLEMENT_ADDRESS),'0x','the Foundation contract is deployed on Monad');

  phase='gateway';
  // The facilitator: the Foundation's own scheme, relaying with a funded wallet.
  const chain={...monad,rpcUrls:{default:{http:[fork.url]}}};
  const relayClient=createWalletClient({account:privateKeyToAccount(relay.privateKey),chain,transport:http(fork.url)}).extend(publicActions);
  const relaySigner=toFacilitatorEvmSigner(Object.assign(relayClient,{address:relay.address}));
  // The SDK sends claim/settle with fixed gas limits sized for other chains;
  // Monad's USDC transfer needs more, so the relay estimates instead and the
  // estimates are reported for the production facilitator to be checked against.
  const gasSeen={};
  const writeContract=relaySigner.writeContract.bind(relaySigner);
  relaySigner.writeContract=async args=>{
    const estimate=BigInt(await rpc.estimateGas({from:relay.address,to:args.address,data:encodeFunctionData({abi:args.abi,functionName:args.functionName,args:args.args})}));
    gasSeen[args.functionName]=String(estimate);
    return writeContract({...args,gas:estimate*13n/10n});
  };
  const facilitator=new x402Facilitator().register(X402_NETWORK,new FacilitatorScheme(relaySigner));
  const config={REAL_MODEL_CALLS_ENABLED:false,PUBLIC_APP_URL:'https://gateway.test',X402_MAX_CHANNELS_PER_PAYER:128,
    TREASURY_ADDRESS:treasury.address,SETTLER_ADDRESS:settler.address,X402_WITHDRAW_DELAY_SECONDS:DELAY,X402_MIN_DEPOSIT_USDC:'1',X402_REQUEST_LIMIT_USDC:'5',
    X402_CLAIM_MIN_USDC:'0.000001',X402_CLAIM_IDLE_SECONDS:86400,X402_CLAIM_INTERVAL_SECONDS:60,AUTH_ALLOWED_ADDRESSES:[],
    DEFAULT_REQUEST_TIMEOUT_MS:30000,MAX_REQUEST_TIMEOUT_MS:30000,STREAM_REQUEST_TIMEOUT_MS:30000,STREAM_IDLE_TIMEOUT_MS:30000,
    AUTH_SESSION_HMAC_SECRET:'fork-session-secret-0123456789abcdef',activeResponseEncryptionKeyId:'t',responseEncryptionKeys:new Map([['t',Buffer.alloc(32,7)]]),
    chains:{143:{rpcUrl:fork.url,usdcAddress:USDC_ADDRESS,confirmations:0}},MONAD_RPC_URL:fork.url};
  await publishCatalog(db.admin,[{publicName:'mock/echo',provider:'mock',providerModel:'echo',usdPerMillion:{input:'1',cachedInput:'0.5',output:'2',reasoning:'0'},
    sourceReference:'https://example.com/mock',reviewedAt:'2026-10-22'}],0);
  const gatewayRepository=new GatewayRepository(db.pools.api,config);
  const gateway=new GatewayService({repository:gatewayRepository,providerRegistry:{get:()=>new MockProvider()},config});
  const storage=new PgChannelStorage(db.pools.api),ledger=new X402Repository(db.pools.api);
  const service=new X402Service({config,gateway,repository:ledger,storage,authorizer:new LocalAuthorizerSigner(settler),facilitator});
  assert.equal(await service.initialize({retries:0}),true);
  const x402={service,repository:ledger,storage,scheme:service.scheme,facilitator};
  app=Fastify({logger:false});
  let signedIn=payerWallet;
  const userAuth=async request=>{request.identity={appUserId:'u1',address:signedIn.address.toLowerCase()};};
  await registerGatewayRoutes(app,{x402,keys:null,userAuth,gatewayRepository});
  await registerX402Routes(app,{x402,userAuth,config,pool:{query:async()=>({rows:[{address:payerWallet.address.toLowerCase()}]})}});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof ZodError)return reply.code(422).send({error:{code:'VALIDATION_ERROR',message:'Request validation failed'}});
    const result=publicError(error);return reply.code(result.statusCode).send(result.body);
  });
  const fetchImpl=async(input,init)=>{
    const request=new Request(input,init);
    const response=await app.inject({method:request.method,url:new URL(request.url).pathname,headers:Object.fromEntries(request.headers),payload:await request.text()});
    return new Response(response.body,{status:response.statusCode,headers:Object.entries(response.headers).map(([k,v])=>[k,String(v)])});
  };
  const client=wallet=>{
    const account=toClientEvmSigner(privateKeyToAccount(wallet.privateKey),relayClient);
    const scheme=new ClientScheme(account,{salt:'0x'+'42'.repeat(32)});
    return {scheme,fetch:wrapFetchWithPayment(fetchImpl,new x402Client().register(X402_NETWORK,scheme))};
  };
  const post=(path,body)=>new Request(`https://gateway.test${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const ok=async response=>{if(response.status!==200)assert.fail(`${response.status} ${await response.text()}`);return response.json();};
  const chat=(content='hello channel',extra={})=>({model:'mock/echo',messages:[{role:'user',content}],max_tokens:32,...extra});
  const worker=new X402SettlementWorker(db.pools.settler,config,{scheme:service.scheme,facilitator,storage:new PgChannelStorage(db.pools.settler),
    repository:new X402Repository(db.pools.settler),rpc});
  const total=async()=>await usdc.balanceOf(payerWallet.address)+await usdc.balanceOf(withdrawer.address)+await usdc.balanceOf(keyWallet.address)
    +await usdc.balanceOf(treasury.address)+await usdc.balanceOf(BATCH_SETTLEMENT_ADDRESS)-contractBefore;
  const contractBefore=await usdc.balanceOf(BATCH_SETTLEMENT_ADDRESS);

  phase='first_call_opens_the_channel';
  const payer=client(payerWallet);
  const unpaid=await app.inject({method:'POST',url:'/v1/chat/completions',payload:chat()});
  assert.equal(unpaid.statusCode,402);assert.equal(unpaid.json().error.code,'PAYMENT_REQUIRED');
  const first=await ok(await payer.fetch(post('/v1/chat/completions',chat())));
  assert.equal(first.choices[0].message.content,'mock:hello channel');
  const [channel]=await storage.list();
  const onchain=await contract.channels(channel.channelId);
  assert.ok(onchain.balance>=1000000n,'the deposit landed in the contract');
  assert.equal(String(onchain.balance),channel.balance);
  assert.equal(await usdc.balanceOf(payerWallet.address),10000000n-onchain.balance);
  assert.equal(await rpc.getBalance(payerWallet.address),0n,'the relay paid the deposit gas');
  assert.ok(first.gateway.x402.transaction,'the receipt names the deposit transaction');
  assert.equal(channel.chargedCumulativeAmount,first.gateway.x402.charged_atomic);
  assert.equal(await total(),20000000n,'USDC is conserved');

  phase='vouchers_and_streams';
  for(let i=0;i<3;i++)await ok(await payer.fetch(post('/v1/chat/completions',chat(`call ${i}`))));
  const stream=await payer.fetch(post('/v1/chat/completions',chat('stream',{stream:true})));
  assert.equal(stream.status,200);assert.match(await stream.text(),/"payment_response"/);
  await ok(await payer.fetch(post('/v1/chat/completions',chat('after stream'))));
  const charged=BigInt((await storage.get(channel.channelId)).chargedCumulativeAmount);
  assert.ok(charged>0n);
  assert.equal((await contract.channels(channel.channelId)).totalClaimed,0n,'nothing on-chain per request');
  assert.equal((await db.admin.query("select count(*)::int n from private.x402_requests where status='completed' and charged_from='usage'")).rows[0].n,6);

  phase='claim_and_settle';
  let claims,settle;
  try {({claims,settle}=await worker.tick());}
  catch(error) {
    const settleAbi=new Contract(BATCH_SETTLEMENT_ADDRESS,['function settle(address,address)','function receivers(address,address) view returns(uint128 totalClaimed,uint128 totalSettled)'],relay);
    const r=await settleAbi.receivers(treasury.address,USDC_ADDRESS);
    let reason='';try{await settleAbi.settle.staticCall(treasury.address,USDC_ADDRESS);}catch(e){reason=e.shortMessage??e.message;}
    throw new Error(`${error.message} receivers=${r.totalClaimed}/${r.totalSettled} channel=${JSON.stringify(await contract.channels(channel.channelId),(k,v)=>typeof v==='bigint'?String(v):v)} static=${reason}`);
  }
  assert.equal(claims.length,1);
  assert.equal((await contract.channels(channel.channelId)).totalClaimed,charged,'claimWithSignature accepted the authorizer signature');
  assert.equal(await usdc.balanceOf(treasury.address),charged,'settle moved the claimed amount to the Treasury');
  assert.ok(settle.transaction);
  assert.equal((await db.admin.query("select count(*)::int n from private.x402_settlements where kind in('claim','settle')")).rows[0].n,2);
  assert.deepEqual(await worker.tick(),{claims:[],settle:null});

  phase='cooperative_refund';
  await ok(await payer.fetch(post('/v1/chat/completions',chat('one more'))));
  const before=await storage.get(channel.channelId);
  const refund=await payer.scheme.refund('https://gateway.test/v1/x402/refund',{fetch:fetchImpl});
  assert.equal(refund.success,true);
  const afterRefund=await contract.channels(channel.channelId);
  assert.equal(afterRefund.totalClaimed,BigInt(before.chargedCumulativeAmount),'the refund claimed what was owed first');
  assert.equal(afterRefund.balance,afterRefund.totalClaimed,'and returned everything else');
  assert.equal(await usdc.balanceOf(payerWallet.address),10000000n-afterRefund.totalClaimed);
  assert.equal(await storage.get(channel.channelId),undefined);
  await worker.tick();
  assert.equal(await usdc.balanceOf(treasury.address),afterRefund.totalClaimed,'the refund claim is settled too');
  assert.equal(await total(),20000000n);

  phase='timed_withdrawal';
  const other=client(withdrawer);
  await ok(await other.fetch(post('/v1/chat/completions',chat('withdrawer'))));
  const [theirs]=await storage.list();
  const owed=BigInt(theirs.chargedCumulativeAmount);
  // The payer leaves without asking: a withdrawal of everything, straight on the contract.
  await sent(contract.connect(withdrawer).initiateWithdraw(theirs.channelConfig,BigInt(theirs.balance)));
  assert.ok(Number((await contract.pendingWithdrawals(theirs.channelId)).initiatedAt)>0);
  worker.minAtomic=10n**12n;
  const claimed=await worker.tick();
  assert.equal(claimed.claims.length,1,'a pending withdrawal is claimed at once, regardless of the threshold');
  assert.equal((await contract.channels(theirs.channelId)).totalClaimed,owed);
  await rpc.send('evm_increaseTime',[DELAY+1]);await rpc.send('anvil_mine',['0x1']);
  await sent(contract.connect(withdrawer).finalizeWithdraw(theirs.channelConfig));
  const left=await contract.channels(theirs.channelId);
  assert.equal(left.balance,owed,'the withdrawal was capped at what was not claimed');
  assert.equal(await usdc.balanceOf(withdrawer.address),5000000n-owed);
  assert.equal(await total(),20000000n);

  // API keys bill from the prepaid pool now: scripts/verify-pool-fork.mjs.
  assert.equal(await total(),20000000n);
  console.log(JSON.stringify({passed:true,charged:String(charged),refundClaimed:String(afterRefund.totalClaimed),withdrawerOwed:String(owed),
    gasEstimates:gasSeen}));
} catch(error) {
  console.error(JSON.stringify({passed:false,phase,error:error.message}));process.exitCode=1;
} finally {await app?.close();await db?.close();await fork?.close();}
