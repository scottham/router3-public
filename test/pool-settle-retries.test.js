// A settle batch the signer cannot send: refused for good (the signer's own
// policy, or the contract reverting on simulation) it fails at once with the
// reason; failing for other causes it is retried on the wallet's backoff and
// given up after a while. Either way its charges go back to the unbatched set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryPoolStore } from '../src/pool/store.js';
import { PoolWorker } from '../src/workers/pool-worker.js';
import { simulationError } from '../src/signing/pool-tx-signer.js';

const PAYER = '0x00000000000000000000000000000000000000a1';
const quiet = () => { const original = console.error; console.error = () => {}; return () => { console.error = original; }; };

async function setup({ submit }) {
  const store = new InMemoryPoolStore();
  await store.ensureAccount(PAYER);
  const request = await store.withAccount(PAYER, (tx) => tx.insertRequest({ status: 'completed', charged_atomic: 5000n, completed_at: new Date() }));
  const batch = await store.withAccount(PAYER, async (tx) => {
    const b = await tx.insertBatch({ batch_key: `0x${'11'.repeat(32)}`, claim_key: `0x${'22'.repeat(32)}`, debit_atomic: 5000n, refill_atomic: 0n, usage_root: `0x${'33'.repeat(32)}` });
    await tx.attach(b.id, [request.id]);
    return b;
  });
  let clock = Date.parse('2026-10-28T00:00:00Z');
  const sent = [];
  const worker = new PoolWorker({ store, chain: {}, config: {}, sender: { async submit(body) { sent.push(body); return submit(body); } }, now: () => new Date(clock) });
  return { store, batch, request, worker, sent, tick: (ms) => { clock += ms; } };
}

test('a simulation revert fails the batch at once with the contract error name and frees its charges', async () => {
  const restore = quiet();
  try {
    const { store, batch, request, worker, sent } = await setup({ submit: () => { throw Object.assign(new Error('SIGNER_SIMULATION_REVERTED'), { code: 'SIGNER_SIMULATION_REVERTED', reason: 'InvalidSettlement' }); } });
    await worker.resubmitPlanned();
    assert.equal(sent.length, 1);
    assert.equal(store.batches.get(batch.id).state, 'failed');
    assert.equal(store.batches.get(batch.id).error_code, 'POOL_SETTLE_REVERTED:InvalidSettlement');
    assert.equal(store.requests.get(request.id).batch_id, null, 'the charge is unbatched again');
    assert.equal((await store.account(PAYER)).collection_failures, 1);
    await worker.resubmitPlanned();
    assert.equal(sent.length, 1, 'a failed batch is not sent again');
  } finally { restore(); }
});

test('a retryable failure waits for the wallet backoff and gives up after the limit', async () => {
  const restore = quiet();
  try {
    const { store, batch, request, worker, sent, tick } = await setup({ submit: () => { throw Object.assign(new Error('SIGNER_GAS_BUDGET_OR_BALANCE'), { code: 'SIGNER_GAS_BUDGET_OR_BALANCE' }); } });
    await worker.resubmitPlanned();
    await worker.resubmitPlanned();
    assert.equal(sent.length, 1, 'inside the backoff nothing is resent');
    assert.equal(store.batches.get(batch.id).state, 'planned');
    for (let i = 1; i < PoolWorker.MAX_SEND_FAILURES; i++) {
      tick(worker.backoffMs(i) + 1);
      await worker.resubmitPlanned();
    }
    assert.equal(sent.length, PoolWorker.MAX_SEND_FAILURES);
    assert.equal(store.batches.get(batch.id).state, 'failed');
    assert.equal(store.batches.get(batch.id).error_code, 'POOL_SETTLE_GAVE_UP:SIGNER_GAS_BUDGET_OR_BALANCE');
    assert.equal(store.requests.get(request.id).batch_id, null);
    assert.equal((await store.account(PAYER)).collection_failures, PoolWorker.MAX_SEND_FAILURES);
  } finally { restore(); }
});

test('the signer names the pool error behind a gas-estimation revert, and leaves other failures alone', () => {
  const reverted = simulationError(Object.assign(new Error('execution reverted (unknown custom error)'), { code: 'CALL_EXCEPTION', data: '0x115931c4' }));
  assert.equal(reverted.code, 'SIGNER_SIMULATION_REVERTED');
  assert.equal(reverted.reason, 'InvalidSettlement');
  assert.equal(reverted.statusCode, 409);
  const named = simulationError(Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', reason: 'DailyLimitExceeded', data: '0x' }));
  assert.equal(named.reason, 'DailyLimitExceeded');
  const foreign = simulationError(Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0xdeadbeef' }));
  assert.equal(foreign.reason, 'selector 0xdeadbeef');
  const network = Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
  assert.equal(simulationError(network), network);
});
