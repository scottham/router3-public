// Channel storage for the x402 batch-settlement scheme, backed by Postgres.
// The SDK's `ChannelStorage` contract: `updateChannel` reads the current record
// and writes the callback's result atomically; returning the same object leaves
// it unchanged, `undefined` deletes it. A row lock inside one transaction gives
// that guarantee across every API replica, and the record lives next to the
// ledger it backs instead of in a cache.
const CHANNEL_ID=/^0x[0-9a-f]{64}$/;
export const normalizeChannelId=id=>{
  const value=String(id??'').toLowerCase();
  if(!CHANNEL_ID.test(value))throw new Error('X402_CHANNEL_ID_INVALID');
  return value;
};
const columns=channel=>[channel.channelConfig.payer.toLowerCase(),channel.channelConfig.payerAuthorizer.toLowerCase(),
  channel.chargedCumulativeAmount,channel.signedMaxClaimable,channel.balance,channel.totalClaimed,
  Number(channel.withdrawRequestedAt??0),channel.lastRequestTimestamp?new Date(channel.lastRequestTimestamp):null];

export class PgChannelStorage {
  constructor(pool){this.pool=pool;}
  async get(channelId) {
    const {rows:[row]}=await this.pool.query('select state from private.x402_channels where channel_id=$1',[normalizeChannelId(channelId)]);
    return row?.state;
  }
  async list() {
    const {rows}=await this.pool.query('select state from private.x402_channels order by channel_id');
    return rows.map(r=>r.state);
  }
  async updateChannel(channelId,update) {
    const key=normalizeChannelId(channelId);
    const client=await this.pool.connect();
    try {
      await client.query('begin');
      const {rows:[row]}=await client.query('select state from private.x402_channels where channel_id=$1 for update',[key]);
      const current=row?.state;
      const next=update(current);
      let result;
      if(next===current)result={channel:current,status:'unchanged'};
      else if(!next) {
        if(current)await client.query('delete from private.x402_channels where channel_id=$1',[key]);
        result={channel:undefined,status:current?'deleted':'unchanged'};
      } else {
        await client.query(`insert into private.x402_channels(channel_id,state,payer,payer_authorizer,charged_cumulative_atomic,signed_max_claimable_atomic,
            balance_atomic,total_claimed_atomic,withdraw_requested_at,last_request_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          on conflict(channel_id) do update set state=excluded.state,payer=excluded.payer,payer_authorizer=excluded.payer_authorizer,
            charged_cumulative_atomic=excluded.charged_cumulative_atomic,signed_max_claimable_atomic=excluded.signed_max_claimable_atomic,
            balance_atomic=excluded.balance_atomic,total_claimed_atomic=excluded.total_claimed_atomic,
            withdraw_requested_at=excluded.withdraw_requested_at,last_request_at=excluded.last_request_at`,
        [key,JSON.stringify({...next,channelId:key}),...columns(next)]);
        result={channel:next,status:'updated'};
      }
      await client.query('commit');
      return result;
    } catch(error) {await client.query('rollback').catch(()=>{});throw error;}
    finally {client.release();}
  }
}
