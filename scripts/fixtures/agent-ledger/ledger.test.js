import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.js';

test('mint and transfer', () => {
  const l = new Ledger();
  l.transfer('mint', 'alice', 1000);
  l.transfer('alice', 'bob', 300);
  assert.equal(l.balance('alice'), 700);
  assert.equal(l.balance('bob'), 300);
});

test('history pages are 1-based, newest first', () => {
  const l = new Ledger();
  for (let i = 1; i <= 12; i++) l.transfer('mint', 'alice', i);
  assert.deepEqual(l.history('alice', 1, 5).map(e => e.amount), [12, 11, 10, 9, 8]);
  assert.deepEqual(l.history('alice', 3, 5).map(e => e.amount), [2, 1]);
});

test('split never loses or invents cents', () => {
  const l = new Ledger();
  l.transfer('mint', 'alice', 100);
  l.split('alice', ['a', 'b', 'c'], 100);
  assert.deepEqual(['a', 'b', 'c'].map(x => l.balance(x)), [34, 33, 33]);
  assert.equal(l.balance('alice'), 0);
});

test('zero and fractional amounts are rejected', () => {
  const l = new Ledger();
  assert.throws(() => l.transfer('mint', 'a', 0), RangeError);
  assert.throws(() => l.transfer('mint', 'a', 1.5), RangeError);
});

test('a transfer can be reversed only once', () => {
  const l = new Ledger();
  l.transfer('mint', 'alice', 100);
  const id = l.transfer('alice', 'bob', 40);
  l.reverse(id);
  assert.equal(l.balance('alice'), 100);
  assert.throws(() => l.reverse(id), /already reversed/);
});
