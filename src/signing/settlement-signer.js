import {createHash, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';

// The signer's HTTP face: a bearer-protected `POST /sign` that hands the body
// to the signer and never reveals more than an error code.
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, statusCode=400) => Object.assign(new Error(code), {code,statusCode});

export {fail as signerError};

export function createSettlementSignerServer(signer,bearerToken) {
  if(typeof bearerToken!=='string' || bearerToken.length<32) throw fail('SIGNER_TOKEN_REQUIRED');
  const expected=Buffer.from(hash(`Bearer ${bearerToken}`),'hex');
  const server=createServer(async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(!timingSafeEqual(expected,Buffer.from(hash(req.headers.authorization||''),'hex'))) return send(401,{error:'UNAUTHORIZED'});
    try {
      if(req.method==='GET'&&req.url==='/healthz') {await signer.pool.query('select 1');return send(200,{ok:true});}
      if(req.method!=='POST'||req.url!=='/sign') return send(404,{error:'NOT_FOUND'});
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>65536) throw fail('BODY_TOO_LARGE',413);chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw fail('INVALID_JSON');}
      return send(200,await signer.signAndBroadcast(body));
    } catch(error) {
      const code=typeof error.code==='string'&&error.code.startsWith('SIGNER_')?error.code:'SIGNER_FAILED';
      // The caller gets only the code; the operator's log says why (no key material passes through here).
      console.error(JSON.stringify({level:'error',message:code,...(error.reason?{reason:error.reason}:{}),detail:String(error.message??error).slice(0,400)}));
      return send(error.statusCode??503,{error:code,...(error.reason?{reason:String(error.reason).slice(0,80)}:{})});
    }
  });
  server.requestTimeout=35000;server.headersTimeout=10000;
  return server;
}
