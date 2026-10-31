import {AppError} from '../lib/errors.js';
import {canonicalize} from '../lib/crypto.js';

// Content the tier quotes price: text, tool calls and images.
// Files, audio and the results of server-side tools are billed at rates no
// price version covers, so a request carrying them is refused by name.
const IMAGE_TYPES=new Set(['image','input_image']);
const UNPRICED_TYPES=new Set(['document','input_file','input_audio','audio','video','file','container_upload','search_result',
  'server_tool_use','web_search_tool_result','web_fetch_tool_result','code_execution_tool_result','mcp_tool_use','mcp_tool_result',
  'item_reference']);

export function unsupported(option) {
  return new AppError('REQUEST_OPTION_NOT_SUPPORTED',`Only text, images and tool calls are supported; this request uses an unsupported option: ${option}`,422,{option});
}

// Replaces each image with a marker and counts it; images are priced by the
// quote's per-image ceiling, never by their (often base64) byte size.
function withoutImages(value,count) {
  if(Array.isArray(value))return value.map(item=>withoutImages(item,count));
  if(!value||typeof value!=='object')return value;
  if(IMAGE_TYPES.has(value.type)) {
    const source=value.source?.type;
    if(source&&source!=='base64'&&source!=='url')throw unsupported(`image.source.${source}`);
    if(value.file_id)throw unsupported('input_image.file_id');
    count.images++;return {type:value.type};
  }
  if(UNPRICED_TYPES.has(value.type))throw unsupported(value.type);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,withoutImages(v,count)]));
}

// The request as estimateTierMaximum reads a chat request: every input byte
// as one text part (an upper bound on its tokens), the images as image parts
// and the output limit as max_completion_tokens. Tools are counted as text but
// not scanned: their JSON schemas use `type` for other things.
export function estimateView({content,tools,maxOutputTokens}) {
  const count={images:0};
  const text=canonicalize({content:withoutImages(content,count),tools:tools??null});
  return {messages:[{role:'user',content:[{type:'text',text},
    ...Array.from({length:count.images},()=>({type:'image_url',image_url:{url:'image'}}))]}],
  ...(maxOutputTokens?{max_completion_tokens:maxOutputTokens}:{})};
}

export function pick(request,fields) {
  const body={};
  for(const field of fields)if(request[field]!==undefined)body[field]=request[field];
  return body;
}
