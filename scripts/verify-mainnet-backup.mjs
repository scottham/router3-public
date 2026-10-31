import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
// Restores the newest backup into a throwaway database and checks the channel
// ledger is intact. The production database is never touched.
const file=readdirSync('backups').filter(n=>n.startsWith('router3-mainnet-')&&n.endsWith('.dump')).sort().at(-1);
if(!file)throw new Error('MAINNET_BACKUP_REQUIRED');
const database=`router3_restore_check_${randomBytes(6).toString('hex')}`;
const prefix=['compose','--env-file','.env.mainnet-local','-f','docker-compose.production.yml','exec','-T','db'];
const run=(args,input)=>execFileSync('docker',[...prefix,...args],{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:8*1024*1024});
let created=false;
try {
  run(['createdb','-U','postgres',database]);created=true;
  run(['pg_restore','-U','postgres','-d',database,'--no-owner','--no-privileges','--exit-on-error'],readFileSync(`backups/${file}`));
  const result=JSON.parse(run(['psql','-U','postgres','-d',database,'-At','-v','ON_ERROR_STOP=1'],
    `select json_build_object('channels',(select count(*) from private.x402_channels),'requests',(select count(*) from private.x402_requests),
      'settlements',(select count(*) from private.x402_settlements),'users',(select count(*) from public.app_users),
      'priceVersions',(select count(*) from private.model_price_versions),
      'chargedNotClaimed',(select coalesce(sum(charged_cumulative_atomic-total_claimed_atomic),0)::text from private.x402_channels));`).trim());
  assert.ok(result.priceVersions>0);
  console.log(JSON.stringify({backup:file,restoreVerified:true,...result,productionDatabaseUntouched:true}));
}finally{if(created)run(['dropdb','-U','postgres',database]);}
