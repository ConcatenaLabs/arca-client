'use strict';
// ArcaRunner runs the Arca command-line client, `arca`, once per command, the
// way a user runs it, and hands back what it printed. It is the Sequentia
// rail's manager: the wallet library has no long-lived daemon on a desktop, so
// what is supervised here is each run of `arca`.
//
//   - One wallet directory, one command at a time. Commands queue and run in
//     order, so two runs never meet in one store.
//   - Every run has a deadline. A run past it is asked to stop (SIGTERM) and,
//     after a grace period, killed. A stop of the app waits for the run in
//     flight before it asks.
//   - No secret is ever an argument, which other users of the machine can
//     read: the node's password goes to `create` in its environment
//     (ARCA_NODE_PASSWORD), and a mnemonic to restore goes to it on its
//     standard input (`--mnemonic-file -`).
//
// `arca` prints JSON. A refusal prints {"error": {"kind", "message"}} (with the
// server's `code` and `status` when the server refused) and exits 1; the
// message is the wallet library's own words and is handed on untouched. What
// `arca` writes on its standard error ("arca: …" lines: the fee of each coin
// before a refresh signs, the witness and re-check on start) is kept as notes.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_LINES = 1000;

// Commands a run of `arca` takes, and the longest each may take. A sync tries
// an unreachable operator for about a minute before it gives up, then works on
// the chain; an exit may build and broadcast several transactions.
const DEADLINES_MS = {
  create: 180000, restore: 600000, sync: 900000, exit: 600000, participate: 300000,
  default: 180000,
};

class RunError extends Error {
  constructor(refusal, notes) {
    super(refusal.message);
    this.refusal = refusal; // {kind, message, code?, status?}
    this.notes = notes || [];
  }
}

// The answer of one run, from its exit status, its standard output and its
// standard error. Exported for the tests.
function parseRun(code, signal, stdout, stderr) {
  const notes = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^arca: /, ''));
  let json = null;
  const text = stdout.trim();
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  if (code === 0 && json !== null && !(json && json.error && Object.keys(json).length === 1)) {
    return { ok: true, result: json, notes };
  }
  if (json && json.error && typeof json.error.message === 'string') {
    // arca also writes the refusal on its standard error: it is the refusal,
    // not a note beside it.
    return { ok: false, refusal: json.error, notes: notes.filter((n) => n !== json.error.message) };
  }
  // Not an answer of the wallet's: the binary is missing, crashed, or was
  // stopped. Say exactly what happened.
  const why = signal ? `arca was stopped (${signal})` : `arca exited ${code} without an answer`;
  const tail = notes.slice(-3).join(' · ');
  return { ok: false, refusal: { kind: 'client', message: tail ? `${why}: ${tail}` : why }, notes };
}

class ArcaRunner {
  // opts: {bin, datadir, env?, deadlines?, onLog?(line), witnessPatience?}
  constructor(opts) {
    this.bin = opts.bin;
    this.datadir = opts.datadir;
    this.env = opts.env || {};
    this.deadlines = Object.assign({}, DEADLINES_MS, opts.deadlines || {});
    this.onLog = opts.onLog || null;
    this.witnessPatience = opts.witnessPatience || null;
    this.queue = Promise.resolve();
    this.current = null; // {proc, command, startedAt}
    this.pending = 0;
    this.stopping = false;
    this.logs = [];
    this.runs = 0;
  }

  log(line) {
    const l = `${new Date().toISOString()} ${line}`;
    this.logs.push(l);
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES);
    if (this.onLog) { try { this.onLog(l); } catch { /* the log is best effort */ } }
  }

  exists() {
    try { return fs.existsSync(path.join(this.datadir, 'arca.sqlite')) && fs.existsSync(path.join(this.datadir, 'mnemonic')); }
    catch { return false; }
  }

  status() {
    return {
      bin: this.bin, datadir: this.datadir, wallet: this.exists(),
      running: this.current ? { command: this.current.command, pid: this.current.proc.pid, since: this.current.startedAt } : null,
      queued: this.pending, runs: this.runs, stopping: this.stopping,
    };
  }

  // Runs `arca <args…>` after every run queued before it. `opts`: {stdin,
  // env, deadlineMs}. Resolves to {result, notes}; rejects with a RunError
  // carrying the refusal verbatim.
  run(args, opts = {}) {
    if (this.stopping) return Promise.reject(new RunError({ kind: 'client', message: 'the app is stopping: nothing more is run' }));
    this.pending += 1;
    const job = this.queue.then(() => { this.pending -= 1; return this._spawn(args, opts); });
    this.queue = job.catch(() => {});
    return job;
  }

  _spawn(args, opts) {
    if (this.stopping) return Promise.reject(new RunError({ kind: 'client', message: 'the app is stopping: nothing more is run' }));
    if (!this.bin || !fs.existsSync(this.bin)) {
      return Promise.reject(new RunError({ kind: 'client', message: `the arca client was not found at ${this.bin || '(unset)'}` }));
    }
    const command = args[0];
    const full = ['--datadir', this.datadir];
    if (this.witnessPatience) full.push('--witness-patience', String(this.witnessPatience));
    full.push(...args);
    const env = Object.assign({}, process.env, this.env, opts.env || {});
    // Nothing of the caller's own wallet settings leaks into a run.
    delete env.ARCA_DATADIR;
    if (!(opts.env && opts.env.ARCA_NODE_PASSWORD)) delete env.ARCA_NODE_PASSWORD;
    const deadline = opts.deadlineMs || this.deadlines[command] || this.deadlines.default;
    this.runs += 1;
    this.log(`run: arca ${redact(args).join(' ')}`);
    return new Promise((resolve, reject) => {
      const [exe, argv] = cleanSpawn(this.bin, full);
      const proc = spawn(exe, argv, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
      this.current = { proc, command, startedAt: Date.now() };
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => {
        stderr += d;
        for (const line of d.toString().split(/\r?\n/)) if (line.trim()) this.log(`${command}: ${line.trim()}`);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        this.log(`${command}: past its deadline of ${deadline} ms, asked to stop`);
        try { proc.kill('SIGTERM'); } catch { /* gone already */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone already */ } }, 5000).unref();
      }, deadline);
      proc.on('error', (e) => {
        clearTimeout(timer);
        this.current = null;
        reject(new RunError({ kind: 'client', message: `arca could not be run: ${e.message}` }));
      });
      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        this.current = null;
        const out = parseRun(code, signal, stdout, stderr);
        if (timedOut && !out.ok && out.refusal.kind === 'client') {
          out.refusal.message = `arca ${command} ran past its deadline (${Math.round(deadline / 1000)} s) and was stopped`;
        }
        this.log(`${command}: ${out.ok ? 'ok' : `refused (${out.refusal.kind}): ${out.refusal.message}`}`);
        if (out.ok) resolve({ result: out.result, notes: out.notes });
        else reject(new RunError(out.refusal, out.notes));
      });
      proc.stdin.on('error', () => { /* a run that does not read its input */ });
      proc.stdin.end(opts.stdin || '');
    });
  }

  // `create`: a new wallet, or one restored from `mnemonic`. The password and
  // the mnemonic never appear on the command line.
  async create({ server, nodeUrl, nodeUser, nodePassword, nodeCookie, mnemonic, exitDelayUnits }) {
    fs.mkdirSync(path.dirname(this.datadir), { recursive: true, mode: 0o700 });
    const args = ['create', '--server', server, '--node-url', nodeUrl];
    if (nodeCookie) args.push('--node-cookie', nodeCookie);
    else if (nodeUser) args.push('--node-user', nodeUser);
    if (exitDelayUnits) args.push('--exit-delay-units', String(exitDelayUnits));
    const env = {};
    if (nodePassword && !nodeCookie) env.ARCA_NODE_PASSWORD = nodePassword;
    let stdin = '';
    if (mnemonic) {
      args.push('--mnemonic-file', '-');
      stdin = mnemonic;
    }
    return this.run(args, { env, stdin });
  }

  // The mnemonic of the wallet, read from its directory, to show it once for
  // the user to write down.
  mnemonic() {
    return fs.readFileSync(path.join(this.datadir, 'mnemonic'), 'utf8').trim();
  }

  // Waits for the run in flight and every queued one to end, at most
  // `graceMs`, then asks the one still running to stop.
  async stop(graceMs = 20000) {
    this.stopping = true;
    const settled = this.queue.then(() => true);
    const done = await Promise.race([settled, new Promise((r) => setTimeout(() => r(false), graceMs))]);
    if (!done && this.current) {
      const { proc, command } = this.current;
      this.log(`${command}: still running at stop, asked to stop`);
      try { proc.kill('SIGTERM'); } catch { /* gone already */ }
      await Promise.race([settled, new Promise((r) => setTimeout(r, 5000))]);
      try { proc.kill('SIGKILL'); } catch { /* gone already */ }
    }
  }
}

// How a run is started. On Linux and macOS, through bash, which closes every
// descriptor above the three standard ones before it becomes arca: the app's
// own process holds files and sockets of its window that Chromium opened
// without close-on-exec, and a wallet process has no business holding them.
// (dash, often /bin/sh, cannot name a descriptor above 9.) Without bash, and
// on Windows, arca is started directly.
const BASH = ['/bin/bash', '/usr/bin/bash'].find((b) => { try { return fs.existsSync(b); } catch { return false; } });
function cleanSpawn(bin, args) {
  if (process.platform === 'win32' || !BASH) return [bin, args];
  const script = 'for p in /dev/fd/*; do n=${p##*/}; case $n in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null ;; esac; done; exec "$0" "$@"';
  return [BASH, ['-c', script, bin, ...args]];
}

// The arguments as logged: what follows a flag that names a secret is never
// written down (none should be on the command line, this is a second guard).
function redact(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (args[i] === '--mnemonic' && i + 1 < args.length) { out.push('[withheld]'); i++; }
  }
  return out;
}

module.exports = { ArcaRunner, RunError, parseRun, redact, cleanSpawn, DEADLINES_MS };
