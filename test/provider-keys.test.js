import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenRouterManagement,ProviderKeyService} from '../src/services/provider-keys.js';

// A fake OpenRouter management API: keys by hash, with the shape the real one returns.
function management() {
  const keys=new Map();let n=0;
  const data=k=>({hash:k.hash,name:k.name,label:`sk-or-v1-${k.hash.slice(0,3)}...`,limit:k.limit,limit_remaining:k.limit==null?null:k.limit-k.usage,
    limit_reset:k.limit_reset??null,disabled:k.disabled,usage:k.usage,created_at:'2026-10-22T00:00:00Z'});
  const fetchImpl=async(url,{method='GET',body}={})=>{
    const u=new URL(url);const json=(status,value)=>({ok:status<400,status,text:async()=>JSON.stringify(value)});
    if(u.pathname==='/api/v1/keys'&&method==='GET')return json(200,{data:[...keys.values()].map(data)});
    if(u.pathname==='/api/v1/keys'&&method==='POST') {
      const {name,limit,limit_reset}=JSON.parse(body);const hash=`h${++n}`;keys.set(hash,{hash,name,limit:limit??null,limit_reset:limit_reset??null,disabled:false,usage:0});
      return json(201,{key:`sk-or-v1-secret-${hash}`,data:data(keys.get(hash))});
    }
    const hash=u.pathname.split('/').pop();const k=keys.get(hash);
    if(!k)return json(404,{error:{message:'not found'}});
    if(method==='PATCH'){Object.assign(k,JSON.parse(body));return json(200,{data:data(k)});}
    if(method==='DELETE'){keys.delete(hash);return json(200,{data:{success:true}});}
    return json(200,{data:data(k)});
  };
  return {keys,client:new OpenRouterManagement({managementKey:'mk',fetchImpl})};
}

// A fake database: the payer key table, and pool daily limits by wallet.
function database(dailyLimits=new Map()) {
  const rows=new Map();let id=0;
  const pool={
    async query(sql,params=[]) {
      if(/from private.provider_payer_keys where payer/.test(sql)){const r=rows.get(params[0]);return {rows:r&&r.provider===params[1]?[r]:[]};}
      if(/insert into private.provider_payer_keys/.test(sql)) {
        const [payer,provider,remote_name,remote_hash,encrypted_secret,limit_usd_nano]=params;
        rows.set(payer,{id:`k${++id}`,payer,provider,remote_name,remote_hash,state:'active',encrypted_secret,limit_usd_nano,usage_usd_nano:'0',disabled_at:null,error_code:null});
        return {rows:[]};
      }
      if(/update private.provider_payer_keys set state='deleted'/.test(sql)){for(const r of rows.values())if(r.id===params[0])Object.assign(r,{state:'deleted',encrypted_secret:null,error_code:'REMOTE_KEY_MISSING'});return {rows:[]};}
      if(/update private.provider_payer_keys set limit_usd_nano=\$2/.test(sql)){for(const r of rows.values())if(r.id===params[0])Object.assign(r,{limit_usd_nano:params[1],usage_usd_nano:params[2]});return {rows:[]};}
      if(/select payer from private.provider_payer_keys/.test(sql))return {rows:[...rows.values()].filter(r=>r.state!=='deleted').map(r=>({payer:r.payer}))};
      if(/from private.pool_accounts/.test(sql)){const d=dailyLimits.get(params[0]);return {rows:d==null?[]:[{daily_limit_atomic:String(d)}]};}
      if(/^(begin|commit|rollback)$/.test(sql)||/pg_advisory_xact_lock/.test(sql))return {rows:[]};
      throw new Error('unexpected query: '+sql.slice(0,60));
    },
    async connect() {return {query:pool.query,release(){}};}
  };
  return {pool,rows};
}

const config={PUBLIC_APP_URL:'https://router3.ai',activeResponseEncryptionKeyId:'v1',responseEncryptionKeys:new Map([['v1',Buffer.alloc(32,7)]])};
const payer='0x'+'ab'.repeat(20),other='0x'+'cd'.repeat(20);

test('a payer key is minted on first use with the configured limit, cached, and decryptable from the row',async()=>{
  const {keys,client}=management();
  const {pool,rows}=database();
  const service=new ProviderKeyService({pool,config,management:client,limitUsd:40});
  const secret=await service.keyFor(payer.toUpperCase());
  assert.match(secret,/^sk-or-v1-secret-h1$/);
  assert.equal(rows.get(payer).remote_name,`router3:router3.ai:${payer}`);
  assert.equal(rows.get(payer).limit_usd_nano,'40000000000');
  assert.equal(keys.get('h1').limit,40);
  assert.ok(!JSON.stringify(rows.get(payer).encrypted_secret).includes('secret-h1'),'the secret is encrypted at rest');
  assert.equal(await service.keyFor(payer),secret);
  assert.equal(keys.size,1,'the cached key is reused');
  const fresh=new ProviderKeyService({pool,config,management:client,limitUsd:40});
  assert.equal(await fresh.keyFor(payer),secret,'a new process decrypts the stored secret');
  await fresh.keyFor(other);
  assert.equal(keys.size,2,'one key per wallet');
  await assert.rejects(fresh.keyFor('not-a-wallet'),e=>e.code==='PAYER_REQUIRED'&&e.chargeCertainty==='not_charged');
  await assert.rejects(fresh.keyFor(undefined),e=>e.code==='PAYER_REQUIRED');
});

test('a remote key with our name but no local secret is replaced, never reused',async()=>{
  const {keys,client}=management();
  await client.createKey({name:`router3:router3.ai:${payer}`,limit:1});
  const {pool}=database();
  const service=new ProviderKeyService({pool,config,management:client,limitUsd:10});
  await service.keyFor(payer);
  assert.deepEqual([...keys.values()].map(k=>k.name),[`router3:router3.ai:${payer}`]);
  assert.equal([...keys.keys()][0],'h2');
});

test('sync mirrors the remote key: the limit is enforced, usage is recorded, a deleted key is noticed',async()=>{
  const {keys,client}=management();
  const {pool,rows}=database();
  const service=new ProviderKeyService({pool,config,management:client,limitUsd:10});
  await service.keyFor(payer);
  keys.get('h1').usage=0.75;keys.get('h1').limit=99;keys.get('h1').limit_reset=null;
  assert.deepEqual(await service.syncPayer(payer),{payer,state:'active',limitUsd:10,limitReset:'daily',usageUsd:0.75});
  assert.equal(keys.get('h1').limit,10,'a limit changed at the provider is put back');
  assert.equal(keys.get('h1').limit_reset,'daily','the limit resets every day');
  assert.equal(rows.get(payer).usage_usd_nano,'750000000');
  keys.delete('h1');
  assert.deepEqual(await service.reconcileAll(),[{payer,state:'deleted'}]);
  assert.equal(rows.get(payer).state,'deleted');
  await assert.rejects(service.keyFor(payer),e=>e.code==='PROVIDER_KEY_UNAVAILABLE');
  assert.equal(await service.syncPayer(other),null);
});

test('a wallet with a prepaid pool gets its pool daily limit as the key limit, reset daily; the configured limit is the fallback',async()=>{
  const {keys,client}=management();
  const {pool}=database(new Map([[payer,25_000_000n]]));
  const service=new ProviderKeyService({pool,config,management:client,limitUsd:10});
  await service.keyFor(payer);
  assert.deepEqual([keys.get('h1').limit,keys.get('h1').limit_reset],[25,'daily']);
  await service.keyFor(other);
  assert.deepEqual([keys.get('h2').limit,keys.get('h2').limit_reset],[10,'daily']);
});
