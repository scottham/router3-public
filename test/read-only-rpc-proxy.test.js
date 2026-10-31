import assert from 'node:assert/strict';
import test from 'node:test';
import { createReadOnlyRpcProxy } from '../scripts/lib/read-only-rpc-proxy.mjs';

test('official fork transport never forwards writes, wallet methods or mixed batches', async (t) => {
  const calls = [];
  const proxy = await createReadOnlyRpcProxy('https://rpc.invalid/secret',{transport:async (url,input) => {
    calls.push({url,input});return {ok:true,json:async()=>({jsonrpc:'2.0',id:1,result:'0x14a34'})};
  }});
  t.after(() => proxy.close());
  const post = async (body) => (await fetch(proxy.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  const read = {jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]};
  assert.equal((await post(read)).result,'0x14a34');
  assert.equal((await post({...read,method:'eth_gasPrice'})).result,'0x14a34');
  assert.equal((await post({...read,method:'eth_getAccountInfo'})).result,'0x14a34');
  for (const method of ['eth_sendRawTransaction','eth_sendTransaction','wallet_sendCalls','personal_sign','anvil_setBalance','debug_setHead']) {
    assert.ok((await post({...read,method})).error);
    assert.ok((await post([read,{...read,method}])).error);
  }
  assert.equal(calls.length,3); assert.equal(proxy.stats.forwarded,3); assert.equal(proxy.stats.rejected,12);
  assert.equal(calls[0].input.redirect,'error');
});

test('read-only fork diagnostics do not expose credential-bearing upstream failures', async (t) => {
  const proxy = await createReadOnlyRpcProxy('https://rpc.invalid/secret',{transport:async()=>({ok:true,json:async()=>({id:1,error:{code:-32601,message:'https://rpc.invalid/secret'}})})});
  t.after(() => proxy.close());
  const response = await fetch(proxy.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getCode',params:[]})});
  const text = await response.text(); assert.doesNotMatch(text,/secret|rpc.invalid/);assert.match(text,/failed/);
  assert.equal(JSON.parse(text).error.code,-32601);
  await assert.rejects(createReadOnlyRpcProxy('http://rpc.invalid'),/HTTPS/);
});
