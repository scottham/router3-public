import {getAddress} from 'ethers';
import {HTTPFacilitatorClient,x402HTTPResourceServer,x402ResourceServer} from '@x402/core/server';
import {decodePaymentRequiredHeader,decodePaymentResponseHeader,decodePaymentSignatureHeader} from '@x402/core/http';
import {BatchSettlementEvmScheme} from '@x402/evm/batch-settlement/server';
import {BATCH_SETTLEMENT_ADDRESS,ERC3009_DEPOSIT_COLLECTOR_ADDRESS,findDefaultAsset,isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload} from '@x402/evm';
import {AppError,publicError} from '../lib/errors.js';
import {ceilDiv,parseDecimalToNano} from '../lib/money.js';
import {ProviderError} from '../providers/provider-error.js';
import {PROTOCOLS} from './../services/gateway-service.js';
import {CHAIN_ID,USDC_ADDRESS} from '../chain.js';

// How every model call is paid: the x402 Foundation `batch-settlement`
// scheme. A payer deposits USDC once into the shared x402BatchSettlement
// contract on Monad, then signs one cumulative voucher per request. The 402 names the request's ceiling (the same hold the
// pool path reserves, rounded up to a micro USDC); after the call the gateway
// settles the actual charge against the voucher. Nothing goes on-chain per
// request: claims are batched (src/workers/x402-settlement-worker.js) and the
// facilitator pays their gas. Deposits, claims, refunds and the receipt
// headers follow the SDK; this file only decides prices, runs the model call
// and keeps the ledger.
export const X402_NETWORK=`eip155:${CHAIN_ID}`;
export const X402_SCHEME='batch-settlement';
export const PROTOCOL_PATHS=Object.freeze({chat:'/v1/chat/completions',anthropic:'/v1/messages',responses:'/v1/responses'});
export const DEPOSIT_PATH='/v1/x402/deposit';
export const REFUND_PATH='/v1/x402/refund';
// A voucher reservation lives at most 10 minutes in the SDK, so the ceiling
// must be settled before a 600 s stream plus settlement ends; the stream
// budget is capped to fit (see loadConfig).
export const MAX_TIMEOUT_SECONDS=600;
const NANO_PER_ATOMIC=1000n;

export const usdcAtomic=value=>parseDecimalToNano(value)/NANO_PER_ATOMIC;

export class X402SettlementError extends AppError {
  constructor(settlement) {
    super('X402_SETTLEMENT_FAILED',settlement.errorMessage||settlement.errorReason||'Payment settlement failed',402,
      {reason:settlement.errorReason??null});
  }
}

export function isPaymentHeader(headers) {
  return typeof headers['payment-signature']==='string';
}

// The channel a signed request pays from, for rate limiting: cheap to decode,
// unverified, so it only picks a bucket.
export function paymentChannelOf(header) {
  try {
    const payload=decodePaymentSignatureHeader(header);
    const id=payload?.payload?.voucher?.channelId;
    return /^0x[0-9a-fA-F]{64}$/.test(id??'')?id.toLowerCase():null;
  } catch {return null;}
}

// What the SDK's HTTP layer needs from a Fastify request, plus the priced plan
// the route options read lazily (price, unpaid body).
class RequestAdapter {
  constructor(service,{headers,path,body,protocol,method='POST'}) {
    Object.assign(this,{service,headers,path,body,protocol,method});
  }
  getHeader(name){const value=this.headers[name.toLowerCase()];return Array.isArray(value)?value[0]:value;}
  getMethod(){return this.method;}
  getPath(){return this.path;}
  getUrl(){return `${this.service.publicUrl}${this.path}`;}
  getAcceptHeader(){return this.getHeader('accept')??'';}
  getUserAgent(){return this.getHeader('user-agent')??'';}
  getBody(){return this.body;}
  plan(){this.planned??=this.service.plan(this.protocol,this.body);return this.planned;}
  async price(){return this.service.assetAmount((await this.plan()).ceilingAtomic);}
}

export class X402Service {
  constructor({config,gateway,repository,storage,authorizer,facilitator,fetchImpl=fetch,logger=console}) {
    const treasury=getAddress(config.TREASURY_ADDRESS);
    const asset=findDefaultAsset(USDC_ADDRESS,X402_NETWORK);
    if(!asset)throw new Error('X402_ASSET_UNKNOWN');
    Object.assign(this,{config,gateway,repository,storage,logger,treasury,asset,ready:false,initError:null});
    this.publicUrl=String(config.PUBLIC_APP_URL??'').replace(/\/+$/,'');
    this.minDepositAtomic=usdcAtomic(config.X402_MIN_DEPOSIT_USDC);
    this.requestLimitAtomic=usdcAtomic(config.X402_REQUEST_LIMIT_USDC);
    this.maxChannelsPerPayer=config.X402_MAX_CHANNELS_PER_PAYER??128;
    this.allowedPayers=config.AUTH_ALLOWED_ADDRESSES?.length?new Set(config.AUTH_ALLOWED_ADDRESSES):null;
    this.facilitator=facilitator??new HTTPFacilitatorClient({url:config.X402_FACILITATOR_URL,timeoutMs:config.X402_FACILITATOR_TIMEOUT_MS});
    this.scheme=new BatchSettlementEvmScheme(treasury,{storage,receiverAuthorizerSigner:authorizer,
      withdrawDelay:config.X402_WITHDRAW_DELAY_SECONDS});
    this.server=new x402ResourceServer(this.facilitator).register(X402_NETWORK,this.scheme);
    // Payer allowlist: the same list that limits console sign-in. Rejected
    // before any state is touched. A wallet may open a bounded number of
    // channels (one per concurrent request it wants to run).
    this.server.onBeforeVerify(async({paymentPayload})=>{
      const raw=paymentPayload?.payload;
      const payer=raw?.channelConfig?.payer;
      if(this.allowedPayers&&(typeof payer!=='string'||!this.allowedPayers.has(payer.toLowerCase())))
        return {abort:true,reason:'payer_not_allowed',message:'This wallet is not allowed to use this gateway'};
      if(isBatchSettlementDepositPayload(raw)&&typeof raw.voucher?.channelId==='string'&&!(await this.storage.get(raw.voucher.channelId).catch(()=>undefined))
        &&await this.repository.countChannels(payer.toLowerCase())>=this.maxChannelsPerPayer)
        return {abort:true,reason:'too_many_channels',message:`This wallet already has ${this.maxChannelsPerPayer} channels`};
    });
    const accepts=price=>({scheme:X402_SCHEME,network:X402_NETWORK,payTo:treasury,price,maxTimeoutSeconds:MAX_TIMEOUT_SECONDS,
      extra:{minDeposit:String(this.minDepositAtomic)}});
    const modelRoute={accepts:accepts(ctx=>ctx.adapter.price()),
      unpaidResponseBody:ctx=>({contentType:'application/json',body:{}}),
      settlementFailedResponseBody:(ctx,failure)=>({contentType:'application/json',
        body:this.errorBody(ctx.adapter.protocol,402,{code:'X402_SETTLEMENT_FAILED',message:failure.errorMessage??failure.errorReason,
          details:{reason:failure.errorReason}})}),
      fetchImpl};
    const routes={};
    for(const path of Object.values(PROTOCOL_PATHS))routes[`POST ${path}`]=modelRoute;
    // Opening or topping up a channel without a model call costs one micro
    // USDC: the voucher must move for the deposit to carry it.
    routes[`POST ${DEPOSIT_PATH}`]={accepts:accepts(this.assetAmount(1n))};
    // The SDK's refund helper probes and submits with GET.
    for(const method of ['GET','POST'])routes[`${method} ${REFUND_PATH}`]={accepts:accepts(this.assetAmount(0n))};
    this.http=new x402HTTPResourceServer(this.server,routes);
  }

  // Fetches the facilitator's supported kinds; retried in the background
  // until it succeeds, and x402 requests answer 503 meanwhile.
  async initialize({retries=Infinity,delayMs=15000,signal}={}) {
    for(let attempt=0;;attempt++) {
      try {await this.http.initialize();this.ready=true;this.initError=null;return true;}
      catch(error) {
        this.initError=error;
        this.logger.error(JSON.stringify({level:'error',message:'x402_initialize_failed',error:error.message}));
        if(attempt>=retries||signal?.aborted)return false;
        await new Promise(resolve=>setTimeout(resolve,delayMs).unref?.());
      }
    }
  }

  assetAmount(atomic){return {amount:String(atomic),asset:this.asset.asset,extra:{name:this.asset.name,version:this.asset.version}};}

  describe() {
    return {scheme:X402_SCHEME,network:X402_NETWORK,chainId:CHAIN_ID,asset:this.asset.asset,assetName:this.asset.name,assetVersion:this.asset.version,
      payTo:this.treasury,receiverAuthorizer:this.scheme.getReceiverAuthorizerSigner()?.address??null,
      withdrawDelaySeconds:this.scheme.getWithdrawDelay(),minDepositAtomic:String(this.minDepositAtomic),
      requestLimitAtomic:String(this.requestLimitAtomic),maxChannelsPerPayer:this.maxChannelsPerPayer,maxTimeoutSeconds:MAX_TIMEOUT_SECONDS,
      contract:BATCH_SETTLEMENT_ADDRESS,depositCollector:ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
      facilitator:this.facilitator.url??null,paths:{...PROTOCOL_PATHS,deposit:DEPOSIT_PATH,refund:REFUND_PATH},ready:this.ready};
  }

  errorBody(protocol,statusCode,error,requestId) {
    const format=PROTOCOLS[protocol]?.errorBody;
    return format?format(statusCode,error,requestId):{error:{...error,...(requestId?{request_id:requestId}:{})}};
  }

  // Validates and prices one request: the gateway's hold becomes the voucher
  // ceiling in micro USDC.
  // API keys pass their own limit, a realistic input estimate and a cap on
  // the output held.
  async plan(protocol,body,{limitAtomic=this.requestLimitAtomic,bytesPerToken=1,holdOutputTokens=null}={}) {
    const plan=await this.gateway.prepare({protocol:protocol==='chat'?null:protocol,body,budgetNano:limitAtomic*NANO_PER_ATOMIC,bytesPerToken,holdOutputTokens});
    const ceilingAtomic=ceilDiv(BigInt(plan.estimate.maxChargeUsdcNano),NANO_PER_ATOMIC)||1n;
    if(ceilingAtomic>limitAtomic) {
      throw new AppError('X402_REQUEST_LIMIT','This request could cost more than the per-request limit; lower max_tokens',402,
        {ceilingAtomic:String(ceilingAtomic),limitAtomic:String(limitAtomic)});
    }
    return {...plan,ceilingAtomic};
  }

  // One model request paid through a channel. Returns `{status,headers,body}`
  // to send, or `{response}` from the gateway (a body or a GatewayStream).
  async handle({protocol,headers,body,signal}) {
    if(!this.ready)throw new AppError('X402_UNAVAILABLE','x402 payments are unavailable; try again shortly',503);
    const path=PROTOCOL_PATHS[protocol];
    const adapter=new RequestAdapter(this,{headers,path,body,protocol});
    const result=await this.http.processHTTPRequest({adapter,path,method:'POST'});
    if(result.type!=='payment-verified')return this.instructions(result,protocol);
    const plan=await adapter.plan();
    const raw=result.paymentPayload.payload;
    const channelId=raw.voucher.channelId.toLowerCase(),payer=raw.channelConfig.payer.toLowerCase();
    const requestId=await this.repository.openRequest({channelId,payer,protocol,modelId:plan.model.model_id,priceVersionId:plan.model.price_version_id,
      callFeePolicyId:plan.model.call_fee_policy_id,requestDigest:plan.requestDigest,maxChargeUsdcNano:plan.estimate.maxChargeUsdcNano,
      ceilingAtomic:plan.ceilingAtomic});
    const ledger=new ChannelLedger({service:this,requestId,plan,payment:result,transport:{request:{adapter,path,method:'POST'}}});
    const gatewayBase={request_id:requestId,price_version_id:plan.model.price_version_id,payment:'x402'};
    const response=await this.gateway.execute({ledger,requestId,request:plan.request,model:plan.model,protocol:protocol==='chat'?null:protocol,
      signal,gatewayBase,context:{requestId,payer,channelId}});
    return {response};
  }

  // A deposit without a model call: opens or tops up the payer's channel.
  async handleDeposit({headers,body}) {
    if(!this.ready)throw new AppError('X402_UNAVAILABLE','x402 payments are unavailable; try again shortly',503);
    const adapter=new RequestAdapter(this,{headers,path:DEPOSIT_PATH,body,protocol:'deposit'});
    const result=await this.http.processHTTPRequest({adapter,path:DEPOSIT_PATH,method:'POST'});
    if(result.type!=='payment-verified')return this.instructions(result,'deposit');
    const raw=result.paymentPayload.payload;
    const channelId=raw.voucher.channelId.toLowerCase(),payer=raw.channelConfig.payer.toLowerCase();
    const requestId=await this.repository.openRequest({channelId,payer,protocol:'deposit',maxChargeUsdcNano:NANO_PER_ATOMIC,ceilingAtomic:1n});
    const settlement=await this.http.processSettlement(result.paymentPayload,result.paymentRequirements,result.declaredExtensions,
      {request:{adapter,path:DEPOSIT_PATH,method:'POST'}});
    if(!settlement.success) {
      await this.repository.fail(requestId,'settlement_failed',settlement.errorReason??'X402_SETTLEMENT_FAILED');
      return this.instructions({type:'payment-error',response:settlement.response},'deposit');
    }
    const cumulative=settlement.extra?.channelState?.chargedCumulativeAmount??null;
    await this.repository.complete(requestId,{actualChargeUsdcNano:NANO_PER_ATOMIC,chargedAtomic:1n,cumulativeAtomic:cumulative,chargedFrom:'usage',
      usageSource:'x402:deposit',settlementTransaction:settlement.transaction});
    await this.journalDeposit(raw,settlement,requestId);
    const channel=await this.storage.get(channelId);
    return {status:200,headers:settlement.headers,body:{channel:publicChannel(channel),request_id:requestId,transaction:settlement.transaction||null}};
  }

  // A cooperative refund: the payer signs a zero-charge voucher, the gateway
  // signs the claim of what it is owed and the refund of the rest, and the
  // facilitator submits both in one transaction. The SDK handles it inside
  // verification; this only journals the result.
  async handleRefund({headers,body,method='POST'}) {
    if(!this.ready)throw new AppError('X402_UNAVAILABLE','x402 payments are unavailable; try again shortly',503);
    const adapter=new RequestAdapter(this,{headers,path:REFUND_PATH,body,protocol:'refund',method});
    const result=await this.http.processHTTPRequest({adapter,path:REFUND_PATH,method});
    const instructions=this.instructions(result,'refund');
    const receipt=instructions.headers?.['PAYMENT-RESPONSE'];
    if(instructions.status===200&&receipt) {
      const settlement=decodePaymentResponseHeader(receipt);
      const payload=decodePaymentSignatureHeader(adapter.getHeader('payment-signature')).payload;
      await this.repository.recordSettlement({kind:'refund',channelId:payload.voucher.channelId.toLowerCase(),transaction:settlement.transaction,
        vouchers:1,amountAtomic:/^\d+$/.test(payload.amount??'')?payload.amount:null,detail:{payer:payload.channelConfig.payer.toLowerCase()}});
      instructions.body={...instructions.body,transaction:settlement.transaction||null};
    }
    return instructions;
  }

  async journalDeposit(raw,settlement,requestId) {
    if(!isBatchSettlementDepositPayload(raw)||!settlement.transaction)return;
    // The settled balance comes from the facilitator's read of the channel,
    // which a lagging RPC node can return from before the deposit (seen as
    // balance 0 after a confirmed deposit). The deposit alone is a floor;
    // the collector raises the rest from the chain.
    await this.storage.updateChannel(raw.voucher.channelId,current=>
      current&&BigInt(current.balance??'0')<BigInt(raw.deposit.amount)?{...current,balance:String(raw.deposit.amount)}:current)
      .catch(error=>this.logger.error(JSON.stringify({level:'error',message:'x402_deposit_floor_failed',requestId,error:error.message})));
    await this.repository.recordSettlement({kind:'deposit',channelId:raw.voucher.channelId.toLowerCase(),transaction:settlement.transaction,
      amountAtomic:raw.deposit.amount,detail:{requestId,payer:raw.channelConfig.payer.toLowerCase()}}).catch(error=>
      this.logger.error(JSON.stringify({level:'error',message:'x402_deposit_journal_failed',requestId,error:error.message})));
  }

  // Turns the SDK's response instructions into a protocol-shaped error body;
  // the 402 keeps its PAYMENT-REQUIRED header and gains a readable copy.
  instructions(result,protocol) {
    const {status,headers,body}=result.response;
    if(status===402&&headers['PAYMENT-REQUIRED']) {
      const required=decodePaymentRequiredHeader(headers['PAYMENT-REQUIRED']);
      const unpaid=!required.error||required.error==='Payment required';
      const code=unpaid?'PAYMENT_REQUIRED':required.error==='payer_not_allowed'?'ADDRESS_NOT_ALLOWED'
        :required.error==='too_many_channels'?'X402_CHANNEL_LIMIT':'X402_PAYMENT_INVALID';
      const message=unpaid?'Payment required: sign a batch-settlement voucher for the amount in PAYMENT-REQUIRED':
        code==='ADDRESS_NOT_ALLOWED'?'This wallet is not allowed to use this gateway':
        code==='X402_CHANNEL_LIMIT'?`This wallet already has ${this.maxChannelsPerPayer} channels; refund an idle one before opening another`:`Payment rejected: ${required.error}`;
      return {status,headers,body:this.errorBody(protocol,402,{code,message,details:{x402:{error:required.error??null,accepts:required.accepts}}})};
    }
    if(status===403)return {status,headers,body:this.errorBody(protocol,403,{code:'X402_FORBIDDEN',message:String(body?.error??'Forbidden')})};
    return {status,headers,body};
  }
}

// Ledger for one channel-paid request: settles the actual charge against the
// voucher (never more than its ceiling), and charges the ceiling when usage
// is unknown, since that is what the payer signed for.
class ChannelLedger {
  constructor({service,requestId,plan,payment,transport}) {
    Object.assign(this,{service,requestId,plan,payment,transport,charged:false});
    this.hold=BigInt(plan.estimate.maxChargeUsdcNano);
  }

  async processSettlement(atomic) {
    const {paymentPayload,paymentRequirements,declaredExtensions}=this.payment;
    return this.service.http.processSettlement(paymentPayload,paymentRequirements,declaredExtensions,this.transport,{amount:String(atomic)});
  }

  async settle({requestId,model,providerResult,gatewayBase}) {
    const reported=providerResult.providerCostUsdNano??null;
    const cost=this.service.gateway.pricing.calculateActual(providerResult.usage,model,reported);
    const charge=cost.customerChargeUsdcNano<=this.hold?cost.customerChargeUsdcNano:this.hold;
    const overrun=cost.customerChargeUsdcNano>this.hold?cost.customerChargeUsdcNano-this.hold:0n;
    let atomic=ceilDiv(charge,NANO_PER_ATOMIC);
    if(atomic<1n)atomic=1n;
    if(atomic>this.plan.ceilingAtomic)atomic=this.plan.ceilingAtomic;
    const settlement=await this.processSettlement(atomic);
    if(!settlement.success)throw new X402SettlementError(settlement);
    this.charged=true;
    const cumulative=settlement.extra?.channelState?.chargedCumulativeAmount??null;
    const billedFrom=model.bailian_quote?.billing==='reported'&&reported!=null?'provider_cost':'price_table';
    await this.service.repository.complete(requestId,{
      actualChargeUsdcNano:charge,unbilledOverrunUsdcNano:overrun,chargedAtomic:atomic,cumulativeAtomic:cumulative,chargedFrom:'usage',
      modelCostUsdcNano:cost.modelCostUsdcNano??cost.providerCostUsdNano,serviceFeeUsdcNano:cost.serviceFeeUsdcNano??0n,
      serviceFeeBps:model.call_fee_policy_id?model.service_fee_bps:null,providerCostUsdNano:cost.providerCostUsdNano,
      providerRequestId:providerResult.providerRequestId??null,usageSource:providerResult.usageSource??model.provider,
      normalizedUsage:providerResult.usage,rawUsageRedacted:{...providerResult.rawUsageRedacted,billed_from:billedFrom},
      settlementTransaction:settlement.transaction});
    await this.service.journalDeposit(this.payment.paymentPayload.payload,settlement,requestId);
    return {...gatewayBase,billed_usdc_nano:String(charge),unbilled_overrun_usdc_nano:String(overrun),
      ...(model.call_fee_policy_id?{model_cost_usdc_nano:String(cost.modelCostUsdcNano),service_fee_usdc_nano:String(cost.serviceFeeUsdcNano),
        service_fee_bps:model.service_fee_bps,fee_policy_id:model.call_fee_policy_id}:{}),
      x402:{charged_atomic:String(atomic),cumulative_atomic:cumulative,ceiling_atomic:String(this.plan.ceilingAtomic),
        transaction:settlement.transaction||null,payment_response:settlement.headers['PAYMENT-RESPONSE']}};
  }

  async fail(requestId,error) {
    const log=message=>this.service.logger.error(JSON.stringify({level:'error',message,requestId,error:error.message}));
    if(error instanceof X402SettlementError) {
      await this.service.repository.fail(requestId,'settlement_failed',error.details?.reason??error.code).catch(()=>log('x402_ledger_write_failed'));
      return error;
    }
    if(this.charged) {
      // Settled on the channel, then failed to record or deliver: keep the
      // row visible for reconciliation against the channel state.
      await this.service.repository.fail(requestId,'settlement_failed','LEDGER_WRITE_FAILED').catch(()=>log('x402_ledger_write_failed'));
      return error;
    }
    if(error instanceof ProviderError&&error.chargeCertainty==='not_charged') {
      await this.payment.cancellationDispatcher.cancel({reason:'handler_failed',error,responseStatus:error.statusCode}).catch(()=>log('x402_cancel_failed'));
      await this.service.repository.fail(requestId,'failed',error.code).catch(()=>log('x402_ledger_write_failed'));
      return new AppError(error.code,error.message,error.statusCode,error.details,{cause:error});
    }
    const code=error instanceof ProviderError?error.code:'UNEXPECTED_USAGE_UNCERTAIN';
    await this.chargeCeiling(requestId,code);
    return error instanceof ProviderError?new AppError(error.code,error.message,error.statusCode,error.details,{cause:error}):error;
  }

  async abandon(requestId){await this.chargeCeiling(requestId,'STREAM_ABANDONED');}

  // Usage unknown (stream cut off, timeout, unexpected error after the
  // provider boundary): the provider bills us for what it generated, and the
  // payer signed the ceiling for exactly this request.
  async chargeCeiling(requestId,code) {
    if(this.charged)return;
    const log=(message,error)=>this.service.logger.error(JSON.stringify({level:'error',message,requestId,code,error:error?.message}));
    try {
      const settlement=await this.processSettlement(this.plan.ceilingAtomic);
      if(!settlement.success) {
        log('x402_ceiling_charge_rejected',new Error(settlement.errorReason));
        await this.service.repository.fail(requestId,'settlement_failed',settlement.errorReason??code);
        return;
      }
      this.charged=true;
      await this.service.repository.complete(requestId,{actualChargeUsdcNano:this.hold,chargedAtomic:this.plan.ceilingAtomic,
        cumulativeAtomic:settlement.extra?.channelState?.chargedCumulativeAmount??null,chargedFrom:'ceiling',failureCode:code,
        usageSource:`ceiling:${code}`,settlementTransaction:settlement.transaction});
      await this.service.journalDeposit(this.payment.paymentPayload.payload,settlement,requestId);
    } catch(error) {
      log('x402_ceiling_charge_failed',error);
      await this.service.repository.fail(requestId,this.charged?'settlement_failed':'failed',this.charged?'LEDGER_WRITE_FAILED':code).catch(()=>{});
    }
  }

  // Channel payments have no idempotent replay: the voucher is the receipt.
  async cache(){}
}

export function publicChannel(channel) {
  if(!channel)return null;
  return {channelId:channel.channelId,config:channel.channelConfig,chargedCumulativeAtomic:channel.chargedCumulativeAmount,
    balanceAtomic:channel.balance,totalClaimedAtomic:channel.totalClaimed,withdrawRequestedAt:channel.withdrawRequestedAt,
    refundNonce:channel.refundNonce,lastRequestAt:channel.lastRequestTimestamp?new Date(channel.lastRequestTimestamp).toISOString():null,
    onchainSyncedAt:channel.onchainSyncedAt?new Date(channel.onchainSyncedAt).toISOString():null};
}

// Maps an AppError thrown before the gateway took over into the protocol's
// error body.
export function x402ErrorResponse(protocol,error) {
  const result=publicError(error);
  return {status:result.statusCode,body:PROTOCOLS[protocol]?.errorBody?.(result.statusCode,result.body.error,error.details?.requestId)??result.body};
}

export {isBatchSettlementRefundPayload};
