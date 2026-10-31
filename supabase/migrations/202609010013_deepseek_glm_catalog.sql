begin;

-- Provider prices captured from the official pricing pages on 2026-09-02.
-- Customer prices initially use 1 USDC == 1 USD and no platform markup. Future
-- commercial pricing must be introduced as a new immutable price version.
with model as (
  insert into public.model_catalog(
    id, public_name, provider, provider_model, enabled, capabilities
  ) values (
    '00000000-0000-4000-8000-000000000201',
    'deepseek/deepseek-v4-flash', 'deepseek', 'deepseek-v4-flash', true,
    '{"chat":true,"reasoning":true,"contextWindow":1000000,"pricingPolicy":"provider-pass-through"}'::jsonb
  )
  on conflict (public_name) do update
    set provider = excluded.provider,
        provider_model = excluded.provider_model,
        enabled = true,
        capabilities = excluded.capabilities
  returning id
)
insert into private.model_price_versions(
  id, model_id, effective_from,
  customer_input_usdc_nano_per_million,
  customer_cached_input_usdc_nano_per_million,
  customer_output_usdc_nano_per_million,
  customer_reasoning_usdc_nano_per_million,
  provider_input_usd_nano_per_million,
  provider_cached_input_usd_nano_per_million,
  provider_output_usd_nano_per_million,
  provider_reasoning_usd_nano_per_million,
  source_reference
)
select
  '00000000-0000-4000-8000-000000000211', id, '2026-09-02T00:00:00Z',
  140000000, 2800000, 280000000, 0,
  140000000, 2800000, 280000000, 0,
  'https://api-docs.deepseek.com/quick_start/pricing'
from model
on conflict (id) do nothing;

with model as (
  insert into public.model_catalog(
    id, public_name, provider, provider_model, enabled, capabilities
  ) values (
    '00000000-0000-4000-8000-000000000202',
    'glm/glm-4.7-flash', 'glm', 'glm-4.7-flash', true,
    '{"chat":true,"reasoning":true,"contextWindow":200000,"pricingPolicy":"provider-pass-through","providerPrice":"free"}'::jsonb
  )
  on conflict (public_name) do update
    set provider = excluded.provider,
        provider_model = excluded.provider_model,
        enabled = true,
        capabilities = excluded.capabilities
  returning id
)
insert into private.model_price_versions(
  id, model_id, effective_from,
  customer_input_usdc_nano_per_million,
  customer_cached_input_usdc_nano_per_million,
  customer_output_usdc_nano_per_million,
  customer_reasoning_usdc_nano_per_million,
  provider_input_usd_nano_per_million,
  provider_cached_input_usd_nano_per_million,
  provider_output_usd_nano_per_million,
  provider_reasoning_usd_nano_per_million,
  source_reference
)
select
  '00000000-0000-4000-8000-000000000212', id, '2026-09-02T00:00:00Z',
  0, 0, 0, 0,
  0, 0, 0, 0,
  'https://docs.z.ai/guides/overview/pricing'
from model
on conflict (id) do nothing;

commit;
