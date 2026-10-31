import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderRegistry} from '../src/providers/registry.js';
import {openRouterCache,hasLongCacheWrite} from '../src/providers/prompt-cache.js';
import {GatewayService} from '../src/services/gateway-service.js';
import * as responses from '../src/protocols/responses.js';
import * as anthropic from '../src/protocols/anthropic.js';
import {InMemoryGatewayRepository,createInMemoryGateway,mockModel,post,parseSse} from './helpers/in-memory-gateway.js';

const quote={kind:'openrouter-usd-v1',billing:'reported',markupBps:0,cache:{mode:'explicit'},
  fx:{cnyPerUsdNano:'1000000000'},contextLength:1000000,maxInputTokens:1000000,maxOutputTokens:1000,maxReasoningTokens:0,
  route:{provider:'Amazon Bedrock',only:['amazon-bedrock','google-vertex/us']},
  tiers:[{lower:0,upper:null,input:'4000000000',cachedInput:'200000000',cacheWrite:'5000000000',cacheWrite1h:'8000000000',output:'20000000000',
    thinkingInput:'4000000000',thinkingCachedInput:'200000000',thinkingOutput:'20000000000'}]};
const model=mockModel({public_name:'openrouter/anthropic/claude-opus-5.5',provider:'openrouter',provider_model:'anthropic/claude-opus-5.5',
  bailian_quote:quote,call_fee_policy_id:'00000000-0000-4000-8000-000000000102',service_fee_bps:100});
const registry=fetchImpl=>createProviderRegistry({providers:[{id:'openrouter',type:'openrouter'}]},
  {providerKeys:{keyFor:async()=>'test-upstream-key'},fetchImpl});
const request=(protocol,extra={})=>protocol==='responses'
  ?{model:model.public_name,instructions:'reusable prefix '.repeat(2000),input:'question',max_output_tokens:20,...extra}
  :protocol==='anthropic'?{model:model.public_name,system:'reusable prefix '.repeat(2000),messages:[{role:'user',content:'question'}],max_tokens:20,...extra}
  :{model:model.public_name,messages:[{role:'system',content:'reusable prefix '.repeat(2000)},{role:'user',content:'question'}],max_tokens:20,...extra};
const upstream=(protocol,body)=>protocol==='responses'?responses.upstreamBody(responses.parse(body),model.provider_model,{keepCacheControl:true})
  :protocol==='anthropic'?anthropic.upstreamBody(anthropic.parse(body),model.provider_model,{keepCacheControl:true}):body;

test('explicit caching: every API preserves directives and affinity, defaults once, and permits opting out',()=>{
  const provider=registry().get('openrouter');
  for(const protocol of ['responses','anthropic',null]){
    const hints={cache_control:{type:'ephemeral',ttl:'1h'},prompt_cache_key:'conversation',session_id:'session'};
    const sent=upstream(protocol,request(protocol,hints));
    assert.deepEqual(sent.cache_control,hints.cache_control);
    assert.equal(sent.prompt_cache_key,'conversation');assert.equal(sent.session_id,'session');
    const explicit={...sent,...provider.extras(sent,model,protocol)};
    assert.deepEqual(explicit.cache_control,hints.cache_control);
    const plain=upstream(protocol,request(protocol));
    const defaults=provider.extras(plain,model,protocol);
    assert.equal(defaults.cache_control,undefined);
    if(protocol==='responses'){
      assert.equal(defaults.instructions,undefined);
      assert.equal(defaults.input[0].content[0].text,plain.instructions);
      assert.equal(defaults.input.at(-1).content,'question');
    }
    const last=protocol==='responses'?defaults.input[0].content[0]:protocol==='anthropic'?defaults.system[0]:defaults.messages[0].content[0];
    assert.deepEqual(protocol==='responses'?last.prompt_cache_breakpoint:last.cache_control,
      protocol==='responses'?{mode:'explicit'}:{type:'ephemeral'});
    const optedOut=upstream(protocol,request(protocol,{cache_control:null}));
    assert.ok(!JSON.parse(JSON.stringify({...optedOut,...provider.extras(optedOut,model,protocol)})).cache_control);
  }
  const routing=provider.extras({},model).provider;
  assert.deepEqual(routing.only,quote.route.only);assert.equal(routing.allow_fallbacks,false);
  assert.equal(routing.order,undefined,'manual order must not disable cache-aware sticky routing');
  const other={...model,provider_model:'any-vendor/any-model',bailian_quote:{...quote,cache:{mode:'implicit'}}};
  assert.equal(provider.extras({},other).cache_control,undefined);
  assert.deepEqual(provider.extras({},other).provider.order,quote.route.only);
  const unknown={...model,bailian_quote:{...quote,cache:undefined}};
  assert.equal(provider.extras({},unknown).cache_control,undefined);
  assert.deepEqual(provider.extras({},unknown).provider.order,quote.route.only);
  assert.equal(openRouterCache({}, {...model,bailian_quote:{...quote,tiers:[{input:'4000000000'}]}}).cache_control,undefined);
  assert.equal(openRouterCache({messages:[{role:'system',content:'prefix'},{role:'user',content:'question'}]}, {...model,provider_model:'new-vendor/released-tomorrow'}).messages[0].content[0].cache_control.type,'ephemeral');
  assert.equal(openRouterCache({}, {...model,bailian_quote:{...quote,cache:{mode:'implicit'}}}).cache_control,undefined);
  assert.equal(openRouterCache({}, {...model,bailian_quote:{...quote,cache:{mode:'mixed'}}}).cache_control,undefined);
});

test('explicit cache boundaries are preserved; user schema properties do not change caching or its hold',()=>{
  for(const prompt of [{messages:[{role:'user',content:[{type:'text',text:'prefix',cache_control:{type:'ephemeral',ttl:'1h'}}]}]},
    {input:[{role:'user',content:[{type:'input_text',text:'prefix',prompt_cache_breakpoint:{mode:'explicit'}}]}]}]){
    assert.deepEqual(openRouterCache(prompt,model),{});
  }
  const schema={messages:[{role:'system',content:'prefix'},{role:'user',content:'question'}],tools:[{type:'function',name:'example',parameters:{properties:{cache_control:{ttl:'1h'}}}}]};
  assert.equal(openRouterCache(schema,model).messages[0].content[0].cache_control.type,'ephemeral');
  assert.equal(hasLongCacheWrite(schema),false);
  assert.equal(hasLongCacheWrite({system:[{type:'text',text:'prefix',cache_control:{type:'ephemeral',ttl:'1h'}}]}),true);
});

test('one explicit-cache policy adds protocol-native breakpoints without modifying text, tools, or the original request',()=>{
  const original={input:[{type:'function_call',name:'lookup',arguments:'{"cache_control":"data"}',call_id:'call1'},
    {type:'function_call_output',call_id:'call1',output:'tool result'},{role:'user',content:'question'}],tools:[{type:'function',name:'lookup',parameters:{properties:{cache_control:{type:'string'}}}}]};
  const saved=structuredClone(original);
  const response=openRouterCache(original,model,'responses');
  assert.deepEqual(response.input[1].output,[{type:'input_text',text:'tool result',prompt_cache_breakpoint:{mode:'explicit'}}]);
  assert.equal(response.input[0],original.input[0]);assert.deepEqual(original,saved);
  const marked={...original,input:response.input};
  assert.deepEqual(openRouterCache(marked,model,'responses'),{},'client tool-result breakpoints must not be overwritten');
  const messages={messages:[{role:'user',content:'prefix'},{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:'result'}]},{role:'user',content:'question'}]};
  const message=openRouterCache(messages,model,'anthropic');
  assert.equal(message.messages[1].content[0].cache_control.type,'ephemeral');
  assert.equal(message.messages[1].content[0].content,'result');
  assert.ok(!messages.messages[1].content[0].cache_control);
  assert.deepEqual(openRouterCache({messages:[{role:'user',content:'same text'},{role:'user',content:'question'}]},model).messages[0].content,
    [{type:'text',text:'same text',cache_control:{type:'ephemeral'}}]);
  assert.deepEqual(openRouterCache({input:'one-shot'},model,'responses'),{});
  assert.deepEqual(openRouterCache({messages:[{role:'user',content:'one-shot'}]},model),{});
});

test('cache write holds cover the one-hour rate for each protocol, including content breakpoints',async()=>{
  const gateway=new GatewayService({repository:new InMemoryGatewayRepository({models:[model]}),providerRegistry:registry(),config:{REAL_MODEL_CALLS_ENABLED:true}});
  for(const protocol of ['responses','anthropic',null]){
    const short=await gateway.prepare({protocol,body:request(protocol)});
    const long=await gateway.prepare({protocol,body:request(protocol,{cache_control:{type:'ephemeral',ttl:'1h'}})});
    assert.ok(long.estimate.maxChargeUsdcNano>short.estimate.maxChargeUsdcNano);
    const minWrite=long.estimate.maxInputTokens*8000000000n/1000000n;
    assert.ok(long.estimate.maxChargeUsdcNano>=minWrite);
  }
  const block=await gateway.prepare({protocol:'anthropic',body:request('anthropic',{
    system:[{type:'text',text:'prefix',cache_control:{type:'ephemeral',ttl:'1h'}}]})});
  const plain=await gateway.prepare({protocol:'anthropic',body:request('anthropic',{system:[{type:'text',text:'prefix'}]})});
  assert.ok(block.estimate.maxChargeUsdcNano>plain.estimate.maxChargeUsdcNano);
  const unknownRate={...model,bailian_quote:{...quote,tiers:quote.tiers.map(t=>({...t,cacheWrite1h:undefined}))}};
  const noHour=new GatewayService({repository:new InMemoryGatewayRepository({models:[unknownRate]}),providerRegistry:registry(),config:{REAL_MODEL_CALLS_ENABLED:true}});
  await assert.rejects(noHour.prepare({protocol:'responses',body:request('responses',{cache_control:{type:'ephemeral',ttl:'1h'}})}),{code:'REQUEST_OPTION_NOT_PRICED'});
});

test('native APIs reject malformed top-level cache controls instead of silently losing them',()=>{
  for(const protocol of [responses,anthropic])for(const cache_control of ['enabled',{type:'unknown'},{type:'ephemeral',ttl:'12h'}]){
    assert.throws(()=>protocol.parse({...request(protocol===responses?'responses':'anthropic'),cache_control}));
  }
});

for(const mode of ['explicit','implicit'])for(const protocol of ['responses','anthropic',null])test(`gateway ${protocol??'chat'} ${mode}: repeated context cache and billing survive HTTP transport`,async t=>{
  const selectedModel={...model,bailian_quote:{...quote,cache:{mode}}};
  const sent=[];let generation=0;
  const providers=registry(async(url,init)=>{
    const body=JSON.parse(init.body);sent.push(body);generation++;
    assert.equal(body.cache_control,undefined);
    if(mode==='explicit'){
      const block=protocol==='responses'?body.input[0].content[0]:protocol==='anthropic'?body.system[0]:body.messages[0].content[0];
      assert.ok(block.cache_control??block.prompt_cache_breakpoint);
    }
    assert.equal(body.prompt_cache_key,'stable-conversation');
    assert.deepEqual(body.provider.order,mode==='explicit'?undefined:quote.route.only);assert.deepEqual(body.provider.only,quote.route.only);
    const cached=generation===2,read=cached?4000:0,write=!cached&&mode==='explicit'?4000:0,cost=cached?0.00096:mode==='explicit'?0.02016:0.01616;
    const id=`gen-cache-${generation}`;
    const details={cached_tokens:read,cache_write_tokens:write};
    let events;
    if(protocol==='responses')events=[{type:'response.completed',response:{id,object:'response',model:model.provider_model,status:'completed',output:[],
      usage:{input_tokens:4000,input_tokens_details:details,output_tokens:8,output_tokens_details:{reasoning_tokens:0},cost}}}];
    else if(protocol==='anthropic')events=[{type:'message_start',message:{id,type:'message',role:'assistant',model:model.provider_model,content:[],usage:{input_tokens:0,output_tokens:0}}},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:!cached&&mode==='implicit'?4000:0,cache_creation_input_tokens:write,cache_read_input_tokens:read,output_tokens:8,cost}},
      {type:'message_stop'}];
    else {
      const completion={id,object:'chat.completion',model:model.provider_model,choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],
        usage:{prompt_tokens:4000,prompt_tokens_details:details,completion_tokens:8,cost}};
      if(!body.stream)return Response.json(completion);
      events=[{...completion,object:'chat.completion.chunk',choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]},'[DONE]'];
    }
    return new Response(events.map(data=>`data: ${typeof data==='string'?data:JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  });
  const h=await createInMemoryGateway({repository:new InMemoryGatewayRepository({models:[selectedModel]}),providers,config:{REAL_MODEL_CALLS_ENABLED:true}});
  t.after(()=>h.app.close());const client=h.client();
  for(const stream of [false,true]){
    const response=await client.fetch(post(`/v1/${protocol==='responses'?'responses':protocol==='anthropic'?'messages':'chat/completions'}`,
      request(protocol,{stream,prompt_cache_key:'stable-conversation'})));
    const text=await response.text();assert.equal(response.status,200,text);
    if(stream)assert.ok(!parseSse(text).some(e=>e.data?.type==='error'||e.data?.error),text);
  }
  const rows=[...h.ledger.requests.values()];assert.equal(rows.length,2);
  assert.deepEqual(rows.map(r=>r.normalizedUsage.cachedInputTokens),[0,4000]);
  assert.deepEqual(rows.map(r=>r.normalizedUsage.inputTokens),[4000,4000]);
  assert.deepEqual(rows.map(r=>r.providerCostUsdNano),[mode==='explicit'?20160000n:16160000n,960000n]);
  assert.deepEqual(rows.map(r=>r.chargedAtomic),[mode==='explicit'?20362n:16322n,970n]);
  assert.ok(rows.every(r=>r.status==='completed'&&r.chargedFrom==='usage'));
  assert.equal(sent.length,2);
});
