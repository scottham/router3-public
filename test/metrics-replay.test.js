import assert from 'node:assert/strict';
import test from 'node:test';
import { replayedSamples } from '../ops/lib/replayed-samples.mjs';

const registry = () => { const samples = []; return { samples, add: (...s) => samples.push(s) }; };

// 2026-10-20: the exporter read balances and the block height over RPC on every
// 30 s scrape, a large share of the RPC plan's monthly allowance.
test('chain metrics are read once per interval and replayed into the scrapes between', async () => {
  let clock = 0, reads = 0;
  const onchain = replayedSamples(300000, async (m) => { reads++; m.add('router3_settler_mon', 'gauge', 'MON', 1.5 + reads); }, () => clock);
  const first = registry(); await onchain(first);
  for (clock = 30000; clock < 300000; clock += 30000) {
    const scrape = registry(); await onchain(scrape);
    assert.deepEqual(scrape.samples, first.samples, 'every scrape still exports the metric');
  }
  assert.equal(reads, 1, 'nine scrapes, one RPC read');
  clock = 300000; const later = registry(); await onchain(later);
  assert.equal(reads, 2);
  assert.equal(later.samples[0][3], 3.5);
});

test('a failed read caches nothing, so the next scrape retries', async () => {
  let fail = true, reads = 0;
  const onchain = replayedSamples(300000, async (m) => { reads++; if (fail) throw new Error('RPC down'); m.add('router3_chain_block', 'gauge', 'block', 7); }, () => 0);
  await assert.rejects(onchain(registry()), /RPC down/);
  fail = false;
  const scrape = registry(); await onchain(scrape);
  assert.equal(reads, 2);
  assert.equal(scrape.samples.length, 1);
});
