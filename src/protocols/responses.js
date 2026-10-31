import {z} from 'zod';
import {AppError} from '../lib/errors.js';
import {streamInvalid} from '../providers/sse.js';
import {optionalUsageCounter,requiredUsageCounter} from '../providers/usage.js';
import {estimateView,pick,unsupported} from './common.js';
import {CACHE_FIELDS,cacheRequestSchema} from '../providers/prompt-cache.js';

// OpenAI Responses (POST /v1/responses), served by the provider's own
// Responses endpoint (DirectProvider.openProtocol). Stateless only: every
// user shares the provider account, so a stored response could be read back
// by anyone holding its id, and a continued conversation has an input size
// the hold cannot bound.
const schema=z.object({
  ...cacheRequestSchema,
  model:z.string().min(1).max(200),
  input:z.union([z.string().min(1),z.array(z.any()).min(1).max(2000)]),
  instructions:z.string().nullable().optional(),
  max_output_tokens:z.number().int().positive().max(1_000_000).nullable().optional(),
  stream:z.boolean().optional().default(false),
  store:z.boolean().nullable().optional(),
  temperature:z.number().min(0).max(2).nullable().optional(),
  top_p:z.number().min(0).max(1).nullable().optional(),
  tools:z.array(z.any()).max(128).optional(),
  tool_choice:z.any().optional(),
  parallel_tool_calls:z.boolean().nullable().optional(),
  reasoning:z.any().optional(),
  text:z.any().optional(),
  include:z.array(z.string()).max(16).nullable().optional()
}).passthrough();

const FIELDS=['input','instructions','max_output_tokens','temperature','top_p','tools','tool_choice','parallel_tool_calls',
  'reasoning','text','include',...CACHE_FIELDS,'truncation','top_logprobs','safety_identifier'];

export const label='Responses';

export function parse(body) {
  const request=schema.parse(body);
  if(request.store===true)throw new AppError('RESPONSES_STORE_NOT_SUPPORTED','Only stateless calls are supported: store must be false or omitted',422);
  for(const option of ['previous_response_id','conversation','prompt'])if(request[option]!=null)throw new AppError('RESPONSES_STATE_NOT_SUPPORTED',`Only stateless calls are supported; ${option} is not`,422,{option});
  if(request.background===true)throw unsupported('background');
  // Built-in tools (web_search, code_interpreter, web_extractor, file_search,
  // mcp, ...) run on the provider and are billed per call. A namespace only
  // groups client tools (Codex sends its sub-agent tools as one); both
  // providers accept it (checked 2026-10-22).
  for(const tool of request.tools??[]) {
    const tools=tool?.type==='namespace'&&Array.isArray(tool.tools)?tool.tools:[tool];
    for(const t of tools)if(t?.type!=='function'&&t?.type!=='custom') {
      throw new AppError('SERVER_TOOLS_NOT_SUPPORTED',`Server-side tools are not supported: ${t?.type}${t?.type==='web_search'?' (in Codex, set web_search = "disabled" in config.toml)':''}`,422,{tool:t?.type??null});
    }
  }
  return request;
}

// Codex sends no max_output_tokens (0.161, even with model_max_output_tokens
// set), and the model's own maximum (DeepSeek Pro: 393216) holds more than
// the per-request limit. Without a limit the gateway sets this one, capped at
// the model's maximum, and forwards it so the provider enforces what was held.
export const DEFAULT_MAX_OUTPUT_TOKENS=65536;

// Returns the field it set, which the gateway may lower further to fit the
// per-request limit.
export function applyDefaults(request,model) {
  if(request.max_output_tokens!=null)return null;
  const quote=model.bailian_quote;
  request.max_output_tokens=Math.min(DEFAULT_MAX_OUTPUT_TOKENS,Number(BigInt(quote.maxOutputTokens)+BigInt(quote.maxReasoningTokens??0)));
  return 'max_output_tokens';
}

export function view(request) {
  return estimateView({content:{instructions:request.instructions??null,input:request.input,text:request.text??null},
    tools:request.tools,maxOutputTokens:request.max_output_tokens});
}

export function upstreamBody(request,providerModel,{keepCacheControl=false}={}) {
  const fields=pick(request,FIELDS);
  if(!keepCacheControl)delete fields.cache_control;
  return {...fields,model:providerModel,store:false,stream:true};
}

const TERMINAL=new Set(['response.completed','response.incomplete','response.failed']);

// The terminal event carries the whole response, usage included.
export class Aggregator {
  constructor() {this.final=null;}
  push({data}) {
    if(data.type==='error')throw streamInvalid();
    if(TERMINAL.has(data.type)) {
      if(this.final||!data.response||typeof data.response!=='object')throw streamInvalid();
      this.final=data;
    }
  }
  toBody() {
    if(!this.final)throw streamInvalid();
    return this.final.response;
  }
  get terminalType() {return this.final?.type;}
}

export const held=type=>TERMINAL.has(type);

// Some providers (OpenRouter) send no `event:` line; the type names the event.
export function forwardEvent({event,data},publicModel) {
  const name=event??data.type;
  if(data.response&&typeof data.response==='object')return {event:name,data:{...data,response:{...data.response,model:publicModel}}};
  return {event:name,data};
}

export function finalEvents(body,gateway,aggregator) {
  const terminal=aggregator.final;
  return [{event:terminal.type,data:{...terminal,response:{...body,gateway}}}];
}

// input_tokens includes cached tokens here (unlike the Anthropic format).
export function usage(body) {
  const u=body.usage;
  if(!u)throw streamInvalid();
  return {inputTokens:requiredUsageCounter(u,'input_tokens'),cachedInputTokens:optionalUsageCounter(u,'input_tokens_details.cached_tokens'),
    outputTokens:requiredUsageCounter(u,'output_tokens'),reasoningTokens:optionalUsageCounter(u,'output_tokens_details.reasoning_tokens')};
}

export function errorBody(statusCode,{code,message,details},requestId) {
  return {error:{code,message,...(details===undefined?{}:{details}),...(requestId?{request_id:requestId}:{})}};
}

export function errorEvent(statusCode,{code,message},requestId) {
  return {event:'error',data:{type:'error',code,message,param:null,...(requestId?{request_id:requestId}:{})}};
}
