import {queryMany,queryOne} from '../db/pool.js';

// The x402 ledger: one row per paid request, the channel mirror the SDK
// storage keeps, and the journal of on-chain claims, settles and refunds.
export class X402Repository {
  constructor(pool){this.pool=pool;}

  async openRequest(input) {
    const row=await queryOne(this.pool,`insert into private.x402_requests(channel_id,payer,protocol,model_id,price_version_id,call_fee_policy_id,
        request_digest,max_charge_usdc_nano,ceiling_atomic,api_key_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [input.channelId,input.payer,input.protocol,input.modelId??null,input.priceVersionId??null,input.callFeePolicyId??null,
        input.requestDigest??null,String(input.maxChargeUsdcNano),String(input.ceilingAtomic),input.apiKeyId??null]);
    return row.id;
  }

  async complete(requestId,input) {
    await this.pool.query(`update private.x402_requests set status='completed',actual_charge_usdc_nano=$2,unbilled_overrun_usdc_nano=$3,
        charged_atomic=$4,cumulative_atomic=$5,charged_from=$6,model_cost_usdc_nano=$7,service_fee_usdc_nano=$8,service_fee_bps=$9,
        provider_cost_usd_nano=$10,provider_request_id=$11,usage_source=$12,normalized_usage=$13,raw_usage_redacted=$14,
        settlement_transaction=$15,failure_code=$16,completed_at=now()
      where id=$1 and status='running'`,
      [requestId,String(input.actualChargeUsdcNano),String(input.unbilledOverrunUsdcNano??0),String(input.chargedAtomic),
        input.cumulativeAtomic==null?null:String(input.cumulativeAtomic),input.chargedFrom,
        input.modelCostUsdcNano==null?null:String(input.modelCostUsdcNano),input.serviceFeeUsdcNano==null?null:String(input.serviceFeeUsdcNano),
        input.serviceFeeBps??null,input.providerCostUsdNano==null?null:String(input.providerCostUsdNano),input.providerRequestId??null,
        input.usageSource??null,input.normalizedUsage??null,input.rawUsageRedacted??null,input.settlementTransaction||null,input.failureCode??null]);
  }

  async fail(requestId,status,failureCode,detail=null) {
    await this.pool.query(`update private.x402_requests set status=$2,failure_code=$3,raw_usage_redacted=coalesce($4,raw_usage_redacted),completed_at=now()
      where id=$1 and status='running'`,[requestId,status,failureCode,detail]);
  }

  async recordSettlement(input) {
    await this.pool.query('insert into private.x402_settlements(kind,channel_id,transaction,vouchers,amount_atomic,detail) values($1,$2,$3,$4,$5,$6)',
      [input.kind,input.channelId??null,input.transaction||null,input.vouchers??0,input.amountAtomic==null?null:String(input.amountAtomic),input.detail??null]);
  }

  // Claimed funds that no later settle moved to the receiver. A cooperative
  // refund claims what the channel owed in the same transaction.
  async hasUnsettledClaims() {
    const row=await queryOne(this.pool,`select exists(select 1 from private.x402_settlements c where c.kind in('claim','refund')
      and not exists(select 1 from private.x402_settlements s where s.kind='settle' and s.created_at>=c.created_at)) pending`);
    return row.pending;
  }

  // In-flight requests on a channel and the sum of their ceilings: the holds
  // an API key's channel has reserved.
  async runningOnChannel(channelId) {
    const row=await queryOne(this.pool,`select count(*)::int n,coalesce(sum(ceiling_atomic),0)::text ceiling from private.x402_requests
      where channel_id=$1 and status='running'`,[channelId.toLowerCase()]);
    return {count:row.n,ceilingAtomic:BigInt(row.ceiling)};
  }

  async requestsForApiKey(apiKeyId,limit=100) {
    return queryMany(this.pool,`select r.id,r.created_at,r.status,r.failure_code,r.protocol,m.public_name model,
        extract(epoch from (r.completed_at-r.started_at))*1000 latency_ms,
        r.actual_charge_usdc_nano::text charge_nano,r.max_charge_usdc_nano::text max_charge_nano,r.charged_atomic::text charged_atomic,
        r.charged_from,r.model_cost_usdc_nano::text model_cost_nano,r.service_fee_usdc_nano::text service_fee_nano,r.normalized_usage usage
      from private.x402_requests r left join public.model_catalog m on m.id=r.model_id
      where r.api_key_id=$1 order by r.created_at desc limit $2`,[apiKeyId,limit]);
  }

  async countChannels(payer) {
    const row=await queryOne(this.pool,'select count(*)::int n from private.x402_channels where payer=$1',[payer.toLowerCase()]);
    return row.n;
  }

  async channelsForPayers(payers) {
    return queryMany(this.pool,`select c.channel_id,c.payer,c.payer_authorizer,c.state->'channelConfig' config,c.charged_cumulative_atomic::text charged_atomic,
        c.balance_atomic::text balance_atomic,c.total_claimed_atomic::text claimed_atomic,c.withdraw_requested_at,c.state->>'refundNonce' refund_nonce,
        c.last_request_at,c.created_at,(c.state->>'onchainSyncedAt')::bigint onchain_synced_at,
        (select count(*) from private.x402_requests r where r.channel_id=c.channel_id and r.status='completed')::int requests
      from private.x402_channels c where c.payer=any($1)
        and not exists(select 1 from private.api_keys k where k.channel_id=c.channel_id) order by c.updated_at desc`,[payers.map(p=>p.toLowerCase())]);
  }

  async requestsForChannel(channelId,payers,limit=100) {
    return queryMany(this.pool,`select r.id,r.created_at,r.status,r.failure_code,r.protocol,m.public_name model,
        extract(epoch from (r.completed_at-r.started_at))*1000 latency_ms,
        r.actual_charge_usdc_nano::text charge_nano,r.max_charge_usdc_nano::text max_charge_nano,r.charged_atomic::text charged_atomic,
        r.cumulative_atomic::text cumulative_atomic,r.charged_from,r.model_cost_usdc_nano::text model_cost_nano,
        r.service_fee_usdc_nano::text service_fee_nano,r.normalized_usage usage,r.settlement_transaction
      from private.x402_requests r left join public.model_catalog m on m.id=r.model_id
      where r.channel_id=$1 and r.payer=any($2) order by r.created_at desc limit $3`,[channelId.toLowerCase(),payers.map(p=>p.toLowerCase()),limit]);
  }
}
