import {decryptJson,encryptJson} from '../lib/crypto.js';
import {decimalUnits} from '../lib/money.js';
import {ProviderError} from '../providers/provider-error.js';

// One OpenRouter API key per payer wallet, minted from the management key
// (which itself cannot call models). The key's credit limit, reset daily, caps
// what one wallet can spend upstream in a day even if the gateway's own
// accounting failed: the wallet's prepaid pool daily limit when it has one,
// otherwise the configured default. And
// OpenRouter's per-key usage can be compared with what the gateway charged
// that wallet. Secrets are encrypted at rest with the response encryption key.
const unavailable=(message,code='PROVIDER_KEY_UNAVAILABLE')=>new ProviderError(message,{code,statusCode:503,chargeCertainty:'not_charged'});
const PAYER=/^0x[0-9a-f]{40}$/;

export class OpenRouterManagement {
  constructor({managementKey,baseUrl='https://openrouter.ai/api/v1',fetchImpl=fetch,timeoutMs=15000}) {
    this.key=managementKey;this.baseUrl=baseUrl.replace(/\/$/,'');this.fetch=fetchImpl;this.timeoutMs=timeoutMs;
  }
  async request(path,{method='GET',body}={}) {
    if(!this.key)throw new Error('OPENROUTER_MANAGEMENT_KEY_REQUIRED');
    let response;
    try {
      response=await this.fetch(`${this.baseUrl}${path}`,{method,redirect:'error',
        headers:{authorization:`Bearer ${this.key}`,'content-type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(this.timeoutMs)});
    } catch {throw new Error('OPENROUTER_MANAGEMENT_UNREACHABLE');}
    // Never put remote bodies or the key in errors.
    const text=await response.text().catch(()=>{throw new Error('OPENROUTER_MANAGEMENT_UNREACHABLE');});
    if(!response.ok){const error=new Error(`OPENROUTER_MANAGEMENT_HTTP_${response.status}`);error.status=response.status;throw error;}
    try{return JSON.parse(text);}catch{throw new Error('OPENROUTER_MANAGEMENT_RESPONSE_INVALID');}
  }
  async listKeys() {
    const result=[];
    for(let offset=0;;offset+=100) {
      const {data}=await this.request(`/keys?offset=${offset}&include_disabled=true`);
      if(!Array.isArray(data))throw new Error('OPENROUTER_MANAGEMENT_RESPONSE_INVALID');
      result.push(...data);
      if(data.length<100)return result;
    }
  }
  createKey(body) {return this.request('/keys',{method:'POST',body});}
  getKey(hash) {return this.request(`/keys/${encodeURIComponent(hash)}`);}
  updateKey(hash,body) {return this.request(`/keys/${encodeURIComponent(hash)}`,{method:'PATCH',body});}
  deleteKey(hash) {return this.request(`/keys/${encodeURIComponent(hash)}`,{method:'DELETE'});}
}

export class ProviderKeyService {
  constructor({pool,config,management,provider='openrouter',limitUsd=100,keyPrefix}) {
    this.pool=pool;this.config=config;this.management=management;this.provider=provider;
    this.limitUsd=limitUsd;
    // Remote key names carry the deployment, so several gateways can share one
    // OpenRouter account without claiming each other's keys.
    this.keyPrefix=keyPrefix??`router3:${config.PUBLIC_APP_URL?new URL(config.PUBLIC_APP_URL).host:'local'}`;
    this.cache=new Map();
  }

  remoteName(payer) {return `${this.keyPrefix}:${payer}`;}

  // The wallet's daily cap in USD (1 USDC = 1 USD).
  async limitFor(payer,client=this.pool) {
    const {rows:[a]}=await client.query('select daily_limit_atomic from private.pool_accounts where payer=$1',[payer]).catch(()=>({rows:[]}));
    const atomic=a?BigInt(a.daily_limit_atomic):0n;
    return atomic>0n?Number(atomic)/1e6:this.limitUsd;
  }

  seal(secret) {
    const keyId=this.config.activeResponseEncryptionKeyId,key=this.config.responseEncryptionKeys.get(keyId);
    const e=encryptJson(secret,keyId,key);
    return {keyId,nonce:e.nonce.toString('base64'),authTag:e.authTag.toString('base64'),ciphertext:e.ciphertext.toString('base64')};
  }

  open(record) {
    const key=this.config.responseEncryptionKeys.get(record.keyId);
    if(!key)throw unavailable('The provider key encryption key is unavailable','PROVIDER_KEY_ENCRYPTION_UNAVAILABLE');
    return decryptJson({keyId:record.keyId,nonce:Buffer.from(record.nonce,'base64'),authTag:Buffer.from(record.authTag,'base64'),
      ciphertext:Buffer.from(record.ciphertext,'base64')},key);
  }

  async row(payer,client=this.pool) {
    const {rows:[row]}=await client.query(`select * from private.provider_payer_keys where payer=$1 and provider=$2`,[payer,this.provider]);
    return row??null;
  }

  // The call key for a payer wallet: minted on first use.
  async keyFor(payer) {
    payer=String(payer??'').toLowerCase();
    if(!PAYER.test(payer))throw unavailable('A payer wallet is required for this provider','PAYER_REQUIRED');
    const cached=this.cache.get(payer);
    if(cached)return cached;
    const row=await this.row(payer);
    if(row?.state==='active'&&row.encrypted_secret) {
      const secret=this.open(row.encrypted_secret);this.cache.set(payer,secret);return secret;
    }
    if(row&&row.state!=='active')throw unavailable(`This wallet's ${this.provider} key is ${row.state}`);
    const secret=await this.ensure(payer);
    this.cache.set(payer,secret);
    return secret;
  }

  // Mints the payer's key under an advisory lock; a second caller waits and
  // reuses it. A remote key with this name but no local secret (a lost create
  // response) is removed before a new one is minted.
  async ensure(payer) {
    const client=await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))',[`provider-key:${this.provider}:${payer}`]);
      const existing=await this.row(payer,client);
      if(existing?.state==='active'&&existing.encrypted_secret){await client.query('commit');return this.open(existing.encrypted_secret);}
      const name=this.remoteName(payer);
      for(const orphan of (await this.management.listKeys()).filter(k=>k.name===name)) {
        await this.management.updateKey(orphan.hash,{disabled:true});await this.management.deleteKey(orphan.hash);
      }
      const limit=await this.limitFor(payer,client);
      const created=await this.management.createKey({name,limit,limit_reset:'daily'});
      if(typeof created?.key!=='string'||!created.data?.hash)throw new Error('OPENROUTER_MANAGEMENT_RESPONSE_INVALID');
      await client.query(`insert into private.provider_payer_keys(payer,provider,remote_name,remote_hash,state,encrypted_secret,limit_usd_nano)
        values($1,$2,$3,$4,'active',$5,$6) on conflict(payer,provider) do update set remote_name=excluded.remote_name,remote_hash=excluded.remote_hash,
        state='active',encrypted_secret=excluded.encrypted_secret,limit_usd_nano=excluded.limit_usd_nano,disabled_at=null,error_code=null,updated_at=now()`,
      [payer,this.provider,name,created.data.hash,this.seal(created.key),decimalUnits(String(limit),9).toString()]);
      await client.query('commit');
      return created.key;
    } catch(error) {await client.query('rollback').catch(()=>undefined);throw error;}
    finally {client.release();}
  }

  // Brings the remote key in line: the configured limit, usage mirrored, a
  // key deleted at the provider noticed.
  async syncPayer(payer) {
    const row=await this.row(payer);
    if(!row||row.state==='deleted'||!row.remote_hash)return null;
    let remote;
    try{remote=(await this.management.getKey(row.remote_hash)).data;}
    catch(error) {
      if(error.status!==404)throw error;
      await this.pool.query(`update private.provider_payer_keys set state='deleted',encrypted_secret=null,error_code='REMOTE_KEY_MISSING',updated_at=now() where id=$1`,[row.id]);
      this.cache.delete(payer);
      return {payer,state:'deleted'};
    }
    const disabled=row.state==='disabled';
    const limit=await this.limitFor(payer);
    if(remote.disabled!==disabled||Number(remote.limit??-1)!==limit||remote.limit_reset!=='daily') {
      remote=(await this.management.updateKey(row.remote_hash,{disabled,limit,limit_reset:'daily'})).data??remote;
    }
    await this.pool.query(`update private.provider_payer_keys set limit_usd_nano=$2,usage_usd_nano=$3,last_synced_at=now(),error_code=null,updated_at=now() where id=$1`,
      [row.id,decimalUnits(String(limit),9).toString(),decimalUnits(String(remote.usage??0),9).toString()]);
    return {payer,state:row.state,limitUsd:limit,limitReset:remote.limit_reset??null,usageUsd:Number(remote.usage??0)};
  }

  async reconcileAll() {
    const {rows}=await this.pool.query(`select payer from private.provider_payer_keys where provider=$1 and state<>'deleted' order by created_at`,[this.provider]);
    const results=[];
    for(const {payer} of rows) {
      try{results.push(await this.syncPayer(payer));}
      catch(error){results.push({payer,error:/^[A-Z0-9_]{1,80}$/.test(error.message)?error.message:'SYNC_FAILED'});}
    }
    return results;
  }

  // Usage OpenRouter attributes to each wallet's key versus the cost the
  // gateway recorded for that wallet's OpenRouter requests.
  async listKeys() {
    const {rows}=await this.pool.query(`select k.payer,k.state,k.limit_usd_nano,k.usage_usd_nano,k.last_synced_at,
      (coalesce((select sum(r.provider_cost_usd_nano) from private.x402_requests r join public.model_catalog c on c.id=r.model_id
        where r.payer=k.payer and c.provider=$1 and r.provider_cost_usd_nano is not null),0)
       +coalesce((select sum(r.provider_cost_usd_nano) from private.pool_requests r join public.model_catalog c on c.id=r.model_id
        where r.payer=k.payer and c.provider=$1 and r.provider_cost_usd_nano is not null),0))::text recorded_usd_nano
      from private.provider_payer_keys k where k.provider=$1 order by k.created_at`,[this.provider]);
    return rows;
  }
}
