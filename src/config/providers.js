import {readFileSync} from 'node:fs';
import {z} from 'zod';

// providers.json: the model providers a deployment serves. Each entry is an
// instance of a type; the type decides where prices come from and how calls
// are made (src/providers/registry.js):
//   deepseek           DeepSeek's own API, prices from its official page daily
//   openrouter         OpenRouter with one API key per payer wallet, minted
//                      from a management key; prices and the serving provider
//                      from its public model API; billed by the cost it reports
//   openai-compatible  any Chat Completions endpoint with reviewed static prices
const envName=z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/);
const rate=z.string().regex(/^\d{1,6}(\.\d{1,9})?$/);
const modelId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,150}$/);
const httpsUrl=z.url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;},'HTTPS URL without credentials, query or fragment');

const staticModel=z.object({
  id:modelId,
  maxOutputTokens:z.number().int().positive(),contextLength:z.number().int().positive(),
  reasoningIncludedInOutput:z.boolean().default(true),tools:z.boolean().default(false),
  usdPerMillion:z.object({input:rate,cachedInput:rate,output:rate,reasoning:rate}).strict(),
  sourceReference:z.url(),reviewedAt:z.iso.date()
}).strict();

export const providerSchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
  type:z.enum(['deepseek','openrouter','openai-compatible']),
  apiKeyEnv:envName.optional(),
  managementKeyEnv:envName.optional(),
  baseUrl:httpsUrl.optional(),
  models:z.array(staticModel).default([]),
  // Synced catalogs: the provider's model ids to serve; OpenRouter entries may
  // name the serving host (`provider`) instead of the default choice.
  allowedModels:z.array(z.union([modelId,z.object({id:modelId,provider:z.string().min(1).max(80)}).strict()])).default([]),
  // OpenRouter: serve every model of these vendors (the id prefix, e.g. anthropic).
  allowedFamilies:z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,60}$/)).default([]),
  // OpenRouter: the credit limit (USD) of the call key minted for each payer wallet.
  payerKeyLimitUsd:z.number().positive().max(100000).default(100),
  // The OpenRouter account enforces Zero Data Retention: hosts are chosen
  // only among OpenRouter's ZDR endpoints.
  zeroDataRetention:z.boolean().default(false),
  // Probe each chosen host once a week with a tiny request and drop the ones
  // that refuse this account (BYOK-only endpoints, privacy policy).
  probeHosts:z.boolean().default(false)
}).strict().superRefine((p,ctx)=>{
  const issue=message=>ctx.addIssue({code:'custom',message});
  if(p.type==='deepseek') {
    if(p.allowedFamilies.length)issue('allowedFamilies is for OpenRouter');
    if(p.id!=='deepseek'||p.baseUrl||p.models.length)issue('DeepSeek automatic pricing uses id deepseek and the official endpoint');
    if(!p.apiKeyEnv)issue('DeepSeek needs apiKeyEnv');
  }
  if(p.type==='openrouter') {
    if(p.id!=='openrouter'||p.baseUrl||p.models.length)issue('OpenRouter uses id openrouter and its public endpoint');
    if(!p.managementKeyEnv)issue('OpenRouter needs managementKeyEnv (a management key mints one call key per payer wallet)');
    if(!p.allowedModels.length&&!p.allowedFamilies.length)issue('OpenRouter needs allowedModels or allowedFamilies: the OpenRouter models to serve');
  }
  if(p.type==='openai-compatible') {
    if(!p.baseUrl||!p.apiKeyEnv)issue('Compatible providers need an HTTPS baseUrl and apiKeyEnv');
    if(!p.models.length)issue('Explicit models with reviewed prices are required');
    if(p.allowedModels.length||p.allowedFamilies.length)issue('allowedModels is for synced catalogs; static models are already an allowlist');
  }
});

export const providersFileSchema=z.object({
  providers:z.array(providerSchema).default([]),
  // Static entries published as they are (openai-compatible models).
  entries:z.array(z.any()).default([])
}).strict().superRefine((c,ctx)=>{
  if(new Set(c.providers.map(p=>p.id)).size!==c.providers.length)ctx.addIssue({code:'custom',message:'Provider ids must be unique'});
});

export function loadProvidersConfig(path) {
  return providersFileSchema.parse(JSON.parse(readFileSync(path,'utf8')));
}

// Catalog entries for a static (openai-compatible) provider.
export function staticEntries(provider) {
  return provider.models.map(m=>({publicName:`${provider.id}/${m.id}`,provider:provider.id,providerModel:m.id,
    usdPerMillion:m.usdPerMillion,sourceReference:m.sourceReference,reviewedAt:m.reviewedAt,
    capabilities:{maxOutputTokens:m.maxOutputTokens,contextLength:m.contextLength,reasoningIncludedInOutput:m.reasoningIncludedInOutput,
      tools:m.tools,upstream:provider.type}}));
}
