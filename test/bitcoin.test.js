'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { btcArgv, btcTotal, boardFee } = require('../src/main/bitcoin');
const { parseRun } = require('../src/main/arca');
const { rails } = require('../src/main/rails');

const INV = 'lnbcrt120u1p4d0d0ysp59d0kg0xklm24jlle2utp76yuzrgm7jk59a95zhyvqams87940v0s';

test('create: the network, the ark and one chain source; the mnemonic is never an argument', () => {
  assert.deepStrictEqual(btcArgv('create', { network: 'testnet4', ark: 'https://ark.example.org', bitcoind: 'http://127.0.0.1:48332/', cookie: '/c/.cookie' }),
    ['bitcoin', 'create', '--testnet4', '--ark', 'https://ark.example.org', '--bitcoind', 'http://127.0.0.1:48332/', '--bitcoind-cookie', '/c/.cookie']);
  assert.deepStrictEqual(btcArgv('create', { network: 'regtest', ark: 'http://127.0.0.1:1', source: 'esplora', esplora: 'https://e.example/api', birthday_height: '150' }),
    ['bitcoin', 'create', '--regtest', '--ark', 'http://127.0.0.1:1', '--esplora', 'https://e.example/api', '--birthday-height', '150']);
  // A user, its password in the environment (main.js), never here.
  const u = btcArgv('create', { network: 'testnet4', ark: 'https://a.example', bitcoind: 'http://n.example', user: 'rpc', password: 'secret' });
  assert.ok(!u.includes('secret'));
  assert.deepStrictEqual(u.slice(-2), ['--bitcoind-user', 'rpc']);
  assert.throws(() => btcArgv('create', { network: 'testnet', ark: 'https://a.example', bitcoind: 'http://n' }), /the network/);
  assert.throws(() => btcArgv('create', { network: 'testnet4', ark: 'ark.example', bitcoind: 'http://n' }), /the ark/);
  assert.throws(() => btcArgv('create', { network: 'testnet4', ark: 'https://a.example', bitcoind: 'http://n' }), /user/);
});

test('Bark\'s own commands run quiet, and Lightning goes through arca\'s calls', () => {
  assert.deepStrictEqual(btcArgv('balance'), ['bitcoin', '--quiet', 'balance']);
  assert.deepStrictEqual(btcArgv('board', { amount: '200000' }), ['bitcoin', '--quiet', 'board', '200000 sats']);
  assert.deepStrictEqual(btcArgv('send', { destination: ' tark1pw07fyu3zqqp ', amount: 20000 }), ['bitcoin', '--quiet', 'send', 'tark1pw07fyu3zqqp', '20000 sats']);
  assert.deepStrictEqual(btcArgv('exit_claim', { address: 'bcrt1pusjg0ghdgfufx70ex6lk' }), ['bitcoin', '--quiet', 'exit', 'claim', 'bcrt1pusjg0ghdgfufx70ex6lk', '--all']);
  assert.deepStrictEqual(btcArgv('ln_pay', { invoice: INV }), ['lightning', 'pay', INV, '--asset', 'btc']);
  assert.deepStrictEqual(btcArgv('ln_receive', { amount: 15000, description: 'coffee' }), ['lightning', 'receive', 'btc', '15000', '--description', 'coffee']);
  assert.deepStrictEqual(btcArgv('ln_claim', { invoice: INV }), ['lightning', 'claim', INV, '--wait', '25']);
  // An invoice is paid over Lightning, never by Bark's send.
  assert.throws(() => btcArgv('send', { destination: INV, amount: 1 }), /destination/);
  assert.throws(() => btcArgv('board', { amount: '0' }), /amount/);
  assert.throws(() => btcArgv('send', { destination: 'tark1 x; rm', amount: 1 }), /destination/);
  assert.throws(() => btcArgv('nope'), /no Bitcoin command/);
});

test('BTC\'s total counts the ark and the on-chain wallet; a board\'s server fee from its schedule', () => {
  assert.strictEqual(btcTotal({ spendable_sat: 1000, pending_exit_sat: 20, pending_board_sat: 0 }, { total_sat: 300, confirmed_sat: 300 }), 1320);
  assert.strictEqual(btcTotal(null, { total_sat: 1 }), null);
  const info = { fees: { board: { min_fee_sat: 330, base_fee_sat: 100, ppm: 1000 } } };
  assert.strictEqual(boardFee(info, 200000), 330);
  assert.strictEqual(boardFee(info, 1000000), 1100);
});

test('a run of Bark\'s own command: a bare answer is text, a refusal Bark\'s words', () => {
  assert.deepStrictEqual(parseRun(0, null, 'tark1pw07fyu3zq\n', '', { bark: true }), { ok: true, result: 'tark1pw07fyu3zq', notes: [] });
  assert.deepStrictEqual(parseRun(0, null, '{"spendable_sat": 5}', '', { bark: true }).result, { spendable_sat: 5 });
  const no = parseRun(1, null, '', 'Error: Insufficient money available\n', { bark: true });
  assert.deepStrictEqual(no.refusal, { kind: 'bark', message: 'Insufficient money available' });
  // Without the flag, a bare answer is still no answer of the wallet's.
  assert.strictEqual(parseRun(0, null, 'tark1', '').ok, false);
});

test('Bark named or beside arca installs the Bitcoin rail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-rails-'));
  try {
    const arca = path.join(dir, 'arca');
    fs.writeFileSync(arca, '');
    const elsewhere = path.join(dir, 'b', 'bark');
    fs.mkdirSync(path.dirname(elsewhere));
    fs.writeFileSync(elsewhere, '');
    const r = rails(arca, elsewhere);
    assert.strictEqual(r[0].installed, true);
    assert.strictEqual(r[0].bin, elsewhere);
    assert.match(r[0].note, /Native BTC in a Bitcoin ark/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
