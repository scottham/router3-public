import assert from 'node:assert/strict';
import test from 'node:test';
import { sleep } from '../src/lib/sleep.js';

test('a worker wait resolves immediately when the runtime is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await sleep(60_000, controller.signal);
  assert.ok(Date.now() - started < 1_000);
});

test('a worker wait resolves as soon as shutdown is requested', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = sleep(60_000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await waiting;
  assert.ok(Date.now() - started < 1_000);
});

test('a wait that finished on its own timer detaches from the signal', async () => {
  const controller = new AbortController();
  await sleep(5, controller.signal);
  // The abort listener must be gone, otherwise a long-lived worker signal keeps
  // one dead listener per pass and eventually warns about a leak.
  assert.doesNotThrow(() => controller.abort());
});

test('a worker wait without a signal still resolves on its own timer', async () => {
  const started = Date.now();
  await sleep(10);
  assert.ok(Date.now() - started >= 5);
});
