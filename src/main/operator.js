'use strict';
// An Arca operator on Sequentia, run from the app: `arcad` and `arca-signer`,
// the ones the app carries (built from arca at the commit in
// build/ARCA_COMMIT), against the runner's Sequentia Core node, with its state
// in the app's own PostgreSQL cluster (postgres.js).
//
// Everything of it lives in one directory of the profile:
//
//   secrets/operator.key     the operator key S (arca-signer --key-file)
//   secrets/wallet.mnemonic  the operator's on-chain wallet, which funds its pools
//   secrets/node.password    the node's RPC password, when one is given
//   signer/signer.record     the signer's record of every spend it co-signed,
//                            and the files it keeps beside it
//   arcad.toml               arcad's configuration, written from the settings
//   run/signer.sock          where the signer answers arcad
//   log/                     each daemon's log
//   state.json               S, the chain's genesis and when it was made
//
// The key and the mnemonic are drawn on this machine (secrets.js) and never
// leave it. The record is made once, with no keepers: an operator for its own
// coins and for trials. One that holds other people's coins needs keepers on
// other machines (arca's doc/operator-procedure.md), which this screen does
// not set up.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Daemon, sleep } = require('./daemon');
const { newKeyHex, newMnemonic, writeSecret } = require('./secrets');
const { stringify } = require('./toml');
const { nodeRpc } = require('./node-rpc');

const HEX64 = /^[0-9a-f]{64}$/;
const SPEC_EXIT_DELAY_UNITS = [254, 338]; // 36 to 48 hours in 512-second units

function defaultSettings() {
  return {
    node: { url: '', user: '', password: '', cookie: '' },
    listen: '127.0.0.1:3535',
    route: '',
    exit_delay_units: SPEC_EXIT_DELAY_UNITS.slice(),
    round_interval_seconds: 60,
    fees: { refresh_ppm: 0, offboard_ppm: 0, lightning_ppm: 0 },
    assets: [],
  };
}

// Checks the runner's settings and answers them in the form kept: every asset
// named by its 64-hex id, none served by default.
function checkSettings(s) {
  const out = Object.assign(defaultSettings(), s || {});
  const err = (m) => { throw new Error(m); };
  out.node = Object.assign(defaultSettings().node, s && s.node);
  if (!/^https?:\/\/[^\s]+$/.test(out.node.url || '')) err('name the node\'s RPC address (http://host:port/)');
  if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[0-9.]+|[A-Za-z0-9.-]+):[0-9]{2,5}$/.test(out.listen || '')) err('the listen address is host:port, such as 127.0.0.1:3535');
  const port = Number(out.listen.split(':').pop());
  if (port < 1 || port > 65535) err('the listen port is out of range');
  out.route = String(out.route || '').trim().replace(/\/+$/, '') || `http://${out.listen}`;
  if (!/^https?:\/\/[^\s]+$/.test(out.route)) err('the route is the address wallets reach the server at: http(s)://host[:port][/path]');
  const d = (out.exit_delay_units || []).map(Number);
  if (d.length !== 2 || !d.every((x) => Number.isInteger(x) && x >= 1 && x <= 65535) || d[0] > d[1]) err('the exit delays are [least, most] in 512-second units');
  out.exit_delay_units = d;
  const ri = Number(out.round_interval_seconds);
  if (!Number.isInteger(ri) || ri < 1 || ri > 86400) err('the round interval is 1 to 86,400 seconds');
  out.round_interval_seconds = ri;
  out.fees = Object.assign(defaultSettings().fees, out.fees || {});
  for (const k of Object.keys(out.fees)) {
    const v = Number(out.fees[k]);
    if (!Number.isInteger(v) || v < 0 || v > 1000000) err(`${k} is 0 to 1,000,000 parts per million`);
    out.fees[k] = v;
  }
  if (!Array.isArray(out.assets) || !out.assets.length) err('name at least one asset to serve: none is served by default');
  const seen = new Set();
  out.assets = out.assets.map((a, i) => {
    const asset = String(a.asset || '').trim().toLowerCase();
    if (!HEX64.test(asset)) err(`asset ${i + 1}: name it by its 64-hex id`);
    if (seen.has(asset)) err(`asset ${asset} is listed twice`);
    seen.add(asset);
    const min = String(a.min_leaf == null ? '' : a.min_leaf).trim();
    if (!/^[1-9][0-9]{0,18}$/.test(min)) err(`asset ${i + 1}: the smallest leaf is a whole number of the asset's atoms`);
    const r = a.rate || { source: 'none' };
    let rate = null;
    if (r.source === 'node') rate = { source: 'node' };
    else if (r.source === 'file') {
      if (!r.path || !path.isAbsolute(String(r.path))) err(`asset ${i + 1}: a rate file is named by its absolute path`);
      rate = { source: 'file', path: String(r.path) };
    } else if (r.source === 'command') {
      const cmd = Array.isArray(r.command) ? r.command.map(String) : String(r.command || '').trim().split(/\s+/).filter(Boolean);
      if (!cmd.length) err(`asset ${i + 1}: name the rate command`);
      rate = { source: 'command', command: cmd };
    } else if (r.source !== 'none' && r.source) err(`asset ${i + 1}: a rate comes from the node, a file or a command, or from nowhere`);
    if (rate && r.max_age_seconds != null && r.max_age_seconds !== '') {
      const m = Number(r.max_age_seconds);
      if (!Number.isInteger(m) || m < 1) err(`asset ${i + 1}: the rate's longest age is a number of seconds`);
      rate.max_age_seconds = m;
    }
    const ppm = (k) => {
      if (a[k] == null || a[k] === '') return undefined;
      const v = Number(a[k]);
      if (!Number.isInteger(v) || v < 0 || v > 1000000) err(`asset ${i + 1}: ${k} is 0 to 1,000,000 parts per million`);
      return v;
    };
    return { asset, min_leaf: min, refresh_ppm: ppm('refresh_ppm'), offboard_ppm: ppm('offboard_ppm'), rate };
  });
  return out;
}

function get(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).get(u, { timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch { /* not JSON */ }
        if (res.statusCode === 200 && j) resolve(j); else reject(new Error(`${url}: HTTP ${res.statusCode}${j && j.message ? `: ${j.message}` : ''}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${url}: no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

function runOnce(bin, args, { env = {}, timeoutMs = 120000, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve({ out: out.trim(), err: err.trim() });
      else reject(new Error(`${path.basename(bin)}: ${(err || out).trim().split('\n').slice(-3).join(' · ') || `exited ${code}`}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

class SequentiaOperator {
  // opts: {dir, bins: {arcad, signer}, pg (a Postgres)}
  constructor(opts) {
    this.dir = opts.dir;
    this.bins = opts.bins;
    this.pg = opts.pg;
    this.p = (...x) => path.join(this.dir, ...x);
    const sock = this.p('run', 'signer.sock');
    this.signer = new Daemon({
      name: 'arca-signer', bin: this.bins.signer, args: [], logFile: this.p('log', 'arca-signer.log'),
      pidFile: this.p('run', 'arca-signer.pid'), stopSignal: 'SIGTERM', graceMs: 30000,
    });
    this.arcad = new Daemon({
      name: 'arcad', bin: this.bins.arcad, args: [this.p('arcad.toml')], env: { RUST_LOG: 'info' },
      logFile: this.p('log', 'arcad.log'), pidFile: this.p('run', 'arcad.pid'), stopSignal: 'SIGINT', graceMs: 60000,
    });
    this.sock = sock;
  }

  state() { try { return JSON.parse(fs.readFileSync(this.p('state.json'), 'utf8')); } catch { return null; } }
  exists() { return !!this.state() && fs.existsSync(this.p('secrets', 'operator.key')); }

  // Reads the node: the chain's genesis, and that it validates its anchors
  // and keeps a transaction index, as arcad needs.
  async checkNode(node) {
    const genesis = await nodeRpc(node, 'getblockhash', [0]);
    const chain = await nodeRpc(node, 'getblockchaininfo');
    let anchors;
    try { anchors = await nodeRpc(node, 'getanchorstatus'); } catch (e) { throw new Error(`the node does not validate its Bitcoin anchors (getanchorstatus: ${e.message}): arcad needs -validateanchor, without which there is no finality`, { cause: e }); }
    let txindex;
    try { const ix = await nodeRpc(node, 'getindexinfo'); txindex = !!(ix && ix.txindex); } catch { txindex = null; }
    if (txindex === false) throw new Error('the node keeps no transaction index: arcad needs -txindex');
    return { genesis, chain: chain.chain, blocks: chain.blocks, anchors, txindex };
  }

  // Makes the operator once: its key, its wallet's mnemonic and the signer's
  // record, for the chain the node follows. Never replaces any of them.
  async create(settings) {
    const s = checkSettings(settings);
    if (this.exists()) throw new Error(`an operator exists already in ${this.dir}: it is stopped and started, never made again`);
    if (this.sock.length > 100) throw new Error(`the signer's socket path is too long for a Unix socket (${this.sock.length} characters): move the app's home (ARCA_CLIENT_HOME) to a shorter path`);
    const node = await this.checkNode(s.node);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const d of ['secrets', 'signer', 'run', 'log']) fs.mkdirSync(this.p(d), { recursive: true, mode: 0o700 });
    const key = this.p('secrets', 'operator.key');
    if (!fs.existsSync(key)) writeSecret(key, newKeyHex());
    const mn = this.p('secrets', 'wallet.mnemonic');
    if (!fs.existsSync(mn)) writeSecret(mn, newMnemonic());
    const S = (await runOnce(this.bins.signer, ['--key-file', key, '--pubkey'])).out.trim();
    if (!/^[0-9a-f]{64}$/.test(S)) throw new Error(`arca-signer printed no operator key: ${S}`);
    const record = this.p('signer', 'signer.record');
    if (!fs.existsSync(record)) {
      await runOnce(this.bins.signer, ['--key-file', key, '--genesis', node.genesis, '--record', record, '--create-record', '--no-keepers']);
    }
    const st = { operator_key: S, genesis: node.genesis, chain: node.chain, created_at: Math.floor(Date.now() / 1000), keepers: 'none' };
    fs.writeFileSync(this.p('state.json'), JSON.stringify(st, null, 2), { mode: 0o600 });
    return { state: st, node };
  }

  // arcad's configuration, from the settings: everything the runner chose,
  // the rest arcad's own defaults.
  config(settings, dbPassword) {
    const s = checkSettings(settings);
    const node = { rpc_url: s.node.url };
    if (s.node.cookie) node.cookie_file = s.node.cookie;
    else {
      if (s.node.user) node.rpc_user = s.node.user;
      if (s.node.password) node.rpc_password = s.node.password;
    }
    const assets = s.assets.map((a) => {
      const e = { asset: a.asset, min_leaf: a.min_leaf };
      if (a.refresh_ppm != null) e.refresh_ppm = a.refresh_ppm;
      if (a.offboard_ppm != null) e.offboard_ppm = a.offboard_ppm;
      if (a.rate) e.rate = a.rate;
      return e;
    });
    const doc = {
      listen: s.listen,
      database: `postgres://arca:${encodeURIComponent(dbPassword)}@127.0.0.1:${this.pg.port}/arca`,
      signer_socket: this.sock,
      wallet_mnemonic_file: this.p('secrets', 'wallet.mnemonic'),
      round_interval_seconds: s.round_interval_seconds,
      exit_delay_units: s.exit_delay_units,
      node,
      finality: { anchor_depth: 2, certification: 'required' },
      watcher: { enabled: true },
      fees: s.fees,
      assets,
    };
    return `# arcad's configuration, written by the Arca client from its Deploy screen.\n# Edit it there: the app writes it again at every start and every reload.\n\n${stringify(doc)}\n`;
  }

  writeConfig(settings, dbPassword) {
    const f = this.p('arcad.toml');
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, this.config(settings, dbPassword), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  signerArgs() {
    const st = this.state();
    return ['--key-file', this.p('secrets', 'operator.key'), '--genesis', st.genesis, '--socket', this.sock, '--record', this.p('signer', 'signer.record')];
  }

  // Starts what is not running: the database, the signer, then arcad, and
  // waits for arcad to answer its info.
  async start(settings) {
    if (!this.exists()) throw new Error('make the operator first');
    const s = checkSettings(settings);
    await this.pg.start();
    const pw = await this.pg.ensureDatabase('arca', 'arca');
    this.writeConfig(s, pw);
    if (!this.signer.pid()) {
      try { fs.unlinkSync(this.sock); } catch { /* none left */ }
      this.signer.args = this.signerArgs();
      await this.signer.start(1500);
      const until = Date.now() + 30000;
      while (!fs.existsSync(this.sock)) {
        if (!this.signer.pid()) throw new Error(`arca-signer stopped: ${this.signer.log(5).join(' · ')}`);
        if (Date.now() > until) throw new Error(`arca-signer made no socket within 30 s: ${this.signer.log(5).join(' · ')}`);
        await sleep(200);
      }
    }
    if (!this.arcad.pid()) await this.arcad.start(2000);
    const until = Date.now() + 180000;
    let last = null;
    while (Date.now() < until) {
      try { return await this.info(s); } catch (e) { last = e; }
      if (!this.arcad.pid()) throw new Error(`arcad stopped: ${this.arcad.log(6).join(' · ')}`);
      await sleep(500);
    }
    throw new Error(`arcad did not answer within 3 minutes: ${last && last.message}`);
  }

  // Stops arcad, then the signer: arcad first, so nothing it asks goes
  // unanswered. The database is the caller's to stop.
  async stop() {
    const a = await this.arcad.stop();
    const b = await this.signer.stop();
    return [a, b];
  }

  // The settings taken anew without a restart (SIGHUP): the assets served,
  // their smallest leaves, fee schedules and rate sources, and the fees. Any
  // other change takes a restart, which arcad's log names.
  async reload(settings) {
    const s = checkSettings(settings);
    const pw = await this.pg.ensureDatabase('arca', 'arca');
    this.writeConfig(s, pw);
    this.arcad.hangup();
    return { reloaded: true };
  }

  info(settings) {
    const s = settings || {};
    const listen = s.listen || '127.0.0.1:3535';
    return get(`http://${listen.replace(/^0\.0\.0\.0:/, '127.0.0.1:')}/v1/info`);
  }

  // A receive address of the operator's on-chain wallet, which the runner pays
  // each asset's pool to: arcad hands out the next one and records it.
  async fundingAddress() {
    if (!fs.existsSync(this.p('arcad.toml'))) throw new Error('start the operator once first: arcad follows the chain from its first start, and only coins paid after it are found');
    const { out } = await runOnce(this.bins.arcad, [this.p('arcad.toml'), 'address'], { timeoutMs: 60000 });
    return JSON.parse(out);
  }

  // The signer's record: where it is, how many entries it holds, and what its
  // first line names (S, the chain, the keepers).
  record() {
    const f = this.p('signer', 'signer.record');
    let size; let lines; let first;
    try {
      const text = fs.readFileSync(f, 'utf8');
      size = Buffer.byteLength(text);
      const ls = text.split('\n').filter(Boolean);
      lines = ls.length;
      first = ls[0] || null;
    } catch { return { path: f, exists: false }; }
    const beside = ['acknowledged', 'keepers-seen', 'stopped'].filter((x) => fs.existsSync(`${f}.${x}`));
    return { path: f, exists: true, bytes: size, entries: Math.max(0, lines - 1), header: first, beside };
  }

  status() {
    return {
      exists: this.exists(), dir: this.dir, state: this.state(),
      daemons: [this.signer.status(), this.arcad.status()], record: this.exists() ? this.record() : null,
    };
  }

  logs(n = 200) { return { arcad: this.arcad.log(n), 'arca-signer': this.signer.log(n) }; }

  // Copies the operator's secrets and its configuration into `dir`, beside a
  // note of what they are and what is never restored from a copy.
  backupSecrets(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = [];
    for (const [from, to] of [[this.p('secrets', 'operator.key'), 'operator.key'], [this.p('secrets', 'wallet.mnemonic'), 'wallet.mnemonic'],
      [this.p('arcad.toml'), 'arcad.toml'], [this.p('state.json'), 'state.json']]) {
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, path.join(dir, to), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(dir, to), 0o600);
      files.push(to);
    }
    const st = this.state() || {};
    fs.writeFileSync(path.join(dir, 'README.txt'), [
      `The Arca operator ${st.operator_key || ''} on the chain whose genesis is ${st.genesis || ''}.`,
      '',
      'operator.key     the operator key S. Whoever holds it can sign as the operator. Keep it offline.',
      'wallet.mnemonic  the operator\'s on-chain wallet: the coins of every pool.',
      'arcad.toml       arcad\'s configuration (it holds the node\'s and the database\'s passwords).',
      '',
      'Not here, on purpose: the signer\'s record and the database. Neither is ever restored from a copy.',
      'The record is what keeps the operator from co-signing a coin twice; a record cut back or replaced',
      'by an older copy signs nothing. The database is restored only to its latest commit: the base',
      'backup beside this directory with every WAL segment archived after it.',
      '',
    ].join('\n'), { mode: 0o600 });
    return files;
  }
}

module.exports = { SequentiaOperator, checkSettings, defaultSettings, SPEC_EXIT_DELAY_UNITS, runOnce, get };
