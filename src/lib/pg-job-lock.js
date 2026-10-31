// Session locks coordinate replicas; financial SQL constraints and idempotency
// remain the authority even if a connection dies and releases its lock.
export async function withJobLock(pool,key,work) {
  const client=await pool.connect();let acquired=false,broken=false;
  const onError=()=>{broken=true;};client.on('error',onError);
  try {
    acquired=(await client.query('select pg_try_advisory_lock(hashtextextended($1,0)) locked',[key])).rows[0].locked;
    if(acquired)return await work(client);
  } finally {
    if(acquired&&!broken)try {await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[key]);}catch{broken=true;}
    client.off('error',onError);client.release(broken);
  }
}
