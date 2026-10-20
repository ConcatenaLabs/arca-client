// The Bitcoin rail driven end to end: a fresh install joins an Arca operator,
// then makes its Bitcoin ark wallet from the same mnemonic and joins a
// Bitcoin ark on regtest; it boards BTC, sends and receives in the ark, pays
// and receives over Lightning (the claim run for the user, and a fresh
// invoice when a payment can no longer be claimed), refreshes, and exits
// alone; a second install restored from the mnemonic finds the same BTC.
// Every step is clicked in the app's window (Playwright for Electron),
// photographed, and its effect checked at the Bitcoin node or the Lightning
// peer.
//
// It needs two harnesses kept running: arca's operator harness (as
// drive.mjs), at its control address, and a Bitcoin ark on regtest
// (arca's contrib/bitcoin-ark-regtest/regtest.sh, after `up`), named by a
// script that runs it with its environment:
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_BITCOIN_ARK=/path/to/ark.sh \
//     node test/e2e/drive-bitcoin.mjs <evidence dir>
//
// The counterpart in the ark is a Bark wallet run with the `bark` the app
// carries (build/bark-linux-x64, staged by build/make-bark-bundle.sh).
// ARCA_CLIENT_APP names a packaged app's executable to drive instead.
import { _electron as electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const ARK = process.env.ARCA_BITCOIN_ARK;
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test-results', 'drive-bitcoin'));
const BARK = process.env.ARCA_CLIENT_BARK || path.join(ROOT, 'build', 'bark-linux-x64', 'bin', 'bark');
if (!ARK) { console.error('ARCA_BITCOIN_ARK names no Bitcoin ark harness'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-client-btc-drive-'));
const LOG = fs.createWriteStream(path.join(OUT, 'drive.log'));

let checks = 0;
let shots = 0;
const T0 = Date.now();
function log(...a) {
  const l = `${String(((Date.now() - T0) / 1000).toFixed(1)).padStart(6)}s ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(l); LOG.write(l + '\n');
}
function check(ok, what, detail) {
  if (!ok) { log(`FAIL ${what}`, detail ?? ''); throw new Error(`check failed: ${what}`); }
  checks++; log(`ok   ${what}${detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
async function ctl(p, body) {
  const r = await fetch(`http://${CONTROL}${p}`, { method: body === undefined && p === '/state' ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`control ${p}: ${JSON.stringify(j)}`);
  return j;
}
function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      const s = stdout.trim(); const i = s.indexOf('{'); const k = s.indexOf('[');
      const at = [i, k].filter((x) => x >= 0).sort((x, y) => x - y)[0];
      let j; try { j = JSON.parse(at === undefined ? s : s.slice(at)); } catch { j = s; }
      resolve({ ok: !err, json: j, stderr: stderr.trim() });
    });
  });
}
const ark = async (...args) => { const r = await run(ARK, args); if (!r.ok) throw new Error(`ark.sh ${args.join(' ')}: ${r.stderr}`); return r.json; };
const mine = (n) => ark('mine', String(n));
const height = async () => Number(await ark('btc', 'getblockcount'));
const bark = (dir, ...args) => run(BARK, ['--datadir', dir, '--quiet', ...args]);

async function launch(home, name) {
  const env = { ...process.env, ARCA_CLIENT_HOME: home, ARCA_CLIENT_SCHEDULE_POLL_MS: '3000', ARCA_CLIENT_WITNESS_PATIENCE: '5',
    ARCA_CLIENT_OFFSCREEN: process.env.ARCA_CLIENT_OFFSCREEN || '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const opts = process.env.ARCA_CLIENT_APP ? { executablePath: process.env.ARCA_CLIENT_APP, args: [], env } : { args: [ROOT], cwd: ROOT, env };
  const app = await electron.launch(opts);
  apps.push(app);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { pageErrors.push(String(e)); log(`PAGE ERROR (${name})`, String(e)); });
  page.on('console', (m) => { if (m.type() === 'error') log(`console (${name})`, m.text()); });
  await page.setViewportSize({ width: 1240, height: 860 }).catch(() => {});
  await page.waitForSelector('body');
  return { app, page };
}
const pageErrors = [];
const apps = [];
async function shot(page, name) {
  shots++;
  const f = path.join(OUT, `${String(shots).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f, fullPage: true });
  log(`shot ${path.basename(f)}`);
}
async function nav(page, view) { await page.click(`.nav[data-view=${view}]`); await page.waitForSelector(`.view.active[data-view=${view}]`); }
async function msgOf(page, sel, timeout = 300000) {
  await page.waitForFunction((s) => { const e = document.querySelector(s); return e && e.textContent.trim() && !e.querySelector('.busy'); }, sel, { timeout });
  return (await page.textContent(sel)).trim().replace(/\s+/g, ' ');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms = 240000, each) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    if (each) await each();
    await sleep(1000);
  }
}
const appState = (page) => page.evaluate(() => window.arca.state());
const btc = (page, c, a) => page.evaluate(([cmd, args]) => window.arca.btc(cmd, args), [c, a || {}]);
const summary = async (page) => { const s = await page.evaluate(() => window.arca.btcSummary()); if (!s.ok) throw new Error(JSON.stringify(s.refusal)); return s.result; };
async function join(page, st, mnemonic) {
  await page.fill('[data-testid=node-url]', st.node_url);
  await page.fill('[data-testid=node-user]', st.node_user);
  await page.fill('[data-testid=node-pass]', st.node_password);
  await page.fill('[data-testid=operator-url]', st.server);
  if (mnemonic) { await page.check('[data-testid=wallet-restore]'); await page.fill('[data-testid=mnemonic-in]', mnemonic); }
  await page.click('[data-testid=join]');
  await page.waitForSelector('[data-testid=join-done]:not([hidden]), [data-testid=join-msg] .refusal', { timeout: 300000 });
  if (await page.isVisible('[data-testid=join-msg] .refusal')) throw new Error(`join refused: ${await page.textContent('[data-testid=join-msg]')}`);
  await page.click('[data-testid=join-continue]');
  await page.waitForSelector('.view.active[data-view=wallet]');
}
async function createBtc(page, info, birthday) {
  await nav(page, 'bitcoin');
  await page.waitForSelector('[data-testid=btc-join]:not([hidden])');
  await page.selectOption('[data-testid=btc-network]', 'regtest');
  await page.fill('[data-testid=btc-ark]', info.ark);
  await page.check('[data-testid=btc-src-bitcoind]');
  await page.fill('[data-testid=btc-core-url]', info.bitcoind);
  await page.fill('[data-testid=btc-core-cookie]', info.cookie);
  if (birthday != null) await page.fill('[data-testid=btc-birthday]', String(birthday));
  await page.click('[data-testid=btc-create]');
  return msgOf(page, '[data-testid=btc-create-msg]');
}
// The incoming payment held at the ark's gateway.
async function heldHtlc() {
  const ch = await ark('gw', 'listpeerchannels');
  for (const c of ch.channels) for (const x of c.htlcs || []) if (x.direction === 'in') return x;
  return null;
}
// lightning-cli pay at the peer, in the background: its answer.
function peerPays(invoice) { return run(ARK, ['peer', 'pay', invoice]).then((r) => r.json); }

async function main() {
  const st = await ctl('/state');
  const info = await ark('info');
  log('operator harness:', { server: st.server, node: st.node_url });
  log('Bitcoin ark:', info, 'bark:', BARK, fs.readFileSync(path.join(path.dirname(BARK), '..', 'VERSION'), 'utf8').split('\n').slice(0, 2).join(' · '));

  // The counterpart in the ark: a Bark wallet of its own, funded and boarded.
  const B = path.join(WORK, 'bark-b');
  const bc = await run(BARK, ['--datadir', B, '--quiet', 'create', '--regtest', '--ark', info.ark, '--bitcoind', info.bitcoind, '--bitcoind-cookie', info.cookie]);
  check(bc.ok, 'the counterpart B is a Bark wallet of its own', bc.stderr);
  const bOn = (await bark(B, 'onchain', 'address')).json.address;
  await ark('btc', '-rpcwallet=miner', 'sendtoaddress', bOn, '0.005');
  await mine(1);
  await until('B\'s funding', async () => (await bark(B, 'onchain', 'balance')).json.confirmed_sat >= 500000, 60000, () => mine(1));
  check((await bark(B, 'board', '300000 sats')).ok, 'B boards 300,000 sat');
  await until('B\'s board', async () => (await bark(B, 'balance')).json.spendable_sat > 0, 120000, async () => { await mine(1); await bark(B, 'maintain'); });

  // --- 1. A fresh install joins the Arca operator ---
  const homeA = path.join(WORK, 'app-a');
  const { app, page } = await launch(homeA, 'A');
  await page.waitForSelector('.view.active[data-view=join]');
  await join(page, st);
  let s = await appState(page);
  const DIR = s.datadir;
  check(s.bitcoin.bark && s.rails[0].id === 'bitcoin' && s.rails[0].installed, 'the app carries Bark: the Bitcoin rail is installed', s.bitcoin.bark);
  await page.waitForFunction(() => /sat/.test((document.querySelector('[data-testid=row-BTC] [data-testid=row-total]') || {}).textContent || ''));
  const rows = await page.$$eval('[data-testid=balance-rows] > .bal', (els) => els.map((e) => e.getAttribute('data-testid')));
  check(rows[0] === 'row-BTC', 'BTC\'s row comes first', rows);
  const row0 = (await page.textContent('[data-testid=row-BTC]')).replace(/\s+/g, ' ');
  check(/0 sat/.test(row0) && /No Bitcoin ark wallet yet/.test(row0), 'BTC shows 0, with no Bitcoin ark wallet yet', row0);
  await shot(page, 'wallet-btc-row-empty');

  // --- 2. The Bitcoin ark wallet, from the same mnemonic ---
  await nav(page, 'bitcoin');
  await page.waitForSelector('[data-testid=btc-join]:not([hidden])');
  await shot(page, 'bitcoin-join-form');
  const tip = await height();
  let m = await createBtc(page, info);
  check(/Joined the Bitcoin ark on regtest/.test(m), 'the Bitcoin ark wallet is made and joined', m.slice(0, 160));
  const birthday = Number((m.match(/from height ([\d,]+)/) || [])[1].replace(/,/g, ''));
  check(birthday >= tip, 'a new wallet scans Bitcoin from now', `${birthday} (tip ${tip})`);
  const mn = fs.readFileSync(path.join(DIR, 'mnemonic'), 'utf8').trim();
  check(fs.readFileSync(path.join(DIR, 'bitcoin', 'mnemonic'), 'utf8').trim() === mn, 'the Bitcoin ark wallet holds the Arca wallet\'s own mnemonic');
  check(!fs.existsSync(path.join(DIR, 'bitcoin', 'auth_token')), 'Bark\'s daemon was stopped and its token removed');
  check(!fs.readFileSync(path.join(homeA, 'config', 'config.json'), 'utf8').includes(mn), 'the app\'s settings hold no mnemonic');
  await shot(page, 'bitcoin-created');
  await page.waitForSelector('[data-testid=btc-total]', { timeout: 60000 });
  await shot(page, 'bitcoin-holdings-empty');

  // --- 3. On-chain BTC, then a board ---
  await page.click('[data-testid=btc-onchain-address]');
  await page.waitForSelector('[data-testid=btc-onchain-address-text]');
  const onAddr = (await page.textContent('[data-testid=btc-onchain-address-text]')).trim();
  const va = await ark('btc', 'validateaddress', onAddr);
  check(va.isvalid && /^bcrt1p/.test(onAddr), 'the on-chain address is a Bitcoin regtest taproot address', onAddr);
  const fundTx = await ark('btc', '-rpcwallet=miner', 'sendtoaddress', onAddr, '0.01');
  await mine(1);
  await until('the app to see the funding', async () => (await summary(page)).onchain.confirmed_sat >= 1000000, 60000, () => mine(1));
  check(true, 'the funding of 1,000,000 sat is confirmed and seen', fundTx);
  await page.fill('[data-testid=btc-board-amount]', '5000');
  await page.click('[data-testid=btc-board-go]');
  await page.click('[data-testid=btc-board-sign]');
  m = await msgOf(page, '[data-testid=btc-board-msg]');
  check(/refused/.test(m) && /below the least the Bitcoin ark's server takes/.test(m), 'a board under the server\'s least is refused before Bark builds anything', m.slice(0, 220));
  check((await summary(page)).onchain.confirmed_sat === 1000000, 'nothing was spent: the on-chain BTC is all confirmed still');
  await shot(page, 'bitcoin-board-refused');
  await page.fill('[data-testid=btc-board-amount]', '400000');
  await page.click('[data-testid=btc-board-go]');
  await page.waitForSelector('[data-testid=btc-board-quote]:not([hidden])');
  const fee = (await page.textContent('[data-testid=btc-board-fee]')).trim();
  check(fee === '500 sat', 'the server\'s board fee is shown before anything is signed: 100 sat + 1,000 ppm of 400,000', fee);
  await shot(page, 'bitcoin-board-fee');
  const mempoolBefore = await ark('btc', 'getrawmempool');
  await page.click('[data-testid=btc-board-sign]');
  m = await msgOf(page, '[data-testid=btc-board-msg]');
  const boardTxid = (m.match(/([0-9a-f]{64})/) || [])[1];
  check(/Boarded 399,500 sat/.test(m) && !!boardTxid, 'boarded: 400,000 less the fee shown', m.slice(0, 160));
  const mempoolAfter = await ark('btc', 'getrawmempool');
  check(!mempoolBefore.includes(boardTxid) && mempoolAfter.includes(boardTxid), 'the board transaction is in the node\'s mempool', boardTxid);
  await shot(page, 'bitcoin-boarded');
  await mine(2);
  const tx = await ark('btc', 'getrawtransaction', boardTxid, 'true');
  check(tx.confirmations >= 2, 'the board is confirmed twice', `${tx.confirmations} confirmations`);
  await until('the board to be spendable', async () => (await summary(page)).ark.spendable_sat >= 399500, 120000, async () => { await mine(1); await btc(page, 'maintain'); });
  check(true, 'the board is a spendable leaf');

  // --- 4. Send and receive in the ark ---
  const bAddr = (await bark(B, 'address')).json;
  await page.fill('[data-testid=btc-send-dest]', String(bAddr));
  await page.fill('[data-testid=btc-send-amount]', '20000');
  const bBefore = (await bark(B, 'balance')).json.spendable_sat;
  await page.click('[data-testid=btc-send-go]');
  m = await msgOf(page, '[data-testid=btc-send-msg]');
  check(/Sent 20,000 sat/.test(m), 'A sends 20,000 sat in the ark', m.slice(0, 120));
  await until('B to hold the payment', async () => { await bark(B, 'maintain'); return (await bark(B, 'balance')).json.spendable_sat >= bBefore + 20000; }, 120000);
  check(true, 'B holds it', `${bBefore} -> ${(await bark(B, 'balance')).json.spendable_sat}`);
  await shot(page, 'bitcoin-sent-in-ark');
  await page.click('[data-testid=btc-ark-address]');
  await page.waitForSelector('[data-testid=btc-ark-address-text]');
  const aArk = (await page.textContent('[data-testid=btc-ark-address-text]')).trim();
  const before4 = (await summary(page)).ark.spendable_sat;
  check((await bark(B, 'send', aArk, '10000 sats')).ok, 'B pays A\'s Ark address 10,000 sat', aArk.slice(0, 24));
  await until('A to hold B\'s payment', async () => { await btc(page, 'maintain'); return (await summary(page)).ark.spendable_sat >= before4 + 10000; }, 120000);
  await page.click('[data-testid=btc-refresh]');
  await page.waitForSelector('[data-testid=btc-total]');
  check(true, 'A holds it', `${before4} -> ${(await summary(page)).ark.spendable_sat}`);
  await shot(page, 'bitcoin-received-in-ark');
  // More than the wallet holds: Bark's refusal, verbatim.
  await page.fill('[data-testid=btc-send-amount]', '90000000');
  await page.click('[data-testid=btc-send-go]');
  m = await msgOf(page, '[data-testid=btc-send-msg]');
  check(/refused/.test(m), 'a send of more than the wallet holds is refused, in Bark\'s words', m.slice(0, 220));
  await shot(page, 'bitcoin-send-refused');

  // --- 5. Lightning out ---
  const label = `w26-out-${Date.now()}`;
  const pinv = await ark('peer', 'invoice', '25000000', label, 'Arca client drive');
  await page.check('[data-testid=btc-send-ln]');
  await page.fill('[data-testid=btc-send-invoice]', pinv.bolt11);
  await page.click('[data-testid=btc-send-go]');
  m = await msgOf(page, '[data-testid=btc-send-msg]');
  const li = (await ark('peer', 'listinvoices', label)).invoices[0];
  check(/Lightning payment paid/.test(m) && li.status === 'paid', 'A pays the peer\'s invoice of 25,000 sat over Lightning; the peer has it paid', li.status);
  check(m.includes(li.payment_preimage), 'the preimage shown is the one the peer revealed', li.payment_preimage);
  await shot(page, 'bitcoin-lightning-paid');

  // --- 6. Lightning in, the claim run for the user ---
  let before6 = (await summary(page)).ark.spendable_sat;
  await page.fill('[data-testid=btc-recv-amount]', '15000');
  await page.fill('[data-testid=btc-recv-desc]', 'drive in');
  await page.click('[data-testid=btc-recv-go]');
  await page.waitForSelector('[data-testid=btc-claim]:not([hidden])');
  let inv = (await page.textContent('[data-testid=btc-invoice]')).trim();
  check(/^lnbcrt150u/.test(inv), 'an invoice for 15,000 sat is shown, the claim waiting', inv.slice(0, 20));
  await page.waitForFunction(() => document.querySelector('[data-testid=btc-claim-state]').dataset.state === 'waiting');
  await shot(page, 'bitcoin-lightning-invoice-waiting');
  let pay = await peerPays(inv);
  check(pay.status === 'complete', 'the peer pays it', `${pay.amount_msat} msat`);
  await page.waitForFunction(() => document.querySelector('[data-testid=btc-claim-state]').dataset.state === 'claimed', null, { timeout: 120000 });
  const after6 = (await summary(page)).ark.spendable_sat;
  check(after6 > before6 && after6 <= before6 + 15000, 'claimed at once: the payment is in the ark, less the fee', `${before6} -> ${after6}`);
  await nav(page, 'wallet'); await nav(page, 'bitcoin');
  await page.waitForSelector('[data-testid=btc-total]');
  await shot(page, 'bitcoin-lightning-claimed');

  // --- 7. A payment that can no longer be claimed: a fresh invoice ---
  before6 = (await summary(page)).ark.spendable_sat;
  await page.fill('[data-testid=btc-recv-amount]', '12000');
  await page.fill('[data-testid=btc-recv-desc]', 'drive again');
  await page.click('[data-testid=btc-recv-go]');
  await page.waitForFunction(() => document.querySelector('[data-testid=btc-claim-state]').dataset.state === 'waiting' &&
    /^lnbcrt120u/.test(document.querySelector('[data-testid=btc-invoice]').textContent));
  inv = (await page.textContent('[data-testid=btc-invoice]')).trim();
  await page.click('[data-testid=btc-claim-stop]');
  await page.waitForFunction(() => document.querySelector('[data-testid=btc-claim-state]').dataset.state === 'stopped', null, { timeout: 90000 });
  check(true, 'the user stops waiting; the app says a payment now goes back to the payer');
  await shot(page, 'bitcoin-lightning-stopped');
  const first = peerPays(inv);
  const held = await until('the payment to reach the ark\'s gateway', heldHtlc, 30000);
  // Blocks enough that the claim's HTLC, the invoice's final CLTV delta past
  // the tip less the server's delta, comes too close to the payment's expiry
  // (arca's README, The Bitcoin side).
  const finalDelta = (await ark('peer', 'decode', inv)).min_final_cltv_expiry;
  const k = Math.max(0, held.expiry + 1 - finalDelta - await height());
  log(`held payment expiry ${held.expiry}; mining ${k} blocks before the claim`);
  await mine(k);
  await page.click('[data-testid=btc-claim-again]');
  await page.waitForSelector('[data-testid=btc-reissued]', { timeout: 120000 });
  const reissued = (await page.textContent('[data-testid=btc-reissued]')).replace(/\s+/g, ' ');
  const fresh = (await page.textContent('[data-testid=btc-invoice]')).trim();
  check(fresh !== inv && /^lnbcrt120u/.test(fresh), 'the claim is too late: a fresh invoice of the same amount replaces the old one', reissued.slice(0, 240));
  const firstPay = await first;
  check(firstPay.status !== 'complete', 'the first payment went back to the payer', firstPay.message || firstPay.status);
  await shot(page, 'bitcoin-lightning-reissued');
  pay = await peerPays(fresh);
  check(pay.status === 'complete', 'the peer pays the fresh invoice');
  await page.waitForFunction(() => document.querySelector('[data-testid=btc-claim-state]').dataset.state === 'claimed', null, { timeout: 120000 });
  check((await summary(page)).ark.spendable_sat > before6, 'claimed: the payment is in the ark');
  await shot(page, 'bitcoin-lightning-reissued-claimed');

  // --- 8. Refresh ---
  const vt0 = (await btc(page, 'vtxos')).result.map((v) => v.id);
  await page.click('[data-testid=btc-refresh-all]');
  m = await msgOf(page, '[data-testid=btc-refresh-msg]');
  check(/Handed to the next round/.test(m), 'every leaf is handed to the next round', m.slice(0, 120));
  await until('new leaves from the round', async () => {
    const v = (await btc(page, 'vtxos')).result.filter((x) => x.state.type === 'spendable');
    return v.length && v.every((x) => !vt0.includes(x.id));
  }, 180000, async () => { await mine(1); await btc(page, 'maintain'); });
  check(true, 'the leaves are new ones from the round');
  await page.click('[data-testid=btc-refresh]');
  await page.waitForSelector('[data-testid=btc-vtxo-state]');
  await shot(page, 'bitcoin-refreshed');

  // --- 9. The headline: the reference unit, BTC on its own row ---
  await nav(page, 'wallet');
  await page.waitForFunction(() => /sat/.test((document.querySelector('[data-testid=row-BTC] [data-testid=row-total]') || {}).textContent || ''));
  const sumNow = await summary(page);
  const rowNow = (await page.textContent('[data-testid=row-BTC]')).replace(/\s+/g, ' ');
  check(rowNow.includes(`${sumNow.total.toLocaleString('en-US')} sat`) && /in the ark/.test(rowNow) && /on-chain/.test(rowNow),
    'BTC\'s row counts the ark and the on-chain wallet', rowNow);
  const total = (await page.textContent('[data-testid=total]')).trim();
  check(total !== '' && total !== '…', 'the headline is shown in the reference unit, BTC on its own row', total);
  await shot(page, 'wallet-headline-btc-row');

  // --- 10. A second install, restored from the mnemonic ---
  const homeR = path.join(WORK, 'app-r');
  const r = await launch(homeR, 'R');
  await r.page.waitForSelector('.view.active[data-view=join]');
  await join(r.page, st, mn);
  m = await createBtc(r.page, info, birthday);
  check(/Joined the Bitcoin ark on regtest/.test(m), 'the restored install makes its Bitcoin ark wallet, scanning from A\'s birthday', m.slice(0, 120));
  const want = (await summary(page)).total;
  await until('the restored Bitcoin side', async () => { await btc(r.page, 'maintain'); return (await summary(r.page)).total === want; }, 180000);
  check(true, 'the restored install holds the same BTC', `${want} sat`);
  await nav(r.page, 'wallet'); await nav(r.page, 'bitcoin');
  await r.page.waitForSelector('[data-testid=btc-total]');
  await shot(r.page, 'restored-bitcoin');
  await r.app.close();

  // --- 11. The exit, alone ---
  await nav(page, 'bitcoin');
  const pre = await summary(page);
  await page.click('[data-testid=btc-exit-estimate]');
  m = await msgOf(page, '[data-testid=btc-exit-msg]');
  check(/before anything is broadcast/.test(m), 'the exit\'s fees are shown first', m.slice(0, 160));
  await shot(page, 'bitcoin-exit-fee');
  await page.click('[data-testid=btc-exit-start]');
  m = await msgOf(page, '[data-testid=btc-exit-msg]');
  check(/under way/.test(m), 'the exit of every leaf starts', m.slice(0, 120));
  await shot(page, 'bitcoin-exit-started');
  await until('every leaf to be claimable', async () => {
    const l = (await btc(page, 'exit_list')).result || [];
    return l.length && l.every((x) => x.state.type === 'claimable');
  }, 900000, async () => { await mine(1); await page.click('[data-testid=btc-exit-progress]'); await msgOf(page, '[data-testid=btc-exit-msg]'); });
  check(true, 'every leaf is on the chain and claimable');
  await shot(page, 'bitcoin-exit-claimable');
  await page.click('[data-testid=btc-exit-claim]');
  m = await msgOf(page, '[data-testid=btc-exit-msg]');
  check(/Claimed to bcrt1/.test(m), 'claimed to the on-chain wallet', m.slice(0, 120));
  await until('the claim to confirm', async () => {
    const x = await summary(page);
    return x.ark.spendable_sat === 0 && x.onchain.confirmed_sat > pre.onchain.confirmed_sat + pre.ark.spendable_sat - 10000;
  }, 300000, async () => { await mine(1); await btc(page, 'maintain'); });
  const post = await summary(page);
  check(true, 'the exited BTC is on-chain, the ark empty', `on-chain ${pre.onchain.confirmed_sat} -> ${post.onchain.confirmed_sat}; ark ${pre.ark.spendable_sat} -> 0`);
  await page.click('[data-testid=btc-refresh]');
  await page.waitForSelector('[data-testid=btc-total]');
  await shot(page, 'bitcoin-exited');

  check(pageErrors.length === 0, 'no page error in any window', pageErrors);
  await app.close();
  log(`DONE: ${checks} checks, ${shots} screenshots`);
}

main().then(() => { LOG.end(); fs.rmSync(WORK, { recursive: true, force: true }); }).catch(async (e) => {
  log('DRIVE FAILED', String(e && e.stack || e));
  for (const a of apps) await a.close().catch(() => {});
  LOG.end();
  log(`left for a look: ${WORK}`);
  process.exitCode = 1;
});
