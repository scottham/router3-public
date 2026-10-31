import { queryMany, queryOne } from '../db/pool.js';

// The catalog as the gateway reads it: a model with its active price version
// and the current per-call fee policy. Models whose synced catalog is stale or
// marked offline are not served.
const FRESH = `not exists(select 1 from private.bailian_catalog_state s where s.model_id=m.id
  and (s.synced_at<=now()-make_interval(secs=>$1) or s.offline_at<=now()))`;

export class GatewayRepository {
  constructor(pool, config = {}) {
    this.pool = pool;
    this.config = config;
  }

  get maxAge() { return this.config.CATALOG_MAX_AGE_SECONDS ?? 129600; }

  async getModelAndPrice(publicName) {
    return queryOne(this.pool,
      `select m.id as model_id, m.public_name, m.provider, m.provider_model,
              m.modality, m.capabilities,
              pv.id as price_version_id, pv.provider_quote, pv.bailian_quote,
              fee.id as call_fee_policy_id,fee.service_fee_bps,
              pv.customer_input_usdc_nano_per_million,
              pv.customer_cached_input_usdc_nano_per_million,
              pv.customer_output_usdc_nano_per_million,
              pv.customer_reasoning_usdc_nano_per_million,
              pv.provider_input_usd_nano_per_million,
              pv.provider_cached_input_usd_nano_per_million,
              pv.provider_output_usd_nano_per_million,
              pv.provider_reasoning_usd_nano_per_million
       from public.model_catalog m
       join lateral (
         select * from private.model_price_versions pv
         where pv.model_id = m.id and pv.effective_from <= now()
           and (pv.effective_until is null or pv.effective_until > now())
         order by pv.effective_from desc limit 1
       ) pv on true
       left join lateral(select id,service_fee_bps from private.call_fee_policies
         where effective_from<=now() order by effective_from desc limit 1) fee on true
       where m.public_name = $2 and m.enabled = true and ${FRESH}`,
      [this.maxAge, publicName]);
  }

  // Models anyone may pay for through a channel: enabled, priced and fresh.
  async listPublicModels() {
    return queryMany(this.pool,
      `select m.id, m.public_name, m.provider, m.created_at
       from public.model_catalog m
       join lateral (
         select 1 from private.model_price_versions pv
         where pv.model_id = m.id and pv.effective_from <= now()
           and (pv.effective_until is null or pv.effective_until > now())
         limit 1
       ) pv on true
       where m.enabled = true and ${FRESH}
       order by m.public_name`, [this.maxAge]);
  }

  // The console's catalog: the same models with their prices and the fee.
  async listCatalog() {
    return queryMany(this.pool,
      `select m.id, m.public_name, m.provider, m.modality, m.capabilities,
              p.id as price_version_id, p.effective_from,
              fee.service_fee_bps,fee.id as call_fee_policy_id,
              p.customer_input_usdc_nano_per_million,
              p.customer_cached_input_usdc_nano_per_million,
              p.customer_output_usdc_nano_per_million,
              p.customer_reasoning_usdc_nano_per_million
       from public.model_catalog m
       join lateral (
         select * from private.model_price_versions pv
         where pv.model_id = m.id and pv.effective_from <= now()
           and (pv.effective_until is null or pv.effective_until > now())
         order by pv.effective_from desc limit 1
       ) p on true
       left join lateral(select id,service_fee_bps from private.call_fee_policies
         where effective_from<=now() order by effective_from desc limit 1) fee on true
       where m.enabled = true and ${FRESH}
       order by m.public_name`, [this.maxAge]);
  }
}
