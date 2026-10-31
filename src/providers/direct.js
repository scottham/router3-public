import {ProviderError} from './provider-error.js';
import {providerHttpError} from './http-error.js';
import {upstreamRequestBody} from './upstream-params.js';
import {optionalUsageCounter,requiredUsageCounter} from './usage.js';
import {ChatCompletionAggregator,collectChatStream,completionToChunk,parseChatStream} from './chat-stream.js';
import {parseSse,streamInvalid} from './sse.js';
import {decimalUnits} from '../lib/money.js';

const notConfigured=()=>new ProviderError('Provider credential is not configured',{
  code:'PROVIDER_NOT_CONFIGURED',statusCode:503,chargeCertainty:'not_charged'});

// Failures before any byte of the request reached the provider: the name did
// not resolve, nothing accepted the connection, or the TLS handshake failed.
// The model cannot have run, so nothing is charged. Anything later (a reset,
// a timeout, the caller leaving) may have reached the model and stays unknown.
const CONNECT_FAILURES=new Set(['ENOTFOUND','EAI_AGAIN','EAI_FAIL','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','EADDRNOTAVAIL','UND_ERR_CONNECT_TIMEOUT']);
const TLS_FAILURE=/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(GET|VERIFY)_|HOSTNAME_MISMATCH)/;
export function isConnectFailure(error) {
  for(let e=error,depth=0;e&&depth<8;e=e.cause,depth++) {
    const codes=[e.code,...(Array.isArray(e.errors)?e.errors.map(x=>x?.code):[])].filter(c=>typeof c==='string');
    if(codes.some(c=>CONNECT_FAILURES.has(c)||TLS_FAILURE.test(c)))return true;
  }
  return false;
}

// A cost the provider reports with the usage (OpenRouter `usage.cost`, USD).
// Parsed losslessly; anything unreadable is treated as absent so the price
// table decides, never a float.
export function reportedCostUsdNano(usage) {
  const cost=usage?.cost;
  if(cost==null)return null;
  try{return decimalUnits(String(cost),9);}catch{return null;}
}

// Calls a provider's own HTTP API with its key: Chat Completions at
// `${baseUrl}/chat/completions`, and the native Anthropic Messages and
// Responses endpoints at `protocolPaths`. The provider's own usage is what
// gets billed; nothing is recounted. `credential` is either a fixed key or a
// resolver that returns the key for the calling project (OpenRouter mints one
// per project).
export class DirectProvider {
  constructor({name,baseUrl,apiKey=null,keyResolver=null,protocolPaths={},headers={},requestExtras=null,fetchImpl=fetch}) {
    this.name=name;
    this.baseUrl=baseUrl.replace(/\/$/,'');
    this.apiKey=apiKey;
    this.keyResolver=keyResolver;
    this.protocolPaths=protocolPaths;
    this.headers=headers;
    this.requestExtras=requestExtras;
    this.fetch=fetchImpl;
  }

  protocolPath(protocol) {return this.protocolPaths[protocol]??null;}

  async credential(context) {
    const key=this.keyResolver?await this.keyResolver(context):this.apiKey;
    if(!key)throw notConfigured();
    return key;
  }

  // Fields the provider needs beyond the customer's request: OpenRouter's
  // usage accounting and the pinned serving provider.
  extras(request,model,protocol=null) {
    return this.requestExtras?.(request,model,protocol)??{};
  }

  async post(path,body,signal,context) {
    const key=await this.credential(context);
    let response;
    try {
      response=await this.fetch(`${this.baseUrl}${path}`,{method:'POST',
        headers:{authorization:`Bearer ${key}`,'content-type':'application/json',...this.headers},
        body:JSON.stringify(body),signal});
    } catch(error) {
      if(!signal?.aborted&&isConnectFailure(error)) {
        throw new ProviderError('Provider is unreachable',{code:'PROVIDER_UNREACHABLE',statusCode:503,chargeCertainty:'not_charged',cause:error});
      }
      throw new ProviderError('Provider network request failed',{code:'PROVIDER_NETWORK_ERROR',chargeCertainty:'unknown',cause:error});
    }
    if(!response.ok)throw providerHttpError(response.status,await response.text().then(t=>{try{return JSON.parse(t);}catch{return null;}}));
    return response;
  }

  async send(request,model,signal,context,{stream=false}={}) {
    const payload=upstreamRequestBody(request,model.provider_model,this.extras(request,model));
    if(stream){payload.stream=true;payload.stream_options={include_usage:true};}
    const response=await this.post('/chat/completions',payload,signal,context);
    return {response,upstreamModel:model.provider_model};
  }

  // Anthropic Messages / Responses: the body is already in the provider's
  // format and always streamed, so usage arrives the same way for streaming
  // and non-streaming clients. Returns the upstream events.
  async openProtocol(protocol,body,signal,context={},model=null) {
    const path=this.protocolPath(protocol);
    if(!path)throw new ProviderError(`${this.name} has no ${protocol} endpoint`,{code:'MODEL_PROTOCOL_UNSUPPORTED',statusCode:422,chargeCertainty:'not_charged'});
    const response=await this.post(path,{...body,...this.extras(body,model,protocol)},signal,context);
    if(!response.headers.get('content-type')?.includes('text/event-stream'))throw streamInvalid();
    return parseSse(response);
  }

  async invoke(request,model,signal,context={}) {
    const {response,upstreamModel}=await this.send(request,model,signal,context);
    const body=response.headers.get('content-type')?.includes('text/event-stream')
      ?await collectChatStream(response):await response.text().then(t=>{try{return JSON.parse(t);}catch{return null;}});
    return this.normalize(body,response,upstreamModel,model);
  }

  // Streaming transport for the gateway's `stream:true` path. Resolves once the
  // upstream has accepted the request (so pre-charge HTTP failures still surface
  // as ordinary JSON errors) and yields raw Chat Completions chunks as they
  // arrive. `result()` is only valid after `chunks` is exhausted.
  async stream(request,model,signal,context={}) {
    const {response,upstreamModel}=await this.send(request,model,signal,context,{stream:true});
    if(!response.headers.get('content-type')?.includes('text/event-stream')) {
      const result=this.normalize(await response.text().then(t=>{try{return JSON.parse(t);}catch{return null;}}),response,upstreamModel,model);
      return {chunks:(async function*(){yield completionToChunk(result.body);})(),result:()=>result};
    }
    const aggregator=new ChatCompletionAggregator();
    const chunks=(async function*(){for await(const chunk of parseChatStream(response)){aggregator.push(chunk);yield chunk;}})();
    return {chunks,result:()=>this.normalize(aggregator.toCompletion(),response,upstreamModel,model)};
  }

  normalize(body,response,upstreamModel,model) {
    if(!body||typeof body!=='object') {
      throw new ProviderError('Provider returned an invalid JSON response',{code:'PROVIDER_RESPONSE_INVALID',statusCode:502,chargeCertainty:'unknown'});
    }
    const usage=body.usage??{};
    const cachedInputPath=usage.prompt_tokens_details?.cached_tokens!=null?'prompt_tokens_details.cached_tokens':'prompt_cache_hit_tokens';
    const reasoningPath=usage.completion_tokens_details?.reasoning_tokens!=null?'completion_tokens_details.reasoning_tokens':'reasoning_tokens';
    const providerRequestId=body.id??response.headers.get('x-request-id');
    return {
      providerRequestId,
      usageSource:`direct:${this.name}`,
      usage:{
        inputTokens:requiredUsageCounter(usage,'prompt_tokens'),
        cachedInputTokens:optionalUsageCounter(usage,cachedInputPath),
        outputTokens:requiredUsageCounter(usage,'completion_tokens'),
        reasoningTokens:optionalUsageCounter(usage,reasoningPath)
      },
      providerCostUsdNano:reportedCostUsdNano(usage),
      // upstream_model is what Router3 asked for; upstream_response_model what
      // the provider reports it ran, and upstream_route which host served it
      // (OpenRouter). Recording them lets reconciliation detect a catalog drift
      // that would bill model A's price for model B's tokens.
      rawUsageRedacted:{...usage,upstream_model:upstreamModel,
        ...(typeof body.model==='string'?{upstream_response_model:body.model}:{}),
        ...(typeof body.provider==='string'?{upstream_route:body.provider}:{})},
      body:{...body,model:model.public_name}
    };
  }
}
