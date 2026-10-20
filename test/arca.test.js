'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArcaRunner, parseRun } = require('../src/main/arca');

const FAKE = path.join(__dirname, 'fixtures', 'fake-arca.js');
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-client-test-'));
  const log = path.join(dir, 'runs.log');
  const r = new ArcaRunner({ bin: FAKE, datadir: path.join(dir, 'wallet'), env: { FAKE_ARCA_LOG: log } });
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, r, runs, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('parseRun: an answer, a refusal verbatim, and a run that gave no answer', () => {
  const ok = parseRun(0, null, '{"a": 1}', 'arca: a note\n');
  assert.deepStrictEqual(ok, { ok: true, result: { a: 1 }, notes: ['a note'] });
  const msg = 'refused: a board of 500 is below the server\'s smallest leaf in asset 7506, 1000';
  const no = parseRun(1, null, JSON.stringify({ error: { kind: 'refused', message: msg } }), `arca: ${msg}\n`);
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.refusal.message, msg, 'the wallet\'s words, untouched');
  const crash = parseRun(101, null, '', 'thread main panicked at x\n');
  assert.strictEqual(crash.ok, false);
  assert.strictEqual(crash.refusal.kind, 'client');
  assert.match(crash.refusal.message, /exited 101 without an answer: thread main panicked/);
  assert.match(parseRun(null, 'SIGTERM', '', '').refusal.message, /stopped \(SIGTERM\)/);
});

test('every run names the wallet directory, and a refusal keeps the server\'s code', async () => {
  const t = fresh();
  try {
    const out = await t.r.run(['info']);
    assert.deepStrictEqual(out.result, { cmd: 'info', rest: ['info'] });
    assert.deepStrictEqual(t.runs()[0].args.slice(0, 2), ['--datadir', t.r.datadir]);
    await assert.rejects(t.r.run(['send', 'arca:00']), (e) => {
      assert.strictEqual(e.refusal.code, 'key_reused');
      assert.strictEqual(e.refusal.status, 409);
      assert.match(e.refusal.message, /^the server refused cosign_transfer \(409 key_reused\)/);
      return true;
    });
  } finally { t.done(); }
});

test('runs never overlap: one wallet directory, one run at a time, in order', async () => {
  const t = fresh();
  try {
    await Promise.all([t.r.run(['slow', '250']), t.r.run(['slow', '50']), t.r.run(['info'])]);
    const runs = t.runs();
    assert.deepStrictEqual(runs.map((x) => x.cmd), ['slow', 'slow', 'info']);
    for (let i = 1; i < runs.length; i++) assert.ok(runs[i].start >= runs[i - 1].end, `run ${i} started before run ${i - 1} ended`);
  } finally { t.done(); }
});

test('create: the password goes in the environment and the mnemonic on stdin, never in the arguments', async () => {
  const t = fresh();
  const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  try {
    await t.r.create({ server: 'http://127.0.0.1:1', nodeUrl: 'http://127.0.0.1:2/', nodeUser: 'u', nodePassword: 's3cret-pw', mnemonic: words });
    const [run] = t.runs();
    assert.strictEqual(run.password, 's3cret-pw');
    assert.strictEqual(run.stdin, words);
    const argv = run.args.join(' ');
    assert.ok(!argv.includes('s3cret-pw') && !argv.includes('legal winner'), argv);
    assert.deepStrictEqual(run.args.slice(run.args.indexOf('--mnemonic-file'), run.args.indexOf('--mnemonic-file') + 2), ['--mnemonic-file', '-']);
    // The password reaches `create` alone.
    await t.r.run(['info']);
    assert.strictEqual(t.runs()[1].password, null);
    assert.strictEqual(t.r.mnemonic(), words);
    assert.ok(t.r.exists());
  } finally { t.done(); }
});

test('a run past its deadline is stopped and says so', async () => {
  const t = fresh();
  try {
    await assert.rejects(t.r.run(['hang'], { deadlineMs: 300 }), /ran past its deadline/);
    const out = await t.r.run(['info']);
    assert.strictEqual(out.result.cmd, 'info', 'the queue goes on after a stopped run');
  } finally { t.done(); }
});

test('a crash is a refusal of the client, with what it wrote', async () => {
  const t = fresh();
  try {
    await assert.rejects(t.r.run(['crash']), (e) => { assert.strictEqual(e.refusal.kind, 'client'); assert.match(e.message, /panicked/); return true; });
  } finally { t.done(); }
});

test('a stop waits for the run in flight, and runs nothing after', async () => {
  const t = fresh();
  try {
    const p = t.r.run(['slow', '300']);
    await new Promise((r) => setTimeout(r, 50));
    await t.r.stop(5000);
    assert.deepStrictEqual((await p).result, { slept: true }, 'the run in flight finished');
    await assert.rejects(t.r.run(['info']), /stopping/);
  } finally { t.done(); }
});

test('a missing client is said plainly', async () => {
  const r = new ArcaRunner({ bin: '/nonexistent/arca', datadir: '/nonexistent/w' });
  await assert.rejects(r.run(['info']), /not found at \/nonexistent\/arca/);
});

test('a run holds none of the app\'s open descriptors', { skip: process.platform === 'win32' }, () => {
  // Electron holds files without close-on-exec (its V8 snapshot among them),
  // which a plain spawn passes on to every child.
  const { spawnSync } = require('child_process');
  const electron = require('electron');
  const report = (mode) => {
    const r = spawnSync(electron, [path.join(__dirname, 'fixtures', 'report-fds.js'), mode].filter(Boolean),
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    return JSON.parse(r.stdout).filter(Boolean);
  };
  const snapshot = (fds) => fds.filter((f) => /v8_context_snapshot|snapshot_blob/.test(f));
  assert.ok(snapshot(report('direct')).length > 0, 'the control: a plain spawn from Electron passes its files on');
  const managed = report(null);
  assert.deepStrictEqual(snapshot(managed), [], 'the run holds none of them');
  assert.ok(managed.every((f) => /^(socket|pipe|anon_inode):|^\/dev\/null$/.test(f) || !f.startsWith('/')), `the run holds no file of the app's: ${managed}`);
});

test('arguments pass through the shell untouched', { skip: process.platform === 'win32' }, async () => {
  const t = fresh();
  try {
    const odd = ['a b', '$HOME', '`x`', '"q"', "'s'", '; rm -rf /', '--x=1'];
    const { result } = await t.r.run(['echo', ...odd]);
    assert.deepStrictEqual(result.rest, ['echo', ...odd]);
  } finally { t.done(); }
});
