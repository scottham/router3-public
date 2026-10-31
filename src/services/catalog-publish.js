import { z } from 'zod';
import { applyBasisPoints, parseDecimalToNano } from '../lib/money.js';
import {canonicalize} from '../lib/crypto.js';

const rate = z.string().regex(/^\d{1,6}(\.\d{1,9})?$/);
const modelSchema = z.object({
  publicName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
  providerModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  usdPerMillion: z.object({input:rate,cachedInput:rate,output:rate,reasoning:rate}),
  sourceReference: z.url(),
  reviewedAt: z.iso.date(),
  bailianQuote: z.record(z.string(),z.unknown()).optional(),
  bailianState: z.object({syncedAt:z.iso.datetime(),offlineAt:z.iso.datetime().nullable()}).optional()
}).strict();

// Operator-only catalog publication; never called with public API credentials.
// All prices are immutable. Re-running the same inputs creates no new version.
// bailianQuote/bailianState carry a synced tier quote (DeepSeek, OpenRouter);
// the names follow the bailian_quote column and bailian_catalog_state table.
export async function publishCatalog(client, entries, markupBps, {replaceProvider=null}={}) {
  const models = z.array(modelSchema).min(1).parse(entries);
  z.number().int().min(0).max(10000).parse(markupBps);
  if (new Set(models.map(m => m.publicName)).size !== models.length) throw new Error('Duplicate catalog model');
  const changed = [];
  await client.query('begin');
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('router3-catalog-publish'))");
    if(replaceProvider)await client.query('update public.model_catalog set enabled=false where provider=$1',[replaceProvider]);
    for (const model of models) {
      if((model.bailianQuote&&!model.bailianState)||(model.bailianState&&!model.bailianQuote))throw new Error('TIER_QUOTE_REQUIRED');
      const capabilities = {...model.capabilities, markupBps};
      // The same upstream model may already exist under an older public name
      // (early migrations seeded deepseek/deepseek-v4-flash for deepseek-flash);
      // (provider, provider_model) is unique, so that row takes the new name.
      await client.query(`update public.model_catalog set public_name=$1 where provider=$2 and provider_model=$3 and public_name<>$1
        and not exists(select 1 from public.model_catalog where public_name=$1)`,[model.publicName,model.provider,model.providerModel]);
      const {rows:[row]} = await client.query(`insert into public.model_catalog(public_name,provider,provider_model,enabled,capabilities)
        values($1,$2,$3,true,$4) on conflict(public_name) do update set provider=excluded.provider,
        provider_model=excluded.provider_model,enabled=true,capabilities=excluded.capabilities returning id`,
      [model.publicName,model.provider,model.providerModel,capabilities]);
      if(model.bailianState)await client.query(`insert into private.bailian_catalog_state(model_id,synced_at,source_region,offline_at)
        values($1,$2,$3,$4) on conflict(model_id) do update set synced_at=excluded.synced_at,offline_at=excluded.offline_at`,
      [row.id,model.bailianState.syncedAt,model.bailianQuote.region,model.bailianState.offlineAt]);
      const provider = ['input','cachedInput','output','reasoning'].map(k => parseDecimalToNano(model.usdPerMillion[k]));
      const customer = provider.map(v => applyBasisPoints(v,markupBps));
      const reference = `${model.sourceReference} [reviewed=${model.reviewedAt}; markup_bps=${markupBps}; policy=${capabilities.pricingPolicy ?? 'published-tariff'}; route=${model.provider}/${model.providerModel}]`;
      const {rows:[latest]} = await client.query(`select id,source_reference,provider_quote,bailian_quote,
        array[customer_input_usdc_nano_per_million,customer_cached_input_usdc_nano_per_million,
          customer_output_usdc_nano_per_million,customer_reasoning_usdc_nano_per_million,
          provider_input_usd_nano_per_million,provider_cached_input_usd_nano_per_million,
          provider_output_usd_nano_per_million,provider_reasoning_usd_nano_per_million]::text[] as rates
        from private.model_price_versions where model_id=$1 and effective_from<=now()
          and (effective_until is null or effective_until>now()) order by effective_from desc limit 1`,[row.id]);
      const rates = [...customer,...provider].map(String);
      if (latest && latest.provider_quote === null && latest.source_reference === reference &&
          canonicalize(latest.bailian_quote??null)===canonicalize(model.bailianQuote??null) &&
          latest.rates.every((v,i) => BigInt(v) === BigInt(rates[i]))) continue;
      await client.query(`insert into private.model_price_versions(model_id,effective_from,
        customer_input_usdc_nano_per_million,customer_cached_input_usdc_nano_per_million,
        customer_output_usdc_nano_per_million,customer_reasoning_usdc_nano_per_million,
        provider_input_usd_nano_per_million,provider_cached_input_usd_nano_per_million,
        provider_output_usd_nano_per_million,provider_reasoning_usd_nano_per_million,source_reference,bailian_quote)
        values($1,clock_timestamp(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[row.id,...rates,reference,model.bailianQuote??null]);
      changed.push(model.publicName);
    }
    await client.query('commit');
    return {models:models.length,changed};
  } catch (error) { await client.query('rollback'); throw error; }
}
