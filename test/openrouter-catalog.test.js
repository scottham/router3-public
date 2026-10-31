import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildOpenRouterQuote,chooseEndpoints,endpointCacheMode,fetchOpenRouterBalance,hostVerdicts,makeOpenRouterCatalog,probeHosts,resolveAllowed,syncOpenRouterCatalog} from '../src/services/openrouter-catalog.js';
import {calculateTierActual,estimateTierMaximum} from '../src/services/tier-pricing.js';
import {PricingService} from '../src/services/pricing-service.js';
import * as anthropic from '../src/protocols/anthropic.js';

// Recorded from the public OpenRouter model API on 2026-10-22.
const fixture=name=>JSON.parse(readFileSync(new URL(`./fixtures/openrouter/${name}.json`,import.meta.url),'utf8')).data;
const models=fixture('models');
const endpoints=new Map([['anthropic/claude-sonnet-5.5',fixture('endpoints-anthropic_claude-sonnet-5.5').endpoints],
  ['deepseek/deepseek-v4.1-flash',fixture('endpoints-deepseek_deepseek-v4.1-flash').endpoints],
  ['qwen/qwen3.8-flash',fixture('endpoints-qwen_qwen3.8-flash').endpoints]]);
const byId=id=>models.find(m=>m.id===id);

test('cache capabilities and write bounds come from endpoints without model-name rules',()=>{
  const host={provider_name:'Example',tag:'example',context_length:100000,max_completion_tokens:1000,
    pricing:{prompt:'0.000004',completion:'0.00002',input_cache_read:'0.0000002',input_cache_write:'0.000005',input_cache_write_1h:'0.000008'}};
  assert.equal(endpointCacheMode({...host,supports_implicit_caching:true}),'implicit');
  assert.equal(endpointCacheMode({...host,supports_implicit_caching:false}),'explicit');
  assert.equal(endpointCacheMode(host),'unknown');
  assert.equal(endpointCacheMode({...host,pricing:{prompt:'0.000004'}}),'none');
  const model={id:'new-vendor/new-model',architecture:{input_modalities:['text'],output_modalities:['text']}};
  const explicit=buildOpenRouterQuote(model,[{...host,supports_implicit_caching:false}]);
  assert.deepEqual(explicit.cache,{mode:'explicit'});
  assert.equal(explicit.tiers[0].cacheWrite1h,'8000000000');
  const mixed=buildOpenRouterQuote(model,[{...host,supports_implicit_caching:false},{...host,tag:'implicit',supports_implicit_caching:true}]);
  assert.deepEqual(mixed.cache,{mode:'mixed'});
  const storage=buildOpenRouterQuote(model,[{...host,supports_implicit_caching:false,
    pricing:{...host.pricing,input_cache_write:'0.0000001'}}]);
  assert.equal(storage.tiers[0].cacheWrite,'4100000000','a storage-only quote is held together with input');
});

test('hosts: the vendor and its first-party clouds first, resellers within 1.5x of them, or the one the allowlist names',()=>{
  const names=list=>list.map(e=>e.tag);
  // Anthropic plus Vertex, Bedrock and Azure: what the ZDR switches leave on
  // when the Anthropic API itself is off.
  assert.deepEqual(names(chooseEndpoints(byId('anthropic/claude-sonnet-5.5'),endpoints.get('anthropic/claude-sonnet-5.5'))),
    ['amazon-bedrock','anthropic','azure/global','claude-on-aws','google-vertex/global','azure/us','google-vertex/us','google-vertex/europe']);
  // No DeepSeek-run host on OpenRouter: the cheapest reseller and those within 1.5x of it, live only.
  const resold=chooseEndpoints(byId('deepseek/deepseek-v4.1-flash'),endpoints.get('deepseek/deepseek-v4.1-flash'));
  assert.deepEqual(names(resold),['decart/fp4','sail-research/fp4/us','sail-research/fp4']);
  assert.deepEqual(names(chooseEndpoints(byId('deepseek/deepseek-v4.1-flash'),endpoints.get('deepseek/deepseek-v4.1-flash'),'Relace')),['relace']);
  assert.throws(()=>chooseEndpoints(byId('deepseek/deepseek-v4.1-flash'),endpoints.get('deepseek/deepseek-v4.1-flash'),'Nobody'),/HOST_UNAVAILABLE/);
  assert.throws(()=>chooseEndpoints(byId('qwen/qwen3.8-flash'),[]),/NO_LIVE_HOST/);
});

test('families: every model of the listed vendors except batch and free variants, after explicit ids',()=>{
  const list=[{id:'anthropic/a'},{id:'anthropic/a:batch'},{id:'anthropic/b:free'},{id:'openai/x'},{id:'z-ai/g'},{id:'~anthropic/latest'}];
  assert.deepEqual(resolveAllowed(list,[{id:'openai/x',provider:'Azure'}],['anthropic','openai']),[{id:'openai/x',provider:'Azure'},'anthropic/a']);
});

test('quotes carry USD rates in nano per million, the cache write rate and the pinned host; settlement comes from the reported cost',()=>{
  const hosts=chooseEndpoints(byId('anthropic/claude-sonnet-5.5'),endpoints.get('anthropic/claude-sonnet-5.5'));
  const quote=buildOpenRouterQuote(byId('anthropic/claude-sonnet-5.5'),hosts);
  assert.equal(quote.billing,'reported');
  assert.deepEqual(quote.route,{provider:'Amazon Bedrock',tag:'amazon-bedrock',only:hosts.map(e=>e.tag)});
  // The dearest host sizes the hold: the regional Vertex/Azure endpoints at $2.20 / $11.
  assert.deepEqual([quote.tiers[0].input,quote.tiers[0].output],['2200000000','11000000000']);
  const [tier]=buildOpenRouterQuote(byId('anthropic/claude-sonnet-5.5'),hosts.filter(e=>e.tag==='anthropic')).tiers;
  // $2 / $10 per million, cache read $0.10, cache write $2.50.
  assert.deepEqual([tier.input,tier.output,tier.cachedInput,tier.cacheWrite],['2000000000','10000000000','100000000','2500000000']);
  assert.equal(quote.contextLength,1000000);assert.equal(quote.maxOutputTokens,128000);
  // The hold assumes every input token may be written to the cache, so
  // explicit cache_control is allowed and priced at the write rate.
  const request={messages:[{role:'user',content:[{type:'text',text:'x'.repeat(1000),cache_control:{type:'ephemeral'}}]}],max_tokens:100};
  const hold=estimateTierMaximum(request,quote,{});
  const plain=estimateTierMaximum({...request,messages:[{role:'user',content:'x'.repeat(1000)}]},{...quote,tiers:[{...tier,cacheWrite:undefined}]},{});
  assert.ok(hold.maxChargeUsdcNano>plain.maxChargeUsdcNano);
  // The gateway forwards cache_control only for such quotes.
  const body={model:'m',max_tokens:10,messages:[{role:'user',content:[{type:'text',text:'s',cache_control:{type:'ephemeral'}}]}]};
  assert.ok(JSON.stringify(anthropic.upstreamBody(anthropic.parse(body),'up',{keepCacheControl:true})).includes('cache_control'));
  assert.ok(!JSON.stringify(anthropic.upstreamBody(anthropic.parse(body),'up')).includes('cache_control'));
  // Settlement: the provider's cost wins over the rate table; without it the rates apply.
  const pricing=new PricingService();
  const usage={inputTokens:1000,cachedInputTokens:0,outputTokens:100,reasoningTokens:0};
  assert.equal(pricing.calculateModelActual(usage,{bailian_quote:quote},1234567n).providerCostUsdNano,1234567n);
  assert.equal(pricing.calculateModelActual(usage,{bailian_quote:quote},null).providerCostUsdNano,calculateTierActual(usage,quote).providerCostUsdNano);
  // Without a reported cost the dearest host's rates apply.
  assert.equal(calculateTierActual(usage,quote).providerCostUsdNano,3300000n);
  // A DeepSeek quote never settles on a reported cost even if one were present.
  assert.equal(pricing.calculateModelActual(usage,{bailian_quote:{...quote,billing:undefined}},5n).providerCostUsdNano,3300000n);
});

test('catalog: allowlisted models only, unknown ones excluded, images refused where billed per image',()=>{
  const allowed=['anthropic/claude-sonnet-5.5','qwen/qwen3.8-flash',{id:'deepseek/deepseek-v4.1-flash',provider:'Relace'},'nobody/missing-model'];
  const {entries,excluded}=makeOpenRouterCatalog(models,endpoints,allowed,new Date('2026-10-22T00:00:00Z'));
  assert.deepEqual(entries.map(e=>e.publicName),['openrouter/anthropic/claude-sonnet-5.5','openrouter/qwen/qwen3.8-flash','openrouter/deepseek/deepseek-v4.1-flash']);
  assert.deepEqual(excluded,[{model:'nobody/missing-model',reason:'OPENROUTER_MODEL_UNAVAILABLE'}]);
  const claude=entries[0];
  assert.deepEqual(claude.usdPerMillion,{input:'2.000000000',cachedInput:'0.100000000',output:'10.000000000',reasoning:'0'});
  assert.equal(claude.capabilities.route,'Amazon Bedrock');
  assert.equal(claude.capabilities.hosts.length,8);
  // The listed price is the first host's; the hold covers the dearest.
  assert.equal(claude.bailianQuote.tiers[0].output,'11000000000');
  assert.equal(claude.capabilities.imageInput,true);
  assert.equal(claude.capabilities.tools,true);
  assert.equal(entries[2].bailianQuote.route.provider,'Relace');
  const perImage={...byId('qwen/qwen3.8-flash'),architecture:{...byId('qwen/qwen3.8-flash').architecture,input_modalities:['text','image']}};
  const priced=endpoints.get('qwen/qwen3.8-flash').map(e=>({...e,pricing:{...e.pricing,image:'0.001'}}));
  assert.equal(makeOpenRouterCatalog([perImage],new Map([['qwen/qwen3.8-flash',priced]]),['qwen/qwen3.8-flash']).entries[0].capabilities.imageInput,false);
  const perRequest=endpoints.get('qwen/qwen3.8-flash').map(e=>({...e,pricing:{...e.pricing,request:'0.01'}}));
  assert.deepEqual(makeOpenRouterCatalog(models,new Map([...endpoints,['qwen/qwen3.8-flash',perRequest]]),['qwen/qwen3.8-flash','anthropic/claude-sonnet-5.5']).excluded,
    [{model:'qwen/qwen3.8-flash',reason:'OPENROUTER_PER_REQUEST_PRICE'}]);
});

test('sync publishes through the catalog with replaceProvider, and the balance is credits minus usage',async()=>{
  const queries=[];
  const db={query:async(sql,params)=>{queries.push([sql,params]);return {rows:/returning id/.test(sql)?[{id:`id-${queries.length}`}]:[]};}};
  const fetchImpl=async url=>{
    const u=String(url);
    if(u.endsWith('/models'))return {ok:true,json:async()=>({data:models})};
    const m=/\/models\/(.+)\/endpoints$/.exec(u);
    if(m)return {ok:true,json:async()=>({data:{endpoints:endpoints.get(decodeURIComponent(m[1]))??[]}})};
    if(u.endsWith('/credits'))return {ok:true,json:async()=>({data:{total_credits:31,total_usage:0.890170017}})};
    return {ok:false,status:404};
  };
  const result=await syncOpenRouterCatalog(db,{},{allowedModels:['anthropic/claude-sonnet-5.5','nobody/x'],fetchImpl});
  assert.equal(result.models,1);
  assert.deepEqual(result.excluded,[{model:'nobody/x',reason:'OPENROUTER_MODEL_UNAVAILABLE'}]);
  assert.ok(queries.some(([sql,params])=>/update public.model_catalog set enabled=false where provider=\$1/.test(sql)&&params[0]==='openrouter'));
  await assert.rejects(syncOpenRouterCatalog(db,{},{allowedModels:[],fetchImpl}),/ALLOWED_MODELS_REQUIRED/);
  assert.equal(await fetchOpenRouterBalance('mk',{fetchImpl}),'30.1098');
  await assert.rejects(fetchOpenRouterBalance('',{fetchImpl}),/MANAGEMENT_KEY_REQUIRED/);
});

// 2026-10-23: priority ("fast", 2.5–5x the price) and flex endpoints were
// candidates, so GPT-5.5 held at $12.5/$75 and listed the flex $2.5/$15.
test('speed tiers are not candidates; own hosts are bounded by the same spread', () => {
  const gpt = fixture('endpoints-openai_gpt-5.5').endpoints;
  const hosts = chooseEndpoints(byId('openai/gpt-5.5'), gpt);
  assert.deepEqual(hosts.map((e) => e.tag), ['azure', 'openai', 'azure/us', 'azure/eu', 'amazon-bedrock/us-east-1']);
  const quote = buildOpenRouterQuote(byId('openai/gpt-5.5'), hosts);
  assert.deepEqual([quote.tiers[0].input, quote.tiers[0].output], ['5500000000', '33000000000'], 'the hold is the dearest standard host');
  assert.deepEqual([hosts[0].pricing.prompt, hosts[0].pricing.completion], ['0.000005', '0.00003'], 'the listed price is the standard one');
  const opus = chooseEndpoints({ id: 'anthropic/claude-opus-5.5' }, fixture('endpoints-anthropic_claude-opus-5.5').endpoints);
  assert.ok(!opus.some((e) => e.tag === 'anthropic/fast'));
  assert.equal(opus.length, 8);
});

test('an account that enforces Zero Data Retention gets only ZDR hosts; a model with none is left out', () => {
  // 2026-10-23: google/gemini-3.8-flash was pinned to Google AI Studio (the cheapest
  // host), which keeps data; OpenRouter answered 404 for every call.
  const model = { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', context_length: 1048576,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools'] };
  const host = (tag, provider, prompt, completion, status = 0) => ({ tag, provider_name: provider, status, context_length: 1048576, max_completion_tokens: 65536,
    pricing: { prompt, completion }, supported_parameters: ['tools'] });
  const endpoints = [host('google-ai-studio', 'Google AI Studio', '0.00000075', '0.00000375'), host('google-vertex/us', 'Google', '0.000000825', '0.000004125'),
    host('google-vertex/global', 'Google', '0.00000075', '0.00000375', -2), host('google-ai-studio/priority', 'Google AI Studio', '0.00000135', '0.00000675')];
  assert.deepEqual(chooseEndpoints(model, endpoints).map((e) => e.tag), ['google-ai-studio', 'google-vertex/us'], 'without ZDR the cheapest host leads');
  const zdr = new Set(['google/gemini-3.8-flash|google-vertex/us', 'google/gemini-3.8-flash|google-vertex/global']);
  assert.deepEqual(chooseEndpoints(model, endpoints, null, zdr).map((e) => e.tag), ['google-vertex/us']);
  const { entries, excluded } = makeOpenRouterCatalog([model, { ...model, id: 'google/other' }],
    new Map([['google/gemini-3.8-flash', endpoints], ['google/other', endpoints]]), ['google/gemini-3.8-flash', 'google/other'], new Date('2026-10-24T00:00:00Z'), zdr);
  assert.deepEqual(entries.map((e) => e.capabilities.hosts), [['google-vertex/us']]);
  assert.deepEqual(excluded, [{ model: 'google/other', reason: 'OPENROUTER_NO_ZDR_HOST' }]);
});

test('probed hosts: refusals (404 BYOK-only) drop the host, rate limits decide nothing, verdicts are kept a week', async () => {
  // 2026-10-24 probe of all 371 pinned pairs: openai/gpt-5.2-chat on azure is
  // BYOK-only (404), five resellers answered 429.
  const calls = [];let deleted = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/keys') && init.method === 'POST') return new Response(JSON.stringify({ key: 'sk-probe', data: { hash: 'h1' } }));
    if (url.endsWith('/keys/h1') && init.method === 'DELETE') { deleted++; return new Response('{}'); }
    const body = JSON.parse(init.body);calls.push(`${body.model}|${body.provider.only[0]}`);
    assert.equal(init.headers.authorization, 'Bearer sk-probe');assert.equal(body.provider.allow_fallbacks, false);
    const status = body.provider.only[0] === 'azure' ? 404 : body.provider.only[0] === 'busy' ? 429 : 200;
    return new Response('{}', { status });
  };
  const verdicts = await probeHosts(['openai/gpt-5.2-chat|azure', 'z-ai/glm-5.3|busy', 'z-ai/glm-5.3|z-ai/fp8'], { managementKey: 'mk', fetchImpl });
  assert.deepEqual([...verdicts], [['openai/gpt-5.2-chat|azure', false], ['z-ai/glm-5.3|z-ai/fp8', true]]);
  assert.equal(deleted, 1, 'the probe key is deleted');
  // Cached verdicts are reused; only what is unknown is probed and stored.
  const stored = [];
  const client = { async query(sql, params) {
    if (/select model,usable/.test(sql)) return { rows: [{ model: 'a/x|h1', usable: false }] };
    stored.push(params);return { rows: [] };
  } };
  const refused = await hostVerdicts(client, ['a/x|h1', 'a/x|h2', 'a/y|h1'], { probe: async (stale) => { assert.deepEqual(stale, ['a/x|h2', 'a/y|h1']); return new Map([['a/x|h2', true]]); } });
  assert.deepEqual(refused, ['a/x|h1']);
  assert.deepEqual(stored, [[['a/x|h2'], [true]]], 'no verdict, nothing stored');
  // A refused host leaves the pinned set.
  const model = { id: 'openai/gpt-5.2-chat', context_length: 128000, architecture: { input_modalities: ['text'], output_modalities: ['text'] } };
  const host = (tag, provider) => ({ tag, provider_name: provider, status: 0, context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000008' } });
  const other = { ...model, id: 'openai/gpt-6' };
  const { entries, excluded } = makeOpenRouterCatalog([model, other], new Map([[model.id, [host('azure', 'Azure')]], [other.id, [host('azure', 'Azure')]]]),
    [model.id, other.id], new Date(), null, new Set(['openai/gpt-5.2-chat|azure']));
  assert.deepEqual(entries.map((e) => e.providerModel), ['openai/gpt-6']);assert.deepEqual(excluded, [{ model: model.id, reason: 'OPENROUTER_NO_LIVE_HOST' }]);
});
