import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseSse} from '../src/providers/sse.js';
import * as anthropic from '../src/protocols/anthropic.js';
import * as responses from '../src/protocols/responses.js';
import {createProviderRegistry} from '../src/providers/registry.js';
import {loadProvidersConfig} from '../src/config/providers.js';
import {calculateTierActual} from '../src/services/tier-pricing.js';
import {loadDeepseekPrices,makeDeepseekCatalog} from '../src/services/deepseek-catalog.js';
import {InMemoryGatewayRepository,createInMemoryGateway,mockModel,ok,parseSse as parseSseText,post} from './helpers/in-memory-gateway.js';

// Streams recorded from DeepSeek and OpenRouter on 2026-10-22.
const fixture=name=>readFileSync(new URL(`./fixtures/protocols/${name}.sse`,import.meta.url),'utf8');
const sse=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
async function events(name) {const out=[];for await(const e of parseSse(sse(fixture(name))))out.push(e);return out;}
async function aggregate(protocol,name) {const a=new protocol.Aggregator();for(const e of await events(name))a.push(e);return a.toBody();}

const FX={cnyPerUsd:'8',date:'2026-10-22',source:'test',policy:'fixed'};
const deepseekEntry=makeDeepseekCatalog([{id:'deepseek-flash',context_window:1048576,max_output_tokens:393216,input_modalities:['text','image'],output_modalities:['text']}],
  loadDeepseekPrices(),FX).entries[0];
const deepseekModel=mockModel({public_name:'deepseek/deepseek-flash',provider:'deepseek',provider_model:'deepseek-flash',
  bailian_quote:deepseekEntry.bailianQuote,capabilities:deepseekEntry.capabilities});

test('SSE: strict framing (no space after the colon, id lines, comments) and DeepSeek framing',async()=>{
  // Some providers frame events this way (measured 2026-10-22).
  const strict=':HTTP_STATUS/200\nid:1\nevent:response.created\ndata:{"type":"response.created"}\n\nid:2\nevent:response.completed\ndata:{"type":"response.completed","response":{"usage":{"input_tokens":350}}}\n\n';
  const out=[];for await(const e of parseSse(sse(strict)))out.push(e);
  assert.deepEqual(out.map(e=>e.event),['response.created','response.completed']);
  assert.equal(out.at(-1).data.response.usage.input_tokens,350);
  const ds=await events('ds-anthropic-text');
  assert.equal(ds[0].event,'message_start');
  assert.equal(ds.at(-1).data.type,'message_stop');
});

test('Anthropic: tool input assembled, usage taken from message_delta, thinking block selects the thinking tariff',async()=>{
  const ds=await aggregate(anthropic,'ds-anthropic-tool');
  assert.deepEqual(ds.content.find(b=>b.type==='tool_use').input,{tz:'UTC'});
  assert.equal(ds.stop_reason,'tool_use');
  assert.equal(anthropic.usage(ds).inputTokens,296);
  assert.equal(anthropic.usage(ds).thinking,true);
  // message_delta wins over message_start (some providers report a partial input count there).
  const a=new anthropic.Aggregator();
  for(const e of await events('ds-anthropic-tool'))a.push(e.event==='message_start'?{...e,data:{...e.data,message:{...e.data.message,usage:{input_tokens:40,output_tokens:1}}}}:e);
  assert.equal(anthropic.usage(a.toBody()).inputTokens,296);
  // input_tokens excludes cache reads in this format.
  assert.deepEqual(anthropic.usage({content:[],usage:{input_tokens:195,cache_read_input_tokens:6400,output_tokens:5}}),
    {inputTokens:6595,cachedInputTokens:6400,outputTokens:5,reasoningTokens:0});
  // Without the flag a thinking reply would be billed at the cheaper non-thinking rate where the tariffs differ.
  const base=deepseekEntry.bailianQuote;
  const quote={...base,tiers:base.tiers.map(t=>({...t,thinkingOutput:String(BigInt(t.output)*4n)}))};
  const plain=calculateTierActual({...anthropic.usage(ds),thinking:false},quote).providerCostUsdNano;
  const thinking=calculateTierActual(anthropic.usage(ds),quote).providerCostUsdNano;
  assert.ok(thinking>plain);
});

test('Responses: usage from the terminal event, cached tokens inside input_tokens',async()=>{
  const ds=await aggregate(responses,'ds-responses-tool');
  assert.deepEqual(responses.usage(ds),{inputTokens:292,cachedInputTokens:128,outputTokens:57,reasoningTokens:19});
  assert.equal((await aggregate(responses,'ds-responses-text')).status,'completed');
  const cut=new responses.Aggregator();
  for(const e of (await events('ds-responses-text')).slice(0,-1))cut.push(e);
  assert.throws(()=>cut.toBody(),{code:'PROVIDER_STREAM_INCOMPLETE'});
});

test('requests: server-side tools and stored state are refused, cache_control is dropped, store is forced off',()=>{
  const base={model:'m',max_tokens:10,messages:[{role:'user',content:'hi'}]};
  assert.throws(()=>anthropic.parse({...base,tools:[{type:'web_search_20250305',name:'web_search'}]}),{code:'SERVER_TOOLS_NOT_SUPPORTED'});
  assert.throws(()=>anthropic.parse({...base,mcp_servers:[{}]}),{code:'REQUEST_OPTION_NOT_SUPPORTED'});
  // Claude Code 2.1.303 puts its environment notes in a system-role message.
  assert.equal(anthropic.parse({...base,messages:[{role:'system',content:[{type:'text',text:'env'}]},{role:'user',content:'hi'}],
    thinking:{type:'adaptive',display:'omitted'},context_management:{edits:[]}}).messages[0].role,'system');
  const request=anthropic.parse({...base,system:[{type:'text',text:'s',cache_control:{type:'ephemeral'}}],
    tools:[{name:'f',input_schema:{type:'object'},cache_control:{type:'ephemeral'}}]});
  assert.ok(!JSON.stringify(anthropic.upstreamBody(request,'up')).includes('cache_control'));
  assert.equal(anthropic.upstreamBody(request,'up').stream,true);
  assert.throws(()=>anthropic.view({...base,messages:[{role:'user',content:[{type:'document',source:{}}]}]}),{code:'REQUEST_OPTION_NOT_SUPPORTED'});

  const r={model:'m',input:'hi'};
  assert.throws(()=>responses.parse({...r,tools:[{type:'web_search'}]}),{code:'SERVER_TOOLS_NOT_SUPPORTED'});
  assert.throws(()=>responses.parse({...r,store:true}),{code:'RESPONSES_STORE_NOT_SUPPORTED'});
  assert.throws(()=>responses.parse({...r,previous_response_id:'resp_x'}),{code:'RESPONSES_STATE_NOT_SUPPORTED'});
  assert.throws(()=>responses.view(responses.parse({...r,input:[{type:'item_reference',id:'x'}]})),{code:'REQUEST_OPTION_NOT_SUPPORTED'});
  assert.throws(()=>responses.parse({...r,tools:[{type:'namespace',name:'n',tools:[{type:'web_search'}]}]}),{code:'SERVER_TOOLS_NOT_SUPPORTED'});
  // Codex 0.161 groups its sub-agent tools in a namespace.
  const okReq=responses.parse({...r,tools:[{type:'function',name:'f',parameters:{}},{type:'custom',name:'apply_patch'},
    {type:'namespace',name:'multi_agent_v1',tools:[{type:'function',name:'close_agent',parameters:{}}]}]});
  assert.deepEqual([responses.upstreamBody(okReq,'up').store,responses.upstreamBody(okReq,'up').stream],[false,true]);
});

test('hold estimate: images count by the per-image ceiling, not their base64 size',()=>{
  const data='A'.repeat(200000);
  const view=anthropic.view({max_tokens:100,messages:[{role:'user',content:[{type:'text',text:'what is this'},{type:'image',source:{type:'base64',media_type:'image/png',data}},
    {type:'tool_result',tool_use_id:'t',content:[{type:'image',source:{type:'base64',media_type:'image/png',data}}]}]}]});
  assert.equal(view.messages[0].content.filter(p=>p.type==='image_url').length,2);
  assert.ok(view.messages[0].content[0].text.length<1000);
  assert.equal(view.max_completion_tokens,100);
  const rview=responses.view({input:[{role:'user',content:[{type:'input_image',image_url:`data:image/png;base64,${data}`}]}]});
  assert.equal(rview.messages[0].content.filter(p=>p.type==='image_url').length,1);
  assert.equal(rview.max_completion_tokens,undefined);
});

test('native endpoints exist per provider; models without a synced quote or a provider endpoint are refused',()=>{
  const {providers}=loadProvidersConfig(new URL('./fixtures/providers-both.json',import.meta.url));
  const registry=createProviderRegistry({providers},{env:{DEEPSEEK_API_KEY:'k'}});
  assert.equal(registry.get('deepseek').protocolPath('anthropic'),'/anthropic/v1/messages');
  assert.equal(registry.get('openrouter').protocolPath('responses'),'/responses');
  assert.equal(registry.get('mock').protocolPath,undefined);
});

// A channel-paid gateway whose provider answers every native call with a recorded stream.
async function protocolGateway(streamText,{repository=new InMemoryGatewayRepository({models:[deepseekModel,mockModel()]}),config={}}={}) {
  const sent=[];
  const provider={protocolPath:name=>`/${name}`,async openProtocol(name,body){sent.push({path:`/${name}`,body});return parseSse(sse(streamText));}};
  const h=await createInMemoryGateway({repository,providers:{get:()=>provider},config:{REAL_MODEL_CALLS_ENABLED:true,...config}});
  return {...h,sent,client:h.client(),request:()=>[...h.ledger.requests.values()][0]};
}
const text=name=>fixture(name);

test('gateway: a streamed Messages call holds the closing events until the charge is final',async()=>{
  const h=await protocolGateway(text('ds-anthropic-tool'));
  const response=await h.client.fetch(post('/v1/messages',{model:'deepseek/deepseek-flash',max_tokens:200,stream:true,
    messages:[{role:'user',content:'time?'}],tools:[{name:'get_time',input_schema:{type:'object'}}]}));
  assert.equal(response.status,200);
  const out=parseSseText(await response.text());
  assert.equal(h.sent[0].path,'/anthropic');
  assert.equal(h.sent[0].body.model,'deepseek-flash');
  assert.equal(out.find(e=>e.data.type==='message_start').data.message.model,'deepseek/deepseek-flash');
  assert.deepEqual(out.slice(-2).map(e=>e.event),['message_delta','message_stop']);
  assert.equal(out.filter(e=>e.event==='message_delta').length,1,'the upstream message_delta is not forwarded');
  const request=h.request();
  assert.equal(request.status,'completed');assert.equal(request.protocol,'anthropic');
  assert.deepEqual(request.normalizedUsage,{...anthropic.usage(await aggregate(anthropic,'ds-anthropic-tool'))});
  assert.equal(out.at(-2).data.gateway.billed_usdc_nano,String(request.actualChargeUsdcNano));
  assert.ok(out.at(-2).data.gateway.x402.payment_response,'the receipt rides in the closing event');
  await h.app.close();
});

test('gateway: a non-streaming Responses call is aggregated from the stream and billed once',async()=>{
  const h=await protocolGateway(text('ds-responses-tool'));
  const response=await ok(await h.client.fetch(post('/v1/responses',{model:'deepseek/deepseek-flash',input:'time?'})));
  assert.equal(response.object,'response');
  assert.equal(response.model,'deepseek/deepseek-flash');
  assert.ok(response.gateway.request_id);
  const request=h.request();
  assert.deepEqual(request.normalizedUsage,{inputTokens:292,cachedInputTokens:128,outputTokens:57,reasoningTokens:19});
  assert.equal(request.usageSource,'direct:deepseek:responses');
  assert.equal(request.rawUsageRedacted.billed_from,'price_table');
  // No max_output_tokens (Codex): the default is held and forwarded.
  assert.equal(request.maxChargeUsdcNano>0n,true);
  assert.equal(h.sent[0].body.max_output_tokens,65536);
  await ok(await h.client.fetch(post('/v1/responses',{model:'deepseek/deepseek-flash',input:'time?',max_output_tokens:100})));
  assert.equal(h.sent[1].body.max_output_tokens,100);
  await h.app.close();
});

test('gateway: a stream that ends before its closing event charges the ceiling and ends with the format error event',async()=>{
  const cut=text('ds-anthropic-text').split('event: message_delta')[0];
  const h=await protocolGateway(cut);
  const response=await h.client.fetch(post('/v1/messages',{model:'deepseek/deepseek-flash',max_tokens:60,stream:true,messages:[{role:'user',content:'hi'}]}));
  const out=parseSseText(await response.text());
  assert.equal(out.at(-1).event,'error');
  assert.equal(out.at(-1).data.type,'error');
  assert.equal(out.at(-1).data.error.code,'PROVIDER_STREAM_INCOMPLETE');
  assert.equal(h.request().chargedFrom,'ceiling');
  await h.app.close();
});

test('gateway: models without a native endpoint are refused before any payment',async()=>{
  const h=await protocolGateway('');
  const response=await h.app.inject({method:'POST',url:'/v1/responses',payload:{model:'mock/echo',input:'hi'}});
  assert.equal(response.statusCode,422);assert.equal(response.json().error.code,'MODEL_PROTOCOL_UNSUPPORTED');
  assert.equal(h.ledger.requests.size,0);
  await h.app.close();
});

test('routes: unpaid and invalid Messages or Responses requests answer in each format',async()=>{
  const h=await protocolGateway(text('ds-anthropic-text'),{repository:new InMemoryGatewayRepository({models:[deepseekModel]})});
  const unpaid=await h.app.inject({method:'POST',url:'/v1/messages?beta=true',headers:{'x-api-key':'ignored','anthropic-version':'2023-06-01'},
    payload:{model:'deepseek/deepseek-flash',max_tokens:60,messages:[{role:'user',content:'hi'}]}});
  assert.equal(unpaid.statusCode,402);
  assert.deepEqual([unpaid.json().type,unpaid.json().error.code],['error','PAYMENT_REQUIRED']);
  assert.ok(unpaid.headers['payment-required']);
  const paid=await h.client.fetch(post('/v1/messages',{model:'deepseek/deepseek-flash',max_tokens:60,messages:[{role:'user',content:'hi'}]},{'anthropic-version':'2023-06-01'}));
  assert.equal(paid.status,200);
  assert.equal((await paid.json()).type,'message');
  const invalid=await h.app.inject({method:'POST',url:'/v1/responses',payload:{model:'deepseek/deepseek-flash'}});
  assert.equal(invalid.statusCode,422);
  assert.equal(invalid.json().error.code,'VALIDATION_ERROR');
  await h.app.close();
});

// OpenRouter recordings: Messages usage carries the cost; Responses streams
// have no `event:` lines and end with `[DONE]`.
test('OpenRouter streams: the reported cost settles the call, Responses events are named from their type',async()=>{
  const msg=await aggregate(anthropic,'or-anthropic-text');
  assert.equal(anthropic.usage(msg).inputTokens,32);
  assert.equal(msg.usage.cost,0.00001908);
  const resp=await events('or-responses-text');
  // The recording hit max_output_tokens, so it ends incomplete; still a terminal event.
  assert.equal(resp.at(-1).event,'response.incomplete');
  assert.equal(responses.forwardEvent({event:null,data:{type:'response.created',response:{model:'x'}}},'pub').event,'response.created');
  const orModel=mockModel({public_name:'openrouter/deepseek/deepseek-v4.1-flash',provider:'openrouter',provider_model:'deepseek/deepseek-v4.1-flash',
    bailian_quote:{...deepseekEntry.bailianQuote,kind:'openrouter-usd-v1',currency:'USD',billing:'reported',route:{provider:'DeepInfra'},fx:{cnyPerUsd:'1',cnyPerUsdNano:'1000000000'}},capabilities:{}});
  const h=await protocolGateway(text('or-responses-text'),{repository:new InMemoryGatewayRepository({models:[orModel]})});
  const response=await ok(await h.client.fetch(post('/v1/responses',{model:orModel.public_name,input:'Reply OK',max_output_tokens:20})));
  assert.equal(response.model,orModel.public_name);
  const request=h.request();
  // 0.00001908 USD reported -> 19080 nano.
  assert.equal(String(request.providerCostUsdNano),'19080');
  assert.equal(request.rawUsageRedacted.billed_from,'provider_cost');
  await h.app.close();
});

test('gateway: an output limit the client left out is lowered to fit the per-request limit and forwarded; an explicit one is refused',async()=>{
  const h=await protocolGateway(text('ds-responses-text'),{config:{X402_REQUEST_LIMIT_USDC:'0.01'}});
  const unpaid=await h.app.inject({method:'POST',url:'/v1/responses',payload:{model:'deepseek/deepseek-flash',input:'hi'}});
  assert.equal(unpaid.statusCode,402);
  const required=JSON.parse(Buffer.from(unpaid.headers['payment-required'],'base64').toString());
  assert.ok(BigInt(required.accepts[0].amount)<=10000n,'the ceiling fits the limit');
  await ok(await h.client.fetch(post('/v1/responses',{model:'deepseek/deepseek-flash',input:'hi'})));
  const forwarded=h.sent[0].body.max_output_tokens;
  assert.ok(forwarded>0&&forwarded<responses.DEFAULT_MAX_OUTPUT_TOKENS,`forwarded ${forwarded}`);
  const explicit=await h.app.inject({method:'POST',url:'/v1/responses',payload:{model:'deepseek/deepseek-flash',input:'hi',max_output_tokens:65536}});
  assert.equal(explicit.statusCode,402);assert.equal(explicit.json().error.code,'X402_REQUEST_LIMIT');
});
