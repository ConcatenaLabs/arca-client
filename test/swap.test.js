'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { swapArgv, activeSwaps } = require('../src/main/swap');
const { ArcaRunner } = require('../src/main/arca');

const X = 'da6f7c0cb71fa6ddb465b6cb00d4be45d6b649a47ab6a35fa39b0ee16b580131';
const ID = 'd7889e8b061e798a26c31d62d860f48afb4cde82748cf9b99151b113a25739d0';

test('an offer names what the wallet gives, the asset and both amounts, every one checked', () => {
  assert.deepStrictEqual(swapArgv('offer', { give: 'asset', asset: X, atoms: '100000', sats: 30000 }),
    ['btc-swap', 'offer', '--give', 'asset', '--asset', X, '--atoms', '100000', '--sats', '30000']);
  assert.deepStrictEqual(swapArgv('offer', { give: 'btc', asset: X, atoms: 1, sats: 2, lapse_seconds: '600' }).slice(-2), ['--lapse-seconds', '600']);
  assert.throws(() => swapArgv('offer', { give: 'sbtc', asset: X, atoms: 1, sats: 1 }), /what the wallet gives/);
  assert.throws(() => swapArgv('offer', { give: 'btc', asset: 'X', atoms: 1, sats: 1 }), /the asset/);
  assert.throws(() => swapArgv('offer', { give: 'btc', asset: X, atoms: 0, sats: 1 }), /the atoms/);
  assert.throws(() => swapArgv('offer', { give: 'btc', asset: X, atoms: 1, sats: '1 --wait' }), /the satoshis/);
});

test('texts handed over are taken only as what they say they are', () => {
  const offer = 'btc-swap-offer:7b7d';
  const take = 'btc-swap-take:7b7d';
  assert.deepStrictEqual(swapArgv('read', { offer: ` ${offer}\n` }), ['btc-swap', 'read', offer]);
  assert.deepStrictEqual(swapArgv('take', { offer }), ['btc-swap', 'take', offer]);
  assert.deepStrictEqual(swapArgv('complete', { take }), ['btc-swap', 'complete', take]);
  assert.throws(() => swapArgv('take', { offer: take }), /the offer/);
  assert.throws(() => swapArgv('complete', { take: offer }), /the take/);
  assert.throws(() => swapArgv('take', { offer: 'btc-swap-offer:7b7d --x' }), /the offer/);
});

test('follow, list and cancel', () => {
  assert.deepStrictEqual(swapArgv('follow', {}), ['btc-swap', 'follow', '--wait', '20', '--claim-slice', '15']);
  assert.deepStrictEqual(swapArgv('follow', { swap: ID, wait: 0, claim_slice: 15 }), ['btc-swap', 'follow', ID, '--wait', '0', '--claim-slice', '15']);
  assert.throws(() => swapArgv('follow', { claim_slice: 1 }), /the claim slice/);
  assert.deepStrictEqual(swapArgv('list'), ['btc-swap', 'list']);
  assert.deepStrictEqual(swapArgv('cancel', { swap: ID }), ['btc-swap', 'cancel', ID]);
  assert.throws(() => swapArgv('cancel', { swap: 'abc' }), /the swap/);
  assert.throws(() => swapArgv('pay', {}), /no swap command/);
});

test('a swap is under way until it ends', () => {
  const list = { swaps: { a: { state: 'locked' }, b: { state: 'done' }, c: { state: 'offered' }, d: { state: 'btc_failed' }, e: { state: 'refunded' } } };
  assert.deepStrictEqual(activeSwaps(list).map((s) => s.state), ['locked', 'offered']);
  assert.deepStrictEqual(activeSwaps(null), []);
});

test('a hold keeps the queue: what was queued before ends first, what comes after waits', async () => {
  const r = new ArcaRunner({ bin: '/nonexistent/arca', datadir: '/nonexistent/w' });
  const order = [];
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const first = r.hold(async () => { order.push('first start'); await sleep(50); order.push('first end'); });
  const held = r.hold(async () => { order.push('held start'); await sleep(30); order.push('held end'); return 7; });
  const after = r.hold(async () => { order.push('after'); });
  assert.strictEqual(await held, 7);
  await Promise.all([first, after]);
  assert.deepStrictEqual(order, ['first start', 'first end', 'held start', 'held end', 'after']);
  r.stopping = true;
  await assert.rejects(r.hold(async () => {}), /stopping/);
});
