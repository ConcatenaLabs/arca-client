#!/usr/bin/env node
'use strict';
// A stand-in for the arca client in the app's tests. It records each run
// (its arguments, whether it saw a node password, what came on its standard
// input) in FAKE_ARCA_LOG, one JSON line per run, and answers as arca does:
// JSON on stdout, a refusal as {"error"} with exit status 1, notes on stderr.
const fs = require('fs');
const args = process.argv.slice(2);
const i = args.indexOf('--datadir');
const datadir = i >= 0 ? args[i + 1] : null;
let rest = args.slice(i >= 0 ? i + 2 : 0);
if (rest[0] === '--witness-patience') rest = rest.slice(2);
const cmd = rest[0];
const stdin = (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } })();
const log = process.env.FAKE_ARCA_LOG;
const start = Date.now();
function record(extra) {
  if (log) fs.appendFileSync(log, JSON.stringify(Object.assign({ args, cmd, start, end: Date.now(), password: process.env.ARCA_NODE_PASSWORD || null, stdin }, extra)) + '\n');
}
function answer(v) { record({}); process.stdout.write(JSON.stringify(v, null, 2) + '\n'); process.exit(0); }
function refuse(kind, message, extra) { record({}); process.stdout.write(JSON.stringify({ error: Object.assign({ kind, message }, extra || {}) }) + '\n'); process.stderr.write(`arca: ${message}\n`); process.exit(1); }
const sleep = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* busy wait: no timers in a sync script */ } };

switch (cmd) {
  case 'create':
    fs.mkdirSync(datadir, { recursive: true });
    fs.writeFileSync(`${datadir}/mnemonic`, stdin.trim() || 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    fs.writeFileSync(`${datadir}/arca.sqlite`, '');
    process.stderr.write('arca: compare the operator key aa with the one the operator publishes\n');
    return answer({ operator: 'aa'.repeat(32), operator_key_check: 'compare the operator key', restore: stdin ? { served: 0, not_recovered: [] } : undefined });
  case 'slow': sleep(Number(rest[1] || 300)); return answer({ slept: true });
  case 'hang': sleep(60000); return answer({});
  case 'crash': process.stderr.write('thread main panicked at somewhere\n'); process.exit(101); break;
  case 'fds': return answer({ fds: fs.readdirSync('/proc/self/fd').map((n) => { try { return fs.readlinkSync(`/proc/self/fd/${n}`); } catch { return null; } }) });
  case 'schedule': return answer({ now: 100, due: process.env.FAKE_DUE === '1', next_sync_at: 200, coins: [] });
  case 'sync': return answer({ schedule: { now: 100, due: false, next_sync_at: 300, coins: [] } });
  case 'board': return refuse('refused', `refused: a board of ${rest[2]} is below the server's smallest leaf in asset ${rest[1]}, 1000`);
  case 'send': return refuse('server', 'the server refused cosign_transfer (409 key_reused): an output\'s key already owns a leaf', { code: 'key_reused', status: 409 });
  default: return answer({ cmd, rest });
}
