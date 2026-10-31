import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import Redis from 'ioredis';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {createServer} from 'node:net';

const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const id=`router3-redis-test-${randomBytes(5).toString('hex')}`,password=randomBytes(24).toString('hex');
const apps=[];let redis,created=false,dispatches=0;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  docker('run','-d','--name',id,'-p',`127.0.0.1:${port}:6379`,'redis:7.4.8-alpine','redis-server','--requirepass',password,'--appendonly','yes','--maxmemory-policy','noeviction');created=true;
  const url=`redis://:${password}@127.0.0.1:${port}/0`;
  redis=new Redis(url,{lazyConnect:true});redis.on('error',()=>{});await redis.connect().catch(()=>{});await redis.ping();
  const config=loadConfig({NODE_ENV:'test',MCG_RUNTIME:'api',PUBLIC_APP_URL:'http://localhost:3000',LOG_LEVEL:'silent',DATABASE_URL_API:'postgresql://test:test@127.0.0.1:1/test',
    AUTH_SESSION_HMAC_SECRET:'s'.repeat(32),RESPONSE_ENCRYPTION_KEYS:`v1:${Buffer.alloc(32).toString('base64')}`,
    TREASURY_ADDRESS:'0x'+'5'.repeat(40),SETTLER_ADDRESS:'0x'+'6'.repeat(40),SETTLER_SIGNER_URL:'http://127.0.0.1:9/sign',SETTLER_SIGNER_BEARER_TOKEN:'t'.repeat(32),X402_FACILITATOR_URL:'http://127.0.0.1:9',
    REDIS_REQUIRED:'true',REDIS_URL:url,REDIS_NAMESPACE:id,RATE_LIMIT_MAX:'4',RATE_LIMIT_WINDOW:'60 seconds'});
  for(let i=0;i<2;i++) {
    const {app}=await buildApp(config,{x402:{facilitator:{async getSupported(){throw new Error('offline');}}}});app.get('/scaling-probe',async()=>({dispatch:++dispatches}));
    apps.push(app);await app.ready();
  }
  const headers={};
  const results=await Promise.all(Array.from({length:20},(_,i)=>apps[i%2].inject({url:'/scaling-probe',headers})));
  assert.equal(results.filter(r=>r.statusCode===200).length,4);assert.equal(results.filter(r=>r.statusCode===429).length,16);assert.equal(dispatches,4);
  const before=await redis.keys(`${id}:api-rate:*`);assert.equal(before.length,1);
  await wait(1200); // Redis AOF fsync=everysec, not a financial durability guarantee.
  docker('stop','-t','1',id);
  const unavailable=await apps[1].inject({url:'/scaling-probe',headers:{authorization:'Bearer mcg_live_different'}});
  assert.equal(unavailable.statusCode,503);assert.equal(unavailable.json().error.code,'RATE_LIMIT_UNAVAILABLE');assert.equal(dispatches,4);
  assert.equal((await apps[0].inject('/healthz')).statusCode,200);assert.equal((await apps[0].inject('/readyz')).statusCode,503);
  docker('start',id);
  let recovered=false;
  for(let n=0;n<40;n++) {
    await wait(100);const result=await apps[0].inject({url:'/scaling-probe',headers});
    if(result.statusCode===429){recovered=true;break;}
  }
  assert.ok(recovered,'Redis AOF preserves the shared counter after restart');assert.equal(dispatches,4);
  await redis.pexpire(before[0],40);await wait(80);
  assert.equal((await apps[1].inject({url:'/scaling-probe',headers})).statusCode,200);assert.equal(dispatches,5);
  console.log('Redis scaling passed: two independent API instances share one atomic limit; 20 concurrent requests dispatch only 4; outage fails closed; health remains live; persisted limits survive restart; expired windows accept new calls.');
}finally{await Promise.all(apps.map(app=>app.close()));redis?.disconnect();if(created)docker('rm','-f','-v',id);}
