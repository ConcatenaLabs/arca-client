'use strict';
// A Bitcoin ark run from the app: Bark's server, `captaind`, and its watchman,
// `watchmand`, the ones the app carries (Bark's upstream release in
// build/BARK_COMMIT), against the runner's own Bitcoin Core, with its state in
// the app's PostgreSQL cluster (database `bark_captaind`).
//
//   captaind.toml, watchmand.toml   written from the settings
//   captaind/                       captaind's data, its key's mnemonic first
//   watchmand/                      the watchman's data, the same mnemonic
//   log/, run/                      each daemon's log and PID
//   state.json                      the network, the round wallet's address the
//                                   watchman sweeps to, when it was made
//
// captaind makes its own key (`captaind create`), from which its server key
// and mailbox key are derived; it never leaves the machine. The watchman
// answers a leaf's exit the server must contest and sweeps expired rounds
// back to the round wallet: without it nothing answers on the chain.
//
// The ark takes no Lightning payments: it is run with no Lightning gateway
// (Bark's `cln_array` empty).
const fs = require('fs');
const path = require('path');
const http2 = require('http2');
const { Daemon, sleep } = require('./daemon');
const { stringify } = require('./toml');
const { nodeRpc } = require('./node-rpc');
const { runOnce } = require('./operator');

// Bark's server at the release the app carries refuses an older Core: it
// reads fields of getmempoolentry that Bitcoin Core 31 added.
const MIN_CORE = 310000;
const NETWORKS = { regtest: 'regtest', signet: 'signet', testnet4: 'testnet4', mainnet: 'main' };

function defaultArkSettings() {
  return {
    network: 'testnet4',
    bitcoind: { url: '', cookie: '', user: '', password: '' },
    listen: '127.0.0.1:3545',
    admin_port: 3546,
    route: '',
    round_interval_seconds: 30,
    vtxo_lifetime: 2016,
    vtxo_exit_delta: 72,
    required_board_confirmations: 2,
    min_board_sat: 10000,
    max_vtxo_sat: 5000000,
  };
}

function checkArkSettings(s) {
  const d = defaultArkSettings();
  const out = Object.assign(d, s || {});
  out.bitcoind = Object.assign(defaultArkSettings().bitcoind, (s && s.bitcoind) || {});
  const err = (m) => { throw new Error(m); };
  if (!NETWORKS[out.network]) err(`the network is one of ${Object.keys(NETWORKS).join(', ')}`);
  if (!/^https?:\/\/[^\s]+$/.test(out.bitcoind.url || '')) err('name Bitcoin Core\'s RPC address (http://host:port/)');
  if (!/^(127\.0\.0\.1|0\.0\.0\.0|[0-9.]+):[0-9]{2,5}$/.test(out.listen || '')) err('the listen address is an IPv4 address and port, such as 127.0.0.1:3545');
  out.route = String(out.route || '').trim().replace(/\/+$/, '') || `http://${out.listen}`;
  const int = (k, lo, hi) => {
    const v = Number(out[k]);
    if (!Number.isInteger(v) || v < lo || v > hi) err(`${k.replace(/_/g, ' ')} is ${lo} to ${hi}`);
    out[k] = v;
  };
  int('admin_port', 1024, 65535);
  int('round_interval_seconds', 1, 86400);
  int('vtxo_lifetime', 20, 65535);
  int('vtxo_exit_delta', 2, 65535);
  int('required_board_confirmations', 1, 1000);
  int('min_board_sat', 330, 2100000000000000);
  int('max_vtxo_sat', 1000, 2100000000000000);
  if (out.vtxo_exit_delta * 2 >= out.vtxo_lifetime) err('a leaf must live more than twice its exit delta');
  if (Number(out.listen.split(':').pop()) === out.admin_port) err('the admin port is not the public one');
  return out;
}

// A gRPC call with an empty request over plain HTTP/2 (h2c), answering the
// response message's bytes: what every Bark wallet asks the server first.
function grpcEmpty(base, method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let client;
    try { client = http2.connect(base); } catch (e) { reject(e); return; }
    const done = (f, v) => { try { client.close(); } catch { /* closed */ } f(v); };
    client.on('error', (e) => done(reject, e));
    const req = client.request({ ':method': 'POST', ':path': method, 'content-type': 'application/grpc', te: 'trailers' });
    const chunks = [];
    let status = null; let message = null;
    req.setTimeout(timeoutMs, () => { req.close(); done(reject, new Error(`${base}: no answer within ${timeoutMs} ms`)); });
    req.on('response', (h) => { if (h['grpc-status'] != null) { status = h['grpc-status']; message = h['grpc-message']; } });
    req.on('trailers', (h) => { status = h['grpc-status']; message = h['grpc-message']; });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (status != null && String(status) !== '0') return done(reject, new Error(`${method}: gRPC status ${status}${message ? `: ${decodeURIComponent(message)}` : ''}`));
      const buf = Buffer.concat(chunks);
      if (buf.length < 5) return done(reject, new Error(`${method}: an empty answer`));
      done(resolve, buf.subarray(5, 5 + buf.readUInt32BE(1)));
    });
    req.on('error', (e) => done(reject, e));
    req.end(Buffer.from([0, 0, 0, 0, 0]));
  });
}

// The fields of a protobuf message: {number: [value…]}, a varint as a BigInt,
// a length-delimited field as its bytes.
function protoFields(buf) {
  const out = {};
  let i = 0;
  const varint = () => {
    let r = 0n; let s = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('a truncated message');
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const no = tag >> 3; const wt = tag & 7;
    let v;
    if (wt === 0) v = varint();
    else if (wt === 2) { const n = Number(varint()); v = buf.subarray(i, i + n); i += n; }
    else if (wt === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (wt === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error(`wire type ${wt}`);
    (out[no] = out[no] || []).push(v);
  }
  return out;
}

// Bark's ArkInfo (server-rpc/protos/bark_server.proto): what a wallet joining
// the ark reads, its server key first.
async function arkInfo(base) {
  const f = protoFields(await grpcEmpty(base, '/bark_server.ArkService/GetArkInfo'));
  const num = (n) => (f[n] ? Number(f[n][0]) : null);
  return {
    network: f[1] ? f[1][0].toString('utf8') : null,
    server_pubkey: f[2] ? f[2][0].toString('hex') : null,
    round_interval_secs: num(3), vtxo_exit_delta: num(5), vtxo_lifetime: num(6),
    required_board_confirmations: num(10), min_board_amount_sat: num(13),
    max_vtxo_amount_sat: num(9), mailbox_pubkey: f[16] ? f[16][0].toString('hex') : null,
  };
}

class BitcoinArk {
  // opts: {dir, bins: {captaind, watchmand}, pg}
  constructor(opts) {
    this.dir = opts.dir;
    this.bins = opts.bins;
    this.pg = opts.pg;
    this.p = (...x) => path.join(this.dir, ...x);
    this.captaind = new Daemon({
      name: 'captaind', bin: this.bins.captaind, args: ['--config', this.p('captaind.toml'), 'start'], env: { CAPTAIND_LOG: 'info' },
      logFile: this.p('log', 'captaind.log'), pidFile: this.p('run', 'captaind.pid'), stopSignal: 'SIGTERM', graceMs: 60000,
    });
    this.watchmand = new Daemon({
      name: 'watchmand', bin: this.bins.watchmand, args: ['--config', this.p('watchmand.toml'), 'start'], env: { CAPTAIND_LOG: 'info' },
      logFile: this.p('log', 'watchmand.log'), pidFile: this.p('run', 'watchmand.pid'), stopSignal: 'SIGTERM', graceMs: 60000,
    });
  }

  state() { try { return JSON.parse(fs.readFileSync(this.p('state.json'), 'utf8')); } catch { return null; } }
  saveState(st) { fs.writeFileSync(this.p('state.json'), JSON.stringify(st, null, 2), { mode: 0o600 }); }
  exists() { return !!this.state() && fs.existsSync(this.p('captaind', 'mnemonic')); }

  // Bitcoin Core as captaind needs it: version 31 or later, on the network
  // named, with a transaction index.
  async checkCore(s) {
    const node = s.bitcoind;
    const ni = await nodeRpc(node, 'getnetworkinfo');
    const bi = await nodeRpc(node, 'getblockchaininfo');
    if (ni.version < MIN_CORE) {
      throw new Error(`Bark's server needs Bitcoin Core 31 or later, and this node is ${ni.subversion} (version ${ni.version})`);
    }
    if (bi.chain !== NETWORKS[s.network]) throw new Error(`the node is on ${bi.chain}, not ${s.network}`);
    let txindex;
    try { const ix = await nodeRpc(node, 'getindexinfo'); txindex = !!(ix && ix.txindex); } catch { txindex = null; }
    if (txindex === false) throw new Error('Bitcoin Core keeps no transaction index: Bark\'s server needs -txindex');
    return { version: ni.version, subversion: ni.subversion, chain: bi.chain, blocks: bi.blocks, ibd: bi.initialblockdownload, txindex };
  }

  bitcoindSection(s) {
    const b = { url: s.bitcoind.url.replace(/\/+$/, '') };
    if (s.bitcoind.cookie) b.cookie = s.bitcoind.cookie;
    else { b.rpc_user = s.bitcoind.user; b.rpc_pass = s.bitcoind.password; }
    return b;
  }

  pgSection(password, max) {
    return { host: '127.0.0.1', port: this.pg.port, name: 'bark_captaind', user: 'bark', password, max_connections: max };
  }

  // captaind's configuration: the runner's choices, and the rest as the
  // Sequentia testnet's Bitcoin ark runs (O2.4): Bark's own fee schedule, its
  // round timings, and no Lightning gateway.
  captaindConfig(settings, dbPassword) {
    const s = checkArkSettings(settings);
    const ppmTable = [{ expiry_blocks_threshold: 0, ppm: 0 }, { expiry_blocks_threshold: 97, ppm: 1000 }, { expiry_blocks_threshold: 199, ppm: 4000 }, { expiry_blocks_threshold: 2161, ppm: 8000 }];
    const sat = (n) => `${n} sat`;
    const doc = {
      data_dir: this.p('captaind'),
      network: s.network,
      vtxo_lifetime: s.vtxo_lifetime,
      vtxo_exit_delta: s.vtxo_exit_delta,
      max_vtxo_amount: sat(s.max_vtxo_sat),
      min_board_amount: sat(s.min_board_sat),
      max_board_amount: sat(s.max_vtxo_sat),
      max_offboard_amount: sat(s.max_vtxo_sat),
      max_arkoor_amount: sat(s.max_vtxo_sat),
      max_vtxo_exit_depth: 100,
      max_arkoor_fanout: 4,
      required_board_confirmations: s.required_board_confirmations,
      min_trusted_confs: Math.min(2, s.required_board_confirmations),
      rpc_rich_errors: true,
      sync_manager_block_poll_interval: '1s',
      nursery_confirm_target_blocks: 6,
      otel_deployment_name: 'arca-client',
      max_read_mailbox_items: 100,
      round_interval: `${s.round_interval_seconds}s`,
      round_submit_time: '5s',
      round_sign_time: '5s',
      nb_round_nonces: 8,
      round_forfeit_nonces_timeout: '30s',
      offboard_session_timeout: '30s',
      offboard_check_interval: '1s',
      offboard_acceptable_fee_rate_duration: '15m',
      cln_reconnect_interval: '10s',
      invoice_check_interval: '3s',
      cln_xpay_timeout: '60s',
      invoice_check_base_delay: '10s',
      max_invoice_check_delay: '10m',
      invoice_poll_interval: '30s',
      htlc_settlement_poll_interval: '60s',
      track_all_base_delay: '1s',
      max_track_all_delay: '60s',
      htlc_expiry_delta: 40,
      htlc_send_expiry_delta: 258,
      max_user_invoice_cltv_delta: 250,
      invoice_expiry: '48h',
      receive_htlc_forward_timeout: '3min',
      ln_receive_anti_dos_required: false,
      max_ln_receive_amount: '0 sat',
      max_ln_send_amount: '0 sat',
      ln_max_fee_ppm: 900000,
      fees: {
        board: { min_fee_sat: 330, base_fee_sat: 100, ppm: 1000 },
        offboard: { base_fee_sat: 200, fixed_additional_vb: 221, ppm_expiry_table: ppmTable },
        refresh: { base_fee_sat: 150, ppm_expiry_table: ppmTable },
        lightning_receive: { base_fee_sat: 100, ppm: 2000 },
        lightning_send: { min_fee_sat: 10, base_fee_sat: 75, ppm_expiry_table: ppmTable },
      },
      vtxopool: { vtxo_targets: [], vtxo_target_issue_threshold: 80, vtxo_lifetime: Math.max(s.vtxo_exit_delta * 3, Math.floor(s.vtxo_lifetime / 2)), vtxo_pre_expiry: s.vtxo_exit_delta, max_vtxo_exit_depth: 3 },
      fee_estimator: { update_interval: '1m', history_duration: '60m', fallback_fee_rate_fast: '5sat/vb', fallback_fee_rate_regular: '3sat/vb', fallback_fee_rate_slow: '2sat/vb', max_fee_rate: '100sat/vb' },
      rpc: { public_address: s.listen, admin_address: `127.0.0.1:${s.admin_port}` },
      postgres: this.pgSection(dbPassword, 10),
      bitcoind: this.bitcoindSection(s),
    };
    return `# Bark's server (captaind), written by the Arca client from its Deploy screen.\n# Edit it there: the app writes it again at every start.\n\n${stringify(doc)}\n`;
  }

  watchmandConfig(settings, dbPassword, sweepAddress) {
    const s = checkArkSettings(settings);
    const doc = {
      data_dir: this.p('watchmand'),
      network: s.network,
      sync_manager_block_poll_interval: '1s',
      htlc_settlement_poll_interval: '60s',
      min_trusted_confs: Math.min(2, s.required_board_confirmations),
      otel_deployment_name: 'arca-client-watchman',
      sweep_address: sweepAddress,
      watchman: { reaction_interval: '1m', sweep_interval: '2h', progress_grace_period: 2, claim_chunksize: 20, incremental_relay_fee: '100 sat/kvb', min_cpfp_amount: '10000 sat' },
      fee_estimator: { update_interval: '1m', history_duration: '60m', fallback_fee_rate_fast: '5sat/vb', fallback_fee_rate_regular: '3sat/vb', fallback_fee_rate_slow: '2sat/vb', max_fee_rate: '100sat/vb' },
      postgres: this.pgSection(dbPassword, 5),
      bitcoind: this.bitcoindSection(s),
    };
    return `# Bark's watchman (watchmand), written by the Arca client from its Deploy screen.\n\n${stringify(doc)}\n`;
  }

  write(file, text) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Makes the ark once: its database and captaind's key. Never again.
  async create(settings) {
    const s = checkArkSettings(settings);
    if (this.exists()) throw new Error(`a Bitcoin ark exists already in ${this.dir}: it is stopped and started, never made again`);
    const core = await this.checkCore(s);
    for (const d of ['', 'captaind', 'watchmand', 'log', 'run']) fs.mkdirSync(this.p(d), { recursive: true, mode: 0o700 });
    await this.pg.start();
    const pw = await this.pg.ensureDatabase('bark_captaind', 'bark');
    this.write(this.p('captaind.toml'), this.captaindConfig(s, pw));
    if (!fs.existsSync(this.p('captaind', 'mnemonic'))) {
      const out = await runOnce(this.bins.captaind, ['--config', this.p('captaind.toml'), 'create'], { timeoutMs: 300000 }).catch((e) => { throw new Error(`captaind create: ${e.message}`); });
      fs.appendFileSync(this.p('log', 'captaind.log'), `--- ${new Date().toISOString()} captaind create\n${out.out}\n${out.err}\n`);
    }
    if (!fs.existsSync(this.p('captaind', 'mnemonic'))) throw new Error('captaind made no key (no mnemonic in its data directory)');
    if (!fs.existsSync(this.p('watchmand', 'mnemonic'))) {
      fs.copyFileSync(this.p('captaind', 'mnemonic'), this.p('watchmand', 'mnemonic'), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(this.p('watchmand', 'mnemonic'), 0o600);
    }
    const st = { network: s.network, created_at: Math.floor(Date.now() / 1000), sweep_address: null };
    this.saveState(st);
    return { state: st, core };
  }

  admin(s, cmd) {
    return runOnce(this.bins.captaind, ['rpc', '--addr', `http://127.0.0.1:${s.admin_port}`, ...cmd], { timeoutMs: 30000 })
      .then(({ out }) => JSON.parse(out));
  }

  // The database, captaind, then the watchman, which sweeps to the round
  // wallet's first address (kept, so it never changes from start to start).
  async start(settings) {
    const s = checkArkSettings(settings);
    if (!this.exists()) throw new Error('make the Bitcoin ark first');
    await this.checkCore(s);
    await this.pg.start();
    const pw = await this.pg.ensureDatabase('bark_captaind', 'bark');
    this.write(this.p('captaind.toml'), this.captaindConfig(s, pw));
    if (!this.captaind.pid()) await this.captaind.start(3000);
    let wallet = null; let last = null;
    const until = Date.now() + 180000;
    while (Date.now() < until) {
      try { wallet = await this.admin(s, ['wallet']); break; } catch (e) { last = e; }
      if (!this.captaind.pid()) throw new Error(`captaind stopped: ${this.captaind.log(6).join(' · ')}`);
      await sleep(1000);
    }
    if (!wallet) throw new Error(`captaind's admin interface did not answer within 3 minutes: ${last && last.message}`);
    const st = this.state();
    if (!st.sweep_address) {
      st.sweep_address = wallet.rounds && wallet.rounds.address;
      if (!st.sweep_address) throw new Error(`captaind names no round wallet address: ${JSON.stringify(wallet)}`);
      this.saveState(st);
    }
    this.write(this.p('watchmand.toml'), this.watchmandConfig(s, pw, st.sweep_address));
    if (!this.watchmand.pid()) await this.watchmand.start(3000);
    return this.info(s);
  }

  async stop() {
    const a = await this.watchmand.stop();
    const b = await this.captaind.stop();
    return [a, b];
  }

  info(settings) {
    const s = checkArkSettings(settings);
    return arkInfo(`http://${s.listen.replace(/^0\.0\.0\.0:/, '127.0.0.1:')}`);
  }

  async wallet(settings) { return this.admin(checkArkSettings(settings), ['wallet']); }

  status() {
    return { exists: this.exists(), dir: this.dir, state: this.state(), daemons: [this.captaind.status(), this.watchmand.status()] };
  }

  logs(n = 200) { return { captaind: this.captaind.log(n), watchmand: this.watchmand.log(n) }; }

  backupSecrets(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = [];
    for (const [from, to] of [[this.p('captaind', 'mnemonic'), 'captaind.mnemonic'], [this.p('captaind.toml'), 'captaind.toml'],
      [this.p('watchmand.toml'), 'watchmand.toml'], [this.p('state.json'), 'state.json']]) {
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, path.join(dir, to), fs.constants.COPYFILE_EXCL);
      fs.chmodSync(path.join(dir, to), 0o600);
      files.push(to);
    }
    fs.writeFileSync(path.join(dir, 'README.txt'), [
      'A Bitcoin ark (Bark\'s captaind and watchmand) run by the Arca client.',
      '',
      'captaind.mnemonic  captaind\'s key: its server key, mailbox key and round wallet derive from it. Keep it offline.',
      'captaind.toml, watchmand.toml  the configurations (they hold the database\'s password).',
      '',
      'The database is restored only to its latest commit: the base backup beside this directory with',
      'every WAL segment archived after it, never an older copy.',
      '',
    ].join('\n'), { mode: 0o600 });
    return files;
  }
}

module.exports = { BitcoinArk, checkArkSettings, defaultArkSettings, arkInfo, protoFields, MIN_CORE, NETWORKS };
