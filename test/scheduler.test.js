'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { SyncScheduler, DAY_MS } = require('../src/main/scheduler');

function runner(due) {
  const calls = [];
  return {
    calls, due,
    exists: () => true,
    run: async (args) => {
      calls.push(args[0]);
      if (args[0] === 'schedule') return { result: { now: 1, due: this_due(), next_sync_at: 2 } };
      return { result: { schedule: { now: 1, due: false, next_sync_at: 5 } }, notes: [] };
    },
  };
  function this_due() { return due.value; }
}

test('the first look of a run of the app syncs; then only when the schedule says so', async () => {
  const due = { value: false };
  const r = runner(due);
  const s = new SyncScheduler(r, { pollMs: 1e9 });
  s.enabled = true;
  await s.tick('the app started');
  assert.deepStrictEqual(r.calls, ['schedule', 'sync']);
  await s.tick();
  assert.deepStrictEqual(r.calls, ['schedule', 'sync', 'schedule'], 'not due: no sync');
  due.value = true;
  await s.tick();
  assert.deepStrictEqual(r.calls.slice(-2), ['schedule', 'sync'], 'due: a sync');
  assert.strictEqual(s.lastSync.ok, true);
  assert.strictEqual(s.lastSchedule.next_sync_at, 5, 'the schedule the sync left');
  s.stop();
});

test('a day since the last sync that succeeded, a sync whatever the schedule says', async () => {
  const r = runner({ value: false });
  const s = new SyncScheduler(r, { pollMs: 1e9 });
  s.enabled = true;
  s.lastSyncOkAt = Date.now() - DAY_MS - 1;
  await s.tick();
  assert.deepStrictEqual(r.calls, ['schedule', 'sync']);
  s.stop();
});

test('a refused sync is kept with its refusal, and the next look tries again', async () => {
  let n = 0;
  const r = { exists: () => true, run: async (a) => { if (a[0] === 'schedule') return { result: { due: true } }; n++; const e = new Error('x'); e.refusal = { kind: 'unreachable', message: 'the operator did not answer' }; throw e; } };
  const s = new SyncScheduler(r, { pollMs: 1e9 });
  s.enabled = true;
  await s.tick();
  await s.tick();
  assert.strictEqual(n, 2);
  assert.strictEqual(s.lastSync.ok, false);
  assert.strictEqual(s.lastSync.refusal.message, 'the operator did not answer');
  assert.strictEqual(s.history.length, 2);
  s.stop();
});

test('no wallet, no run', async () => {
  const calls = [];
  const s = new SyncScheduler({ exists: () => false, run: async (a) => { calls.push(a); return { result: {} }; } }, { pollMs: 1e9 });
  s.enabled = true;
  await s.tick('the app started');
  assert.deepStrictEqual(calls, []);
  s.stop();
});

test('a time the schedule named is kept, even when each look names a later one', async () => {
  // A coin handed to a refresh: every look names "an hour from now".
  let now = 1000;
  const calls = [];
  const r = {
    exists: () => true,
    run: async (a) => {
      calls.push(a[0]);
      if (a[0] === 'schedule') return { result: { now, due: false, next_sync_at: now + 3600 } };
      return { result: { schedule: { now, due: false, next_sync_at: now + 3600 } }, notes: [] };
    },
  };
  const s = new SyncScheduler(r, { pollMs: 1e9 });
  s.enabled = true;
  s.lastSyncOkAt = Date.now();
  await s.tick('the app started');            // syncs; the sync names 4600
  assert.strictEqual(s.target, 4600);
  now = 3000; await s.tick();                   // names 6600; 4600 is kept
  assert.strictEqual(s.target, 4600);
  assert.strictEqual(calls.filter((c) => c === 'sync').length, 1, 'not yet');
  now = 4600; await s.tick();                   // the chain reached the time named
  assert.strictEqual(calls.filter((c) => c === 'sync').length, 2);
  assert.strictEqual(s.lastSync.reason, 'due: the time the schedule named');
  assert.strictEqual(s.target, 8200, 'the sync named the next time afresh');
  s.stop();
});
