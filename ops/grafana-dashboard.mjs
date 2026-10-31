// Builds the Router 3 Grafana dashboard and creates or updates it through the
// Grafana HTTP API. Usage:
//   node --env-file=.env.mainnet-local ops/grafana-dashboard.mjs          (push)
//   node ops/grafana-dashboard.mjs --file-only                              (regenerate the JSON only)
// Either way ops/grafana/router3-dashboard.json is rewritten; commit it with this file.
// Needs GRAFANA_URL and GRAFANA_SA_TOKEN (service account, Editor) to push.
import {writeFileSync} from 'node:fs';

const env=process.env;
const ds={type:'prometheus',uid:env.GRAFANA_PROM_UID||'grafanacloud-prom'};
const UID='router3-overview';
let id=0,y=0;
const panels=[];

const target=(expr,legend='',extra={})=>({datasource:ds,expr,legendFormat:legend,refId:String.fromCharCode(65+(extra.ref??0)),...extra.opts});
function row(title){panels.push({type:'row',title,id:++id,gridPos:{h:1,w:24,x:0,y:y++},collapsed:false});}
// Lays panels left to right on one band of the given height.
function band(h,items){
  let x=0;
  for(const p of items){panels.push({...p,id:++id,datasource:ds,gridPos:{h,w:p.w,x,y}});x+=p.w;delete panels.at(-1).w;}
  y+=h;
}
const stat=(title,expr,{unit='none',decimals,w=4,mappings,thresholds,description}={})=>({type:'stat',title,description,w,
  targets:[target(expr)],
  options:{reduceOptions:{calcs:['lastNotNull'],fields:'',values:false},colorMode:'value',graphMode:'area',textMode:'value'},
  fieldConfig:{defaults:{unit,decimals,mappings:mappings??[],thresholds:thresholds??{mode:'absolute',steps:[{color:'purple',value:null}]}},overrides:[]}});
const series=(title,exprs,{unit='none',w=12,stack=false,description}={})=>({type:'timeseries',title,description,w,
  targets:exprs.map(([expr,legend],ref)=>target(expr,legend,{ref})),
  options:{legend:{displayMode:'list',placement:'bottom'},tooltip:{mode:'multi'}},
  fieldConfig:{defaults:{unit,custom:{lineWidth:2,fillOpacity:stack?40:10,stacking:{mode:stack?'normal':'none'}}},overrides:[]}});
const table=(title,expr,{unit='none',w=12,label='model',description}={})=>({type:'table',title,description,w,
  targets:[target(expr,'',{opts:{format:'table',instant:true}})],
  transformations:[{id:'organize',options:{excludeByName:{Time:true},renameByName:{[label]:{code:'错误码',provider:'供应商'}[label]??'模型',error:'错误',price_source:'价格来源',Value:title}}}],
  options:{sortBy:[{displayName:title,desc:true}],showHeader:true},
  fieldConfig:{defaults:{unit},overrides:[]}});
const upDown=[{type:'value',options:{0:{text:'DOWN',color:'red'},1:{text:'UP',color:'green'}}}];
const red=(limit)=>({mode:'absolute',steps:[{color:'red',value:null},{color:'green',value:limit}]});

const FINAL='status=~"completed|failed|settlement_failed"';
row('状态');
band(4,[
  stat('API','max(router3_service_up{service="api"})',{mappings:upDown,thresholds:red(1),w:3}),
  stat('Facilitator','max(router3_service_up{service="facilitator"})',{mappings:upDown,thresholds:red(1),w:3,description:'基金会 facilitator 的 /supported。不可用时存款、claim 和退款延后，凭证仍可本地核验。'}),
  stat('Treasury USDC','max(router3_treasury_usdc)',{decimals:2,w:3}),
  stat('x402 合约 USDC','max(router3_x402_contract_usdc)',{decimals:2,w:3,description:'x402BatchSettlement 合约持有的全部 USDC（所有收款方的通道）。'}),
  stat('开放通道','max(router3_x402_channels)',{decimals:0,w:3}),
  stat('通道存款 USDC','max(router3_x402_channel_balance_usdc)',{decimals:2,w:3,description:'用户存在本网关通道里的 USDC，属于用户，可取回。'}),
  stat('用户','max(router3_users)',{w:3}),
  stat('Settler MON','max(router3_settler_mon)',{decimals:3,w:3,description:'Settler 只签名，不付 gas；这里只是提醒它不该持有资金。'})
]);
row('流量');
band(4,[
  stat('请求数（所选时段）',`sum(increase(router3_requests_total{${FINAL}}[$__range]))`,{decimals:0,w:6}),
  stat('失败率（所选时段）',`(sum(increase(router3_requests_total{status=~"failed|settlement_failed"}[$__range])) or vector(0)) / clamp_min(sum(increase(router3_requests_total{${FINAL}}[$__range])),1)`,
    {unit:'percentunit',decimals:1,w:6,thresholds:{mode:'absolute',steps:[{color:'green',value:null},{color:'orange',value:0.02},{color:'red',value:0.05}]}}),
  stat('P95 耗时（近 15 分钟）','max(router3_request_duration_seconds{quantile="0.95"})',{unit:'s',decimals:1,w:6}),
  stat('进行中','sum(router3_requests_total{status="running"}) or vector(0)',{decimals:0,w:6})
]);
band(8,[
  series('每分钟请求（按状态）',[[`sum by(status)(rate(router3_requests_total{${FINAL}}[5m]))*60`,'{{status}}']],{unit:'reqpm',stack:true}),
  series('耗时（近 15 分钟完成的请求）',[['max(router3_request_duration_seconds{quantile="0.5"})','P50'],['max(router3_request_duration_seconds{quantile="0.95"})','P95']],{unit:'s'})
]);
band(8,[
  table('请求数（按模型）',`sort_desc(sum by(model)(increase(router3_requests_total{${FINAL}}[$__range])) > 0)`),
  table('失败（按错误码）','sort_desc(sum by(code)(increase(router3_request_failures_total[$__range])) > 0)',{label:'code'})
]);
row('收入与结算');
band(4,[
  stat('计费 USDC（所选时段）','sum(increase(router3_charged_usdc_total[$__range]))',{unit:'none',decimals:4,w:6}),
  stat('服务费 USDC（所选时段）','sum(increase(router3_service_fee_usdc_total[$__range]))',{decimals:4,w:6}),
  stat('供应商成本 USD（所选时段）','sum(increase(router3_provider_cost_usd_total[$__range]))',{decimals:4,w:6}),
  stat('按上限计费（累计）','max(router3_x402_ceiling_charges_total)',{decimals:0,w:6,description:'用量未知（流被中断、超时）时按凭证上限收费的请求数。'})
]);
band(4,[
  stat('已计费未上链 USDC','max(router3_x402_unclaimed_usdc)',{decimals:4,w:6,thresholds:{mode:'absolute',steps:[{color:'green',value:null},{color:'orange',value:5},{color:'red',value:20}]},
    description:'凭证已签、尚未 claim 的金额。collector 按阈值、闲置和取回申请批量 claim。'}),
  stat('已 claim USDC','max(router3_x402_claimed_usdc)',{decimals:4,w:6}),
  stat('距上次 claim','max(router3_x402_last_claim_age_seconds)',{unit:'s',w:6,thresholds:{mode:'absolute',steps:[{color:'green',value:null},{color:'orange',value:172800}]}}),
  stat('链上取回中的通道','max(router3_x402_channels_withdrawing)',{decimals:0,w:6,description:'用户在合约上发起了限时取回；collector 下一轮立即 claim 已计费部分。'})
]);
band(8,[
  series('每小时计费 USDC（按模型）',[['sum by(model)(increase(router3_charged_usdc_total[1h]))','{{model}}']],{stack:true}),
  series('通道资金 USDC',[['max(router3_x402_channel_balance_usdc)','通道存款'],['max(router3_x402_charged_usdc)','累计计费'],['max(router3_x402_claimed_usdc)','已 claim']])
]);
band(8,[
  series('链上操作（24 小时内）',[['sum by(kind)(router3_x402_settlements_24h)','{{kind}}']]),
  series('RPC 延迟',[['max(router3_rpc_latency_seconds)','eth_blockNumber']],{unit:'s',w:6}),
  series('数据源可读',[['min by(source)(router3_exporter_source_up)','{{source}}']],{w:6})
]);
row('模型目录与价格');
band(4,[
  stat('DeepSeek 距上次成功同步','time() - max(router3_catalog_last_success_timestamp_seconds{provider="deepseek"})',{unit:'s',w:4,
    thresholds:{mode:'absolute',steps:[{color:'green',value:null},{color:'orange',value:90000},{color:'red',value:129600}]},description:'价格来自官方中文价格页；超过 36 小时未成功，DeepSeek 模型停止接单。'}),
  stat('DeepSeek 最近一次','max(router3_catalog_last_run_ok{provider="deepseek"})',{mappings:[{type:'value',options:{0:{text:'失败',color:'red'},1:{text:'成功',color:'green'}}}],thresholds:red(1),w:4}),
  stat('待人工核对','sum(router3_catalog_last_run_review) or vector(0)',{decimals:0,w:4,
    thresholds:{mode:'absolute',steps:[{color:'green',value:null},{color:'orange',value:1}]},description:'价格行消失、价格变动超过 3 倍或新模型未映射。详情见 catalog 容器日志 CATALOG_PRICES_NEED_REVIEW。'}),
  stat('价格变更（所选时段）','sum(increase(router3_price_versions_total[$__range])) or vector(0)',{decimals:0,w:4,description:'新写入的价格版本数；人民币计价的模型含每日汇率变动。'})
]);
band(8,[
  series('可用模型数',[['sum by(provider)(router3_catalog_models{enabled="true"})','{{provider}}']],{w:8}),
  series('价格变更（每天）',[['sum by(provider)(increase(router3_price_versions_total[1d]))','{{provider}}']],{w:8}),
  table('最近一次同步','max by(provider,error,price_source)(router3_catalog_last_run_ok)',{w:8,label:'provider'})
]);
row('供应商对账');
band(4,[
  stat('DeepSeek 余额（元）','max(router3_provider_balance{provider="deepseek"})',{decimals:2,w:4,thresholds:red(10),description:'每日目录同步时读取。余额决定并发上限，低于 10 元需要充值。'}),
  stat('DeepSeek 对账差额（元）','max(router3_provider_balance_gap{provider="deepseek"})',{decimals:2,w:4,
    thresholds:{mode:'absolute',steps:[{color:'red',value:null},{color:'orange',value:-0.5},{color:'green',value:-0.05},{color:'orange',value:0.05},{color:'red',value:0.5}]},
    description:'最近两次检查之间：余额减少额 − 记录的成本。正数表示扣费多于记录（价格不对或有网关外的调用）。余额精确到 0.01 元；充值的那天为空。'}),
  stat('OpenRouter 余额（美元）','max(router3_provider_balance{provider="openrouter"})',{decimals:2,w:4,thresholds:red(5),description:'管理 Key 读取的账户额度减已用。每个付款钱包的 Key 另有自己的上限。'}),
  stat('OpenRouter 对账差额（美元）','max(router3_provider_balance_gap{provider="openrouter"})',{decimals:4,w:4,
    thresholds:{mode:'absolute',steps:[{color:'red',value:null},{color:'orange',value:-0.5},{color:'green',value:-0.05},{color:'orange',value:0.05},{color:'red',value:0.5}]},
    description:'OpenRouter 按每次响应报告的成本结算，差额应接近 0；正数表示有网关外的调用或成本漏记。'}),
  stat('距上次对账','time() - min(router3_provider_balance_checked_timestamp_seconds)',{unit:'s',w:8,
    thresholds:{mode:'absolute',steps:[{color:'green',value:null},{color:'orange',value:90000},{color:'red',value:129600}]}})
]);
row('主机');
band(6,[
  series('CPU 使用率',[['100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))*100','CPU']],{unit:'percent',w:8}),
  series('内存使用率',[['(1 - max(node_memory_MemAvailable_bytes)/max(node_memory_MemTotal_bytes))*100','内存']],{unit:'percent',w:8}),
  series('磁盘使用率 /',[['(1 - max(node_filesystem_avail_bytes{mountpoint="/"})/max(node_filesystem_size_bytes{mountpoint="/"}))*100','/']],{unit:'percent',w:8})
]);

const dashboard={uid:UID,title:'Router 3 · 运营总览',tags:['router3'],timezone:'browser',schemaVersion:39,refresh:'1m',
  time:{from:'now-24h',to:'now'},panels};

// ops/grafana/router3-dashboard.json is the generated copy kept in git, for review
// and for importing by hand (Dashboards → New → Import).
const file=new URL('./grafana/router3-dashboard.json',import.meta.url);
writeFileSync(file,JSON.stringify({dashboard},null,2)+'\n');
const out=process.argv.indexOf('--out');
if(out>0){writeFileSync(process.argv[out+1],JSON.stringify({dashboard},null,2));console.log(`written ${process.argv[out+1]}`);process.exit(0);}
if(process.argv.includes('--file-only')){console.log('written ops/grafana/router3-dashboard.json');process.exit(0);}
if(!env.GRAFANA_URL||!env.GRAFANA_SA_TOKEN)throw new Error('GRAFANA_URL and GRAFANA_SA_TOKEN are required');
const base=new URL(env.GRAFANA_URL).origin;
const call=async(method,path,body)=>{
  const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${env.GRAFANA_SA_TOKEN}`,'content-type':'application/json'},
    body:body&&JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const text=await response.text();
  if(!response.ok)throw new Error(`GRAFANA_${method}_${path}_${response.status}: ${text.slice(0,200)}`);
  return text?JSON.parse(text):null;
};
const folders=await call('GET','/api/folders');
const folder=folders.find(f=>f.title==='Router 3')??await call('POST','/api/folders',{title:'Router 3'});
const saved=await call('POST','/api/dashboards/db',{dashboard,folderUid:folder.uid,overwrite:true,message:'ops/grafana-dashboard.mjs'});
console.log(JSON.stringify({url:base+saved.url,version:saved.version}));
