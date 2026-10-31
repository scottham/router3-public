// Fires N chat requests at once and prints status counts and latency.
//   MCG_API_KEY=mcg_live_... node scripts/verify-gateway-load.mjs [N] [model]
// MCG_BASE_URL defaults to the public gateway. Each request asks for one
// token with thinking off, so 500 requests cost well under 0.05 USDC.
const [n='100',model='deepseek/deepseek-flash']=process.argv.slice(2);
const base=process.env.MCG_BASE_URL??'https://router3.ai';
const key=process.env.MCG_API_KEY;
if(!key)throw new Error('MCG_API_KEY is required');
const body=JSON.stringify({model,max_tokens:1,thinking:{type:'disabled'},enable_thinking:false,messages:[{role:'user',content:'1'}]});
const one=async()=>{
  const started=performance.now();
  try {
    const r=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body});
    const j=await r.json().catch(()=>({}));
    return {status:r.status,code:j.error?.code??j.code??null,ms:performance.now()-started};
  }catch(e){return {status:0,code:e.cause?.code??e.message,ms:performance.now()-started};}
};
const started=performance.now();
const results=await Promise.all(Array.from({length:Number(n)},one));
const counts={};for(const r of results){const k=r.code?`${r.status}:${r.code}`:String(r.status);counts[k]=(counts[k]??0)+1;}
const ok=results.filter(r=>r.status===200).map(r=>r.ms).sort((a,b)=>a-b);
const q=p=>ok.length?Math.round(ok[Math.min(ok.length-1,Math.floor(p*ok.length))]):null;
console.log(JSON.stringify({base,model,n:Number(n),wallMs:Math.round(performance.now()-started),status:counts,p50Ms:q(.5),p95Ms:q(.95),maxMs:q(1)}));
