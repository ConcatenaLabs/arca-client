'use strict';
// The secrets an operator the app runs is made from, drawn on this machine and
// written to files only their owner can read. None ever leaves the machine or
// appears on a command line.
//
//   key        the operator key S: 32 random bytes as 64 hex characters, the
//              form arca-signer's --key-file reads.
//   mnemonic   a BIP39 mnemonic of 12 words (128 bits of entropy and its
//              checksum), from the English list in bip39-english.txt, the
//              form arcad's wallet_mnemonic_file reads.
//   password   a database password: 32 random bytes, hex.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let WORDS = null;
function words() {
  if (!WORDS) {
    WORDS = fs.readFileSync(path.join(__dirname, 'bip39-english.txt'), 'utf8').split('\n').map((w) => w.trim()).filter(Boolean);
    if (WORDS.length !== 2048) throw new Error('the BIP39 word list is not 2048 words');
  }
  return WORDS;
}

// A mnemonic from `entropy` (16 to 32 bytes, a multiple of 4): the entropy's
// bits, then the first entropy_bits/32 bits of its SHA-256, read 11 bits a word.
function mnemonicFromEntropy(entropy) {
  if (!Buffer.isBuffer(entropy) || entropy.length < 16 || entropy.length > 32 || entropy.length % 4) throw new Error('entropy must be 16 to 32 bytes, a multiple of 4');
  const hash = crypto.createHash('sha256').update(entropy).digest();
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('')
    + [...hash].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, entropy.length * 8 / 32);
  const list = words();
  const out = [];
  for (let i = 0; i < bits.length; i += 11) out.push(list[parseInt(bits.slice(i, i + 11), 2)]);
  return out.join(' ');
}

function newMnemonic() { return mnemonicFromEntropy(crypto.randomBytes(16)); }
function newKeyHex() { return crypto.randomBytes(32).toString('hex'); }
function newPassword() { return crypto.randomBytes(32).toString('hex'); }

// Writes `text` to `file` for its owner alone, never over a file that exists:
// a secret once made is never replaced by the app.
function writeSecret(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, text.endsWith('\n') ? text : text + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readSecret(file) { return fs.readFileSync(file, 'utf8').trim(); }

module.exports = { mnemonicFromEntropy, newMnemonic, newKeyHex, newPassword, writeSecret, readSecret };
