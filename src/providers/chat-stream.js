import {ProviderError} from './provider-error.js';

const invalid=()=>new ProviderError('The provider stream ended incomplete; the charge will be reconciled',{
  code:'PROVIDER_STREAM_INCOMPLETE',statusCode:502,chargeCertainty:'unknown'
});

// Layer 1: transport. Turn an SSE byte stream into parsed Chat Completions
// chunks. The caller sees one JSON object per `data:` event; `[DONE]` ends the
// iteration. Anything the upstream does after `[DONE]`, an `error` payload,
// non-JSON data or exceeding the byte budget retains uncertain usage: the
// provider may have billed tokens we never saw.
export async function* parseChatStream(response,{maxBytes=32*1024*1024}={}) {
  const reader=response.body?.getReader();if(!reader)throw invalid();
  const decoder=new TextDecoder();let pending='',bytes=0,done=false;
  function parse(event) {
    const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)return undefined;
    if(data==='[DONE]'){done=true;return undefined;}
    if(done)throw invalid();
    let chunk;try{chunk=JSON.parse(data);}catch{throw invalid();}
    if(!chunk||typeof chunk!=='object'||chunk.error)throw invalid();
    return chunk;
  }
  try {
    while(true) {
      const item=await reader.read();if(item.done)break;
      bytes+=item.value.byteLength;if(bytes>maxBytes)throw invalid();
      pending+=decoder.decode(item.value,{stream:true});pending=pending.replaceAll('\r\n','\n');
      let end;while((end=pending.indexOf('\n\n'))>=0){
        const chunk=parse(pending.slice(0,end));pending=pending.slice(end+2);
        if(chunk)yield chunk;
      }
    }
    pending+=decoder.decode();if(pending.trim()){const chunk=parse(pending);if(chunk)yield chunk;}
    if(!done)throw invalid();
  } catch(error) {await reader.cancel().catch(()=>undefined);throw error instanceof ProviderError?error:invalid();}
  finally {reader.releaseLock();}
}

// Layer 2: aggregation. Fold streamed chunks into one synchronous
// `chat.completion` object. The streaming gateway path pushes every chunk it
// forwards so the replay cache and the usage receipt describe exactly what the
// customer received; the non-streaming path feeds it a whole upstream stream.
export class ChatCompletionAggregator {
  constructor() {this.result=null;this.usage=null;this.choices=new Map();}
  push(chunk) {
    if(this.result && chunk.id && this.result.id!==chunk.id)throw invalid();
    this.result??={id:chunk.id,object:'chat.completion',created:chunk.created,model:chunk.model};
    if(chunk.usage)this.usage=chunk.usage;
    for(const item of chunk.choices??[]) {
      if(!Number.isSafeInteger(item.index)||item.index<0||item.index>0)throw invalid();
      const choice=this.choices.get(item.index)??{index:item.index,message:{role:'assistant',content:''},finish_reason:null};
      const delta=item.delta??{},message=choice.message;
      for(const field of ['content','reasoning_content','refusal']) {
        if(delta[field]!=null){if(typeof delta[field]!=='string')throw invalid();message[field]=(message[field]??'')+delta[field];}
      }
      for(const tool of delta.tool_calls??[]) {
        if(!Number.isSafeInteger(tool.index)||tool.index<0||tool.index>127)throw invalid();
        message.tool_calls??=[];
        const current=message.tool_calls[tool.index]??{id:tool.id,type:'function',function:{name:'',arguments:''}};
        if(tool.id)current.id=tool.id;
        if(tool.function?.name)current.function.name+=tool.function.name;
        if(tool.function?.arguments)current.function.arguments+=tool.function.arguments;
        message.tool_calls[tool.index]=current;
      }
      if(item.finish_reason!=null)choice.finish_reason=item.finish_reason;
      this.choices.set(item.index,choice);
    }
  }
  get complete() {
    return Boolean(this.usage&&this.result&&this.choices.size&&![...this.choices.values()].some(c=>!c.finish_reason));
  }
  // `usage` may be supplied by the caller when the final usage travelled
  // separately from the chunks (the streaming gateway path strips it).
  toCompletion(usage=this.usage) {
    if(!usage||!this.result||!this.choices.size||[...this.choices.values()].some(c=>!c.finish_reason))throw invalid();
    return {...this.result,choices:[...this.choices.values()].sort((a,b)=>a.index-b.index),usage};
  }
}

export async function aggregateChatStream(chunks) {
  const aggregator=new ChatCompletionAggregator();
  for await(const chunk of chunks)aggregator.push(chunk);
  return aggregator.toCompletion();
}

// Some models only support streaming with their official thinking default.
// Assemble that transport into our synchronous Chat Completions API; never
// disable thinking to make a non-streaming upstream request work.
export async function collectChatStream(response,options={}) {
  return aggregateChatStream(parseChatStream(response,options));
}

// A cached synchronous completion replayed to a streaming client: one chunk
// carrying the whole message, so OpenAI SDK stream consumers see a well-formed
// delta followed by `[DONE]`.
export function completionToChunk(completion) {
  const {choices=[],object:_object,...rest}=completion;
  return {
    ...rest,
    object:'chat.completion.chunk',
    choices:choices.map(({message,...choice})=>({...choice,delta:message??{}}))
  };
}
