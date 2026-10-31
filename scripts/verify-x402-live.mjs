// Live x402 acceptance against a deployed gateway (default https://router3.ai)
// with a real wallet on Monad mainnet and the gateway's real facilitator:
// first paid call deposits (the payer spends no MON), vouchers carry the next
// calls, a stream puts its receipt in the last chunk and the call after it
// resyncs through one corrective 402, then a cooperative refund claims the
// charged amount and returns the rest. Finally waits for the collector to
// settle the claimed amount to the Treasury and reports every balance.
//
//   node --env-file=.env.mainnet-local --env-file=.env scripts/verify-x402-live.mjs [--no-wait]
//
// Needs PRIVATE_KEY (the payer, holding a few USDC), MONAD_RPC_URL and
// TREASURY_ADDRESS. Spends well under 0.01 USDC in model calls.
import assert from 'node:assert/strict';
import {createPublicClient,http,parseAbi,toHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {monad} from 'viem/chains';
import {x402Client} from '@x402/core/client';
import {wrapFetchWithPayment} from '@x402/fetch';
import {BatchSettlementEvmScheme as ClientScheme,computeChannelId} from '@x402/evm/batch-settlement/client';
import {BATCH_SETTLEMENT_ADDRESS,toClientEvmSigner} from '@x402/evm';
import {randomBytes} from 'node:crypto';

const base=(process.env.MCG_BASE_URL??'https://router3.ai').replace(/\/$/,'');
const model=process.env.MCG_X402_MODEL??'deepseek/deepseek-flash';
const wait=!process.argv.includes('--no-wait');
const NETWORK='eip155:143';
const USDC='0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
for(const name of ['PRIVATE_KEY','MONAD_RPC_URL','TREASURY_ADDRESS'])if(!process.env[name])throw new Error(`${name} is required`);

const rpc=createPublicClient({chain:monad,transport:http(process.env.MONAD_RPC_URL)});
const account=privateKeyToAccount(`0x${process.env.PRIVATE_KEY.trim().replace(/^['"]|['"]$/g,'').replace(/^0x/i,'')}`);
const erc20=parseAbi(['function balanceOf(address) view returns (uint256)']);
const batch=parseAbi(['function channels(bytes32) view returns (uint128 balance,uint128 totalClaimed)']);
const usdcOf=address=>rpc.readContract({address:USDC,abi:erc20,functionName:'balanceOf',args:[address]});
const monOf=address=>rpc.getBalance({address});
const treasury=process.env.TREASURY_ADDRESS;

const salt=toHex(randomBytes(32));
const scheme=new ClientScheme(toClientEvmSigner(account,rpc),{salt});
const paidFetch=wrapFetchWithPayment(fetch,new x402Client().register(NETWORK,scheme));
const post=(path,body)=>[`${base}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}];
const chat=(content,extra={})=>({model,messages:[{role:'user',content}],max_tokens:16,...extra});
const ok=async response=>{if(response.status!==200)throw new Error(`${response.status} ${await response.text()}`);return response.json();};
const log=(step,detail)=>console.log(JSON.stringify({step,...detail}));

const before={payerUsdc:await usdcOf(account.address),payerMon:await monOf(account.address),treasuryUsdc:await usdcOf(treasury)};
const terms=await (await fetch(`${base}/v1/x402`)).json();
assert.equal(terms.ready,true,'gateway reports x402 ready');
log('terms',{payer:account.address,treasury,facilitator:terms.facilitator,minDeposit:terms.minDepositAtomic});

const unpaid=await fetch(...post('/v1/chat/completions',chat('hi')));
assert.equal(unpaid.status,402);
const quote=(await unpaid.json()).error.details.x402.accepts[0];
log('quote',{amount:quote.amount,payTo:quote.payTo});

const first=await ok(await paidFetch(...post('/v1/chat/completions',chat('Reply with one word.'))));
assert.ok(first.gateway?.x402?.charged_atomic,'receipt has the charged amount');
assert.ok(first.gateway.x402.transaction,'the first call deposited through the facilitator');
const config={payer:account.address,payerAuthorizer:account.address,receiver:quote.payTo,receiverAuthorizer:quote.extra.receiverAuthorizer,token:quote.asset,withdrawDelay:quote.extra.withdrawDelay,salt};
const channelId=computeChannelId(config,NETWORK);
const afterDeposit=await rpc.readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:batch,functionName:'channels',args:[channelId]});
log('deposit',{transaction:first.gateway.x402.transaction,channelId,balance:String(afterDeposit[0]),charged:first.gateway.x402.charged_atomic,ceiling:first.gateway.x402.ceiling_atomic});
assert.ok(afterDeposit[0]>=BigInt(terms.minDepositAtomic),'the deposit landed in the contract');
assert.equal(await monOf(account.address),before.payerMon,'the payer spent no MON');

const second=await ok(await paidFetch(...post('/v1/chat/completions',chat('Reply with one word again.'))));
log('voucher',{charged:second.gateway.x402.charged_atomic,cumulative:second.gateway.x402.cumulative_atomic});
const stream=await paidFetch(...post('/v1/chat/completions',chat('Count to three.',{stream:true})));
assert.equal(stream.status,200);
const text=await stream.text();
const receipt=text.split('\n').filter(l=>l.startsWith('data: ')&&l.includes('payment_response')).pop();
assert.ok(receipt,'the stream carries its receipt in the last chunk');
log('stream',{chunks:text.split('\n\n').length,receipt:JSON.parse(receipt.slice(6)).gateway.x402.cumulative_atomic});
const third=await ok(await paidFetch(...post('/v1/chat/completions',chat('And after the stream?'))));
log('after_stream',{charged:third.gateway.x402.charged_atomic,cumulative:third.gateway.x402.cumulative_atomic});
const cumulative=BigInt(third.gateway.x402.cumulative_atomic);

const refund=await scheme.refund(`${base}/v1/x402/refund`,{fetch});
log('refund',refund);
assert.equal(refund.success,true,'the facilitator claimed and refunded in one transaction');
const afterRefund=await rpc.readContract({address:BATCH_SETTLEMENT_ADDRESS,abi:batch,functionName:'channels',args:[channelId]});
assert.equal(afterRefund[1],cumulative,'the refund claimed exactly the charged amount');
assert.equal(afterRefund[0]-afterRefund[1],0n,'nothing is left unclaimed in the channel');
const payerAfter=await usdcOf(account.address);
assert.equal(before.payerUsdc-payerAfter,cumulative,'the payer paid exactly the charged amount');

let settled=null;
if(wait){
  const deadline=Date.now()+15*60*1000;
  while(Date.now()<deadline){
    const now=await usdcOf(treasury);
    if(now-before.treasuryUsdc>=cumulative){settled=String(now-before.treasuryUsdc);break;}
    await new Promise(r=>setTimeout(r,20000));
  }
  assert.ok(settled,'the collector settled the claimed amount to the Treasury within 15 minutes');
}
console.log(JSON.stringify({passed:true,channelId,charged:String(cumulative),payerSpentUsdc:String(before.payerUsdc-payerAfter),payerSpentMon:'0',treasuryReceived:settled}));
