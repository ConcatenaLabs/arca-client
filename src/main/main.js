'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ArcaRunner } = require('./arca');
const { SyncScheduler } = require('./scheduler');
const { rails, barkBeside } = require('./rails');
const { btcArgv, btcTotal } = require('./bitcoin');
const { nodeRpc, checkNode } = require('./node-rpc');
const { loadConfig, saveConfig, defaultConfig } = require('./config');
const { argv } = require('./commands');

// ARCA_CLIENT_HOME moves every file the app writes (its settings and the
// wallet's directory) under one directory: a second profile on one machine,
// or a test run that must leave nothing behind.
if (process.env.ARCA_CLIENT_HOME) {
  app.setPath('userData', path.join(process.env.ARCA_CLIENT_HOME, 'config'));
}
function homeDir() { return process.env.ARCA_CLIENT_HOME || path.join(os.homedir(), '.arca-client'); }

// --- the bundled arca client ---------------------------------------------------
// A release carries `arca` under <resources>/arca/bin; `npm start` in a
// checkout uses the one build/make-arca-bundle.sh staged.
function bundledArca() {
  const exe = process.platform === 'win32' ? 'arca.exe' : 'arca';
  const cands = [
    path.join(process.resourcesPath || '', 'arca', 'bin', exe),
    path.join(__dirname, '..', '..', 'build', `arca-${process.platform === 'win32' ? 'win' : 'linux'}-x64`, 'bin', exe),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return null;
}
function bundledVersion() {
  for (const c of [path.join(process.resourcesPath || '', 'arca', 'VERSION'), path.join(__dirname, '..', '..', 'build', 'arca-linux-x64', 'VERSION')]) {
    try { return fs.readFileSync(c, 'utf8').trim(); } catch { /* next */ }
  }
  return null;
}

// Bark's client and daemon, which arca runs for the Bitcoin side: a release
// carries them beside arca, under <resources>/arca/bin; `npm start` in a
// checkout uses the ones build/make-bark-bundle.sh staged.
function bundledBark() {
  const exe = process.platform === 'win32' ? 'bark.exe' : 'bark';
  const cands = [
    path.join(process.resourcesPath || '', 'arca', 'bin', exe),
    path.join(__dirname, '..', '..', 'build', `bark-${process.platform === 'win32' ? 'win' : 'linux'}-x64`, 'bin', exe),
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return null;
}
function bundledBarkVersion() {
  for (const c of [path.join(process.resourcesPath || '', 'arca', 'BARK_VERSION'), path.join(__dirname, '..', '..', 'build', 'bark-linux-x64', 'VERSION')]) {
    try { return fs.readFileSync(c, 'utf8').trim(); } catch { /* next */ }
  }
  return null;
}

let config = null;
function cfg() {
  if (!config) config = loadConfig(app.getPath('userData'), defaultConfig(homeDir()));
  return config;
}
function save() { saveConfig(app.getPath('userData'), cfg()); }

// The arca binary and wallet directory in use: the bundled client and the
// app's own directory, or, attached, a client and a wallet the user already
// runs from the command line.
function arcaBin() { const c = cfg(); return c.mode === 'attached' && c.attached.bin ? c.attached.bin : bundledArca(); }
function datadir() { const c = cfg(); return c.mode === 'attached' && c.attached.datadir ? c.attached.datadir : c.datadir; }
// Bark: beside an attached arca when one is there, else the one the app carries.
function barkBin() {
  const c = cfg();
  if (c.mode === 'attached' && c.attached.bin) { const b = barkBeside(c.attached.bin); if (b && fs.existsSync(b)) return b; }
  return bundledBark();
}
// What every run of arca is told of Bark.
function barkEnv() {
  const b = barkBin();
  if (!b) return {};
  return { ARCA_BARK_EXEC: b, ARCA_BARKD_EXEC: path.join(path.dirname(b), process.platform === 'win32' ? 'barkd.exe' : 'barkd') };
}
function btcWallet() { try { return fs.existsSync(path.join(datadir(), 'bitcoin', 'mnemonic')); } catch { return false; } }

let runner = null;
let scheduler = null;
// The Bitcoin side's own queue: Bark lets one process at a time open its
// wallet, and a claim holds it while a payer pays.
let btcRunner = null;
let btcTimer = null;
let win = null;
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function makeRunner() {
  const old = scheduler;
  if (old) old.stop();
  stopClaim('the wallet changed');
  if (btcTimer) clearInterval(btcTimer);
  runner = new ArcaRunner({
    bin: arcaBin(), datadir: datadir(), env: barkEnv(),
    witnessPatience: process.env.ARCA_CLIENT_WITNESS_PATIENCE ? Number(process.env.ARCA_CLIENT_WITNESS_PATIENCE) : null,
    onLog: (l) => send('log', l),
  });
  scheduler = new SyncScheduler(runner, {
    pollMs: Number(process.env.ARCA_CLIENT_SCHEDULE_POLL_MS || 0) || 120000,
    onEvent: (e) => send('sync-event', e),
  });
  if (cfg().autoSync && runner.exists()) scheduler.start();
  btcRunner = new ArcaRunner({
    bin: arcaBin(), datadir: datadir(), env: barkEnv(),
    deadlines: { default: 180000, bitcoin: 300000 },
    onLog: (l) => send('log', `[bitcoin] ${l}`),
  });
  // Bark refreshes leaves before they expire when it is told to maintain the
  // wallet: at the start and every half hour while the app runs.
  const maintain = () => { if (btcWallet() && !claim) btcCall('maintain').catch(() => {}); };
  setTimeout(maintain, 5000).unref();
  btcTimer = setInterval(maintain, Number(process.env.ARCA_CLIENT_BITCOIN_MAINTAIN_MS || 0) || 1800000);
  btcTimer.unref();
}

// One Bitcoin command on its queue: Bark's answer, or its refusal verbatim.
async function btcCall(command, a = {}, extra = {}) {
  let args;
  try { args = btcArgv(command, a); } catch (e) { return { ok: false, refusal: { kind: 'input', message: e.message }, notes: [] }; }
  const bark = args[0] === 'bitcoin' && args[1] === '--quiet';
  const deadlineMs = command === 'create' ? 900000 : command === 'ln_claim' ? (Number(a.wait || 25) + 60) * 1000
    : ['exit_progress', 'exit_start', 'refresh', 'board', 'send', 'ln_pay'].includes(command) ? 600000 : 180000;
  try {
    const { result, notes } = await btcRunner.run(args, Object.assign({ bark, deadlineMs }, extra));
    return { ok: true, result, notes };
  } catch (e) {
    return { ok: false, refusal: e.refusal || { kind: 'client', message: e.message }, notes: e.notes || [] };
  }
}

// The claim of a payment over Lightning, run for the user while the invoice
// is shown: Bark's server holds a payment only until the wallet claims it.
// Slices of 25 seconds, so other Bitcoin commands get Bark's wallet between
// them. When the payment can no longer be claimed, the wallet answers a
// fresh invoice (`reissued`), shown in place of the old one, and the claim
// goes on with it.
let claim = null; // {invoice, amount, since, state, history[], stop}
const CLAIM_FOR_MS = Number(process.env.ARCA_CLIENT_CLAIM_FOR_MS || 0) || 3600000;
function claimState() { return claim ? { invoice: claim.invoice, amount: claim.amount, since: claim.since, state: claim.state, history: claim.history } : null; }
function stopClaim(why) { if (claim && claim.state === 'waiting') { claim.stop = why; } }
async function runClaim(c) {
  while (!c.stop) {
    if (Date.now() - c.since > CLAIM_FOR_MS) { c.state = 'stopped'; c.history.push({ at: Date.now(), state: 'stopped', note: 'no payment came within the hour: claim again to wait more' }); break; }
    const out = await btcCall('ln_claim', { invoice: c.invoice, wait: 25 });
    if (c.stop) break;
    if (!out.ok) {
      c.state = 'refused'; c.history.push({ at: Date.now(), state: 'refused', refusal: out.refusal });
      send('btc-event', { type: 'claim-refused', invoice: c.invoice, refusal: out.refusal });
      break;
    }
    const r = out.result;
    if (r.state === 'claimed') {
      c.state = 'claimed'; c.history.push({ at: Date.now(), state: 'claimed', receive: r.receive });
      send('btc-event', { type: 'claimed', invoice: c.invoice, receive: r.receive });
      break;
    }
    if (r.state === 'reissued') {
      c.history.push({ at: Date.now(), state: 'reissued', replaces: c.invoice, invoice: r.invoice, why: r.why });
      send('btc-event', { type: 'reissued', replaces: c.invoice, invoice: r.invoice, why: r.why });
      c.invoice = r.invoice;
    }
  }
  if (c.stop && c.state === 'waiting') { c.state = 'stopped'; c.history.push({ at: Date.now(), state: 'stopped', note: c.stop }); }
  send('btc-event', { type: 'claim-ended', claim: claimState() });
}
function startClaim(invoice, amount) {
  stopClaim('a new claim started');
  claim = { invoice, amount, since: Date.now(), state: 'waiting', history: [], stop: null };
  runClaim(claim).catch((e) => { if (claim) { claim.state = 'refused'; claim.history.push({ at: Date.now(), state: 'refused', refusal: { kind: 'client', message: e.message } }); } });
}

// Every call the renderer makes to the wallet goes through here: the answer,
// or the refusal in the library's own words.
async function arcaCall(args, opts) {
  try {
    const { result, notes } = await runner.run(args, opts);
    return { ok: true, result, notes };
  } catch (e) {
    return { ok: false, refusal: e.refusal || { kind: 'client', message: e.message }, notes: e.notes || [] };
  }
}

// --- IPC -------------------------------------------------------------------------
ipcMain.handle('state', () => {
  const c = cfg();
  return {
    mode: c.mode, joined: runner.exists(), datadir: datadir(), attached: c.attached,
    node: Object.assign({}, c.node, { password: c.node.password ? '••••' : '' }),
    operator: c.operator, autoSync: c.autoSync, backedUp: c.backedUp,
    arca: { bin: arcaBin(), bundled: !!bundledArca(), version: c.mode === 'attached' ? null : bundledVersion() },
    rails: rails(arcaBin(), barkBin()), runner: runner.status(), sync: scheduler.status(),
    bitcoin: {
      wallet: btcWallet(), settings: Object.assign({}, c.bitcoin, { password: c.bitcoin.password ? '••••' : '' }),
      bark: barkBin(), version: c.mode === 'attached' ? null : bundledBarkVersion(), runner: btcRunner.status(), claim: claimState(),
    },
    platform: process.platform, appVersion: app.getVersion(),
  };
});
ipcMain.handle('arca', async (_e, command, a) => {
  let args;
  try { args = argv(command, a); } catch (e) { return { ok: false, refusal: { kind: 'input', message: e.message }, notes: [] }; }
  const out = await arcaCall(args);
  // A command that changes what the wallet holds may change the schedule.
  if (out.ok && ['board', 'send', 'receive', 'participate', 'exit', 'restore', 'mailbox', 'forget_request'].includes(command) && scheduler.enabled) {
    scheduler._arm(500, 'the schedule');
  }
  return out;
});
ipcMain.handle('sync-now', async () => scheduler.syncNow('asked for'));

// --- the Bitcoin side ---------------------------------------------------------------
ipcMain.handle('btc', async (_e, command, a) => {
  if (command === 'create') {
    const c = cfg();
    const b = Object.assign({}, c.bitcoin, a || {});
    if (b.password === '••••') b.password = c.bitcoin.password;
    c.bitcoin = { network: b.network, ark: String(b.ark || '').trim(), source: b.source === 'esplora' ? 'esplora' : 'bitcoind',
      bitcoind: String(b.bitcoind || '').trim(), cookie: String(b.cookie || '').trim(), user: String(b.user || '').trim(),
      password: String(b.password || ''), esplora: String(b.esplora || '').trim() };
    save();
    if (!runner.exists()) return { ok: false, refusal: { kind: 'input', message: 'join an operator first: the Bitcoin ark wallet is made from this wallet\'s mnemonic' }, notes: [] };
    const env = c.bitcoin.source === 'bitcoind' && !c.bitcoin.cookie && c.bitcoin.password ? { ARCA_BITCOIND_PASSWORD: c.bitcoin.password } : {};
    return btcCall('create', Object.assign({}, c.bitcoin, { birthday_height: a && a.birthday_height }), { env });
  }
  return btcCall(command, a || {});
});
// What the Bitcoin side holds: Bark's ark balance and its on-chain wallet,
// and their total in satoshis, as BTC's row counts it.
ipcMain.handle('btc-summary', async () => {
  if (!btcWallet()) return { ok: true, result: { wallet: false } };
  const ark = await btcCall('balance');
  const onchain = await btcCall('onchain_balance');
  if (!ark.ok || !onchain.ok) return { ok: false, refusal: (ark.ok ? onchain : ark).refusal, notes: [] };
  return { ok: true, result: { wallet: true, ark: ark.result, onchain: onchain.result, total: btcTotal(ark.result, onchain.result) } };
});
ipcMain.handle('btc-receive', async (_e, a) => {
  const out = await btcCall('ln_receive', a || {});
  if (out.ok) startClaim(out.result.invoice, out.result.amount_sat);
  return out;
});
ipcMain.handle('btc-claim', async (_e, a) => {
  try { btcArgv('ln_claim', { invoice: a && a.invoice }); } catch (e) { return { ok: false, refusal: { kind: 'input', message: e.message } }; }
  startClaim(String(a.invoice).trim(), a.amount || null);
  return { ok: true, result: claimState() };
});
ipcMain.handle('btc-claim-stop', async () => { stopClaim('stopped by the user'); return { ok: true, result: claimState() }; });
ipcMain.handle('set-auto-sync', (_e, on) => {
  const c = cfg(); c.autoSync = !!on; save();
  if (c.autoSync && runner.exists()) scheduler.start(); else scheduler.stop();
  return scheduler.status();
});
ipcMain.handle('set-node', (_e, node) => {
  const c = cfg();
  c.node = { url: String(node.url || '').trim(), user: String(node.user || '').trim(),
    password: node.password === '••••' ? c.node.password : String(node.password || ''), cookie: String(node.cookie || '').trim() };
  save(); return true;
});
ipcMain.handle('set-operator', (_e, op) => { const c = cfg(); c.operator = { url: String(op.url || '').trim(), source: 'address' }; save(); return true; });
ipcMain.handle('test-node', async (_e, node) => {
  const c = cfg();
  const n = Object.assign({}, c.node, node || {});
  if (n.password === '••••') n.password = c.node.password;
  try { return { ok: true, result: await checkNode(n) }; } catch (e) { return { ok: false, refusal: { kind: 'node', message: e.message } }; }
});
ipcMain.handle('asset-labels', async () => {
  try {
    const labels = await nodeRpc(cfg().node, 'dumpassetlabels');
    // A label Elements gives the policy asset on its own chains names another
    // chain's coin; a Sequentia asset is never called bitcoin.
    const out = {};
    for (const [name, id] of Object.entries(labels || {})) if (!/^bitcoin$/i.test(name)) out[id] = name;
    return out;
  } catch { return {}; }
});
ipcMain.handle('join', async (_e, j) => {
  const c = cfg();
  if (runner.exists()) return { ok: false, refusal: { kind: 'input', message: `a wallet already exists in ${datadir()}` } };
  const node = c.node;
  const out = await (async () => {
    try {
      const { result, notes } = await runner.create({
        server: c.operator.url, nodeUrl: node.url, nodeUser: node.user || null, nodePassword: node.password || null,
        nodeCookie: node.cookie || null, mnemonic: j && j.mnemonic ? String(j.mnemonic).trim().split(/\s+/).join(' ') : null,
      });
      return { ok: true, result, notes };
    } catch (e) { return { ok: false, refusal: e.refusal || { kind: 'client', message: e.message }, notes: e.notes || [] }; }
  })();
  if (out.ok) {
    c.backedUp = !!(j && j.mnemonic);
    save();
    if (c.autoSync) scheduler.start();
  }
  return out;
});
ipcMain.handle('mnemonic', () => { try { return runner.mnemonic(); } catch { return null; } });
ipcMain.handle('set-backed-up', () => { const c = cfg(); c.backedUp = true; save(); return true; });
ipcMain.handle('set-mode', (_e, m) => {
  const c = cfg();
  if (m.mode === 'attached') {
    c.mode = 'attached';
    c.attached = { bin: String(m.bin || '').trim(), datadir: String(m.datadir || '').trim() };
  } else {
    c.mode = 'bundled';
  }
  save();
  makeRunner();
  return true;
});
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('reveal', (_e, p) => { shell.showItemInFolder(p); });
ipcMain.handle('logs', () => runner.logs.slice());

// --- window ------------------------------------------------------------------------
// ARCA_CLIENT_OFFSCREEN=1 renders the window without showing it, for a test
// run on a machine whose screen is someone else's.
const OFFSCREEN = process.env.ARCA_CLIENT_OFFSCREEN === '1';
function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#101214',
    title: 'Arca',
    show: !OFFSCREEN,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: OFFSCREEN },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    makeRunner();
    createWindow();
  });
  // A clean stop: no new run starts, the one in flight is let finish.
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    if (scheduler) scheduler.stop();
    stopClaim('the app is stopping');
    if (btcTimer) clearInterval(btcTimer);
    Promise.race([Promise.all([runner ? runner.stop(20000) : Promise.resolve(), btcRunner ? btcRunner.stop(40000) : Promise.resolve()]),
      new Promise((r) => setTimeout(r, 45000))])
      .finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}

