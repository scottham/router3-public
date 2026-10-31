import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
const stamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
mkdirSync('backups',{recursive:true,mode:0o700});
const target=`backups/router3-mainnet-${stamp}.dump`,tmp=target+'.partial';
const fd=openSync(tmp,'wx',0o600);
try {
  const code=await new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--env-file','.env.mainnet-local','-f','docker-compose.production.yml','exec','-T','db',
      'pg_dump','-U','postgres','-d','router3','--format=custom'],{stdio:['ignore',fd,'pipe']});
    child.stderr.resume();child.once('error',reject);child.once('exit',resolve);
  });
  if(code!==0)throw new Error('MAINNET_BACKUP_FAILED');
  fsyncSync(fd);closeSync(fd);renameSync(tmp,target);
  console.log(JSON.stringify({backup:target,includes:'Accounting, identities, price versions, settlement nonce and signed-transaction journal',
    alsoPreservePrivately:['.env.mainnet-local','.secrets/monad-settler.key','deployments/monad-mainnet-prepaid-pool.json','.state']}));
} catch(error) {try{closeSync(fd);}catch{}try{unlinkSync(tmp);}catch{}throw error;}
