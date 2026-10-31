import {Wallet,getAddress} from 'ethers';
import {BATCH_SETTLEMENT_ADDRESS,BATCH_SETTLEMENT_DOMAIN,voucherTypes} from '@x402/evm';
import {decodePaymentRequiredHeader} from '@x402/core/http';
import {AppError} from '../lib/errors.js';
import {ceilDiv} from '../lib/money.js';
import {createApiKey,decryptJson,hmacSha256} from '../lib/crypto.js';
import {ProviderError} from '../providers/provider-error.js';
import {CHAIN_ID} from '../chain.js';
import {REALISTIC_BYTES_PER_TOKEN} from '../services/pricing-service.js';
import {usdcAtomic} from './service.js';
import {sleep} from '../lib/sleep.js';

// API keys bill from the wallet's prepaid pool (src/pool): every key of a
// wallet shares it, so a new key works at once. A request holds an estimate
// of its cost against the pool and is charged its actual cost when it ends;
// the collector debits charges and refills the pool on-chain. Keys created
// before the pool returned each had an x402 channel; what is left on it can
// still be refunded to the wallet.
export const API_KEY_PREFIX='r3_live';
const NANO_PER_ATOMIC=1000n;
// Runs fn, trying again after a pause for each of `retries` failures.
async function retry(fn,retries,delayMs) {
  for(let attempt=0;;attempt++) {
    try {return await fn();}
    catch(error) {if(attempt>=retries)throw error;await sleep(delayMs);}
  }
}
const TOKEN=/^r3_live_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/;

export function apiKeyOf(headers) {
  const bearer=typeof headers.authorization==='string'&&headers.authorization.startsWith('Bearer ')?headers.authorization.slice(7).trim():null;
  const value=bearer??(typeof headers['x-api-key']==='string'?headers['x-api-key'].trim():null);
  return value&&value.startsWith(`${API_KEY_PREFIX}_`)?value:null;
}

const voucherDomain=()=>({...BATCH_SETTLEMENT_DOMAIN,chainId:CHAIN_ID,verifyingContract:getAddress(BATCH_SETTLEMENT_ADDRESS)});

// Key rows in Postgres.
export class PgApiKeyStore {
  constructor(pool){this.pool=pool;}
  async insert(row) {
    const {rows:[created]}=await this.pool.query(`insert into private.api_keys(payer,name,prefix,token_hash,authorizer,encrypted_authorizer,salt,channel_id)
      values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[row.payer,row.name,row.prefix,row.token_hash,row.authorizer,row.encrypted_authorizer,row.salt,row.channel_id]);
    return created;
  }
  async listByPayer(payer){return (await this.pool.query('select * from private.api_keys where payer=$1 order by created_at desc',[payer])).rows;}
  async get(id,payer){return (await this.pool.query('select * from private.api_keys where id=$1 and payer=$2',[id,payer])).rows[0]??null;}
  async useToken(hash) {
    return (await this.pool.query(`update private.api_keys set last_used_at=now() where token_hash=$1 and state='active' returning *`,[hash])).rows[0]??null;
  }
  async revoke(id){await this.pool.query(`update private.api_keys set state='revoked',revoked_at=now() where id=$1 and state='active'`,[id]);}
  async setLimits(id,{daily,total}) {
    return (await this.pool.query('update private.api_keys set daily_limit_atomic=$2,total_limit_atomic=$3 where id=$1 returning *',
      [id,daily==null?null:String(daily),total==null?null:String(total)])).rows[0]??null;
  }
}

export class ApiKeyService {
  // `service`, `repository`, `storage`: x402, for older keys' channels;
  // `pool`: PoolBilling.
  constructor({store,config,service,repository,storage,pool=null,maxConcurrency=128,logger=console}) {
    Object.assign(this,{store,config,service,repository,storage,pool,maxConcurrency,logger});
    this.secret=config.AUTH_SESSION_HMAC_SECRET;
    this.requestLimitAtomic=usdcAtomic(config.API_KEY_REQUEST_LIMIT_USDC??'50');
    this.holdOutputTokens=config.API_KEY_HOLD_OUTPUT_TOKENS??8192;
    this.signers=new Map();
    this.locks=new Map();
  }

  // Charges on one channel run one at a time in this process; the record's
  // compare-and-set below covers another replica.
  async serial(channelId,fn) {
    const previous=this.locks.get(channelId)??Promise.resolve();
    const run=previous.catch(()=>{}).then(fn);
    const tail=run.catch(()=>{});
    this.locks.set(channelId,tail);
    try {return await run;}
    finally {if(this.locks.get(channelId)===tail)this.locks.delete(channelId);}
  }

  open(record) {
    const key=this.config.responseEncryptionKeys.get(record.keyId);
    if(!key)throw new AppError('API_KEY_ENCRYPTION_UNAVAILABLE','The API key encryption key is unavailable',503);
    return decryptJson({keyId:record.keyId,nonce:Buffer.from(record.nonce,'base64'),authTag:Buffer.from(record.authTag,'base64'),
      ciphertext:Buffer.from(record.ciphertext,'base64')},key);
  }

  // The channel a key pays from: the payer's wallet, the key's authorizer,
  // and the gateway's receiver terms.
  channelConfig(row) {
    const terms=this.service.describe();
    return {payer:getAddress(row.payer),payerAuthorizer:getAddress(row.authorizer),receiver:getAddress(terms.payTo),
      receiverAuthorizer:getAddress(terms.receiverAuthorizer),token:getAddress(terms.asset),withdrawDelay:Number(terms.withdrawDelaySeconds),salt:row.salt};
  }

  async create({payer,name,dailyLimitAtomic=null,totalLimitAtomic=null}) {
    payer=getAddress(payer).toLowerCase();
    const {token,prefix,digest}=createApiKey(this.secret,API_KEY_PREFIX);
    let created=await this.store.insert({payer,name,prefix,token_hash:digest,authorizer:null,encrypted_authorizer:null,salt:null,channel_id:null});
    if(dailyLimitAtomic!=null||totalLimitAtomic!=null)created=await this.store.setLimits(created.id,{daily:dailyLimitAtomic,total:totalLimitAtomic});
    return {token,key:this.view(created)};
  }

  // `usage`: this key's running requests and what it was charged (today,
  // total) from the pool; `channel`: an older key's x402 channel, if any.
  view(row,usage={running:0,today:0n,total:0n},channel=null) {
    const s=v=>v==null?null:String(v);
    const legacy=row.channel_id?(()=>{
      const balance=BigInt(channel?.balance??0),charged=BigInt(channel?.chargedCumulativeAmount??0);
      return {channelId:row.channel_id,balanceAtomic:String(balance),chargedAtomic:String(charged),unspentAtomic:String(balance>charged?balance-charged:0n)};
    })():null;
    return {id:row.id,name:row.name,prefix:row.prefix,state:row.state,createdAt:row.created_at,lastUsedAt:row.last_used_at,revokedAt:row.revoked_at,
      dailyLimitAtomic:s(row.daily_limit_atomic),totalLimitAtomic:s(row.total_limit_atomic),
      running:usage.running,spentTodayAtomic:String(usage.today),spentAtomic:String(usage.total),maxConcurrency:this.maxConcurrency,legacyChannel:legacy};
  }

  async list(payer) {
    payer=payer.toLowerCase();
    const rows=await this.store.listByPayer(payer);
    const totals=this.pool?await this.pool.store.keyTotals(payer,new Date(new Date().toISOString().slice(0,10))):new Map();
    return Promise.all(rows.map(async row=>this.view(row,totals.get(row.id),row.channel_id?await this.storage.get(row.channel_id):null)));
  }

  async setLimits(row,{dailyLimitAtomic,totalLimitAtomic}) {
    const limits={daily:dailyLimitAtomic,total:totalLimitAtomic};
    const update=()=>this.store.setLimits(row.id,limits);
    const changed=this.pool?await this.pool.store.withAccount(row.payer,tx=>tx?tx.setKeyLimits(row.id,limits):update()):await update();
    return this.view(changed);
  }

  async owned(payer,id) {
    const row=/^[0-9a-f-]{36}$/.test(String(id))?await this.store.get(id,payer.toLowerCase()):null;
    if(!row)throw new AppError('API_KEY_NOT_FOUND','API key not found',404);
    return row;
  }

  async authenticate(token) {
    if(!TOKEN.test(token))throw new AppError('API_KEY_INVALID','Invalid API key',401);
    const row=await this.store.useToken(hmacSha256(this.secret,token));
    if(!row)throw new AppError('API_KEY_INVALID','Invalid or revoked API key',401);
    const allowed=this.config.AUTH_ALLOWED_ADDRESSES;
    if(allowed?.length&&!allowed.includes(row.payer.toLowerCase()))
      throw new AppError('ADDRESS_NOT_ALLOWED','This wallet is not allowed to use this gateway',403);
    return row;
  }

  signer(row) {
    let signer=this.signers.get(row.id);
    if(!signer) {
      signer=new Wallet(this.open(row.encrypted_authorizer).privateKey);
      if(signer.address.toLowerCase()!==row.authorizer)throw new AppError('API_KEY_AUTHORIZER_MISMATCH','API key signer does not match',500);
      this.signers.set(row.id,signer);
    }
    return signer;
  }

  signVoucher(row,channelId,maxClaimableAmount) {
    return this.signer(row).signTypedData(voucherDomain(),voucherTypes,{channelId,maxClaimableAmount:BigInt(maxClaimableAmount)});
  }

  // Re-signs the voucher at the current total after a deposit or refund
  // replaced it with its own (lower) one.
  resign(row){return this.serial(row.channel_id,()=>this.resignOnce(row));}

  async resignOnce(row) {
    for(let attempt=0;attempt<50;attempt++) {
      const current=await this.storage.get(row.channel_id);
      if(!current||BigInt(current.signedMaxClaimable??0)>=BigInt(current.chargedCumulativeAmount??0)&&current.signature)return;
      const signature=await this.signVoucher(row,row.channel_id,current.chargedCumulativeAmount);
      const result=await this.storage.updateChannel(row.channel_id,latest=>
        latest&&String(latest.chargedCumulativeAmount)===String(current.chargedCumulativeAmount)
          ?{...latest,signedMaxClaimable:String(current.chargedCumulativeAmount),signature}:latest);
      if(result.status==='updated')return;
    }
  }

  // A model request paid with an API key, from the wallet's pool.
  async handle({row,protocol,body,signal}) {
    if(!this.pool)throw new AppError('POOL_UNAVAILABLE','Pool billing is not configured on this gateway',503);
    const plan=await this.service.plan(protocol,body,{limitAtomic:this.requestLimitAtomic,
      bytesPerToken:REALISTIC_BYTES_PER_TOKEN,holdOutputTokens:this.holdOutputTokens});
    const requestId=await this.pool.open({key:row,ceilingAtomic:plan.ceilingAtomic,request:{protocol,model_id:plan.model.model_id,
      price_version_id:plan.model.price_version_id,call_fee_policy_id:plan.model.call_fee_policy_id??null,request_digest:plan.requestDigest??null,
      max_charge_usdc_nano:BigInt(plan.estimate.maxChargeUsdcNano)}});
    const ledger=new PoolKeyLedger({keys:this,row,requestId,plan});
    const gatewayBase={request_id:requestId,price_version_id:plan.model.price_version_id,payment:'api_key'};
    const response=await this.service.gateway.execute({ledger,requestId,request:plan.request,model:plan.model,protocol:protocol==='chat'?null:protocol,
      signal,gatewayBase,context:{requestId,payer:row.payer}});
    return {response};
  }

  // The payment requirements the gateway announces for a path, as a client
  // would read them from the 402.
  async accepted() {
    const outcome=await this.service.handleRefund({headers:{},body:{},method:'POST'});
    const required=decodePaymentRequiredHeader(outcome.headers['PAYMENT-REQUIRED']);
    return {accepted:required.accepts[0],resource:required.resource};
  }

  header(envelope,payload) {
    return Buffer.from(JSON.stringify({x402Version:2,...(envelope.resource?{resource:envelope.resource}:{}),accepted:envelope.accepted,payload})).toString('base64');
  }

  // Returns the channel's unspent balance to the payer's wallet in one
  // transaction (the gateway claims what is owed first). Refused while the
  // key has requests in flight.
  async refund(row) {
    if(!row.channel_id)return {status:200,body:{refunded:false,amountAtomic:'0'}};
    const current=await this.storage.get(row.channel_id);
    if(!current||BigInt(current.balance??0)<=BigInt(current.chargedCumulativeAmount??0))return {status:200,body:{refunded:false,amountAtomic:'0'}};
    if((await this.repository.runningOnChannel(row.channel_id)).count>0)
      throw new AppError('API_KEY_BUSY','Requests are still running on this API key; refund when they finish',409);
    const charged=String(current.chargedCumulativeAmount??0);
    const payload={type:'refund',channelConfig:this.channelConfig(row),
      voucher:{channelId:row.channel_id,maxClaimableAmount:charged,signature:await this.signVoucher(row,row.channel_id,charged)}};
    const outcome=await this.service.handleRefund({headers:{'payment-signature':this.header(await this.accepted(),payload)},body:{},method:'POST'});
    if(outcome.status!==200)return outcome;
    await this.resign(row);
    return {status:200,body:{refunded:true,amountAtomic:String(BigInt(current.balance)-BigInt(charged)),transaction:outcome.body?.transaction??null}};
  }

  async revoke(row) {
    await this.store.revoke(row.id);
    this.signers.delete(row.id);
  }
}

// Ledger for one key-paid request: the actual cost (even above the hold),
// bounded by what the pool can pay; the hold when usage is unknown.
class PoolKeyLedger {
  constructor({keys,row,requestId,plan}) {
    Object.assign(this,{keys,row,requestId,plan,closed:false});
    this.hold=BigInt(plan.estimate.maxChargeUsdcNano);
  }

  async settle({requestId,model,providerResult,gatewayBase}) {
    const reported=providerResult.providerCostUsdNano??null;
    const cost=this.keys.service.gateway.pricing.calculateActual(providerResult.usage,model,reported);
    let atomic=ceilDiv(cost.customerChargeUsdcNano,NANO_PER_ATOMIC);
    if(atomic<1n)atomic=1n;
    const billedFrom=model.bailian_quote?.billing==='reported'&&reported!=null?'provider_cost':'price_table';
    let charge=0n,overrun=0n;
    const close=()=>this.keys.pool.close(this.row.payer,requestId,{atomic,fields:got=>{
      charge=got<atomic?got*NANO_PER_ATOMIC:cost.customerChargeUsdcNano;
      overrun=cost.customerChargeUsdcNano>charge?cost.customerChargeUsdcNano-charge:0n;
      return {actual_charge_usdc_nano:charge,unbilled_overrun_usdc_nano:overrun,charged_from:'usage',
        model_cost_usdc_nano:cost.modelCostUsdcNano??cost.providerCostUsdNano,service_fee_usdc_nano:cost.serviceFeeUsdcNano??0n,
        service_fee_bps:model.call_fee_policy_id?model.service_fee_bps:null,provider_cost_usd_nano:cost.providerCostUsdNano,
        provider_request_id:providerResult.providerRequestId??null,usage_source:providerResult.usageSource??model.provider,
        normalized_usage:providerResult.usage,raw_usage_redacted:{...providerResult.rawUsageRedacted,billed_from:billedFrom}};
    }});
    // The usage is known from here on. A database hiccup while writing it must
    // not turn into a ceiling charge: the write is retried, and if execute()
    // still gives up, fail() tries this same close once more before anything
    // else.
    this.usageClose=close;
    const charged=await retry(close,this.keys.settleRetries??2,this.keys.settleRetryMs??200);
    this.usageClose=null;
    this.closed=true;
    if(charged==null)throw new AppError('POOL_REQUEST_CLOSED','The request was already settled',409);
    return {...gatewayBase,billed_usdc_nano:String(charge),unbilled_overrun_usdc_nano:String(overrun),
      ...(model.call_fee_policy_id?{model_cost_usdc_nano:String(cost.modelCostUsdcNano),service_fee_usdc_nano:String(cost.serviceFeeUsdcNano),
        service_fee_bps:model.service_fee_bps,fee_policy_id:model.call_fee_policy_id}:{})};
  }

  async fail(requestId,error) {
    const log=message=>this.keys.logger.error(JSON.stringify({level:'error',message,requestId,error:error.message}));
    if(this.closed)return error;
    if(error instanceof ProviderError&&error.chargeCertainty==='not_charged') {
      await this.keys.pool.release(this.row.payer,requestId,{status:'failed',failureCode:error.code}).catch(()=>log('pool_release_failed'));
      this.closed=true;
      return new AppError(error.code,error.message,error.statusCode,error.details,{cause:error});
    }
    const code=error instanceof ProviderError?error.code:'UNEXPECTED_USAGE_UNCERTAIN';
    await this.chargeCeiling(requestId,code);
    return error instanceof ProviderError?new AppError(error.code,error.message,error.statusCode,error.details,{cause:error}):error;
  }

  async abandon(requestId){await this.chargeCeiling(requestId,'STREAM_ABANDONED');}

  async chargeCeiling(requestId,code) {
    if(this.closed)return;
    this.closed=true;
    // settle() computed the real charge but could not write it: that write,
    // not the ceiling, is what the request owes.
    if(this.usageClose) {
      const close=this.usageClose;this.usageClose=null;
      try {await close();return;}
      catch(error) {this.keys.logger.error(JSON.stringify({level:'error',message:'pool_usage_close_failed',requestId,error:error.message}));}
    }
    try {
      await this.keys.pool.close(this.row.payer,requestId,{atomic:this.plan.ceilingAtomic,fields:got=>({actual_charge_usdc_nano:got*NANO_PER_ATOMIC,
        charged_from:'ceiling',failure_code:code,usage_source:`ceiling:${code}`})});
    } catch(error) {
      this.keys.logger.error(JSON.stringify({level:'error',message:'pool_ceiling_charge_failed',requestId,code,error:error.message}));
    }
  }

  async cache(){}
}
