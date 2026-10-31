import {ProviderError} from './provider-error.js';

const invalid=()=>new ProviderError('The provider stream ended incomplete; the charge will be reconciled',{
  code:'PROVIDER_STREAM_INCOMPLETE',statusCode:502,chargeCertainty:'unknown'
});

// Server-sent events from the Anthropic and Responses formats: one
// `{event,data}` per event, `data` parsed as JSON. Field names may or may not
// be followed by a space; `id:` lines and comments (some providers send
// `:HTTP_STATUS/200`) are skipped. These formats have no `[DONE]`, though
// OpenRouter appends one; it is ignored and the caller decides from the
// events whether the stream finished. Non-JSON data or a stream over the
// byte budget retains uncertain usage.
export async function* parseSse(response,{maxBytes=32*1024*1024}={}) {
  const reader=response.body?.getReader();if(!reader)throw invalid();
  const decoder=new TextDecoder();let pending='',bytes=0;
  function parse(block) {
    let event=null;const data=[];
    for(const line of block.split('\n')) {
      if(!line||line.startsWith(':'))continue;
      const colon=line.indexOf(':');
      const field=colon<0?line:line.slice(0,colon);
      const value=colon<0?'':line.slice(colon+1).replace(/^ /,'');
      if(field==='event')event=value;
      else if(field==='data')data.push(value);
    }
    if(!data.length||(data.length===1&&data[0]==='[DONE]'))return null;
    let parsed;try{parsed=JSON.parse(data.join('\n'));}catch{throw invalid();}
    if(!parsed||typeof parsed!=='object')throw invalid();
    return {event:event??parsed.type??null,data:parsed};
  }
  try {
    while(true) {
      const item=await reader.read();if(item.done)break;
      bytes+=item.value.byteLength;if(bytes>maxBytes)throw invalid();
      pending+=decoder.decode(item.value,{stream:true});pending=pending.replaceAll('\r\n','\n');
      let end;while((end=pending.indexOf('\n\n'))>=0){
        const event=parse(pending.slice(0,end));pending=pending.slice(end+2);
        if(event)yield event;
      }
    }
    pending+=decoder.decode();if(pending.trim()){const event=parse(pending);if(event)yield event;}
  } catch(error) {await reader.cancel().catch(()=>undefined);throw error instanceof ProviderError?error:invalid();}
  finally {reader.releaseLock();}
}

export {invalid as streamInvalid};
