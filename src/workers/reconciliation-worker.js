import { sleep } from '../lib/sleep.js';
import { withJobLock } from '../lib/pg-job-lock.js';

// Housekeeping once a minute: requests whose API process died are closed
// (an x402 reservation expired by itself, nothing was charged; a pool request
// is charged its hold, as with unknown usage), and
// expired sign-in challenges and sessions are deleted.
export class ReconciliationWorker {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
  }

  async run(signal) {
    while (!signal.aborted) {
      await withJobLock(this.pool, 'router3-reconciler', async (db) => {
        const staleBefore = new Date(Date.now() - this.config.STALE_REQUEST_AFTER_SECONDS * 1000);
        const { rows: [{ lost }] } = await db.query('select private.recover_lost_x402_requests($1) lost', [staleBefore]);
        if (lost > 0) console.error(JSON.stringify({ level: 'warn', message: 'x402_requests_lost', requests: lost }));
        // Pool requests left running are charged their hold (usage unknown).
        const { rows: [{ pool }] } = await db.query('select private.recover_lost_pool_requests($1) pool', [staleBefore]);
        if (pool > 0) console.error(JSON.stringify({ level: 'warn', message: 'pool_requests_lost', requests: pool }));
        await db.query('select * from private.cleanup_expired_base_auth_data()');
      });
      await sleep(60000, signal);
    }
  }
}
