import {z} from 'zod';
import {AppError} from '../lib/errors.js';
import {streamInvalid} from '../providers/sse.js';
import {optionalUsageCounter,requiredUsageCounter} from '../providers/usage.js';
import {estimateView,pick,unsupported} from './common.js';
import {CACHE_FIELDS,cacheRequestSchema} from '../providers/prompt-cache.js';

// Anthropic Messages (POST /v1/messages), served by the provider's own
// Anthropic-compatible endpoint (DirectProvider.openProtocol).
const schema=z.object({
  ...cacheRequestSchema,
  model:z.string().min(1).max(200),
  // Claude Code also sends role:'system' turns inside messages (2.1.x); both
  // providers accept them (checked 2026-10-22).
  messages:z.array(z.object({role:z.enum(['user','assistant','system']),content:z.any()}).passthrough()).min(1).max(1000),
  system:z.any().optional(),
  max_tokens:z.number().int().positive().max(1_000_000),
  stream:z.boolean().optional().default(false),
  temperature:z.number().min(0).max(2).optional(),
  top_p:z.number().min(0).max(1).optional(),
  top_k:z.number().int().nonnegative().optional(),
  stop_sequences:z.array(z.string()).max(16).optional(),
  tools:z.array(z.any()).max(128).optional(),
  tool_choice:z.any().optional(),
  thinking:z.any().optional(),
  output_config:z.any().optional()
}).passthrough();

const FIELDS=['messages','system','max_tokens','temperature','top_p','top_k','stop_sequences','tools','tool_choice','thinking','output_config',...CACHE_FIELDS];

// An explicit cache write (cache_control) is billed above the input rate.
// Where the price version carries that rate (OpenRouter quotes) the marker is
// forwarded and the hold assumes every input token may be written; otherwise
// it is dropped. DeepSeek caches implicitly; Claude needs the priced opt-in.
function withoutCacheControl(value) {
  if(Array.isArray(value))return value.map(withoutCacheControl);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='cache_control').map(([k,v])=>[k,withoutCacheControl(v)]));
}

export const label='Anthropic Messages';

export function parse(body) {
  const request=schema.parse(body);
  // Typed tools (web_search_*, web_fetch_*, code_execution_*, bash_*, ...) run
  // on the provider and are billed per call; only client tools are served.
  for(const tool of request.tools??[]) {
    if(tool?.type!=null&&tool.type!=='custom')throw new AppError('SERVER_TOOLS_NOT_SUPPORTED',`Server-side tools are not supported: ${tool.type}`,422,{tool:tool.type});
  }
  for(const option of ['mcp_servers','container'])if(request[option]!=null)throw unsupported(option);
  return request;
}

export function view(request) {
  return estimateView({content:{system:request.system??null,messages:request.messages},tools:request.tools,maxOutputTokens:request.max_tokens});
}

export function upstreamBody(request,providerModel,{keepCacheControl=false}={}) {
  const fields=pick(request,FIELDS);
  return {...(keepCacheControl?fields:withoutCacheControl(fields)),model:providerModel,stream:true};
}

// Folds the event stream into one Messages response. Usage is the union of
// message_start and message_delta; the delta's counts win because some
// providers report a partial input count in message_start (measured 2026-10-22).
export class Aggregator {
  constructor() {this.message=null;this.blocks=[];this.usage={};this.delta=null;this.stopped=false;}
  push({data}) {
    switch(data.type) {
      case 'message_start':
        if(this.message||!data.message)throw streamInvalid();
        this.message={...data.message};Object.assign(this.usage,data.message.usage??{});break;
      case 'content_block_start':
        if(!this.message||!Number.isSafeInteger(data.index)||data.index<0||data.index>1023)throw streamInvalid();
        this.blocks[data.index]={...data.content_block,...(data.content_block?.type==='tool_use'?{input:{},json:''}:{})};break;
      case 'content_block_delta': {
        const block=this.blocks[data.index],delta=data.delta??{};
        if(!block)throw streamInvalid();
        if(delta.type==='text_delta')block.text=(block.text??'')+delta.text;
        else if(delta.type==='thinking_delta')block.thinking=(block.thinking??'')+delta.thinking;
        else if(delta.type==='signature_delta')block.signature=(block.signature??'')+delta.signature;
        else if(delta.type==='input_json_delta')block.json+=delta.partial_json??'';
        break;
      }
      case 'content_block_stop': {
        const block=this.blocks[data.index];
        if(!block)throw streamInvalid();
        if(block.json!==undefined){try{block.input=block.json?JSON.parse(block.json):{};}catch{throw streamInvalid();}delete block.json;}
        break;
      }
      case 'message_delta':this.delta=data.delta??{};Object.assign(this.usage,data.usage??{});break;
      case 'message_stop':this.stopped=true;break;
      case 'error':throw streamInvalid();
      default:break;
    }
  }
  toBody() {
    if(!this.message||!this.stopped)throw streamInvalid();
    return {...this.message,content:this.blocks.filter(Boolean),stop_reason:this.delta?.stop_reason??this.message.stop_reason??null,
      stop_sequence:this.delta?.stop_sequence??this.message.stop_sequence??null,usage:this.usage};
  }
}

// Sent only after billing is final, carrying the settled usage.
export const held=type=>type==='message_delta'||type==='message_stop';

export function forwardEvent({event,data},publicModel) {
  if(data.type==='message_start')return {event,data:{...data,message:{...data.message,model:publicModel}}};
  return {event,data};
}

export function finalEvents(body,gateway) {
  return [{event:'message_delta',data:{type:'message_delta',delta:{stop_reason:body.stop_reason,stop_sequence:body.stop_sequence},usage:body.usage,gateway}},
    {event:'message_stop',data:{type:'message_stop'}}];
}

// input_tokens excludes cache reads and writes (measured on both providers).
// Reasoning is not counted apart; a thinking block selects the thinking tariff.
export function usage(body) {
  const u=body.usage??{};
  const cacheRead=optionalUsageCounter(u,'cache_read_input_tokens'),cacheWrite=optionalUsageCounter(u,'cache_creation_input_tokens');
  const thinking=body.content.some(b=>(b.type==='thinking'&&b.thinking)||b.type==='redacted_thinking');
  return {inputTokens:requiredUsageCounter(u,'input_tokens')+cacheRead+cacheWrite,cachedInputTokens:cacheRead,
    outputTokens:requiredUsageCounter(u,'output_tokens'),reasoningTokens:0,...(thinking?{thinking:true}:{})};
}

const ERROR_TYPES={400:'invalid_request_error',401:'authentication_error',402:'billing_error',403:'permission_error',404:'not_found_error',
  409:'invalid_request_error',413:'request_too_large',422:'invalid_request_error',429:'rate_limit_error',503:'overloaded_error',504:'timeout_error'};

export function errorBody(statusCode,{code,message,details},requestId) {
  return {type:'error',error:{type:ERROR_TYPES[statusCode]??'api_error',message,code,...(details===undefined?{}:{details}),
    ...(requestId?{request_id:requestId}:{})}};
}

export function errorEvent(statusCode,error,requestId) {
  return {event:'error',data:errorBody(statusCode,error,requestId)};
}
