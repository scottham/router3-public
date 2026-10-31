begin;

-- Forward-only rollback: retain immutable prices, owners, requests, holds,
-- provider usage and settlement history. Do not delete financial records.
update private.openrouter_project_budgets set suspended=true;
update private.openrouter_bindings set suspended=true;
update private.openrouter_keys set state='draining' where state='active';
update public.model_catalog set enabled=false where provider='openrouter';

-- Known aliases keep their IDs, and therefore project model allowlists.
-- An operator must publish a current LiteLLM catalog/price snapshot to enable
-- them. Neither old vendor prices nor OpenRouter endpoint prices are reused.
update public.model_catalog set provider='deepseek',provider_model='deepseek-flash',enabled=false
where public_name='deepseek/deepseek-v4-flash';
update public.model_catalog set provider='glm',provider_model='glm-4.7-flash',enabled=false
where public_name='glm/glm-4.7-flash';

commit;
