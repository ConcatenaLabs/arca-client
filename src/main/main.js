'use strict';
const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ArcaRunner } = require('./arca');
const { SyncScheduler } = require('./scheduler');
const { rails } = require('./rails');
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

let runner = null;
let scheduler = null;
let win = null;
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function makeRunner() {
  const old = scheduler;
  if (old) old.stop();
  runner = new ArcaRunner({
    bin: arcaBin(), datadir: datadir(),
    witnessPatience: process.env.ARCA_CLIENT_WITNESS_PATIENCE ? Number(process.env.ARCA_CLIENT_WITNESS_PATIENCE) : null,
    onLog: (l) => send('log', l),
  });
  scheduler = new SyncScheduler(runner, {
    pollMs: Number(process.env.ARCA_CLIENT_SCHEDULE_POLL_MS || 0) || 120000,
    onEvent: (e) => send('sync-event', e),
  });
  if (cfg().autoSync && runner.exists()) scheduler.start();
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
    rails: rails(arcaBin()), runner: runner.status(), sync: scheduler.status(),
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
    Promise.race([runner ? runner.stop(20000) : Promise.resolve(), new Promise((r) => setTimeout(r, 30000))])
      .finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}

