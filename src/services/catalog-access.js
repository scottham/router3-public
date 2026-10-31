// Access probes send one request per model, so their verdicts are kept and only
// models never seen, or last checked more than maxAgeSeconds ago, are probed
// again. force re-probes everything (operator recheck).
export async function cachedAccess(client,provider,ids,probe,{maxAgeSeconds=604800,force=false}={}) {
  const {rows}=await client.query(`select model,usable from private.catalog_model_access
    where provider=$1 and model=any($2::text[]) and checked_at>now()-make_interval(secs=>$3)`,[provider,ids,maxAgeSeconds]);
  const known=force?new Map():new Map(rows.map(r=>[r.model,r.usable]));
  const stale=ids.filter(id=>!known.has(id));
  if(stale.length) {
    const usable=await probe(stale);
    for(const id of stale)known.set(id,usable.has(id));
    await client.query(`insert into private.catalog_model_access(provider,model,usable)
      select $1,m,u from unnest($2::text[],$3::boolean[]) as t(m,u)
      on conflict(provider,model) do update set usable=excluded.usable,checked_at=now()`,[provider,stale,stale.map(id=>known.get(id))]);
  }
  return new Set(ids.filter(id=>known.get(id)));
}

export function accessOptions(env) {
  const maxAgeSeconds=Number(env.CATALOG_ACCESS_CHECK_SECONDS??604800);
  if(!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<3600)throw new Error('INVALID_CATALOG_ACCESS_CHECK_SECONDS');
  return {maxAgeSeconds,force:env.CATALOG_RECHECK_ACCESS==='true'};
}
