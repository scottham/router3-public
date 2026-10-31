import assert from 'node:assert/strict';
import test from 'node:test';
import {upstreamRequestBody} from '../src/providers/upstream-params.js';
import {GatewayService} from '../src/services/gateway-service.js';

test('thinking controls reach the upstream while routing/fanout overrides remain excluded',()=>{
  const result=upstreamRequestBody({messages:[],max_tokens:32,thinking:{type:'disabled'},reasoning_effort:'low',
    api_base:'https://untrusted.invalid',extra_body:{api_key:'untrusted'},n:10,mock_response:'free'},'deepseek/deepseek-flash');
  assert.deepEqual(result,{messages:[],max_tokens:32,thinking:{type:'disabled'},reasoning_effort:'low',model:'deepseek/deepseek-flash',stream:false});
});

test('invalid thinking objects are rejected before model lookup or pricing',async()=>{
  const gateway=new GatewayService({config:{},providerRegistry:{},repository:{getModelAndPrice:async()=>assert.fail('must reject before lookup')}});
  for(const thinking of [{type:'unknown'},{type:'disabled',budget_tokens:100000},{type:'disabled',api_base:'https://untrusted.invalid'}]) {
    await assert.rejects(gateway.prepare({body:{model:'deepseek/flash',messages:[{role:'user',content:'OK'}],max_tokens:32,thinking}}));
  }
});
