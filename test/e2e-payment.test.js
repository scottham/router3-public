import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openPayment} from '../scripts/lib/e2e-payment.mjs';

function keyFile(t,value){
  const dir=mkdtempSync(join(tmpdir(),'router3-payment-test-')),path=join(dir,'key');
  const previous=process.env.MCG_API_KEY_FILE;
  writeFileSync(path,value,{mode:0o600});process.env.MCG_API_KEY_FILE=path;
  t.after(()=>{if(previous===undefined)delete process.env.MCG_API_KEY_FILE;else process.env.MCG_API_KEY_FILE=previous;rmSync(dir,{recursive:true,force:true});});
}

test('provided-key E2E reads its dashboard without signing, configuring, or revoking a wallet pool',async t=>{
  const token=`r3_live_abcdefgh_${'A'.repeat(43)}`;
  keyFile(t,token);
  const calls=[];
  const server=createServer((req,res)=>{
    calls.push([req.method,req.url]);assert.equal(req.headers.authorization,`Bearer ${token}`);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({key:{spentAtomic:'123',running:0},pool:{availableAtomic:'456'}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const payment=await openPayment({gatewayUrl:`http://127.0.0.1:${server.address().port}`});
  assert.equal(payment.token,token);
  assert.equal(payment.mode,'api-key');
  const view=await payment.view();assert.equal(view.chargedAtomic,'123');assert.equal(view.unspentAtomic,'456');
  assert.equal(payment.charged({billed_usdc_nano:'1000'}),'1000');
  assert.deepEqual(await payment.close(),{providedKey:true});
  assert.deepEqual(calls,[['GET','/v1/key']]);
});

test('provided-key E2E rejects malformed credentials before making requests',t=>{
  keyFile(t,'invalid');
  assert.throws(()=>openPayment({gatewayUrl:'http://127.0.0.1:9'}),/INVALID_E2E_API_KEY_FILE/);
});
