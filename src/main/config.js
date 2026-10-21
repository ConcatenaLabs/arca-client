'use strict';
// The app's settings, in <userData>/config.json, readable by its owner alone:
// the node's RPC (its password included, as the wallet's own directory keeps
// it), the operator's address, whether the wallet is the app's own or one
// attached from the command line, whether `sync` runs on its schedule, and the
// Bitcoin side's network, ark and chain source.
const fs = require('fs');
const path = require('path');

function defaultConfig(home) {
  return {
    version: 1,
    mode: 'bundled',
    datadir: path.join(home, 'sequentia'),
    attached: { bin: '', datadir: '' },
    node: { url: 'http://127.0.0.1:18332/', user: '', password: '', cookie: '' },
    operator: { url: '', source: 'address', key: '' },
    autoSync: true,
    // Developer mode shows every rail and the Deploy screen. It is the default
    // on the testnet.
    developer: true,
    backedUp: false,
    // The Bitcoin side: the network, the Bitcoin ark joined, and the chain
    // source (a Bitcoin Core node of version 29 or later, or Esplora).
    bitcoin: { network: 'testnet4', ark: '', source: 'bitcoind', bitcoind: 'http://127.0.0.1:48332/', cookie: '', user: '', password: '', esplora: '' },
  };
}

function file(dir) { return path.join(dir, 'config.json'); }

function loadConfig(dir, defaults) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file(dir), 'utf8')); } catch { c = {}; }
  const out = Object.assign({}, defaults, c);
  out.node = Object.assign({}, defaults.node, c.node || {});
  out.operator = Object.assign({}, defaults.operator, c.operator || {});
  out.attached = Object.assign({}, defaults.attached, c.attached || {});
  out.bitcoin = Object.assign({}, defaults.bitcoin, c.bitcoin || {});
  if (!['bundled', 'attached'].includes(out.mode)) out.mode = 'bundled';
  return out;
}

function saveConfig(dir, c) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file(dir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(dir));
}

module.exports = { defaultConfig, loadConfig, saveConfig };
