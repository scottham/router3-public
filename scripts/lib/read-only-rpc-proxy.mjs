import { createServer } from 'node:http';

// Foundry gets a loopback endpoint whose upstream transport cannot broadcast.
// Reject whole batches if ANY method is outside this read-only allowlist.
const readOnlyRpcMethods = new Set([
  'eth_chainId','net_version','web3_clientVersion','eth_blockNumber','eth_gasPrice','eth_getBlockByNumber','eth_getBlockByHash',
  'eth_getBalance','eth_getCode','eth_getStorageAt','eth_getTransactionCount','eth_getProof','eth_getAccountInfo',
  'eth_getTransactionByHash','eth_getTransactionReceipt','eth_getLogs','eth_call','eth_getBlockReceipts'
]);

// Public endpoints rate-limit Foundry's parallel startup reads; queue upstream
// calls and retry HTTP 429 with backoff instead of failing the fork.
function rateLimited(transport, { concurrency = 4, retries = 6, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let active = 0; const waiting = [];
  const acquire = () => active < concurrency ? (active++, Promise.resolve()) : new Promise((resolve) => waiting.push(resolve));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return async (url, options) => {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        const result = await transport(url, { ...options, signal: AbortSignal.timeout(20000) });
        if (result.status !== 429 || attempt >= retries) return result;
        await sleep(250 * 2 ** attempt);
      }
    } finally { release(); }
  };
}

export async function createReadOnlyRpcProxy(upstream, { transport: rawTransport = fetch, ...limits } = {}) {
  const transport = rateLimited(rawTransport, limits);
  const url = new URL(upstream);
  if (url.protocol !== 'https:') throw new Error('Fork upstream must use HTTPS');
  const stats = { forwarded: 0, rejected: 0, methods: {}, rejectedMethods: {} };
  const server = createServer(async (request,response) => {
    response.setHeader('content-type','application/json');
    let body = '';
    try {
      if (request.method !== 'POST') throw new Error('RPC_POST_REQUIRED');
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 2_000_000) throw new Error('RPC_BODY_TOO_LARGE'); }
      const payload = JSON.parse(body);
      const batch = Array.isArray(payload) ? payload : [payload];
      if (!batch.length || batch.length > 100 || batch.some((item) => !item || item.jsonrpc !== '2.0' || !readOnlyRpcMethods.has(item.method))) {
        stats.rejected++;
        for (const item of batch) {
          const name = /^[a-zA-Z][a-zA-Z0-9_]{0,80}$/.test(item?.method ?? '') ? item.method : 'invalid';
          stats.rejectedMethods[name] = (stats.rejectedMethods[name] ?? 0) + 1;
        }
        response.end(JSON.stringify({ jsonrpc:'2.0',id:null,error:{code:-32601,message:'Read-only fork proxy rejected a method'} }));
        return;
      }
      for (const item of batch) stats.methods[item.method] = (stats.methods[item.method] ?? 0) + 1;
      stats.forwarded += batch.length;
      const result = await transport(url.href,{method:'POST',headers:{'content-type':'application/json'},body,redirect:'error'});
      // mainnet.base.org answers the optional eth_getAccountInfo with HTTP 401
      // (-32611 request filter). Report it as -32601 so Foundry falls back.
      if (!result.ok) {
        if (!batch.every((item) => item.method === 'eth_getAccountInfo')) throw new Error('UPSTREAM_HTTP_ERROR');
        const unavailable = (item) => ({ jsonrpc:'2.0',id:item.id,error:{code:-32601,message:'Read-only upstream RPC failed'} });
        response.end(JSON.stringify(Array.isArray(payload) ? batch.map(unavailable) : unavailable(payload)));
        return;
      }
      const data = await result.json();
      // Never forward transport diagnostics that could contain URL credentials.
      // Preserve numeric codes, notably -32601, so Foundry may fall back from
      // optional eth_getAccountInfo to getBalance/getCode/getTransactionCount.
      const sanitized = (item) => item?.error ? { jsonrpc:'2.0',id:item.id,error:{
        code:Number.isInteger(item.error.code) ? item.error.code : -32000,message:'Read-only upstream RPC failed'
      } } : item;
      response.end(JSON.stringify(Array.isArray(data) ? data.map(sanitized) : sanitized(data)));
    } catch {
      response.statusCode = 502;
      response.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Read-only RPC request failed'}}));
    }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  return { url:`http://127.0.0.1:${server.address().port}`, stats,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  };
}
