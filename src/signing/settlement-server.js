import {readFileSync} from 'node:fs';
import pg from 'pg';
import {FetchRequest,JsonRpcProvider,Wallet,getAddress,parseEther,parseUnits} from 'ethers';
import {createSettlementSignerServer} from './settlement-signer.js';
import {X402AuthorizerSigner} from './x402-authorizer-signer.js';
import {PoolTxSigner} from './pool-tx-signer.js';
import {AUTHORIZER_SIGNER_REF} from '../x402/authorizer.js';
import {CHAIN_ID,USDC_ADDRESS} from '../chain.js';

// The only process holding the Settler key. It signs
//  - the two EIP-712 messages the x402BatchSettlement contract accepts from a
//    channel's receiver authorizer (ClaimBatch, Refund), bounded by the
//    gateway's channel mirror; and
//  - prepaid pool transactions (pool-tx-signer.js), rebuilt from the rows the
//    gateway recorded, within gas and USDC budgets.
const env=process.env;
const required=name=>{if(!env[name])throw new Error(`${name}_REQUIRED`);return env[name];};
const wallet=new Wallet(readFileSync(required('SETTLEMENT_SIGNER_KEY_FILE'),'utf8').trim());
const pool=new pg.Pool({connectionString:required('DATABASE_URL_SIGNER'),max:4,connectionTimeoutMillis:5000,
  statement_timeout:30000,application_name:'router3-settlement-signer'});
pool.on('error',()=>console.error(JSON.stringify({level:'error',message:'SIGNER_DATABASE_CONNECTION_FAILED'})));
const authorizerSigner=new X402AuthorizerSigner({pool,wallet});

let poolSigner=null,provider=null;
if(env.POOL_ADDRESS) {
  const policy={chainId:CHAIN_ID,poolAddress:getAddress(env.POOL_ADDRESS),usdcAddress:USDC_ADDRESS,
    treasuryAddress:getAddress(required('TREASURY_ADDRESS')),runtimeCodeHash:required('POOL_CODE_HASH'),
    maxDebitAtomic:parseUnits(env.SETTLEMENT_SIGNER_MAX_DEBIT_USDC||'1000',6),
    dailyUsdcAtomic:parseUnits(env.SETTLEMENT_SIGNER_DAILY_USDC||'10000',6),
    maxGas:BigInt(env.SETTLEMENT_SIGNER_MAX_GAS||'2500000'),
    // Monad bills gasLimit x price in MON; mainnet base fee is ~100 gwei.
    maxFeePerGas:parseUnits(env.SETTLEMENT_SIGNER_MAX_GWEI||'1000',9),
    maxTransactionCostWei:parseEther(env.SETTLEMENT_SIGNER_MAX_GAS_MON||'0.2'),
    dailyCostWei:parseEther(env.SETTLEMENT_SIGNER_DAILY_GAS_MON||'5'),
    permitDailyCostWei:parseEther(env.SETTLEMENT_SIGNER_DAILY_PERMIT_GAS_MON||'1')};
  if(!/^0x[0-9a-fA-F]{64}$/.test(policy.runtimeCodeHash)||policy.permitDailyCostWei>policy.dailyCostWei
    ||[policy.maxDebitAtomic,policy.dailyUsdcAtomic,policy.maxGas,policy.maxFeePerGas,policy.maxTransactionCostWei,policy.dailyCostWei,policy.permitDailyCostWei].some(v=>v<=0n))
    throw new Error('INVALID_SIGNER_POLICY');
  const request=new FetchRequest(required('MONAD_RPC_URL'));request.timeout=12000;
  provider=new JsonRpcProvider(request,CHAIN_ID,{staticNetwork:true});
  poolSigner=new PoolTxSigner({pool,provider,wallet,policy});
  await poolSigner.verifyChain();
}

const server=createSettlementSignerServer({pool,signAndBroadcast:body=>{
  if(body?.signerRef===AUTHORIZER_SIGNER_REF)return authorizerSigner.sign(body);
  if(poolSigner&&['pool-settle-v1','pool-op-v1'].includes(body?.signerRef))return poolSigner.signAndBroadcast(body);
  throw Object.assign(new Error('SIGNER_REQUEST_NOT_ALLOWED'),{code:'SIGNER_REQUEST_NOT_ALLOWED',statusCode:400});
}},required('SETTLER_SIGNER_BEARER_TOKEN'));
server.listen(Number(env.SETTLEMENT_SIGNER_PORT||8790),env.SETTLEMENT_SIGNER_HOST||'0.0.0.0',()=>console.log(JSON.stringify({
  level:'info',message:'settlement_signer_ready',chainId:CHAIN_ID,address:wallet.address,pool:env.POOL_ADDRESS??null})));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(async()=>{await pool.end();provider?.destroy();}));
