// Pool accounts, the requests they pay for, settlement batches and relayed
// calls. `withAccount(payer, fn)` runs `fn` with the wallet's account locked,
// so holds and charges are exact across processes; everything that changes
// an account's running totals goes through it.
const BIG=new Set(['pool_balance_atomic','withdrawal_atomic','refill_target_atomic','daily_limit_atomic','daily_remaining_atomic',
  'wallet_balance_atomic','allowance_atomic','unsettled_atomic','held_atomic','ceiling_atomic','charged_atomic','debit_atomic','refill_atomic',
  'max_charge_usdc_nano','actual_charge_usdc_nano','unbilled_overrun_usdc_nano','model_cost_usdc_nano','service_fee_usdc_nano','provider_cost_usd_nano',
  'daily_limit_atomic','total_limit_atomic']);
// Rows come back with bigints for amounts, whichever store produced them.
export function normalize(row) {
  if(!row)return row;
  const out={...row};
  for(const k of Object.keys(out))if(BIG.has(k)&&out[k]!=null)out[k]=BigInt(out[k]);
  for(const k of ['running','collection_failures'])if(out[k]!=null)out[k]=Number(out[k]);
  return out;
}
const sqlValue=v=>typeof v==='bigint'?v.toString():v;
const set=(fields,offset=1)=>{
  const keys=Object.keys(fields);
  return {sql:keys.map((k,i)=>`${k}=$${i+offset}`).join(','),values:keys.map(k=>sqlValue(fields[k]))};
};

class PgAccountTx {
  constructor(client,payer){this.client=client;this.payer=payer;}
  async account(){return normalize((await this.client.query('select * from private.pool_accounts where payer=$1',[this.payer])).rows[0]);}
  async update(fields) {
    const {sql,values}=set(fields,2);
    return normalize((await this.client.query(`update private.pool_accounts set ${sql} where payer=$1 returning *`,[this.payer,...values])).rows[0]);
  }
  async insertRequest(row) {
    const keys=Object.keys(row);
    const {rows:[created]}=await this.client.query(`insert into private.pool_requests(payer,${keys.join(',')}) values($1,${keys.map((_,i)=>`$${i+2}`).join(',')}) returning *`,
      [this.payer,...keys.map(k=>sqlValue(row[k]))]);
    return normalize(created);
  }
  async request(id){return normalize((await this.client.query('select * from private.pool_requests where id=$1 and payer=$2 for update',[id,this.payer])).rows[0]);}
  async key(id){return normalize((await this.client.query('select * from private.api_keys where id=$1 and payer=$2',[id,this.payer])).rows[0]);}
  async setKeyLimits(id,{daily,total}) {
    return (await this.client.query('update private.api_keys set daily_limit_atomic=$3,total_limit_atomic=$4 where id=$1 and payer=$2 returning *',
      [id,this.payer,daily==null?null:String(daily),total==null?null:String(total)])).rows[0];
  }
  async batch(id){return normalize((await this.client.query('select * from private.pool_batches where id=$1 and payer=$2',[id,this.payer])).rows[0]);}
  async failUnsignedBatch(id,code){return normalize((await this.client.query('select * from private.fail_unsigned_pool_batch($1,$2,$3)',[this.payer,id,code])).rows[0]);}
  async updateRequest(id,fields) {
    const {sql,values}=set(fields,2);
    await this.client.query(`update private.pool_requests set ${sql} where id=$1`,[id,...values]);
  }
  async keyUsage(apiKeyId,since) {
    const {rows:[r]}=await this.client.query(`select count(*) filter(where status='running')::int running,
        coalesce(sum(ceiling_atomic) filter(where status='running'),0)::text held,
        coalesce(sum(ceiling_atomic) filter(where status='running' and created_at>=$2 and created_at<$2::timestamptz+interval '1 day'),0)::text day_held,
        coalesce(sum(charged_atomic) filter(where status<>'running' and created_at>=$2 and created_at<$2::timestamptz+interval '1 day'),0)::text today,
        coalesce(sum(charged_atomic) filter(where status<>'running'),0)::text total
      from private.pool_requests where api_key_id=$1`,[apiKeyId,since]);
    return {running:r.running,held:BigInt(r.held),dayHeld:BigInt(r.day_held),today:BigInt(r.today),total:BigInt(r.total)};
  }
  // Completed charges no settlement has taken yet, oldest first.
  async unbatched(limit=500) {
    return (await this.client.query(`select id,charged_atomic from private.pool_requests where payer=$1 and batch_id is null and charged_atomic>0
      and status in ('completed','settlement_failed') order by completed_at,id limit $2`,[this.payer,limit])).rows.map(normalize);
  }
  async insertBatch(row) {
    const keys=Object.keys(row);
    const {rows:[b]}=await this.client.query(`insert into private.pool_batches(payer,${keys.join(',')}) values($1,${keys.map((_,i)=>`$${i+2}`).join(',')}) returning *`,
      [this.payer,...keys.map(k=>sqlValue(row[k]))]);
    return normalize(b);
  }
  async attach(batchId,ids){if(ids.length)await this.client.query('update private.pool_requests set batch_id=$1 where id=any($2::uuid[]) and batch_id is null',[batchId,ids]);}
  async detach(batchId){await this.client.query('update private.pool_requests set batch_id=null where batch_id=$1',[batchId]);}
  // The account is already locked; API readers must not need UPDATE on batches.
  async openBatch(){return normalize((await this.client.query(`select * from private.pool_batches where payer=$1 and state in('planned','submitted')`,[this.payer])).rows[0]);}
  async updateBatch(id,fields) {
    const {sql,values}=set(fields,2);
    return normalize((await this.client.query(`update private.pool_batches set ${sql} where id=$1 returning *`,[id,...values])).rows[0]);
  }
}

export class PgPoolStore {
  constructor(pool){this.pool=pool;}
  async ensureAccount(payer){await this.pool.query('insert into private.pool_accounts(payer) values($1) on conflict do nothing',[payer]);}
  async account(payer){return normalize((await this.pool.query('select * from private.pool_accounts where payer=$1',[payer])).rows[0]);}
  async withAccount(payer,fn) {
    const client=await this.pool.connect();
    try {
      await client.query('begin');
      const {rows}=await client.query('select payer from private.pool_accounts where payer=$1 for update',[payer]);
      if(!rows.length){await client.query('rollback');return fn(null);}
      const result=await fn(new PgAccountTx(client,payer));
      await client.query('commit');
      return result;
    } catch(error) {await client.query('rollback').catch(()=>{});throw error;}
    finally {client.release();}
  }
  // The snapshot is written without touching the running totals.
  async saveSnapshot(payer,snap) {
    return this.withAccount(payer,async tx=>{
      if(!tx||await tx.openBatch())return false;
      const a=await tx.account();
      if(a.snapshot_block!=null&&Number(snap.snapshot_block)<Number(a.snapshot_block))return false;
      await tx.update(snap);return true;
    });
  }
  async wantRefill(payer){await this.pool.query('update private.pool_accounts set refill_wanted_at=coalesce(refill_wanted_at,now()) where payer=$1',[payer]);}
  async hasOpenBatch(payer){return (await this.pool.query(`select 1 from private.pool_batches where payer=$1 and state in('planned','submitted')`,[payer])).rows.length>0;}
  async accountsToCollect(limit=100) {
    return (await this.pool.query(`select * from private.pool_accounts
      where refill_target_atomic>0 or unsettled_atomic>0 or withdrawal_atomic>0 or refill_wanted_at is not null or pool_balance_atomic>0
      order by refill_wanted_at nulls last,last_attempt_at nulls first limit $1`,[limit])).rows.map(normalize);
  }
  async oldestUnbatched(payer) {
    const {rows:[r]}=await this.pool.query(`select min(completed_at) at from private.pool_requests where payer=$1 and batch_id is null and charged_atomic>0
      and status in ('completed','settlement_failed')`,[payer]);
    return r?.at?new Date(r.at):null;
  }
  async submittedBatches(){return (await this.pool.query(`select * from private.pool_batches where state='submitted' order by created_at`)).rows.map(normalize);}
  async plannedBatches(){return (await this.pool.query(`select * from private.pool_batches where state='planned' order by created_at`)).rows.map(normalize);}
  async insertOp(op) {
    const {rows:[row]}=await this.pool.query(`insert into private.pool_ops(payer,kind,payload) values($1,$2,$3) returning *`,[op.payer??null,op.kind,op.payload??{}]);
    return row;
  }
  async openOps(payer=undefined) {
    if(payer===undefined)return (await this.pool.query(`select * from private.pool_ops where state in('queued','submitted') order by created_at`)).rows;
    return (await this.pool.query(`select * from private.pool_ops where payer=$1 and state in('queued','submitted') order by created_at`,[payer])).rows;
  }
  async recentOps(payer,limit=10){return (await this.pool.query('select * from private.pool_ops where payer=$1 order by created_at desc limit $2',[payer,limit])).rows;}
  async updateOp(id,fields) {
    const {sql,values}=set(fields,2);
    await this.pool.query(`update private.pool_ops set ${sql} where id=$1`,[id,...values]);
  }
  // `before`: a page boundary, requests created strictly before it.
  async requestsForKey(apiKeyId,limit=100,before=null) {
    return (await this.pool.query(`select r.id,r.created_at,r.status,r.failure_code,r.protocol,m.public_name model,
        extract(epoch from (r.completed_at-r.started_at))*1000 latency_ms,
        r.actual_charge_usdc_nano::text charge_nano,r.max_charge_usdc_nano::text max_charge_nano,r.charged_atomic::text charged_atomic,
        r.ceiling_atomic::text ceiling_atomic,r.charged_from,r.model_cost_usdc_nano::text model_cost_nano,r.service_fee_usdc_nano::text service_fee_nano,
        r.normalized_usage usage,(r.batch_id is not null) settled
      from private.pool_requests r left join public.model_catalog m on m.id=r.model_id
      where r.api_key_id=$1 and ($3::timestamptz is null or r.created_at<$3) order by r.created_at desc limit $2`,[apiKeyId,limit,before])).rows;
  }
  // What a key spent since `since`, by UTC day and by model; finished
  // requests only. Token counts come from the normalized usage.
  async keyUsage(apiKeyId,since) {
    const sums=`count(*)::int requests,count(*) filter(where status<>'completed')::int failed,coalesce(sum(r.charged_atomic),0)::text charged_atomic,
      coalesce(sum((r.normalized_usage->>'inputTokens')::bigint),0)::text input_tokens,coalesce(sum((r.normalized_usage->>'outputTokens')::bigint),0)::text output_tokens,
      coalesce(sum((r.normalized_usage->>'reasoningTokens')::bigint),0)::text reasoning_tokens,coalesce(sum((r.normalized_usage->>'cachedInputTokens')::bigint),0)::text cached_input_tokens,
      coalesce(avg(extract(epoch from (r.completed_at-r.started_at))*1000) filter(where r.completed_at is not null),0)::int avg_latency_ms`;
    const where=`from private.pool_requests r where r.api_key_id=$1 and r.created_at>=$2 and r.status<>'running' and r.kind='request'`;
    const [daily,models]=await Promise.all([
      this.pool.query(`select to_char(r.created_at at time zone 'utc','YYYY-MM-DD') as day,${sums} ${where} group by 1 order by 1`,[apiKeyId,since]),
      this.pool.query(`select m.public_name model,${sums} ${where.replace('from private.pool_requests r','from private.pool_requests r left join public.model_catalog m on m.id=r.model_id')}
        group by 1 order by sum(r.charged_atomic) desc,1`,[apiKeyId,since])]);
    return {daily:daily.rows,models:models.rows};
  }
  async keyTotals(payer,since) {
    const {rows}=await this.pool.query(`select api_key_id,count(*) filter(where status='running')::int running,
        coalesce(sum(charged_atomic) filter(where created_at>=$2),0)::text today,coalesce(sum(charged_atomic),0)::text total
      from private.pool_requests where payer=$1 and api_key_id is not null group by api_key_id`,[payer,since]);
    return new Map(rows.map(r=>[r.api_key_id,{running:r.running,today:BigInt(r.today),total:BigInt(r.total)}]));
  }
  async insertFee(payer,{chargedAtomic,code}) {
    return this.withAccount(payer,async tx=>{
      if(!tx)return null;
      const account=await tx.account();
      if(account.activation_charged)return null;
      await tx.insertRequest({kind:'activation_fee',status:'completed',charged_atomic:chargedAtomic,charged_from:'fee',
        actual_charge_usdc_nano:chargedAtomic*1000n,usage_source:code,completed_at:new Date()});
      return tx.update({activation_charged:true,unsettled_atomic:account.unsettled_atomic+chargedAtomic});
    });
  }
}

// The same contract in memory, for the test harness.
export class InMemoryPoolStore {
  constructor({keyStore=null}={}){this.keyStore=keyStore;this.signedTransactions=new Map();this.accounts=new Map();this.requests=new Map();this.batches=new Map();this.ops=new Map();this.locks=new Map();this.modelNames=new Map();this.seq=0;}
  id(){return `00000000-0000-4000-8000-${String(++this.seq).padStart(12,'0')}`;}
  async ensureAccount(payer) {
    if(!this.accounts.has(payer))this.accounts.set(payer,normalize({payer,pool_balance_atomic:0n,withdrawal_atomic:0n,withdrawable_at:null,
      refill_target_atomic:0n,daily_limit_atomic:0n,daily_remaining_atomic:0n,wallet_balance_atomic:0n,allowance_atomic:0n,snapshot_block:null,snapshot_at:null,
      unsettled_atomic:0n,held_atomic:0n,running:0,refill_wanted_at:null,activation_charged:false,collection_failures:0,last_attempt_at:null,created_at:new Date()}));
  }
  async account(payer){const a=this.accounts.get(payer);return a?{...a}:undefined;}
  async withAccount(payer,fn) {
    const previous=this.locks.get(payer)??Promise.resolve();
    let release;const gate=new Promise(r=>{release=r;});
    this.locks.set(payer,previous.then(()=>gate));
    await previous;
    try {
      if(!this.accounts.has(payer))return await fn(null);
      // Changes apply only if fn finishes, like a transaction.
      const staged={account:{...this.accounts.get(payer)},requests:new Map(),batches:new Map(),attach:[],detach:[]};
      const store=this;
      const tx={
        payer,
        async account(){return {...staged.account};},
        async update(fields){Object.assign(staged.account,normalize(fields));return {...staged.account};},
        async insertRequest(row){const r=normalize({id:store.id(),payer,kind:'request',status:'running',charged_atomic:0n,ceiling_atomic:0n,max_charge_usdc_nano:0n,
          unbilled_overrun_usdc_nano:0n,batch_id:null,started_at:new Date(),created_at:new Date(),completed_at:null,...row});staged.requests.set(r.id,r);return {...r};},
        async request(id){const r=staged.requests.get(id)??store.requests.get(id);return r&&r.payer===payer?{...r}:undefined;},
        async key(id){return store.keyStore?.get(id,payer)??null;},
        async setKeyLimits(id,limits){return store.keyStore.setLimits(id,limits);},
        async batch(id){const b=staged.batches.get(id)??store.batches.get(id);return b&&b.payer===payer?{...b}:null;},
        async failUnsignedBatch(id,code){
          const b=await this.batch(id);if(!b||b.state!=='planned')return b;
          const hash=store.signedTransactions.get(id);
          if(hash)return this.updateBatch(id,{state:'submitted',tx_hash:hash,error_code:null});
          const failed=await this.updateBatch(id,{state:'failed',error_code:code});await this.detach(id);return failed;
        },
        async updateRequest(id,fields){const r=staged.requests.get(id)??{...store.requests.get(id)};staged.requests.set(id,{...r,...normalize(fields)});},
        async keyUsage(apiKeyId,since){
          const merged=new Map(store.requests);for(const [id,r] of staged.requests)merged.set(id,r);
          const rows=[...merged.values()].filter(r=>r.api_key_id===apiKeyId);
          const run=rows.filter(r=>r.status==='running'),done=rows.filter(r=>r.status!=='running');
          const inDay=r=>r.created_at>=since&&r.created_at<new Date(since.getTime()+86400000);
          return {running:run.length,held:run.reduce((s,r)=>s+r.ceiling_atomic,0n),
            dayHeld:run.filter(inDay).reduce((s,r)=>s+r.ceiling_atomic,0n),
            today:done.filter(inDay).reduce((s,r)=>s+r.charged_atomic,0n),total:done.reduce((s,r)=>s+r.charged_atomic,0n)};
        },
        async unbatched(limit=500){return [...store.requests.values()].filter(r=>r.payer===payer&&!r.batch_id&&r.charged_atomic>0n&&['completed','settlement_failed'].includes(r.status))
          .sort((a,b)=>a.completed_at-b.completed_at||a.id.localeCompare(b.id)).slice(0,limit).map(r=>({id:r.id,charged_atomic:r.charged_atomic}));},
        async insertBatch(row){const b=normalize({id:store.id(),payer,state:'planned',tx_hash:null,refill_result:null,error_code:null,created_at:new Date(),...row});staged.batches.set(b.id,b);return {...b};},
        async attach(batchId,ids){staged.attach.push([batchId,ids]);},
        async detach(batchId){staged.detach.push(batchId);},
        async openBatch(){return [...store.batches.values(),...staged.batches.values()].find(b=>b.payer===payer&&['planned','submitted'].includes(b.state));},
        async updateBatch(id,fields){const b={...(staged.batches.get(id)??store.batches.get(id)),...normalize(fields)};staged.batches.set(id,b);return {...b};}
      };
      const result=await fn(tx);
      this.accounts.set(payer,staged.account);
      for(const [id,r] of staged.requests)this.requests.set(id,r);
      for(const [id,b] of staged.batches)this.batches.set(id,b);
      for(const batchId of staged.detach)for(const r of this.requests.values())if(r.batch_id===batchId)r.batch_id=null;
      for(const [batchId,ids] of staged.attach)for(const id of ids){const r=this.requests.get(id);if(r&&!r.batch_id)r.batch_id=batchId;}
      return result;
    } finally {release();}
  }
  async saveSnapshot(payer,snap){return this.withAccount(payer,async tx=>{
    if(!tx||await tx.openBatch())return false;
    const a=await tx.account();if(a.snapshot_block!=null&&Number(snap.snapshot_block)<Number(a.snapshot_block))return false;
    await tx.update(snap);return true;
  });}
  async wantRefill(payer){const a=this.accounts.get(payer);if(a&&!a.refill_wanted_at)a.refill_wanted_at=new Date();}
  async hasOpenBatch(payer){return [...this.batches.values()].some(b=>b.payer===payer&&['planned','submitted'].includes(b.state));}
  async accountsToCollect(){return [...this.accounts.values()].filter(a=>a.refill_target_atomic>0n||a.unsettled_atomic>0n||a.withdrawal_atomic>0n||a.refill_wanted_at||a.pool_balance_atomic>0n).map(a=>({...a}));}
  async oldestUnbatched(payer){const t=[...this.requests.values()].filter(r=>r.payer===payer&&!r.batch_id&&r.charged_atomic>0n&&r.status!=='running').map(r=>r.completed_at);return t.length?new Date(Math.min(...t)):null;}
  async submittedBatches(){return [...this.batches.values()].filter(b=>b.state==='submitted').map(b=>({...b}));}
  async plannedBatches(){return [...this.batches.values()].filter(b=>b.state==='planned').map(b=>({...b}));}
  async insertOp(op) {
    if([...this.ops.values()].some(o=>(o.payer??'')===(op.payer??'')&&o.kind===op.kind&&['queued','submitted'].includes(o.state)))
      throw Object.assign(new Error('duplicate key value violates unique constraint'),{code:'23505'});
    const row={id:this.id(),payer:op.payer??null,kind:op.kind,payload:op.payload??{},state:'queued',tx_hash:null,error_code:null,attempts:0,created_at:new Date()};
    this.ops.set(row.id,row);return {...row};
  }
  async openOps(payer=undefined){return [...this.ops.values()].filter(o=>['queued','submitted'].includes(o.state)&&(payer===undefined||o.payer===payer)).map(o=>({...o}));}
  async recentOps(payer,limit=10){return [...this.ops.values()].filter(o=>o.payer===payer).reverse().slice(0,limit).map(o=>({...o}));}
  async updateOp(id,fields){Object.assign(this.ops.get(id),fields);}
  // `modelNames`: model id → public name, what the catalog join does in Postgres.
  async requestsForKey(apiKeyId,limit=100,before=null){return [...this.requests.values()].filter(r=>r.api_key_id===apiKeyId&&(!before||r.created_at<before)).reverse().slice(0,limit).map(r=>({id:r.id,created_at:r.created_at,status:r.status,
    failure_code:r.failure_code??null,protocol:r.protocol,model:this.modelNames?.get(r.model_id)??null,latency_ms:r.completed_at?r.completed_at-r.started_at:null,
    charge_nano:r.actual_charge_usdc_nano==null?null:String(r.actual_charge_usdc_nano),charged_atomic:String(r.charged_atomic),
    ceiling_atomic:String(r.ceiling_atomic),charged_from:r.charged_from??null,usage:r.normalized_usage??null,settled:Boolean(r.batch_id)}));}
  async keyUsage(apiKeyId,since) {
    const rows=[...this.requests.values()].filter(r=>r.api_key_id===apiKeyId&&r.created_at>=since&&r.status!=='running'&&(r.kind??'request')==='request');
    const group=by=>{
      const out=new Map();
      for(const r of rows) {
        const k=by(r),g=out.get(k)??{requests:0,failed:0,charged:0n,input:0n,output:0n,reasoning:0n,cached:0n,latency:0,timed:0};
        const u=r.normalized_usage??{};
        g.requests++;if(r.status!=='completed')g.failed++;g.charged+=r.charged_atomic;
        g.input+=BigInt(u.inputTokens??0);g.output+=BigInt(u.outputTokens??0);g.reasoning+=BigInt(u.reasoningTokens??0);g.cached+=BigInt(u.cachedInputTokens??0);
        if(r.completed_at){g.latency+=r.completed_at-r.started_at;g.timed++;}
        out.set(k,g);
      }
      return [...out].map(([k,g])=>({key:k,requests:g.requests,failed:g.failed,charged_atomic:String(g.charged),input_tokens:String(g.input),output_tokens:String(g.output),
        reasoning_tokens:String(g.reasoning),cached_input_tokens:String(g.cached),avg_latency_ms:g.timed?Math.round(g.latency/g.timed):0}));
    };
    const daily=group(r=>new Date(r.created_at).toISOString().slice(0,10)).sort((a,b)=>a.key.localeCompare(b.key)).map(({key,...g})=>({day:key,...g}));
    const models=group(r=>this.modelNames?.get(r.model_id)??null).sort((a,b)=>Number(BigInt(b.charged_atomic)-BigInt(a.charged_atomic))).map(({key,...g})=>({model:key,...g}));
    return {daily,models};
  }
  async keyTotals(payer,since) {
    const out=new Map();
    for(const r of this.requests.values()) {
      if(r.payer!==payer||!r.api_key_id)continue;
      const t=out.get(r.api_key_id)??{running:0,today:0n,total:0n};
      if(r.status==='running')t.running++;
      t.total+=r.charged_atomic;if(r.created_at>=since)t.today+=r.charged_atomic;
      out.set(r.api_key_id,t);
    }
    return out;
  }
  async insertFee(payer,{chargedAtomic,code}) {
    return this.withAccount(payer,async tx=>{
      if(!tx)return null;
      const a=await tx.account();
      if(a.activation_charged)return null;
      await tx.insertRequest({kind:'activation_fee',status:'completed',charged_atomic:chargedAtomic,charged_from:'fee',actual_charge_usdc_nano:chargedAtomic*1000n,usage_source:code,completed_at:new Date()});
      return tx.update({activation_charged:true,unsettled_atomic:a.unsettled_atomic+chargedAtomic});
    });
  }
}
