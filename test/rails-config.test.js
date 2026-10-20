'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rails } = require('../src/main/rails');
const { defaultConfig, loadConfig, saveConfig } = require('../src/main/config');

test('BTC\'s rail comes first, shown even when its software is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-rails-'));
  try {
    const arca = path.join(dir, 'arca');
    fs.writeFileSync(arca, '');
    let r = rails(arca);
    assert.deepStrictEqual(r.map((x) => x.id), ['bitcoin', 'sequentia']);
    assert.strictEqual(r[0].asset, 'BTC');
    assert.strictEqual(r[0].installed, false);
    assert.match(r[0].note, /does not carry Bark/);
    assert.strictEqual(r[1].installed, true);
    fs.writeFileSync(path.join(dir, 'bark'), '');
    r = rails(arca);
    assert.strictEqual(r[0].installed, true, 'Bark beside arca installs the Bitcoin rail');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settings are written for their owner alone, and read back over the defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-config-'));
  try {
    const d = defaultConfig(dir);
    assert.strictEqual(d.datadir, path.join(dir, 'sequentia'));
    const c = loadConfig(dir, d);
    assert.deepStrictEqual(c, d, 'no file: the defaults');
    c.node.password = 'pw'; c.operator.url = 'https://op.example/arca'; c.mode = 'nonsense';
    saveConfig(dir, c);
    assert.strictEqual(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);
    const back = loadConfig(dir, d);
    assert.strictEqual(back.node.password, 'pw');
    assert.strictEqual(back.operator.url, 'https://op.example/arca');
    assert.strictEqual(back.mode, 'bundled', 'an unknown mode falls back to the bundled client');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
