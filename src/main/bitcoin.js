'use strict';
// The Bitcoin rail's commands, and how each becomes the arguments of one run
// of `arca`. The Bitcoin side is Bark's own wallet for Bitcoin arks, in
// <wallet directory>/bitcoin, made from the Arca wallet's own mnemonic: native
// BTC in a Bitcoin ark, never a Sequentia leaf. `arca` runs Bark for it:
//
//   create           `arca bitcoin create`, the mnemonic handed to Bark's daemon
//                    in a request body, never on a command line
//   Lightning        `arca lightning pay | receive btc | claim`, which read back
//                    what Bark does not print
//   everything else  `arca bitcoin --quiet …`, Bark's own command and its JSON
//
// Every argument is checked for its form here; Bark checks its meaning. Bark
// lets one process at a time open its wallet, so these all run on one queue
// of their own (main.js), apart from the Sequentia side's.

const NETWORKS = ['testnet4', 'mainnet', 'signet', 'mutinynet', 'regtest'];
const URL_RE = /^https?:\/\/[^\s]+$/;
const SATS = /^[0-9]{1,15}$/;
// Destinations Bark's `send` takes, kept to their characters: an Ark address,
// a Bitcoin address, a BIP-321 URI, a Lightning address.
const DEST = /^[A-Za-z0-9:?=&%._+@/-]{8,2000}$/;
const INVOICE = /^(lightning:)?ln[a-z0-9]{8,2000}$/i;

function btcArgv(command, a = {}) {
  const need = (ok, what) => { if (!ok) throw new Error(`${what} is not valid`); };
  const sats = (v) => { need(SATS.test(String(v)) && Number(v) > 0, 'the amount'); return String(v); };
  const q = (...rest) => ['bitcoin', '--quiet', ...rest];
  switch (command) {
    case 'create': {
      need(NETWORKS.includes(a.network), 'the network');
      need(URL_RE.test(a.ark || ''), 'the ark\'s address');
      const out = ['bitcoin', 'create', `--${a.network}`, '--ark', a.ark];
      if (a.source === 'esplora') {
        need(URL_RE.test(a.esplora || ''), 'the Esplora address');
        out.push('--esplora', a.esplora);
      } else {
        need(URL_RE.test(a.bitcoind || ''), 'the Bitcoin Core node\'s address');
        out.push('--bitcoind', a.bitcoind);
        if (a.cookie) out.push('--bitcoind-cookie', String(a.cookie));
        else { need(/^[^\s]+$/.test(a.user || ''), 'the Bitcoin Core node\'s user'); out.push('--bitcoind-user', a.user); }
      }
      if (a.birthday_height != null && a.birthday_height !== '') {
        need(/^[0-9]{1,9}$/.test(String(a.birthday_height)), 'the height to scan from');
        out.push('--birthday-height', String(a.birthday_height));
      }
      return out;
    }
    case 'ark_info': return q('ark-info');
    case 'balance': return q('balance');
    case 'onchain_balance': return q('onchain', 'balance');
    case 'onchain_address': return q('onchain', 'address');
    case 'address': return q('address');
    case 'vtxos': return q('vtxos');
    case 'history': return q('history');
    case 'board': return q('board', `${sats(a.amount)} sats`);
    case 'send': {
      const d = String(a.destination || '').trim();
      need(DEST.test(d) && !INVOICE.test(d), 'the destination');
      return q('send', d, `${sats(a.amount)} sats`);
    }
    case 'refresh': return q('refresh', '--all');
    case 'maintain': return q('maintain');
    case 'exit_estimate': return q('exit', 'estimate-fee', '--all');
    case 'exit_start': return q('exit', 'start', '--all');
    case 'exit_progress': return q('exit', 'progress');
    case 'exit_list': return q('exit', 'list');
    case 'exit_claim': {
      need(/^[a-z0-9]{14,90}$/i.test(String(a.address || '')), 'the address');
      return q('exit', 'claim', a.address, '--all');
    }
    case 'ln_pay': {
      const inv = String(a.invoice || '').trim();
      need(INVOICE.test(inv), 'the invoice');
      return ['lightning', 'pay', inv, '--asset', 'btc'];
    }
    case 'ln_receive': {
      const out = ['lightning', 'receive', 'btc', sats(a.amount)];
      if (a.description) { need(String(a.description).length <= 200, 'the description'); out.push('--description', String(a.description)); }
      return out;
    }
    case 'ln_claim': {
      const inv = String(a.invoice || '').trim();
      need(INVOICE.test(inv), 'the invoice');
      const wait = a.wait == null ? 25 : Number(a.wait);
      need(Number.isInteger(wait) && wait > 0 && wait <= 600, 'the wait');
      return ['lightning', 'claim', inv, '--wait', String(wait)];
    }
    default: throw new Error(`no Bitcoin command ${command}`);
  }
}

// What the Bitcoin side holds, in satoshis, from Bark's ark balance and its
// on-chain balance, as `arca balance` counts it: every amount of the ark
// balance (spendable, pending in a round, a board, an exit, a Lightning
// payment either way) and the on-chain wallet's total.
function btcTotal(ark, onchain) {
  if (!ark || !onchain) return null;
  let t = 0;
  for (const [k, v] of Object.entries(ark)) if (k.endsWith('_sat') && Number.isFinite(v)) t += v;
  if (!Number.isFinite(onchain.total_sat)) return null;
  return t + onchain.total_sat;
}

// The server's fee for a board of `sats`, from its schedule (`ark-info`'s
// fees.board): the miner's fee of the board transaction comes on top.
function boardFee(info, sats) {
  const f = info && info.fees && info.fees.board;
  if (!f) return null;
  const n = Number(sats);
  return Math.max(f.min_fee_sat || 0, (f.base_fee_sat || 0) + Math.ceil((n * (f.ppm || 0)) / 1e6));
}

module.exports = { btcArgv, btcTotal, boardFee, NETWORKS };
