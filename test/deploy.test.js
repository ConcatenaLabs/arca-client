'use strict';
// The Deploy screen's parts that need no chain: the secrets it draws, the
// configurations it writes, the settings it refuses, and the supervision of a
// daemon (a stand-in here).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mnemonicFromEntropy, newMnemonic, newKeyHex, writeSecret } = require('../src/main/secrets');
const { stringify } = require('../src/main/toml');
const { checkSettings, SequentiaOperator, SPEC_EXIT_DELAY_UNITS } = require('../src/main/operator');
const { checkArkSettings, protoFields, BitcoinArk } = require('../src/main/ark-server');
const { Daemon } = require('../src/main/daemon');
const { Deploy, MASK } = require('../src/main/deploy');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const node = { url: 'http://127.0.0.1:18884/', user: 'u', password: 'p' };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'arca-deploy-')); }

test('BIP39 mnemonics match the reference vectors and carry a checksum', () => {
  assert.strictEqual(mnemonicFromEntropy(Buffer.alloc(16)), 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  assert.strictEqual(mnemonicFromEntropy(Buffer.from('7f'.repeat(16), 'hex')), 'legal winner thank year wave sausage worth useful legal winner thank yellow');
  assert.strictEqual(mnemonicFromEntropy(Buffer.from('80'.repeat(16), 'hex')), 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above');
  assert.strictEqual(mnemonicFromEntropy(Buffer.from('ff'.repeat(32), 'hex')).split(' ').length, 24);
  const a = newMnemonic(); const b = newMnemonic();
  assert.strictEqual(a.split(' ').length, 12);
  assert.notStrictEqual(a, b);
  assert.match(newKeyHex(), /^[0-9a-f]{64}$/);
});

test('a secret is written for its owner alone, and never over one that exists', () => {
  const d = tmp();
  const f = path.join(d, 's', 'operator.key');
  writeSecret(f, 'x');
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.throws(() => writeSecret(f, 'y'), /EEXIST/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'x\n');
});

test('TOML: strings cannot break their line, tables and arrays of tables nest', () => {
  const t = stringify({ a: 'x"\n[evil]\\', n: 3, b: true, arr: [1, 2], t: { k: 'v' }, assets: [{ asset: A, rate: { source: 'node' } }, { asset: B }] });
  assert.ok(t.includes('a = "x\\"\\n[evil]\\\\"'));
  assert.ok(!/^\[evil\]/m.test(t));
  assert.ok(t.includes('[t]\nk = "v"'));
  assert.ok(t.includes(`[[assets]]\nasset = "${A}"\n[assets.rate]\nsource = "node"`));
  assert.ok(t.includes(`[[assets]]\nasset = "${B}"`));
});

test('an operator serves no asset by default and takes the specification\'s exit delays', () => {
  assert.throws(() => checkSettings({ node }), /name at least one asset to serve: none is served by default/);
  const s = checkSettings({ node, assets: [{ asset: A, min_leaf: '1000' }] });
  assert.deepStrictEqual(s.exit_delay_units, SPEC_EXIT_DELAY_UNITS);
  assert.deepStrictEqual(SPEC_EXIT_DELAY_UNITS, [254, 338]);
  assert.strictEqual(s.route, 'http://127.0.0.1:3535');
  assert.strictEqual(s.assets[0].rate, null);
});

test('an operator\'s settings refuse what arcad would misread', () => {
  const base = { node, assets: [{ asset: A, min_leaf: '1000' }] };
  assert.throws(() => checkSettings(Object.assign({}, base, { assets: [{ asset: 'X', min_leaf: '1' }] })), /64-hex id/);
  assert.throws(() => checkSettings(Object.assign({}, base, { assets: [{ asset: A, min_leaf: '1' }, { asset: A, min_leaf: '2' }] })), /listed twice/);
  assert.throws(() => checkSettings(Object.assign({}, base, { assets: [{ asset: A, min_leaf: '0' }] })), /smallest leaf/);
  assert.throws(() => checkSettings(Object.assign({}, base, { exit_delay_units: [338, 254] })), /exit delays/);
  assert.throws(() => checkSettings(Object.assign({}, base, { assets: [{ asset: A, min_leaf: '5', rate: { source: 'file', path: 'rel.json' } }] })), /absolute path/);
  assert.throws(() => checkSettings(Object.assign({}, base, { assets: [{ asset: A, min_leaf: '5', rate: { source: 'oracle' } }] })), /node, a file or a command/);
  assert.throws(() => checkSettings(Object.assign({}, base, { node: { url: '' } })), /RPC address/);
});

test('arcad\'s configuration carries the runner\'s assets, rates and delays, and nothing by default', () => {
  const d = tmp();
  const op = new SequentiaOperator({ dir: d, bins: { arcad: '/x/arcad', signer: '/x/arca-signer' }, pg: { port: 25999 } });
  const text = op.config({ node, assets: [{ asset: B, min_leaf: '500', refresh_ppm: 10, rate: { source: 'command', command: '/bin/rate --x' } }, { asset: A, min_leaf: '1000', rate: { source: 'node' } }] }, 'pw"');
  assert.ok(text.includes('exit_delay_units = [254, 338]'));
  assert.ok(text.includes('database = "postgres://arca:pw%22@127.0.0.1:25999/arca"'));
  assert.ok(text.indexOf(B) < text.indexOf(A), 'the assets are served in the order listed');
  assert.ok(text.includes('command = ["/bin/rate", "--x"]'));
  assert.ok(text.includes('rpc_password = "p"'));
  assert.ok(text.includes('[watcher]\nenabled = true'));
  assert.ok(!/fee_assets/.test(text), 'no asset is named a fee asset by the app');
});

test('a Bitcoin ark\'s settings', () => {
  const s = checkArkSettings({ bitcoind: { url: 'http://127.0.0.1:18443/' } });
  assert.strictEqual(s.network, 'testnet4');
  assert.throws(() => checkArkSettings({ network: 'testnet3', bitcoind: { url: 'http://x:1/' } }), /network is one of/);
  assert.throws(() => checkArkSettings({ bitcoind: { url: 'http://x:1/' }, vtxo_lifetime: 100, vtxo_exit_delta: 60 }), /more than twice/);
  const ark = new BitcoinArk({ dir: tmp(), bins: {}, pg: { port: 25999 } });
  const c = ark.captaindConfig({ network: 'regtest', bitcoind: { url: 'http://127.0.0.1:18443/', cookie: '/c/.cookie' } }, 'pw');
  assert.ok(c.includes('network = "regtest"'));
  assert.ok(c.includes('cookie = "/c/.cookie"'));
  assert.ok(c.includes('max_ln_receive_amount = "0 sat"'), 'Lightning is off: the ark runs no gateway');
  assert.ok(!c.includes('cln_array'));
});

test('protobuf fields are read as Bark\'s ArkInfo carries them', () => {
  const key = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 7)]);
  const msg = Buffer.concat([Buffer.from([0x0a, 7]), Buffer.from('regtest'), Buffer.from([0x12, 33]), key, Buffer.from([0x18, 0x96, 0x01]), Buffer.from([0x68, 0x90, 0x4e])]);
  const f = protoFields(msg);
  assert.strictEqual(f[1][0].toString(), 'regtest');
  assert.strictEqual(f[2][0].toString('hex'), key.toString('hex'));
  assert.strictEqual(Number(f[3][0]), 150);
  assert.strictEqual(Number(f[13][0]), 10000);
});

test('a daemon outlives its starter, is found again by its PID, and stops on its signal', async () => {
  const d = tmp();
  const script = path.join(d, 'standin');
  fs.writeFileSync(script, '#!/bin/sh\necho "standin up $$"\ntrap \'echo "standin got INT"; exit 0\' INT\nwhile :; do sleep 0.1; done\n', { mode: 0o755 });
  const mk = () => new Daemon({ name: 'standin', bin: script, args: [], logFile: path.join(d, 'log', 's.log'), pidFile: path.join(d, 'run', 's.pid'), stopSignal: 'SIGINT', graceMs: 5000 });
  const pid = await mk().start(500);
  // A second Daemon of the same files, as the app's next start makes, finds it.
  const again = mk();
  assert.strictEqual(again.pid(), pid);
  assert.strictEqual(again.status().running, true);
  assert.strictEqual(await again.start(), pid, 'a running daemon is not started twice');
  const r = await again.stop();
  assert.match(r.was, /stopped \(SIGINT\)/);
  assert.strictEqual(again.pid(), null);
  assert.ok(again.log().some((l) => l.includes('standin got INT')));
});

test('a PID the system gave another program is never taken for the daemon', () => {
  const d = tmp();
  const pidFile = path.join(d, 'x.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, bin: '/nowhere/arcad' }));
  const x = new Daemon({ name: 'arcad', bin: '/nowhere/arcad', args: [], logFile: path.join(d, 'x.log'), pidFile });
  assert.strictEqual(x.pid(), null);
});

test('a daemon that exits at once is reported with its last words', async () => {
  const d = tmp();
  const script = path.join(d, 'dies');
  fs.writeFileSync(script, '#!/bin/sh\necho "arcad: the database refused: no such role"\nexit 1\n', { mode: 0o755 });
  const x = new Daemon({ name: 'arcad', bin: script, args: [], logFile: path.join(d, 'l'), pidFile: path.join(d, 'p') });
  await assert.rejects(x.start(800), /arcad exited 1: arcad: the database refused: no such role/);
});

test('Deploy keeps passwords out of what the window reads, and a masked one is the one kept', () => {
  let saved = null;
  const dep = new Deploy({ home: tmp(), bins: {}, settings: () => saved, save: (x) => { saved = x; } });
  dep.save({ sequentia: { node: { url: 'http://n/', password: 'secret' } }, bitcoin: { bitcoind: { url: 'http://b/', password: 'btcsecret' } } });
  const st = dep.status();
  assert.strictEqual(st.settings.sequentia.node.password, MASK);
  assert.strictEqual(st.settings.bitcoin.bitcoind.password, MASK);
  assert.ok(!JSON.stringify(st).includes('secret'));
  dep.save({ sequentia: { node: { url: 'http://n2/', password: MASK } } });
  assert.strictEqual(saved.sequentia.node.password, 'secret');
  assert.strictEqual(saved.sequentia.node.url, 'http://n2/');
  assert.throws(() => dep.save({ backupDir: 'relative' }), /absolute path/);
});

test('a daemon\'s binary is installed into the profile once, under its hash, and never over another', () => {
  const { installBinary } = require('../src/main/deploy');
  const d = tmp();
  const src = path.join(d, 'carried', 'arcad');
  fs.mkdirSync(path.dirname(src));
  fs.writeFileSync(src, 'one');
  const a = installBinary(src, path.join(d, 'bin'));
  assert.notStrictEqual(a, src);
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'one');
  assert.strictEqual(fs.statSync(a).mode & 0o777, 0o700);
  assert.strictEqual(installBinary(src, path.join(d, 'bin')), a, 'the same binary is the same file');
  fs.writeFileSync(src, 'two');
  const b = installBinary(src, path.join(d, 'bin'));
  assert.notStrictEqual(b, a);
  assert.strictEqual(path.basename(b), 'arcad');
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'one', 'the copy a running daemon uses is left as it is');
});
