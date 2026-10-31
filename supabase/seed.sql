-- Safe seed: a deterministic mock model for integration tests. It does not create money.
with inserted as (
  insert into public.model_catalog(public_name, provider, provider_model, enabled, capabilities)
  values ('mock/echo', 'mock', 'mock/echo', true, '{"reasoningIncludedInOutput":true}'::jsonb)
  on conflict (public_name) do update
  set enabled = true, capabilities = excluded.capabilities
  returning id
), model as (
  select id from inserted
  union all
  select id from public.model_catalog where public_name = 'mock/echo'
  limit 1
)
insert into private.model_price_versions(
  model_id, effective_from,
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
select id, timestamptz '2026-01-01 00:00:00+00', 0, 0, 0, 0, 0, 0, 0, 0, 'local mock seed'
from model
where not exists (
  select 1 from private.model_price_versions pv
  where pv.model_id = model.id and pv.effective_until is null
);
