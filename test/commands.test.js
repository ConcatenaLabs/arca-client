'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { argv, WALLET_COMMANDS } = require('../src/main/commands');

const X = '75'.repeat(32);
const L = 'ab'.repeat(32);

test('each wallet command becomes the arguments of arca', () => {
  assert.deepStrictEqual(argv('balance'), ['balance']);
  assert.deepStrictEqual(argv('board_quote', { asset: X, amount: '2000000' }), ['board', X, '2000000', '--quote']);
  const fee = { asset: X, amount: '30' };
  assert.deepStrictEqual(argv('board', { asset: X, amount: 5, fee_asset: X, shown: fee }), ['board', X, '5', '--fee-asset', X, '--shown', JSON.stringify(fee)]);
  assert.deepStrictEqual(argv('receive', { asset: X, amount: '300000' }), ['receive', '--asset', X, '--amount', '300000']);
  assert.deepStrictEqual(argv('receive', {}), ['receive']);
  assert.deepStrictEqual(argv('send', { request: ' arca:7b22 ', amount: '1' }), ['send', 'arca:7b22', '--amount', '1']);
  assert.deepStrictEqual(argv('quote', { leaves: [L] }), ['quote', '--leaf', L]);
  const shown = [{ leaf_id: L, fee: '0' }];
  assert.deepStrictEqual(argv('participate', { leaves: [], shown }), ['participate', '--shown', JSON.stringify(shown)]);
  assert.deepStrictEqual(argv('exit_quote', { leaf_id: L }), ['exit', L, '--quote']);
  assert.deepStrictEqual(argv('exit', { leaf_id: L, shown: { [X]: '200' } }), ['exit', L, '--shown', JSON.stringify({ [X]: '200' })]);
  assert.deepStrictEqual(argv('exit', { leaf_id: L, shown: {} }), ['exit', L, '--shown', '{}']);
  assert.deepStrictEqual(argv('forget_request', { owner: 'restored' }), ['forget-request', 'restored']);
  for (const c of WALLET_COMMANDS) assert.doesNotThrow(() => { try { argv(c, {}); } catch (e) { if (!/is not valid/.test(e.message)) throw e; } }, c);
});

test('nothing but a command\'s own arguments reaches the command line', () => {
  assert.throws(() => argv('board', { asset: '--datadir', amount: '1' }), /the asset is not valid/);
  assert.throws(() => argv('board', { asset: X, amount: '1' }), /the fee shown is not valid/, 'no board without the fee shown');
  assert.throws(() => argv('exit', { leaf_id: L }), /the fees shown is not valid/, 'no exit without the fees shown');
  assert.throws(() => argv('board', { asset: X, amount: '1 --fee-asset x' }), /the amount is not valid/);
  assert.throws(() => argv('board', { asset: X, amount: '-5' }), /the amount is not valid/);
  assert.throws(() => argv('send', { request: 'arca:00 --amount 5' }), /the receive request is not valid/);
  assert.throws(() => argv('exit', { leaf_id: '../../x' }), /the coin is not valid/);
  assert.throws(() => argv('participate', { leaves: [] }), /the fees shown is not valid/, 'no participation without the fees shown');
  assert.throws(() => argv('create', {}), /no command create/);
  assert.throws(() => argv('bitcoin', {}), /no command bitcoin/);
});
