// The swap of BTC for an asset driven end to end, in two installs of the app:
// P gives an asset for BTC and Q gives BTC for it. Both join one Arca
// operator (whose SeqLN node in X makes the asset leg) and one Bitcoin ark on
// regtest. P makes the offer in its Swap screen, Q reads and takes it, P
// completes it, and the apps run the swap on their own: P's asset locked, the
// round that makes Q's leaf, Q's payment, P's claim, Q's claim of the leaf.
// Then a swap abandoned: Q's app is closed right after it takes, so Q never
// pays; once the lock's time is over the operator fails Q's receive back and
// P's asset comes back to P. Every swap step is clicked in the window
// (Playwright for Electron), photographed, and its effect checked in the
// wallets' own answers, at the Bitcoin ark and at the operator.
//
// It needs arca's operator harness run with a Lightning leg
// (ARCA_OPERATOR_LIGHTNING=1 and LIGHTNINGD_EXEC; arca's
// bark-cli/tests/arca_operator_for_browsers.rs) at its control address, and a
// Bitcoin ark on regtest (arca's contrib/bitcoin-ark-regtest/regtest.sh, after
// `up`), named by a script that runs it with its environment:
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_BITCOIN_ARK=/path/to/ark.sh \
//     node test/e2e/drive-swap.mjs <evidence dir>
//
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
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test-results', 'drive-swap'));
if (!ARK) { console.error('ARCA_BITCOIN_ARK names no Bitcoin ark harness'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-client-swap-drive-'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms = 300000, each) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    if (each) await each();
    await sleep(1000);
  }
}

const apps = [];
const pageErrors = [];
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
  await page.setViewportSize({ width: 1240, height: 900 }).catch(() => {});
  await page.waitForSelector('body');
  return { app, page };
}
async function shot(page, name) {
  shots++;
  const f = path.join(OUT, `${String(shots).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f, fullPage: true });
  log(`shot ${path.basename(f)}`);
}
// The swap list in view, then photographed.
async function shotList(page, name) {
  await page.locator('[data-testid=swaps]').scrollIntoViewIfNeeded();
  await shot(page, name);
}
async function nav(page, view) { await page.click(`.nav[data-view=${view}]`); await page.waitForSelector(`.view.active[data-view=${view}]`); }
async function msgOf(page, sel, timeout = 300000) {
  await page.waitForFunction((s) => { const e = document.querySelector(s); return e && e.textContent.trim() && !e.querySelector('.busy'); }, sel, { timeout });
  return (await page.textContent(sel)).trim().replace(/\s+/g, ' ');
}
const arcaRun = (page, c, a) => page.evaluate(([cmd, args]) => window.arca.run(cmd, args), [c, a || {}]);
const btc = (page, c, a) => page.evaluate(([cmd, args]) => window.arca.btc(cmd, args), [c, a || {}]);
const summary = async (page) => { const s = await page.evaluate(() => window.arca.btcSummary()); if (!s.ok) throw new Error(JSON.stringify(s.refusal)); return s.result; };
const swaps = async (page) => { const s = await page.evaluate(() => window.arca.swap('list')); if (!s.ok) throw new Error(JSON.stringify(s.refusal)); return s.result.swaps; };
async function swapState(page, id) { const s = await swaps(page); return s[id] ? s[id].state : null; }
async function join(page, st) {
  await page.waitForSelector('.view.active[data-view=join]');
  await page.fill('[data-testid=node-url]', st.node_url);
  await page.fill('[data-testid=node-user]', st.node_user);
  await page.fill('[data-testid=node-pass]', st.node_password);
  await page.fill('[data-testid=operator-url]', st.server);
  await page.click('[data-testid=join]');
  await page.waitForSelector('[data-testid=join-done]:not([hidden]), [data-testid=join-msg] .refusal', { timeout: 300000 });
  if (await page.isVisible('[data-testid=join-msg] .refusal')) throw new Error(`join refused: ${await page.textContent('[data-testid=join-msg]')}`);
  await page.click('[data-testid=join-continue]');
  await page.waitForSelector('.view.active[data-view=wallet]');
}
async function createBtc(page, info) {
  await nav(page, 'bitcoin');
  await page.waitForSelector('[data-testid=btc-join]:not([hidden])');
  await page.selectOption('[data-testid=btc-network]', 'regtest');
  await page.fill('[data-testid=btc-ark]', info.ark);
  await page.check('[data-testid=btc-src-bitcoind]');
  await page.fill('[data-testid=btc-core-url]', info.bitcoind);
  await page.fill('[data-testid=btc-core-cookie]', info.cookie);
  await page.click('[data-testid=btc-create]');
  return msgOf(page, '[data-testid=btc-create-msg]');
}
// The asset's row in the wallet: what it counts, in atoms.
async function xRow(page, x) {
  const b = await arcaRun(page, 'balance');
  if (!b.ok) throw new Error(JSON.stringify(b.refusal));
  const states = (b.result.arca || {})[x] || {};
  return Object.entries(states).filter(([k]) => k !== 'awaiting_preimage').reduce((t, [, v]) => t + Number(v), 0)
    + Number((b.result.sequentia_onchain || {})[x] || 0);
}
// The operator's next round, once a participation stands: the operator holds
// the payment inside it and wants Q's leaf a moment after P's lock. Its txid.
async function leafRound() {
  return until('the operator\'s round of Q\'s leaf', async () => { const r = await ctl('/round', {}); return r.round || null; }, 120000);
}
// The Bitcoin ark's server grants a receive's HTLCs from a pool of VTXOs it
// refills on the chain as blocks come.
async function refillPool() { for (let i = 0; i < 4; i++) { await mine(1); await sleep(3000); } }

async function main() {
  const st = await ctl('/state');
  const info = await ark('info');
  log('operator harness:', { server: st.server, node: st.node_url, x: st.x, lightning: st.lightning });
  check(st.lightning === true, 'the operator runs a SeqLN node in X (ARCA_OPERATOR_LIGHTNING)');
  log('Bitcoin ark:', info, 'app:', process.env.ARCA_CLIENT_APP || ROOT);

  // --- 1. Two installs, each joined to the operator and the Bitcoin ark ---
  const P = await launch(path.join(WORK, 'app-p'), 'P');
  await join(P.page, st);
  check(/Joined the Bitcoin ark on regtest/.test(await createBtc(P.page, info)), 'P joins the Bitcoin ark');
  const Q = await launch(path.join(WORK, 'app-q'), 'Q');
  await join(Q.page, st);
  check(/Joined the Bitcoin ark on regtest/.test(await createBtc(Q.page, info)), 'Q joins the Bitcoin ark');
  // P's asset: X paid to its address, boarded on the fee the app is shown.
  const pAddr = await arcaRun(P.page, 'address');
  await ctl('/fund', { script: pAddr.result.script_pubkey, asset: st.x, amount: 3000000 });
  await ctl('/produce', {});
  const bq = await arcaRun(P.page, 'board_quote', { asset: st.x, amount: '2000000' });
  check(bq.ok, 'P\'s board of 2,000,000 X is quoted', bq.ok ? bq.result.fee : bq.refusal);
  const bd = await arcaRun(P.page, 'board', { asset: st.x, amount: '2000000', shown: bq.result.fee });
  check(bd.ok, 'P boards 2,000,000 X', bd.ok ? undefined : bd.refusal);
  await ctl('/produce', {}); await ctl('/bury', {});
  await until('P\'s board credited', async () => { const b = await arcaRun(P.page, 'boards'); return b.ok && b.result.every((x) => x.server && x.server.state === 'credited'); }, 120000);
  await arcaRun(P.page, 'sync');
  // Q's BTC: on-chain, then boarded into the ark.
  const qOn = await btc(Q.page, 'onchain_address');
  await ark('btc', '-rpcwallet=miner', 'sendtoaddress', qOn.result.address, '0.01');
  await mine(1);
  await until('Q\'s funding', async () => (await summary(Q.page)).onchain.confirmed_sat >= 1000000, 60000, () => mine(1));
  check((await btc(Q.page, 'board', { amount: '400000' })).ok, 'Q boards 400,000 sat');
  await until('Q\'s board', async () => (await summary(Q.page)).ark.spendable_sat > 0, 180000, async () => { await mine(1); await btc(Q.page, 'maintain'); });
  const p0 = { x: await xRow(P.page, st.x), btc: (await summary(P.page)).ark.spendable_sat };
  const q0 = { x: await xRow(Q.page, st.x), btc: (await summary(Q.page)).ark.spendable_sat };
  log('books before:', { P: p0, Q: q0 });

  // --- 2. A swap, offered by P ---
  await refillPool();
  await nav(P.page, 'swap');
  await shot(P.page, 'p-swap-screen');
  await P.page.selectOption('[data-testid=swap-give]', 'asset');
  await P.page.fill('[data-testid=swap-asset]', st.x);
  await P.page.fill('[data-testid=swap-atoms]', '100000');
  await P.page.fill('[data-testid=swap-sats]', '30000');
  await P.page.click('[data-testid=swap-offer]');
  let m = await msgOf(P.page, '[data-testid=swap-offer-msg]');
  check(/Offered: nothing is locked/.test(m), 'P\'s offer is made, nothing locked', m.slice(0, 120));
  check(/Gives: 100,100 atoms/.test(m) && /the operator's fee 100 included/.test(m), 'P sees what it gives: 100,000 X and the operator\'s fee of 100', m.slice(0, 400));
  check(/Gets: 29,840 sat of BTC/.test(m) && /Bark's fee 160 sat/.test(m), 'P sees what it gets: 30,000 sat less Bark\'s fee of 160', m.slice(0, 400));
  const offer = (await P.page.textContent('[data-testid=swap-offer-text]')).trim();
  check(/^btc-swap-offer:[0-9a-f]+$/.test(offer), 'the offer\'s text', offer.slice(0, 40));
  await shot(P.page, 'p-offered');

  await nav(Q.page, 'swap');
  await Q.page.fill('[data-testid=swap-offer-in]', offer);
  await Q.page.click('[data-testid=swap-read]');
  m = await msgOf(Q.page, '[data-testid=swap-read-msg]');
  check(/nothing is asked or locked yet/.test(m), 'Q reads the offer: nothing asked or locked', m.slice(0, 100));
  check(/Gives: 30,\d{3} sat of BTC/.test(m) && /Bark's fee \d+ sat/.test(m), 'Q sees what it gives: 30,000 sat and Bark\'s fee', m.slice(0, 400));
  check(/Gets: 99,900 atoms/.test(m) && /the operator's fee 100/.test(m), 'Q sees what it gets: 100,000 X less the operator\'s fee', m.slice(0, 400));
  await shot(Q.page, 'q-read');
  await Q.page.click('[data-testid=swap-take]');
  m = await msgOf(Q.page, '[data-testid=swap-read-msg]');
  check(/Taken: nothing is locked yet/.test(m), 'Q takes the offer', m.slice(0, 100));
  const take = (await Q.page.textContent('[data-testid=swap-take-text]')).trim();
  check(/^btc-swap-take:[0-9a-f]+$/.test(take), 'the take\'s text', take.slice(0, 40));
  await shot(Q.page, 'q-taken');

  await P.page.fill('[data-testid=swap-take-in]', take);
  await P.page.click('[data-testid=swap-complete]');
  m = await msgOf(P.page, '[data-testid=swap-complete-msg]');
  check(/Completed/.test(m), 'P completes its offer', m.slice(0, 100));
  const latest = async (page) => Object.values(await swaps(page)).sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  const pid = (await latest(P.page)).id;
  check(!!pid && (await swaps(Q.page))[pid], 'the swap is in both wallets, under one id', pid);
  await until('P\'s asset locked (by the app\'s follow loop)', async () => (await swapState(P.page, pid)) === 'locked', 180000);
  check(true, 'P\'s app locked the asset on its own');
  await shotList(P.page, 'p-locked');
  const round = await leafRound();
  check(!!round, 'the operator\'s round makes Q\'s leaf, final', round);
  await until('both sides done', async () => (await swapState(P.page, pid)) === 'done' && (await swapState(Q.page, pid)) === 'done', 400000);
  check(true, 'the swap is done in both apps, each run by its own follow loop');
  await P.page.click('[data-testid=swap-refresh]');
  await Q.page.click('[data-testid=swap-refresh]');
  await P.page.waitForSelector('[data-testid=swap-state][data-state=done]');
  await Q.page.waitForSelector('[data-testid=swap-state][data-state=done]');
  await shotList(P.page, 'p-done');
  await shotList(Q.page, 'q-done');
  await until('P\'s BTC', async () => (await summary(P.page)).ark.spendable_sat > p0.btc, 120000, async () => { await btc(P.page, 'maintain'); });
  await arcaRun(Q.page, 'sync'); await arcaRun(P.page, 'sync');
  const p1 = { x: await xRow(P.page, st.x), btc: (await summary(P.page)).ark.spendable_sat };
  const q1 = { x: await xRow(Q.page, st.x), btc: (await summary(Q.page)).ark.spendable_sat };
  log('books after:', { P: p1, Q: q1 });
  check(p1.btc - p0.btc === 29840, 'P holds 29,840 sat more: 30,000 less Bark\'s fee', `${p0.btc} -> ${p1.btc}`);
  check(q0.btc - q1.btc > 30000 && q0.btc - q1.btc < 31000, 'Q holds 30,000 sat and Bark\'s fee less', `${q0.btc} -> ${q1.btc}`);
  check(p0.x - p1.x >= 100100 && p0.x - p1.x < 101100, 'P holds 100,000 X, the fee and margins less', `${p0.x} -> ${p1.x}`);
  check(q1.x - q0.x <= 99900 && q1.x - q0.x > 98900, 'Q holds 100,000 X less the fee and its claim\'s margins more', `${q0.x} -> ${q1.x}`);
  const ps = (await swaps(P.page))[pid]; const qs = (await swaps(Q.page))[pid];
  check(ps.preimage && ps.preimage === qs.preimage && ps.posted === true, 'one preimage on both sides; P posted it to the operator');

  // --- 3. A swap abandoned: Q gone right after it takes ---
  await refillPool();
  await P.page.selectOption('[data-testid=swap-give]', 'asset');
  await P.page.fill('[data-testid=swap-atoms]', '50000');
  await P.page.fill('[data-testid=swap-sats]', '10000');
  await P.page.click('[data-testid=swap-offer]');
  await msgOf(P.page, '[data-testid=swap-offer-msg]');
  const offer2 = (await P.page.textContent('[data-testid=swap-offer-text]')).trim();
  await Q.page.fill('[data-testid=swap-offer-in]', offer2);
  await Q.page.click('[data-testid=swap-read]');
  await msgOf(Q.page, '[data-testid=swap-read-msg]');
  await Q.page.click('[data-testid=swap-take]');
  m = await msgOf(Q.page, '[data-testid=swap-read-msg]');
  check(/Taken/.test(m), 'Q takes a second offer');
  const take2 = (await Q.page.textContent('[data-testid=swap-take-text]')).trim();
  await Q.app.close();
  apps.splice(apps.indexOf(Q.app), 1);
  check(true, 'Q\'s app is closed: Q is gone');
  await P.page.fill('[data-testid=swap-take-in]', take2);
  await P.page.click('[data-testid=swap-complete]');
  await msgOf(P.page, '[data-testid=swap-complete-msg]');
  const sid = (await latest(P.page)).id;
  await until('P\'s asset locked', async () => (await swapState(P.page, sid)) === 'locked', 180000);
  const lock2 = (await swaps(P.page))[sid].lock;
  check(lock2 && lock2.amount === '50000', 'P locked 50,000 X in an htlc-1 leaf, its own while the payment stands', lock2);
  const round2 = await leafRound();
  check(!!round2, 'the round makes Q\'s leaf; Q never comes to pay', round2);
  await shotList(P.page, 'p-locked-q-gone');
  // Past the lock's time the operator fails Q's receive back, and P's lock
  // comes back to it.
  let steps = 0;
  await until('P\'s asset back', async () => (await swapState(P.page, sid)) === 'refunded', 1500000, async () => {
    if (steps < 36) { steps++; await ctl('/advance', { seconds: 6 * 3600 }); }
    await sleep(4000);
  });
  const out2 = (await swaps(P.page))[sid];
  check(true, 'P\'s swap is refunded: the operator failed Q\'s receive back, and P\'s lock came back', `${steps} advances of six hours: ${out2.outcome}`);
  await P.page.click('[data-testid=swap-refresh]');
  await P.page.waitForSelector('[data-testid=swap-state][data-state=refunded]');
  await shotList(P.page, 'p-refunded');
  await arcaRun(P.page, 'sync');
  const p2 = await xRow(P.page, st.x);
  check(p2 < p1.x && p1.x - p2 < 2000, 'P holds its 50,000 X again, less only the margins of the lock and its return', `${p1.x} -> ${p2}`);
  check(pageErrors.length === 0, 'no page error in either app', pageErrors);
  log(`DONE: ${checks} checks, ${shots} screenshots`);
}

main().then(async () => {
  for (const a of apps) await a.close().catch(() => {});
  process.exit(0);
}).catch(async (e) => {
  log('DRIVE FAILED:', String(e && e.stack || e));
  for (const a of apps) await a.close().catch(() => {});
  process.exit(1);
});
