import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync,readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

/** Empty local database with real gateway migrations, never a copy of user data.
 * Temporary role names replace only the role references in the grant template.
 * No existing role/password, public endpoint or business database is modified.
 */
function localSupabaseServer() {
  // ROUTER3_ISOLATED_PG_URL points at any disposable local PostgreSQL superuser
  // (for example an embedded server) when the Supabase container is not running.
  const override=process.env.ROUTER3_ISOLATED_PG_URL;
  if(override) {
    const url=new URL(override);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'ROUTER3_ISOLATED_PG_URL must be local');
    return {host:url.hostname,port:Number(url.port||5432),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password)};
  }
  const [container]=JSON.parse(execFileSync('docker',['inspect','supabase_db_model-credit-gateway'],{encoding:'utf8'}));
  const env=Object.fromEntries(container.Config.Env.map(entry=>{const i=entry.indexOf('=');return [entry.slice(0,i),entry.slice(i+1)];}));
  const port=container.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort;assert.match(port??'',/^\d+$/);
  return {host:'127.0.0.1',port:Number(port),user:'postgres',password:env.POSTGRES_PASSWORD};
}

export async function createIsolatedGatewayDatabase({beforeMigration}={}) {
  const suffix=randomBytes(6).toString('hex');const database=`router3_vault_test_${suffix}`;
  const connection={...localSupabaseServer(),connectionTimeoutMillis:5000,statement_timeout:15000};
  const admin=new pg.Client({...connection,database:'postgres'});let created=false,db;
  const roles={},pools={},createdRoles=[],clientEnds=[],poolErrors=[];
  const runtimePool=options=>{
    const pool=new pg.Pool(options);
    // pg-pool.end can remove idle clients before their TCP/Backend end event.
    // Await actual closure before DROP DATABASE so FORCE cannot kill clients
    // still unwinding and emit an unhandled, credential-bearing error object.
    pool.on('connect',client=>clientEnds.push(new Promise(resolve=>client.once('end',resolve))));
    pool.on('error',error=>poolErrors.push(error.code??'ISOLATED_POOL_ERROR'));
    return pool;
  };
  const close=async()=>{
    await Promise.all(Object.values(pools).map(pool=>pool.end()));await Promise.all(clientEnds);await db?.end();
    if(created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    for(const role of createdRoles){await admin.query(`REVOKE "${role}" FROM postgres`);await admin.query(`DROP ROLE "${role}"`);}
    await admin.end();
    if(poolErrors.length)throw new Error(`ISOLATED_POOL_FAILURE:${poolErrors.join(',')}`);
  };
  try {
    await admin.connect();await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
    db=new pg.Client({...connection,database});await db.connect();
    // Minimal unused Supabase Auth dependencies for historical migrations. No
    // auth users are copied/created; the current Base Account identity path is used.
    await db.query(`CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,raw_app_meta_data jsonb,raw_user_meta_data jsonb,email text);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';`);
    const directory=new URL('../../supabase/migrations/',import.meta.url);
    const migrations=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort();
    for(const name of migrations) {
      if(beforeMigration)await beforeMigration(db,name);
      try {await db.query(readFileSync(new URL(name,directory),'utf8'));}
      catch(error){throw Object.assign(new Error('ISOLATED_MIGRATION_FAILED'),{code:error.code,migration:name});}
    }
    for(const kind of ['api','settler','reconciler']) {
      const role=`vault_test_${kind}_${suffix}`;roles[kind]=role;
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);createdRoles.push(role);
      await admin.query(`GRANT "${role}" TO postgres`);
    }
    const template=readFileSync(new URL('../../supabase/manual/create_backend_roles.sql.template',import.meta.url),'utf8');
    const start=template.indexOf('grant usage on schema public, private');assert.ok(start>0);
    let grants=template.slice(start).replace(/^alter role gateway_\w+ set [^;]+;\n/gm,'');
    for(const [kind,role] of Object.entries(roles)) grants=grants.replaceAll(new RegExp(`\\bgateway_${kind}\\b`,'g'),role);
    assert.doesNotMatch(grants,/\b(?:alter role|create role|password|connect on database)\b/i);
    await db.query(grants);
    for(const [kind,role] of Object.entries(roles)) pools[kind]=runtimePool({...connection,database,options:`-c role=${role}`,max:3});
    const createRuntimeRole = async kind => {
      assert.match(kind,/^[a-z][a-z0-9_]{0,24}$/); assert.equal(roles[kind],undefined);
      const role=`vault_test_${kind}_${suffix}`; roles[kind]=role;
      await admin.query(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`); createdRoles.push(role);
      await admin.query(`GRANT "${role}" TO postgres`);
      const pool=runtimePool({...connection,database,options:`-c role=${role}`,max:4}); pools[kind]=pool;
      return {role,pool};
    };
    return {admin:db,pools,migrationCount:migrations.length,createRuntimeRole,close};
  } catch(error) {await close();throw error;}
}
