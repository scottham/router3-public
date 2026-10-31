import test from 'node:test';
import assert from 'node:assert/strict';
import {collectChatStream} from '../src/providers/chat-stream.js';

const chunk=(data)=>`data: ${JSON.stringify({id:'abc',model:'qwen-plus',...data})}\r\n\r\n`;
function response(text,split=1) {
  const data=new TextEncoder().encode(text);
  return new Response(new ReadableStream({start(c){for(let i=0;i<data.length;i+=split)c.enqueue(data.slice(i,i+split));c.close();}}));
}
test('collects split UTF-8, reasoning, tools and final usage',async()=>{
  const body=chunk({choices:[{index:0,delta:{reasoning_content:'思考',content:'你'}}]})
    +chunk({choices:[{index:0,delta:{content:'好',tool_calls:[{index:0,id:'call1',function:{name:'lookup',arguments:'{'}}]}}]})
    +chunk({choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'}'}}]},finish_reason:'tool_calls'}]})
    +chunk({choices:[],usage:{prompt_tokens:5,completion_tokens:8}})+'data: [DONE]\r\n\r\n';
  const parsed=await collectChatStream(response(body));
  assert.equal(parsed.choices[0].message.content,'你好');assert.equal(parsed.choices[0].message.reasoning_content,'思考');
  assert.equal(parsed.choices[0].message.tool_calls[0].function.arguments,'{}');assert.equal(parsed.usage.completion_tokens,8);
});
test('missing usage, truncation, upstream errors and size limits retain uncertain usage',async()=>{
  for(const body of ['data: [DONE]\n\n',chunk({error:{message:'upstream failed'}}),chunk({usage:{prompt_tokens:1}})]) {
    await assert.rejects(collectChatStream(response(body)),e=>e.chargeCertainty==='unknown');
  }
  await assert.rejects(collectChatStream(response('x'.repeat(32)),{maxBytes:10}),e=>e.chargeCertainty==='unknown');
});

import {ChatCompletionAggregator,aggregateChatStream,completionToChunk,parseChatStream} from '../src/providers/chat-stream.js';

test('the parse layer yields raw chunks as they arrive and stops at [DONE]',async()=>{
  const body=chunk({choices:[{index:0,delta:{content:'a'}}]})+': keep-alive comment\n\n'
    +chunk({choices:[{index:0,delta:{content:'b'},finish_reason:'stop'}]})+chunk({choices:[],usage:{prompt_tokens:1,completion_tokens:2}})+'data: [DONE]\n\n';
  const seen=[];
  for await(const item of parseChatStream(response(body,3)))seen.push(item);
  assert.equal(seen.length,3);
  assert.equal(seen[0].choices[0].delta.content,'a');
  assert.deepEqual(seen[2].usage,{prompt_tokens:1,completion_tokens:2});
  // A stream that never reaches [DONE] is incomplete even when it parsed cleanly.
  await assert.rejects((async()=>{for await(const _ of parseChatStream(response(chunk({choices:[]}))));})(),e=>e.code==='PROVIDER_STREAM_INCOMPLETE');
  // Oversized streams stop reading early, with uncertain usage.
  await assert.rejects((async()=>{for await(const _ of parseChatStream(response('x'.repeat(64)),{maxBytes:16}));})(),e=>e.chargeCertainty==='unknown');
});

test('the aggregation layer accepts usage supplied separately and reports completeness',async()=>{
  const aggregator=new ChatCompletionAggregator();
  aggregator.push({id:'abc',created:1,model:'m',choices:[{index:0,delta:{role:'assistant',content:'hi'}}]});
  assert.equal(aggregator.complete,false);
  assert.throws(()=>aggregator.toCompletion(),e=>e.code==='PROVIDER_STREAM_INCOMPLETE');
  aggregator.push({id:'abc',choices:[{index:0,delta:{},finish_reason:'stop'}]});
  assert.equal(aggregator.complete,false,'usage still missing');
  const completion=aggregator.toCompletion({prompt_tokens:2,completion_tokens:1});
  assert.deepEqual(completion,{id:'abc',object:'chat.completion',created:1,model:'m',
    choices:[{index:0,message:{role:'assistant',content:'hi'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}});
  assert.throws(()=>aggregator.push({id:'other',choices:[]}),e=>e.code==='PROVIDER_STREAM_INCOMPLETE');
  const aggregated=await aggregateChatStream((async function*(){yield {id:'x',choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}};})());
  assert.equal(aggregated.choices[0].message.content,'ok');
});

test('a cached completion replays as one well-formed chunk',()=>{
  const replayed=completionToChunk({id:'abc',object:'chat.completion',created:1,model:'m',usage:{total_tokens:3},gateway:{request_id:'r'},
    choices:[{index:0,message:{role:'assistant',content:'hi',tool_calls:[{id:'c',type:'function',function:{name:'f',arguments:'{}'}}]},finish_reason:'tool_calls'}]});
  assert.equal(replayed.object,'chat.completion.chunk');
  assert.deepEqual(replayed.choices[0].delta.tool_calls[0].function.name,'f');
  assert.equal(replayed.choices[0].message,undefined);
  assert.equal(replayed.choices[0].finish_reason,'tool_calls');
  assert.deepEqual(replayed.gateway,{request_id:'r'});
});
