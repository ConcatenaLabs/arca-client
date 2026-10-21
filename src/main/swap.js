'use strict';
// The swap of native BTC in a Bitcoin ark for an asset in the operator's
// tree, with another wallet of the operator, under one payment hash
// (`arca btc-swap`): its commands, and how each becomes the arguments of one
// run of `arca`. The wallet library holds the swap; `arca` runs Bark for its
// Bitcoin side. A run opens both the Arca wallet and Bark's, so it holds
// both queues (main.js).
//
//   offer      what the wallet gives (`btc` or `asset`), the asset, its atoms
//              and the satoshis: the offer's text and what it gives and gets,
//              every fee shown; nothing locked
//   read       what taking an offer gives and gets, every fee shown
//   take       takes an offer: the take's text for the maker
//   complete   the maker completes its offer with the take
//   follow     moves the swaps on, running Bark as each needs
//   list       every swap with its state and log
//   cancel     ends a swap the wallet has locked nothing of

const ASSET = /^[0-9a-f]{64}$/;
const SWAP = /^[0-9a-f]{64}$/;
const COUNT = /^[0-9]{1,15}$/;
const OFFER = /^btc-swap-offer:[0-9a-f]{2,20000}$/;
const TAKE = /^btc-swap-take:[0-9a-f]{2,20000}$/;

function swapArgv(command, a = {}) {
  const need = (ok, what) => { if (!ok) throw new Error(`${what} is not valid`); };
  const count = (v, what) => { need(COUNT.test(String(v)) && Number(v) > 0, what); return String(v); };
  const text = (v, re, what) => { const t = String(v || '').trim(); need(re.test(t), what); return t; };
  switch (command) {
    case 'offer': {
      need(a.give === 'btc' || a.give === 'asset', 'what the wallet gives');
      need(ASSET.test(a.asset || ''), 'the asset');
      const out = ['btc-swap', 'offer', '--give', a.give, '--asset', a.asset, '--atoms', count(a.atoms, 'the atoms'),
        '--sats', count(a.sats, 'the satoshis')];
      if (a.lapse_seconds != null && a.lapse_seconds !== '') out.push('--lapse-seconds', count(a.lapse_seconds, 'the lapse'));
      return out;
    }
    case 'read': return ['btc-swap', 'read', text(a.offer, OFFER, 'the offer')];
    case 'take': return ['btc-swap', 'take', text(a.offer, OFFER, 'the offer')];
    case 'complete': return ['btc-swap', 'complete', text(a.take, TAKE, 'the take')];
    case 'follow': {
      const out = ['btc-swap', 'follow'];
      if (a.swap) { need(SWAP.test(a.swap), 'the swap'); out.push(a.swap); }
      const wait = a.wait == null ? 20 : Number(a.wait);
      need(Number.isInteger(wait) && wait >= 0 && wait <= 600, 'the wait');
      const slice = a.claim_slice == null ? 15 : Number(a.claim_slice);
      need(Number.isInteger(slice) && slice >= 5 && slice <= 120, 'the claim slice');
      out.push('--wait', String(wait), '--claim-slice', String(slice));
      return out;
    }
    case 'list': return ['btc-swap', 'list'];
    case 'cancel': need(SWAP.test(a.swap || ''), 'the swap'); return ['btc-swap', 'cancel', a.swap];
    default: throw new Error(`no swap command ${command}`);
  }
}

// The states a swap ends in; any other is under way, and the follow loop runs
// often while one is.
const OVER = ['done', 'refunded', 'lapsed', 'cancelled', 'abandoned', 'btc_failed'];
function activeSwaps(list) {
  const swaps = (list && list.swaps) || {};
  return Object.values(swaps).filter((s) => !OVER.includes(s.state));
}

module.exports = { swapArgv, activeSwaps, OVER };
