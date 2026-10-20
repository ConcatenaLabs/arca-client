'use strict';
// The rails the app holds a wallet on, one per chain. Every rail is shown,
// installed or not, so a holding never disappears from the wallet because its
// software is missing: BTC's row is there from the first start, with what is
// needed for it.
//
//   sequentia  Arca coins and on-chain coins of every Sequentia asset, through
//              the Arca command-line client (`arca`), against an Arca operator
//              and a Sequentia Core node.
//   bitcoin    BTC, in a Bitcoin ark through Bark, against Bitcoin Core or an
//              Esplora server. The app carries Bark's client and daemon
//              (`bark`, `barkd`) beside `arca`, which runs them for its
//              Bitcoin side (`<datadir>/bitcoin`, made from the wallet's own
//              mnemonic); a build without Bark shows the rail, empty, saying
//              so.
//
// A rail is {id, chain, label, asset, installed, note}. The renderer lays the
// wallet out from this list; adding a rail is adding an entry and its manager.

const fs = require('fs');
const path = require('path');

// Bark's client, `bark`: the one named, else the one beside arca.
function barkBeside(arcaBin) {
  return arcaBin ? path.join(path.dirname(arcaBin), process.platform === 'win32' ? 'bark.exe' : 'bark') : null;
}

function bitcoinRail(arcaBin, barkBin) {
  const bark = barkBin || barkBeside(arcaBin);
  const installed = !!(bark && fs.existsSync(bark));
  return {
    id: 'bitcoin', chain: 'Bitcoin', label: 'Bitcoin', asset: 'BTC', installed,
    bin: installed ? bark : null,
    note: installed
      ? 'Native BTC in a Bitcoin ark, through Bark, against Bitcoin Core or Esplora.'
      : 'BTC is held on Bitcoin itself, in a Bitcoin ark through Bark. This build does not carry Bark, so the Bitcoin side holds nothing here.',
  };
}

function sequentiaRail(arcaBin) {
  const installed = !!(arcaBin && fs.existsSync(arcaBin));
  return {
    id: 'sequentia', chain: 'Sequentia', label: 'Sequentia', asset: null, installed, bin: installed ? arcaBin : null,
    note: installed
      ? 'Every Sequentia asset, as Arca coins and on-chain coins, against an Arca operator and a Sequentia Core node.'
      : 'The Arca client (arca) was not found.',
  };
}

// BTC first, always: it is a first-class holding on its own chain.
function rails(arcaBin, barkBin) {
  return [bitcoinRail(arcaBin, barkBin), sequentiaRail(arcaBin)];
}

module.exports = { rails, bitcoinRail, sequentiaRail, barkBeside };
