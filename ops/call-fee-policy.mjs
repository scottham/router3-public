// Called only by the operator bootstrap. Active requests retain the old ID.
export async function configureCallFeePolicy(db,env) {
  const bps=Number(env.CALL_SERVICE_FEE_BPS??100);
  if(!Number.isInteger(bps)||bps<0||bps>10000)throw new Error('INVALID_CALL_SERVICE_FEE_BPS');
  await db.query('begin');
  try {
    await db.query("select pg_advisory_xact_lock(hashtext('router3-call-fee-policy'))");
    let current=(await db.query('select * from private.call_fee_policies where effective_from<=now() order by effective_from desc limit 1')).rows[0];
    if(!current||current.service_fee_bps!==bps)current=(await db.query('insert into private.call_fee_policies(service_fee_bps) values($1) returning *',[bps])).rows[0];
    await db.query('commit');return {id:current.id,serviceFeeBps:bps};
  }catch(error){await db.query('rollback');throw error;}
}
