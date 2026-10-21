'use strict';
// The Deploy screen's side of the main process: an Arca operator on Sequentia
// and a Bitcoin ark, each run by the app on the runner's machine, under the
// profile's home:
//
//   <home>/deploy/postgres/   the database cluster both keep their state in
//   <home>/deploy/sequentia/  the Arca operator (operator.js)
//   <home>/deploy/bitcoin/    the Bitcoin ark (ark-server.js)
//
// One action at a time: a start, a stop or a backup runs to its end before the
// next begins, so two never meet in one directory. The daemons outlive the
// app; quitting it stops none of them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Postgres, findPostgres } = require('./postgres');
const { SequentiaOperator, defaultSettings } = require('./operator');
const { BitcoinArk, checkArkSettings, defaultArkSettings } = require('./ark-server');

function defaultDeploy() {
  return {
    postgresBin: '',
    pgPort: 25432,
    backupDir: '',
    sequentia: defaultSettings(),
    bitcoin: defaultArkSettings(),
  };
}

const MASK = '••••';
function masked(s) {
  const out = JSON.parse(JSON.stringify(s));
  if (out.sequentia && out.sequentia.node && out.sequentia.node.password) out.sequentia.node.password = MASK;
  if (out.bitcoin && out.bitcoin.bitcoind && out.bitcoin.bitcoind.password) out.bitcoin.bitcoind.password = MASK;
  return out;
}

// A daemon's binary, installed into the profile before it runs: a release
// carries the daemons inside its AppImage, whose mount goes away when the app
// quits, and a daemon still running from it then dies the first time it pages
// in code from a file that is no longer there. Each binary is copied, once,
// under the first 16 hex characters of its SHA-256, so a newer app installs
// beside it and never over a file a running daemon uses.
function installBinary(src, binDir) {
  if (!src || !fs.existsSync(src)) return src;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16);
  const dir = path.join(binDir, sha);
  const dest = path.join(dir, path.basename(src));
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o700);
    fs.renameSync(tmp, dest);
  }
  return dest;
}

class Deploy {
  // opts: {home, settings() (the saved deploy settings), save(settings),
  // bins: {arcad, signer, captaind, watchmand}}
  constructor(opts) {
    this.home = path.join(opts.home, 'deploy');
    this.getSettings = opts.settings;
    this.saveSettings = opts.save;
    this.carried = opts.bins;
    this.installed = null;
    this.queue = Promise.resolve();
    this.busy = null;
  }

  settings() {
    const d = defaultDeploy();
    const s = this.getSettings() || {};
    return Object.assign(d, s, {
      sequentia: Object.assign(d.sequentia, s.sequentia || {}, { node: Object.assign(d.sequentia.node, (s.sequentia && s.sequentia.node) || {}) }),
      bitcoin: Object.assign(d.bitcoin, s.bitcoin || {}, { bitcoind: Object.assign(d.bitcoin.bitcoind, (s.bitcoin && s.bitcoin.bitcoind) || {}) }),
    });
  }

  // The daemons' binaries, installed into the profile the first time they are
  // needed (installBinary).
  get bins() {
    if (!this.installed) {
      const dir = path.join(this.home, 'bin');
      this.installed = Object.fromEntries(Object.entries(this.carried).map(([k, v]) => [k, installBinary(v, dir)]));
    }
    return this.installed;
  }

  pgBin() { return findPostgres(this.settings().postgresBin || null); }

  backupDir() { return this.settings().backupDir || path.join(this.home, 'backup'); }

  pg() {
    const s = this.settings();
    return new Postgres({ home: path.join(this.home, 'postgres'), binDir: this.pgBin(), port: Number(s.pgPort), backupDir: this.backupDir() });
  }
  // An operator's manager. `run` names whether it is to start anything, and so
  // needs the installed binaries; reading its state needs none.
  seq(run = false) { const b = run ? this.bins : this.carried; return new SequentiaOperator({ dir: path.join(this.home, 'sequentia'), bins: { arcad: b.arcad, signer: b.signer }, pg: this.pg() }); }
  ark(run = false) { const b = run ? this.bins : this.carried; return new BitcoinArk({ dir: path.join(this.home, 'bitcoin'), bins: { captaind: b.captaind, watchmand: b.watchmand }, pg: this.pg() }); }

  // Settings from the window: a password shown masked is the one kept.
  save(next) {
    const cur = this.settings();
    const n = Object.assign({}, cur, next || {});
    if (next && next.sequentia) {
      n.sequentia = Object.assign({}, cur.sequentia, next.sequentia, { node: Object.assign({}, cur.sequentia.node, next.sequentia.node || {}) });
      if (n.sequentia.node.password === MASK) n.sequentia.node.password = cur.sequentia.node.password;
    }
    if (next && next.bitcoin) {
      n.bitcoin = Object.assign({}, cur.bitcoin, next.bitcoin, { bitcoind: Object.assign({}, cur.bitcoin.bitcoind, next.bitcoin.bitcoind || {}) });
      if (n.bitcoin.bitcoind.password === MASK) n.bitcoin.bitcoind.password = cur.bitcoin.bitcoind.password;
    }
    const port = Number(n.pgPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('the database port is 1024 to 65535');
    if (port !== Number(cur.pgPort) && this.pg().initialised()) throw new Error('the database exists already: its port stays as it was made');
    n.pgPort = port;
    if (n.backupDir && !path.isAbsolute(n.backupDir)) throw new Error('name the backup directory by its absolute path');
    this.saveSettings(n);
    return n;
  }

  // Runs `fn` after every action before it.
  act(name, fn) {
    const job = this.queue.then(async () => {
      this.busy = { name, since: Date.now() };
      try { return await fn(); } finally { this.busy = null; }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  status() {
    const pg = this.pg();
    const s = this.settings();
    return {
      settings: masked(s), busy: this.busy, home: this.home, backupDir: this.backupDir(),
      binaries: Object.fromEntries(Object.entries(this.carried).map(([k, v]) => [k, v && fs.existsSync(v) ? v : null])),
      postgres: Object.assign(pg.status(), { found: this.pgBin(), initialised: pg.initialised() }),
      sequentia: this.seq().status(),
      bitcoin: this.ark().status(),
    };
  }

  // Stops the database once neither side runs on it.
  async stopDbIfIdle() {
    const up = [...this.seq().status().daemons, ...this.ark().status().daemons].some((d) => d.running);
    if (up) return null;
    return this.pg().stop();
  }

  async run(action, a = {}) {
    const s = this.settings();
    switch (action) {
      case 'save': return this.save(a);
      case 'seq-test-node': return this.seq().checkNode(s.sequentia.node);
      case 'seq-create': return this.act(action, () => this.seq(true).create(s.sequentia));
      case 'seq-start': return this.act(action, () => this.seq(true).start(s.sequentia));
      case 'seq-stop': return this.act(action, async () => { const r = await this.seq().stop(); const db = await this.stopDbIfIdle(); return { stopped: r, database: db }; });
      case 'seq-reload': return this.act(action, () => this.seq(true).reload(s.sequentia));
      case 'seq-info': return this.seq().info(s.sequentia);
      case 'seq-address': return this.act(action, () => this.seq(true).fundingAddress());
      case 'ark-test-core': return this.ark().checkCore(checkArkSettings(s.bitcoin));
      case 'ark-create': return this.act(action, () => this.ark(true).create(s.bitcoin));
      case 'ark-start': return this.act(action, () => this.ark(true).start(s.bitcoin));
      case 'ark-stop': return this.act(action, async () => { const r = await this.ark().stop(); const db = await this.stopDbIfIdle(); return { stopped: r, database: db }; });
      case 'ark-info': return this.ark().info(s.bitcoin);
      case 'ark-wallet': return this.ark(true).wallet(s.bitcoin);
      case 'logs': return Object.assign({ postgres: this.pg().daemon.log(Number(a.lines) || 200) }, this.seq().logs(Number(a.lines) || 200), this.ark().logs(Number(a.lines) || 200));
      case 'backup': return this.act(action, () => this.backup());
      default: throw new Error(`no such action: ${action}`);
    }
  }

  // A backup into the backup directory: each side's secrets and
  // configuration, and a base backup of the database, which the WAL archived
  // there since completes.
  async backup() {
    const dir = this.backupDir();
    const pg = this.pg();
    if (!pg.initialised()) throw new Error('nothing is deployed yet');
    await pg.setBackupDir(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = { dir, written: [] };
    const seq = this.seq();
    if (seq.exists()) out.written.push(...seq.backupSecrets(path.join(dir, `sequentia-${stamp}`)).map((f) => `sequentia-${stamp}/${f}`));
    const ark = this.ark();
    if (ark.exists()) out.written.push(...ark.backupSecrets(path.join(dir, `bitcoin-${stamp}`)).map((f) => `bitcoin-${stamp}/${f}`));
    const wasUp = !!pg.daemon.pid();
    if (!wasUp) await pg.start();
    try {
      out.base = path.basename(await pg.baseBackup());
      out.written.push(out.base);
    } finally {
      if (!wasUp) await this.stopDbIfIdle();
    }
    out.wal = path.join(dir, 'wal');
    return out;
  }
}

module.exports = { Deploy, defaultDeploy, MASK, installBinary };
