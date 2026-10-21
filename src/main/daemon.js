'use strict';
// A daemon the Deploy screen runs: an operator's server, its signer, its
// database, Bark's server or its watchman. Unlike a run of `arca`, a daemon
// lives on its own once started:
//
//   - It is started in a session of its own (detached), with its standard
//     output and error appended to its log file, so it keeps running when the
//     app quits, and an operator stays online while the window is closed. The
//     app finds it again at its next start by the PID it wrote down.
//   - The PID file names the binary as well as the PID, and a PID is taken as
//     the daemon's only while /proc says that process runs that binary, so a
//     PID the system gave to another program since is never signalled.
//   - It is stopped by the signal it shuts down cleanly on (arcad SIGINT,
//     arca-signer SIGTERM, PostgreSQL SIGINT, its fast shutdown), waited for,
//     and killed only when it has not exited by its grace period.
//   - It inherits none of Electron's descriptors: like every run of `arca`, it
//     is started through bash, which closes them before it becomes the daemon
//     (cleanSpawn).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { cleanSpawn } = require('./arca');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Whether process `pid` runs `bin`, as /proc says: its executable is that
// binary, or (a script run by its interpreter) its command line names it.
// null where /proc is not there (not Linux), which takes the PID as it is.
function procRuns(pid, bin) {
  let exe = null; let argv = null;
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); } catch { /* next */ }
  try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* none */ }
  if (exe === null && argv === null) return null;
  if (exe && path.basename(exe) === path.basename(bin)) return true;
  return !!(argv && argv.slice(0, 2).some((a) => a === bin));
}

// The last `n` lines of `file`, read from its end (a log may be large).
function tail(file, n = 200, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (len < size) lines.shift();
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

class Daemon {
  // opts: {name, bin, args, env?, cwd?, logFile, pidFile, stopSignal ('SIGINT'
  // or 'SIGTERM'), graceMs?, pidFromFile? (a file the daemon writes its own PID
  // in, first line: PostgreSQL's postmaster.pid)}
  constructor(opts) {
    Object.assign(this, { env: {}, graceMs: 60000, stopSignal: 'SIGTERM' }, opts);
  }

  // The running daemon's PID, or null.
  pid() {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')); } catch { rec = null; }
    let pid = rec && rec.pid;
    if (this.pidFromFile) {
      try { pid = Number(fs.readFileSync(this.pidFromFile, 'utf8').split('\n')[0]) || pid; } catch { /* not running, or never started */ }
    }
    if (!pid || !alive(pid)) return null;
    if (procRuns(pid, this.bin) === false) return null;
    return pid;
  }

  status() {
    const pid = this.pid();
    let since = null;
    try { since = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')).startedAt || null; } catch { /* none */ }
    return { name: this.name, running: !!pid, pid, since: pid ? since : null, log: this.logFile };
  }

  // Starts it unless it runs. Resolves once it has run for `settleMs` without
  // exiting; rejects with its last log lines when it exits before.
  async start(settleMs = 1500) {
    if (this.pid()) return this.pid();
    if (!this.bin || !fs.existsSync(this.bin)) throw new Error(`${this.name}: ${this.bin || 'its binary'} was not found`);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(this.pidFile), { recursive: true, mode: 0o700 });
    const out = fs.openSync(this.logFile, 'a', 0o600);
    const before = fs.fstatSync(out).size;
    fs.writeSync(out, `--- ${new Date().toISOString()} the app starts ${path.basename(this.bin)}\n`);
    const [exe, argv] = cleanSpawn(this.bin, this.args);
    const env = Object.assign({}, process.env, this.env);
    let child;
    try {
      child = spawn(exe, argv, { detached: true, stdio: ['ignore', out, out], env, cwd: this.cwd || undefined, windowsHide: true });
    } finally { fs.closeSync(out); }
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });
    child.on('error', (e) => { exited = { error: e.message }; });
    child.unref();
    const startedAt = Date.now();
    fs.writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid, bin: this.bin, startedAt }), { mode: 0o600 });
    const until = Date.now() + settleMs;
    while (Date.now() < until && !exited) await sleep(100);
    if (exited) {
      try { fs.unlinkSync(this.pidFile); } catch { /* gone */ }
      const lines = tail(this.logFile, 8).filter((l) => !l.startsWith('---'));
      const how = exited.error ? `could not be run: ${exited.error}` : exited.signal ? `was stopped (${exited.signal})` : `exited ${exited.code}`;
      const err = new Error(`${this.name} ${how}${lines.length ? `: ${lines.join(' · ')}` : ''}`);
      err.logFrom = before;
      throw err;
    }
    return child.pid;
  }

  // Stops it with its signal, waits up to its grace period, then kills it.
  // Resolves to what happened.
  async stop() {
    const pid = this.pid();
    if (!pid) { try { fs.unlinkSync(this.pidFile); } catch { /* gone */ } return { name: this.name, was: 'not running' }; }
    try { process.kill(pid, this.stopSignal); } catch { /* gone already */ }
    const until = Date.now() + this.graceMs;
    while (Date.now() < until && alive(pid)) await sleep(200);
    let how = `stopped (${this.stopSignal})`;
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      how = `killed after ${Math.round(this.graceMs / 1000)} s without stopping on ${this.stopSignal}`;
      const until2 = Date.now() + 10000;
      while (Date.now() < until2 && alive(pid)) await sleep(200);
    }
    try { fs.unlinkSync(this.pidFile); } catch { /* gone */ }
    try { fs.appendFileSync(this.logFile, `--- ${new Date().toISOString()} the app ${how.split(' ')[0]} it\n`); } catch { /* best effort */ }
    return { name: this.name, was: how, pid };
  }

  // Sends SIGHUP: arcad reads its configuration again.
  hangup() {
    const pid = this.pid();
    if (!pid) throw new Error(`${this.name} is not running`);
    process.kill(pid, 'SIGHUP');
    return pid;
  }

  log(n = 200) { return tail(this.logFile, n); }
}

module.exports = { Daemon, tail, alive, procRuns, sleep };
