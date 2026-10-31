import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {DirectProvider,reportedCostUsdNano} from '../src/providers/direct.js';
import {createProviderRegistry} from '../src/providers/registry.js';
import {loadProvidersConfig} from '../src/config/providers.js';

const model=Object.freeze({provider:'deepseek',provider_model:'deepseek-flash',public_name:'deepseek/deepseek-flash'});
const json=(body,init={})=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'},...init});
const sse=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
const provider=(fetchImpl,options={})=>new DirectProvider({name:'deepseek',baseUrl:'https://api.deepseek.com/',apiKey:'sk-test',fetchImpl,
  protocolPaths:{anthropic:'/anthropic/v1/messages',responses:'/responses'},...options});

test('the registry builds one direct provider per configured instance and nothing else',()=>{
  const {providers}=loadProvidersConfig(new URL('./fixtures/providers-both.json',import.meta.url));
  const keys=[];
  const registry=createProviderRegistry({providers,PUBLIC_APP_URL:'https://router3.ai',APP_NAME:'Router 3'},
    {env:{DEEPSEEK_API_KEY:'sk-ds'},providerKeys:{keyFor:async id=>{keys.push(id);return 'sk-or-project';}}});
  assert.deepEqual(registry.names().sort(),['deepseek','mock','openrouter']);
  assert.equal(registry.get('deepseek').protocolPath('anthropic'),'/anthropic/v1/messages');
  assert.equal(registry.get('openrouter').protocolPath('responses'),'/responses');
  assert.throws(()=>registry.get('bailian'),e=>e.code==='PROVIDER_NOT_SUPPORTED');
  // OpenRouter routes only among the hosts the catalog priced and asks for its cost.
  const quote={route:{provider:'Anthropic'}};
  assert.deepEqual(registry.get('openrouter').extras({},{bailian_quote:quote}),{usage:{include:true},provider:{order:['Anthropic'],allow_fallbacks:false}});
  const hosts=['anthropic','amazon-bedrock','google-vertex/global'];
  assert.deepEqual(registry.get('openrouter').extras({},{bailian_quote:{route:{provider:'Anthropic',only:hosts}}}),
    {usage:{include:true},provider:{order:hosts,only:hosts,allow_fallbacks:false}});
  assert.deepEqual(registry.get('deepseek').extras({},{bailian_quote:quote}),{});
});

test('chat: only allowed fields reach the provider, usage and the reported cost are normalized',async()=>{
  let sent;
  const instance=provider(async(url,options)=>{
    sent={url,options,body:JSON.parse(options.body)};
    return json({id:'chatcmpl_test',model:'deepseek-flash',provider:'DeepInfra',
      choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}],
      usage:{prompt_tokens:12,completion_tokens:4,cost:0.00001344,prompt_tokens_details:{cached_tokens:3},completion_tokens_details:{reasoning_tokens:1}}});
  });
  const result=await instance.invoke({messages:[{role:'user',content:'hi'}],max_tokens:20,api_key:'customer',api_base:'https://attacker.invalid',
    mock_response:'free',fallbacks:['x'],num_retries:99,metadata:{customer:'value'},n:3},model,AbortSignal.timeout(1000),{requestId:'r1'});
  assert.equal(sent.url,'https://api.deepseek.com/chat/completions');
  assert.equal(sent.options.headers.authorization,'Bearer sk-test');
  assert.deepEqual(sent.body,{messages:[{role:'user',content:'hi'}],max_tokens:20,model:'deepseek-flash',stream:false});
  assert.deepEqual(result.usage,{inputTokens:12,cachedInputTokens:3,outputTokens:4,reasoningTokens:1});
  assert.equal(result.usageSource,'direct:deepseek');
  assert.equal(result.providerCostUsdNano,13440n);
  assert.equal(result.rawUsageRedacted.upstream_model,'deepseek-flash');
  assert.equal(result.rawUsageRedacted.upstream_route,'DeepInfra');
  assert.equal(result.body.model,'deepseek/deepseek-flash');
  assert.equal(reportedCostUsdNano({}),null);
  assert.equal(reportedCostUsdNano({cost:'abc'}),null);
  assert.equal(reportedCostUsdNano({cost:1.5e-7}),150n);
});

test('chat stream: usage on the finish chunk is billed, comment lines are ignored (OpenRouter recording)',async()=>{
  let sent;
  const instance=provider(async(_url,options)=>{sent=JSON.parse(options.body);return sse(readFileSync(new URL('./fixtures/openrouter/chat-stream.sse',import.meta.url),'utf8'));});
  const upstream=await instance.stream({messages:[{role:'user',content:'Count 1 to 3'}],max_tokens:30},model);
  assert.deepEqual([sent.stream,sent.stream_options],[true,{include_usage:true}]);
  let chunks=0;for await(const _ of upstream.chunks)chunks++;
  assert.ok(chunks>3);
  const result=upstream.result();
  assert.deepEqual(result.usage,{inputTokens:36,cachedInputTokens:0,outputTokens:30,reasoningTokens:30});
  assert.equal(result.providerCostUsdNano,17640n);
  assert.equal(result.body.choices[0].finish_reason,'length');
});

test('per-project credentials: the resolver runs per call and a missing key is a pre-charge failure',async()=>{
  const seen=[];
  const instance=new DirectProvider({name:'openrouter',baseUrl:'https://openrouter.ai/api/v1',keyResolver:async ctx=>{seen.push(ctx.projectId);return ctx.projectId==='p1'?'sk-or-p1':null;},
    fetchImpl:async(_url,options)=>{seen.push(options.headers.authorization);return json({id:'g',choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});}});
  await instance.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},{...model,provider:'openrouter'},undefined,{projectId:'p1'});
  assert.deepEqual(seen,['p1','Bearer sk-or-p1']);
  await assert.rejects(instance.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model,undefined,{projectId:'p2'}),
    e=>e.code==='PROVIDER_NOT_CONFIGURED'&&e.chargeCertainty==='not_charged');
});

test('native endpoints: the protocol path and extras are applied, non-stream answers are rejected',async()=>{
  const calls=[];
  const instance=provider(async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});
    return calls.length===1?sse('event: message_start\ndata: {"type":"message_start","message":{}}\n\n'):json({type:'message'});},
  {requestExtras:(_body,_model,protocol)=>protocol?{provider:{order:['X']}}:{}});
  const events=await instance.openProtocol('anthropic',{model:'deepseek-flash',messages:[],max_tokens:1,stream:true},undefined,{},{});
  const out=[];for await(const e of events)out.push(e);
  assert.equal(calls[0].url,'https://api.deepseek.com/anthropic/v1/messages');
  assert.deepEqual(calls[0].body.provider,{order:['X']});
  assert.equal(out[0].event,'message_start');
  await assert.rejects(instance.openProtocol('anthropic',{},undefined,{},{}),{code:'PROVIDER_STREAM_INCOMPLETE'});
  await assert.rejects(instance.openProtocol('nope',{},undefined,{},{}),{code:'MODEL_PROTOCOL_UNSUPPORTED'});
});

test('upstream HTTP failures are classified conservatively: 4xx never charged, timeouts and 5xx uncertain',async()=>{
  const cases=[
    [400,'not_charged','PROVIDER_REQUEST_REJECTED',400],
    [401,'not_charged','PROVIDER_AUTH_FAILED',502],
    [402,'not_charged','PROVIDER_CREDIT_UNAVAILABLE',503],
    [404,'not_charged','PROVIDER_MODEL_UNAVAILABLE',503],
    [408,'unknown','PROVIDER_TIMEOUT',504],
    [429,'not_charged','PROVIDER_RATE_LIMITED',429],
    [500,'unknown','PROVIDER_HTTP_ERROR',502],
    [503,'unknown','PROVIDER_HTTP_ERROR',502]
  ];
  for(const [status,certainty,code,statusCode] of cases) {
    const instance=provider(async()=>json({error:{message:'the platform account is out of credit'}},{status}));
    await assert.rejects(instance.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model),e=>{
      assert.equal(e.code,code,String(status));assert.equal(e.chargeCertainty,certainty);assert.equal(e.statusCode,statusCode);
      // Account details from the upstream never reach the customer.
      if(code!=='PROVIDER_REQUEST_REJECTED')assert.doesNotMatch(e.message,/platform account/);
      return true;
    });
  }
  const network=provider(async()=>{throw new Error('ECONNRESET');});
  await assert.rejects(network.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model),e=>e.code==='PROVIDER_NETWORK_ERROR'&&e.chargeCertainty==='unknown');
  // Nothing reached the provider: the name did not resolve, nothing listened,
  // or TLS failed (undici wraps the cause, happy-eyeballs in an AggregateError).
  for(const cause of [Object.assign(new Error('getaddrinfo ENOTFOUND'),{code:'ENOTFOUND'}),
    Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'})]),{code:'ECONNREFUSED'}),
    Object.assign(new Error('certificate has expired'),{code:'CERT_HAS_EXPIRED'}),
    Object.assign(new Error('timeout'),{code:'UND_ERR_CONNECT_TIMEOUT'})]) {
    const unreachable=provider(async()=>{throw new TypeError('fetch failed',{cause});});
    await assert.rejects(unreachable.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model),e=>{
      assert.equal(e.code,'PROVIDER_UNREACHABLE',cause.code);assert.equal(e.chargeCertainty,'not_charged');assert.equal(e.statusCode,503);return true;
    });
  }
  // A reset after the request went out, or the caller leaving, stays unknown.
  const reset=provider(async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('socket hang up'),{code:'ECONNRESET'})});});
  await assert.rejects(reset.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model),e=>e.code==='PROVIDER_NETWORK_ERROR'&&e.chargeCertainty==='unknown');
  const aborted=new AbortController();aborted.abort();
  const left=provider(async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('refused'),{code:'ECONNREFUSED'})});});
  await assert.rejects(left.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model,aborted.signal),e=>e.code==='PROVIDER_NETWORK_ERROR'&&e.chargeCertainty==='unknown');
  const broken=provider(async()=>new Response('not json',{headers:{'content-type':'application/json'}}));
  await assert.rejects(broken.invoke({messages:[{role:'user',content:'hi'}],max_tokens:1},model),e=>e.code==='PROVIDER_RESPONSE_INVALID');
});
