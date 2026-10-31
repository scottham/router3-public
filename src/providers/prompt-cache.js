import {z} from 'zod';

export const CACHE_FIELDS=['cache_control','prompt_cache_key','session_id'];
export const cacheRequestSchema={
  cache_control:z.object({type:z.literal('ephemeral'),ttl:z.enum(['5m','1h']).optional()}).strict().nullable().optional(),
  prompt_cache_key:z.string().max(256).nullable().optional(),
  session_id:z.string().max(256).optional()
};

// Inspect prompt blocks, not JSON schemas or tool arguments that can contain
// user-defined properties with these names.
function cachePoints(request) {
  const list=value=>Array.isArray(value)?value:[];
  const blocks=[...list(request.system),...list(request.tools),...list(request.messages),...list(request.input)];
  for(let i=0;i<blocks.length;i++){
    blocks.push(...list(blocks[i]?.content));
    if(blocks[i]?.type==='function_call_output')blocks.push(...list(blocks[i].output));
  }
  return [request,...blocks].flatMap(block=>[block?.cache_control,block?.prompt_cache_breakpoint]).filter(Boolean);
}

export const hasLongCacheWrite=request=>cachePoints(request).some(point=>point.ttl==='1h');

// Implicit caching does not need a change to the deployment's host order.
// Explicit caches use the provider's cache-aware session routing.
export const usesStickyCache=model=>model?.bailian_quote?.cache?.mode==='explicit';

// The catalog records upstream capabilities. Only explicit caches need a
// default directive; implicit caches need no prompt changes. null opts out.
export function openRouterCache(request,model,protocol=null) {
  if(request.cache_control===null)return {cache_control:undefined};
  if(model?.bailian_quote?.cache?.mode!=='explicit'
    ||!model.bailian_quote.tiers.every(t=>t.cacheWrite!=null)||cachePoints(request).length)return {};
  // Cache a reusable prefix and leave the newest input outside it. This
  // avoids writing one-shot queries and keeps a fresh tail for generation.
  return lastBreakpoint(request,protocol,{type:'ephemeral'});
}

function lastBreakpoint(request,protocol,directive) {
  const responses=protocol==='responses';
  const field=responses?'input':'messages',type=responses?'input_text':'text';
  const marker=responses?{prompt_cache_breakpoint:{mode:'explicit'}}:{cache_control:directive};
  const mark=content=>{
    if(typeof content==='string')return content?[{type,text:content,...marker}]:null;
    if(!Array.isArray(content))return null;
    for(let i=content.length-1;i>=0;i--){
      if(content[i]?.type!==type&&!(protocol==='anthropic'&&content[i]?.type==='tool_result'))continue;
      return content.map((part,n)=>n===i?{...part,...marker}:part);
    }
    return null;
  };
  const items=request[field];
  for(let i=(Array.isArray(items)?items.length:0)-2;i>=0;i--){
    const key=responses&&items[i]?.type==='function_call_output'?'output':'content';
    const content=mark(items[i]?.[key]);
    if(content)return {[field]:items.map((item,n)=>n===i?{...item,[key]:content}:item)};
  }
  if(protocol==='anthropic'){
    const system=mark(request.system);
    if(system)return {system};
  }
  // Responses has no breakpoint field on top-level instructions; its native
  // developer-message form provides the same instructions with a boundary.
  if(responses&&typeof request.instructions==='string'&&request.instructions){
    const input=typeof request.input==='string'?[{role:'user',content:request.input}]:items;
    return {instructions:undefined,input:[{role:'developer',content:mark(request.instructions)},...input]};
  }
  return {};
}
