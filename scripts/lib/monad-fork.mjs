import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { AbiCoder, JsonRpcProvider } from 'ethers';
import { CHAIN_ID, PUBLIC_RPC_URL, USDC_ADDRESS } from '../../src/chain.js';
import { createReadOnlyRpcProxy } from './read-only-rpc-proxy.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const USDC_NAME_CALL={to:USDC_ADDRESS,data:'0x06fdde03'};

// Forks Monad mainnet just behind the upstream finalized head. Monad full
// nodes keep only a few days of state, so a fixed historic block would stop
// working; the fork is instead pinned to whatever block it starts from and
// checked against Circle's USDC. MONAD_FORK_RPC_URL overrides the upstream.
// `host` defaults to loopback. Containers on Linux cannot reach the host's
// loopback, so a Docker-facing test binds the bridge gateway address instead.
export async function startMonadFork({host='127.0.0.1',upstream=process.env.MONAD_FORK_RPC_URL||PUBLIC_RPC_URL}={}) {
  const chainId=CHAIN_ID;
  const proxy=await createReadOnlyRpcProxy(upstream);
  let child,provider;
  const close=async()=>{
    provider?.destroy();
    if(child&&child.exitCode===null&&child.signalCode===null){
      const ended=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');
      await Promise.race([ended,sleep(2000)]);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await ended;}
    }
    await proxy.close();
  };
  try {
    const probe=new JsonRpcProvider(proxy.url,chainId,{staticNetwork:true,cacheTimeout:-1});
    let block,blockHash;
    try {
      assert.equal(Number(await probe.send('eth_chainId',[])),chainId);
      const finalized=await probe.send('eth_getBlockByNumber',['finalized',false]);
      block=Number(BigInt(finalized.number))-2;blockHash=(await probe.getBlock(block)).hash;
      assert.match(AbiCoder.defaultAbiCoder().decode(['string'],await probe.call({...USDC_NAME_CALL,blockTag:block}))[0],/^USDC$/);
    } finally {probe.destroy();}
    const reservation=createServer();await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(0,host,resolve);});
    const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
    const url=`http://${host}:${port}`;
    const env=Object.fromEntries(['PATH','HOME','TMPDIR'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
    child=spawn('anvil',['--host',host,'--port',String(port),'--fork-url',proxy.url,'--fork-block-number',String(block),
      '--chain-id',String(chainId),'--network','monad','--no-storage-caching','--silent'],{env,stdio:['ignore','ignore','ignore']});
    let spawnError;child.once('error',error=>{spawnError=error;});
    provider=new JsonRpcProvider(url,chainId,{staticNetwork:true,cacheTimeout:-1,batchMaxCount:1});provider.pollingInterval=100;
    const deadline=Date.now()+45000;let ready=false;
    while(Date.now()<deadline){
      if(spawnError||child.exitCode!==null||child.signalCode!==null) throw new Error('LOCAL_FORK_START_FAILED');
      try {ready=Number(await provider.send('eth_chainId',[]))===chainId;if(ready)break;} catch {}
      await sleep(250);
    }
    assert.equal(ready,true,'Local fork did not start');
    assert.match(await provider.send('web3_clientVersion',[]),/anvil/i);
    assert.equal((await provider.getBlock(block)).hash,blockHash);
    return {url,provider,block,remoteStats:proxy.stats,close};
  } catch(error){await close();throw error;}
}
