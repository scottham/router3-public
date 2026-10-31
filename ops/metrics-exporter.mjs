// Read-only Prometheus exporter: aggregate numbers from private.metrics_snapshot()
// and private.metrics_x402(), on-chain balances of the operating addresses, and
// liveness of the API. It holds no key and sends no transaction. Listens on the
// internal network only; Grafana Alloy scrapes it and pushes outbound.
import http from 'node:http';
import pg from 'pg';
import {Contract,JsonRpcProvider,formatEther,formatUnits,isAddress} from 'ethers';
import {replayedSamples} from './lib/replayed-samples.mjs';

const env=process.env;
if(!env.DATABASE_URL_METRICS)throw new Error('METRICS_CONFIGURATION_REQUIRED');
const port=Number(env.METRICS_PORT??9464);
const chain=JSON.parse(env.CHAIN_CONFIG_JSON||'{}')['143']??{};
const address=value=>(value&&isAddress(value)?value:null);
const settler=address(env.SETTLER_ADDRESS),treasury=address(env.TREASURY_ADDRESS);
const BATCH_SETTLEMENT='0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003';
const rpc=new JsonRpcProvider(env.MONAD_RPC_URL||chain.rpcUrl,143,{staticNetwork:true});
const usdc=address(chain.usdcAddress)?new Contract(chain.usdcAddress,['function balanceOf(address) view returns(uint256)'],rpc):null;
const db=new pg.Pool({connectionString:env.DATABASE_URL_METRICS,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
db.on('error',()=>{});
const probes={api:env.METRICS_API_URL??'http://api:8787/readyz',facilitator:env.METRICS_FACILITATOR_URL??`${env.X402_FACILITATOR_URL??'https://x402-facilitator.molandak.org'}/supported`};

const nano=value=>Number(BigInt(value??0))/1e9;
const usdcAtomic=value=>Number(formatUnits(BigInt(value??0),6));
const escape=value=>String(value).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n');

// Collects one family per metric name so each gets a single HELP/TYPE header.
class Registry {
  families=new Map();
  add(name,type,help,value,labels={}) {
    if(value==null||!Number.isFinite(Number(value)))return;
    if(!this.families.has(name))this.families.set(name,{type,help,samples:[]});
    const pairs=Object.entries(labels).map(([k,v])=>`${k}="${escape(v)}"`).join(',');
    this.families.get(name).samples.push(`${name}${pairs?`{${pairs}}`:''} ${Number(value)}`);
  }
  text() {
    return [...this.families].map(([name,f])=>`# HELP ${name} ${f.help}\n# TYPE ${name} ${f.type}\n${f.samples.join('\n')}`).join('\n')+'\n';
  }
}

async function database(m) {
  const {rows:[{s}]}=await db.query('select private.metrics_snapshot() s');
  for(const f of s.failures)m.add('router3_request_failures_total','counter','Failed requests by failure code.',f.n,{code:f.code});
  m.add('router3_request_duration_seconds','gauge','Duration of requests completed in the last 15 minutes.',s.latency.p50,{quantile:'0.5'});
  m.add('router3_request_duration_seconds','gauge','Duration of requests completed in the last 15 minutes.',s.latency.p95,{quantile:'0.95'});
  m.add('router3_request_duration_window_requests','gauge','Requests completed in the last 15 minutes.',s.latency.n);
  m.add('router3_service_fee_usdc_total','counter','Per-call service fees billed.',nano(s.service_fee_nano));
  m.add('router3_users','gauge','Wallets that signed in to the console.',s.users);
  for(const k of s.provider_keys??[]) {
    m.add('router3_provider_keys','gauge','Per-wallet provider call keys by state.',k.n,{provider:k.provider,state:k.state});
    m.add('router3_provider_key_usage_usd','gauge','Usage the provider attributes to those keys.',nano(k.usage_usd_nano),{provider:k.provider,state:k.state});
  }
  const {rows:[{b}]}=await db.query('select private.metrics_provider_balance() b');
  for(const p of b) {
    m.add('router3_provider_balance','gauge','Provider account balance in its own currency at the last daily check.',Number(p.balance),{provider:p.provider,currency:p.currency});
    m.add('router3_provider_balance_checked_timestamp_seconds','gauge','When the provider balance was last checked.',p.checked_at,{provider:p.provider});
    if(p.gap!==null)m.add('router3_provider_balance_gap','gauge','Balance drop minus recorded cost between the last two checks, in the provider currency; positive means the provider charged more than recorded.',Number(p.gap),{provider:p.provider,currency:p.currency});
  }
  for(const c of s.catalog??[]) {
    m.add('router3_catalog_models','gauge','Models in the catalog by provider and whether they are enabled.',c.enabled,{provider:c.provider,enabled:'true'});
    m.add('router3_catalog_models','gauge','Models in the catalog by provider and whether they are enabled.',c.total-c.enabled,{provider:c.provider,enabled:'false'});
  }
  for(const v of s.price_versions??[])m.add('router3_price_versions_total','counter','Price versions written; CNY-priced ones include daily FX moves.',v.n,{provider:v.provider});
  for(const r of s.catalog_runs??[])m.add('router3_catalog_runs_total','counter','Catalog sync runs by provider and result.',r.n,{provider:r.provider,result:r.ok?'ok':'failed'});
  for(const l of s.catalog_last??[]) {
    const labels={provider:l.provider};
    m.add('router3_catalog_last_run_ok','gauge','1 when the latest catalog run of this provider succeeded.',l.ok?1:0,{...labels,error:l.error_code??'',price_source:l.price_source??''});
    m.add('router3_catalog_last_run_timestamp_seconds','gauge','When the latest catalog run finished.',l.finished_at,labels);
    m.add('router3_catalog_last_success_timestamp_seconds','gauge','When the latest successful catalog run finished.',l.last_success_at,labels);
    m.add('router3_catalog_last_run_models','gauge','Models priced by the latest run.',l.models,labels);
    m.add('router3_catalog_last_run_changed','gauge','Price changes written by the latest run.',l.changed,labels);
    m.add('router3_catalog_last_run_excluded','gauge','Models left out by the latest run (unavailable or not billable).',l.excluded,labels);
    m.add('router3_catalog_last_run_review','gauge','Models the latest run held back or could not map; see catalog logs.',l.review,labels);
  }
  await x402(m);
}

// x402 channels (docs/X402.md): what payers deposited, what they were charged,
// what is still unclaimed on-chain, and the collector's claims and settles.
async function x402(m) {
  const {rows:[{x}]}=await db.query('select private.metrics_x402() x');
  const c=x.channels;
  m.add('router3_x402_channels','gauge','Open x402 payment channels.',c.n);
  m.add('router3_x402_channels_withdrawing','gauge','Channels whose payer started a timed withdrawal.',c.withdrawing);
  m.add('router3_x402_channel_balance_usdc','gauge','USDC deposited in open channels, as last mirrored.',usdcAtomic(c.balance_atomic));
  m.add('router3_x402_charged_usdc','gauge','Cumulative amount charged against open channels.',usdcAtomic(c.charged_atomic));
  m.add('router3_x402_claimed_usdc','gauge','Amount of those charges already claimed on-chain.',usdcAtomic(c.claimed_atomic));
  m.add('router3_x402_unclaimed_usdc','gauge','Charged but not yet claimed on-chain; at risk until the collector claims it.',usdcAtomic(c.unclaimed_atomic));
  for(const r of x.requests) {
    m.add('router3_requests_total','counter','Model requests by final or current status.',r.n,{model:r.model,status:r.status});
    m.add('router3_charged_usdc_total','counter','USDC charged to channels (model cost and service fee).',nano(r.charged_nano),{model:r.model});
    m.add('router3_provider_cost_usd_total','counter','Estimated provider cost in USD.',nano(r.provider_cost_nano),{model:r.model});
  }
  m.add('router3_x402_ceiling_charges_total','counter','Requests charged at their ceiling because usage was unknown.',x.ceiling_charges);
  for(const t of x.settlements)m.add('router3_x402_settlements_24h','gauge','On-chain operations in the last 24 hours by kind.',t.n,{kind:t.kind});
  if(x.last_claim_age_seconds!=null)m.add('router3_x402_last_claim_age_seconds','gauge','Seconds since the collector last claimed vouchers.',x.last_claim_age_seconds);
}

// Chain reads are billed per call by the RPC provider and balances change
// slowly, so they are taken at most every METRICS_CHAIN_INTERVAL_SECONDS and
// replayed into the scrapes in between.
const onchain=replayedSamples(Number(env.METRICS_CHAIN_INTERVAL_SECONDS??300)*1000,m=>readChain(m));
async function readChain(m) {
  const started=performance.now();
  const block=await rpc.getBlockNumber();
  m.add('router3_rpc_latency_seconds','gauge','Latency of one eth_blockNumber call.',(performance.now()-started)/1000);
  m.add('router3_chain_block','gauge','Latest Monad block seen by the RPC.',block);
  const reads=[];
  if(settler)reads.push(rpc.getBalance(settler).then(v=>m.add('router3_settler_mon','gauge','MON held by the Settler (it only signs; the facilitator pays gas).',Number(formatEther(v)))));
  if(usdc&&treasury)reads.push(usdc.balanceOf(treasury).then(v=>m.add('router3_treasury_usdc','gauge','USDC held by the Treasury.',usdcAtomic(v))));
  if(usdc)reads.push(usdc.balanceOf(BATCH_SETTLEMENT).then(v=>m.add('router3_x402_contract_usdc','gauge','USDC held by the x402BatchSettlement contract (all channels of all receivers).',usdcAtomic(v))));
  await Promise.all(reads);
}

async function probe(m) {
  await Promise.all(Object.entries(probes).map(async([service,url])=>{
    let up=0;
    try{up=(await fetch(url,{signal:AbortSignal.timeout(3000)})).ok?1:0;}catch{}
    m.add('router3_service_up','gauge','1 when the service health check passes.',up,{service});
  }));
}

// One collection at a time, reused for 10 s, so scrapes never pile up on the database or RPC.
let cache={at:0,text:''},running=null;
async function collect() {
  if(Date.now()-cache.at<10000)return cache.text;
  running??=(async()=>{
    const m=new Registry();
    const results=await Promise.allSettled([database(m),onchain(m),probe(m)]);
    ['database','chain','probe'].forEach((source,i)=>m.add('router3_exporter_source_up','gauge','1 when the exporter could read this source.',results[i].status==='fulfilled'?1:0,{source}));
    results.forEach((r,i)=>{if(r.status==='rejected')console.error(JSON.stringify({message:'METRICS_SOURCE_FAILED',source:['database','chain','probe'][i]}));});
    cache={at:Date.now(),text:m.text()};
    return cache.text;
  })().finally(()=>{running=null;});
  return running;
}

const server=http.createServer(async(request,response)=>{
  if(request.method!=='GET'||request.url!=='/metrics'){response.writeHead(404).end();return;}
  try{response.writeHead(200,{'content-type':'text/plain; version=0.0.4'}).end(await collect());}
  catch{response.writeHead(500).end();}
});
server.listen(port,'0.0.0.0');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>db.end()));
