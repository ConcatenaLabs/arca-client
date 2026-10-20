'use strict';
// The wallet commands the window may ask for, and how each becomes the
// arguments of one run of `arca`. Nothing else reaches the command line: every
// argument is checked for its form here, and the wallet checks its meaning.
// Whatever signs or broadcasts at a fee goes ahead only on the fee the window
// showed (`shown`), which the wallet compares with the fee now.

const ASSET = /^[0-9a-f]{64}$/;
const LEAF = /^[0-9a-f]{64}$/;
function argv(command, a = {}) {
  const need = (ok, what) => { if (!ok) throw new Error(`${what} is not valid`); };
  const amount = (v) => { need(/^[0-9]+$/.test(String(v)), 'the amount'); return String(v); };
  switch (command) {
    // The Bitcoin side is read on its own queue (main.js): Bark lets one
    // process at a time open its wallet.
    case 'balance': return ['balance', '--without-bitcoin'];
    case 'info': case 'address': case 'coins': case 'boards': case 'mailbox':
    case 'participations': case 'sync': case 'schedule': case 'recheck': case 'refusals': case 'restore':
      return [command];
    case 'record': need(LEAF.test(a.leaf_id), 'the coin'); return ['record', a.leaf_id];
    case 'board_quote': case 'board': {
      need(ASSET.test(a.asset), 'the asset');
      const out = ['board', a.asset, amount(a.amount)];
      if (a.fee_asset) { need(ASSET.test(a.fee_asset), 'the fee asset'); out.push('--fee-asset', a.fee_asset); }
      if (command === 'board_quote') out.push('--quote');
      else { need(a.shown && typeof a.shown === 'object', 'the fee shown'); out.push('--shown', JSON.stringify(a.shown)); }
      return out;
    }
    case 'receive': {
      const out = ['receive'];
      if (a.asset) { need(ASSET.test(a.asset), 'the asset'); out.push('--asset', a.asset); }
      if (a.amount) out.push('--amount', amount(a.amount));
      return out;
    }
    case 'forget_request': need(/^([0-9a-f]{64}|restored)$/.test(a.owner), 'the request'); return ['forget-request', a.owner];
    case 'send': {
      need(typeof a.request === 'string' && a.request.length > 8 && !/\s/.test(a.request.trim()), 'the receive request');
      const out = ['send', a.request.trim()];
      if (a.amount) out.push('--amount', amount(a.amount));
      if (a.asset) { need(ASSET.test(a.asset), 'the asset'); out.push('--asset', a.asset); }
      return out;
    }
    case 'quote': case 'participate': {
      const out = [command];
      for (const l of a.leaves || []) { need(LEAF.test(l), 'a coin'); out.push('--leaf', l); }
      if (a.max_fee_ppm != null && a.max_fee_ppm !== '') out.push('--max-fee-ppm', amount(a.max_fee_ppm));
      if (command === 'participate') {
        need(Array.isArray(a.shown), 'the fees shown');
        out.push('--shown', JSON.stringify(a.shown));
      }
      return out;
    }
    case 'exit_quote': case 'exit': {
      need(LEAF.test(a.leaf_id), 'the coin');
      const out = ['exit', a.leaf_id];
      if (a.fee_asset) { need(ASSET.test(a.fee_asset), 'the fee asset'); out.push('--fee-asset', a.fee_asset); }
      if (command === 'exit_quote') out.push('--quote');
      else { need(a.shown && typeof a.shown === 'object', 'the fees shown'); out.push('--shown', JSON.stringify(a.shown)); }
      return out;
    }
    default: throw new Error(`no command ${command}`);
  }
}

module.exports = { argv, WALLET_COMMANDS: ['info', 'address', 'balance', 'coins', 'boards', 'mailbox', 'participations', 'sync', 'schedule',
  'recheck', 'refusals', 'restore', 'record', 'board_quote', 'board', 'receive', 'forget_request', 'send', 'quote', 'participate',
  'exit_quote', 'exit'] };
