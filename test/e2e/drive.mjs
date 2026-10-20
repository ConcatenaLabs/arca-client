// The app driven end to end against a local Arca operator on regtest: a fresh
// install joins, boards, receives, sends, settles now, keeps to the
// schedule, runs the exit drill, shows refusals in the wallet's own words, and
// a second fresh install restores the wallet from its mnemonic. Every step is
// clicked in the app's window (Playwright for Electron), photographed, and
// its effect on the chain checked at the node.
//
// The operator is arca's test harness, kept running (arca's
// bark-cli/tests/arca_operator_for_browsers.rs), reached at its control
// address:
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 node test/e2e/drive.mjs <evidence dir>
//
// It uses the arca client the app carries (build/arca-linux-x64, staged by
// build/make-arca-bundle.sh), also for the counterpart wallet, run as a user
// runs it. ARCA_CLIENT_APP names a packaged app's executable to drive instead
// of this checkout.
import { _electron as electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test-results', 'drive'));
const ARCA = process.env.ARCA_CLIENT_ARCA || path.join(ROOT, 'build', 'arca-linux-x64', 'bin', 'arca');
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-client-drive-'));
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
const rpc = (method, params = []) => ctl('/rpc', { method, params });

// The counterpart: a wallet run with the same arca client, from the command line.
function cli(dir, args, opts = {}) {
  return new Promise((resolve) => {
    const p = execFile(ARCA, ['--datadir', dir, '--witness-patience', '5', ...args], { env: { ...process.env, ARCA_NODE_PASSWORD: opts.password || '' }, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        let j = null; try { j = JSON.parse(stdout); } catch { /* not JSON */ }
        resolve({ ok: !err, json: j, stderr });
      });
    p.stdin.end(opts.stdin || '');
  });
}

async function launch(home, name) {
  const env = { ...process.env, ARCA_CLIENT_HOME: home, ARCA_CLIENT_SCHEDULE_POLL_MS: '3000', ARCA_CLIENT_WITNESS_PATIENCE: '5',
    ARCA_CLIENT_OFFSCREEN: process.env.ARCA_CLIENT_OFFSCREEN || '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const opts = process.env.ARCA_CLIENT_APP
    ? { executablePath: process.env.ARCA_CLIENT_APP, args: [], env }
    : { args: [ROOT], cwd: ROOT, env };
  const app = await electron.launch(opts);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { pageErrors.push(String(e)); log(`PAGE ERROR (${name})`, String(e)); });
  page.on('console', (m) => { if (m.type() === 'error') log(`console (${name})`, m.text()); });
  await page.setViewportSize({ width: 1240, height: 860 }).catch(() => {});
  await page.waitForSelector('body');
  return { app, page };
}
const pageErrors = [];
const extraLive = [];
async function shot(page, name) {
  shots++;
  const f = path.join(OUT, `${String(shots).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f, fullPage: true });
  log(`shot ${path.basename(f)}`);
}
async function nav(page, view) { await page.click(`.nav[data-view=${view}]`); await page.waitForSelector(`.view.active[data-view=${view}]`); }
async function msgOf(page, sel, timeout = 180000) {
  // Waits for a message box to end its "busy" state and returns its text.
  await page.waitForFunction((s) => { const e = document.querySelector(s); return e && e.textContent.trim() && !e.querySelector('.busy'); }, sel, { timeout });
  return (await page.textContent(sel)).trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls `f` (async) until it answers truthy, at most `ms`.
async function until(what, f, ms = 240000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}
// Clicks Join and waits for the wallet, or fails at once with the refusal.
async function join(page) {
  await page.click('[data-testid=join]');
  await page.waitForSelector('[data-testid=join-done]:not([hidden]), [data-testid=join-msg] .refusal', { timeout: 300000 });
  if (await page.isVisible('[data-testid=join-msg] .refusal')) throw new Error(`join refused: ${await page.textContent('[data-testid=join-msg]')}`);
}
// Clicks "Sync now" and waits for that sync to be recorded, whatever its outcome.
async function syncNow(page) {
  await nav(page, 'wallet');
  const asked = async () => (await appState(page)).sync.history.filter((x) => x.reason === 'asked for');
  const n = (await asked()).length;
  await page.click('[data-testid=sync-now]');
  await until('the sync asked for', async () => (await asked()).length > n, 300000);
  const last = (await asked())[0];
  if (!last.ok) log('sync refused:', last.refusal);
}
const walletRun = (page, c) => page.evaluate((cmd) => window.arca.run(cmd), c);
async function appState(page) { return page.evaluate(() => window.arca.state()); }
async function confirmations(txid) { const t = await rpc('getrawtransaction', [txid, true]); return t.confirmations || 0; }

async function main() {
  const st = await ctl('/state');
  log('operator harness:', { server: st.server, node: st.node_url, X: st.x, Y: st.y, tip: st.tip });
  log('arca client:', ARCA, fs.readFileSync(path.join(path.dirname(ARCA), '..', 'VERSION'), 'utf8').split('\n')[0]);
  const X = st.x;

  // The counterpart B, on the command line, funded and boarded.
  const B = path.join(WORK, 'cli-b');
  const bc = await cli(B, ['create', '--server', st.server, '--node-url', st.node_url, '--node-user', st.node_user], { password: st.node_password });
  check(bc.ok, 'the counterpart wallet B is created on the command line');
  const bAddr = (await cli(B, ['address'])).json;
  await ctl('/fund', { script: bAddr.script_pubkey, asset: X, amount: 3000000 });
  await ctl('/produce');
  const bBoard = await cli(B, ['board', X, '2000000']);
  check(bBoard.ok, 'B boards 2,000,000 X', bBoard.json.txid);
  await ctl('/produce'); await ctl('/bury');

  // --- 1. A fresh install: the join screen ---
  const homeA = path.join(WORK, 'app-a');
  let { app, page } = await launch(homeA, 'A');
  await page.waitForSelector('.view.active[data-view=join]');
  check(true, 'a fresh install opens on the join screen');
  check((await page.title()) === 'Arca', 'the window names itself Arca');
  await shot(page, 'join-fresh');

  // --- 2. The node, tested ---
  await page.fill('[data-testid=node-url]', st.node_url);
  await page.fill('[data-testid=node-user]', st.node_user);
  await page.fill('[data-testid=node-pass]', st.node_password);
  await page.click('[data-testid=node-test]');
  const nodeMsg = await msgOf(page, '[data-testid=node-msg]');
  check(/chain elementsregtest/.test(nodeMsg) && /transaction index: on/.test(nodeMsg), 'the node answers: elementsregtest, transaction index on', nodeMsg);

  // --- 3. Join the operator by address, a new wallet ---
  await page.fill('[data-testid=operator-url]', st.server);
  await join(page);
  const opKey = (await page.textContent('[data-testid=operator-key]')).trim();
  const bInfo = (await cli(B, ['info'])).json;
  check(opKey === bInfo.operator && /^[0-9a-f]{64}$/.test(opKey), 'the pinned operator key is the one the counterpart pinned', opKey);
  check(/compare the operator key/.test(await page.textContent('[data-testid=operator-key-check]')), 'the key check is shown in the wallet\'s words');
  const words = (await page.textContent('[data-testid=mnemonic-words]')).replace(/\d+/g, ' ').trim().split(/\s+/);
  check(words.length === 12 || words.length === 24, `the mnemonic is shown once to write down (${words.length} words)`);
  await shot(page, 'joined-mnemonic');
  await page.click('[data-testid=join-continue]');
  await page.waitForSelector('.view.active[data-view=wallet]');
  let s = await appState(page);
  const DIR = s.datadir;
  check(s.joined && DIR.startsWith(homeA) && s.arca.bundled, 'the wallet lives in the app\'s own directory, run by the client it carries', `${DIR}, ${s.arca.bin}`);
  check(fs.statSync(path.join(DIR, 'mnemonic')).mode % 0o1000 === 0o600, 'the mnemonic file is its owner\'s alone');
  const cfgText = fs.readFileSync(path.join(homeA, 'config', 'config.json'), 'utf8');
  check(!cfgText.includes(words.join(' ')), 'the app\'s settings hold no mnemonic');

  // --- 4. The wallet: BTC's row first, empty, with its note ---
  await page.waitForSelector('[data-testid=row-BTC]');
  const rows = await page.$$eval('[data-testid=balance-rows] > .bal', (els) => els.map((e) => e.getAttribute('data-testid')));
  check(rows[0] === 'row-BTC', 'BTC\'s row comes first', rows);
  const btc = await page.textContent('[data-testid=row-BTC]');
  check(/0 sat/.test(btc) && /Bark/.test(btc), 'BTC shows 0 with what the Bitcoin side needs', btc.replace(/\s+/g, ' '));
  await shot(page, 'wallet-empty-btc-first');

  // --- 5. Board ---
  await nav(page, 'board');
  await page.click('[data-testid=get-address]');
  const addr = (await page.textContent('[data-testid=address-text]')).trim();
  const v = await rpc('validateaddress', [addr]);
  check(v.isvalid && /^0014/.test(v.scriptPubKey), 'the on-chain address is an unblinded P2WPKH address', addr);
  const fund = await ctl('/fund', { script: v.scriptPubKey, asset: X, amount: 3000000 });
  await ctl('/produce');
  check(await confirmations(fund.txid) >= 1, 'the funding of 3,000,000 X is in a block', fund.txid);
  await page.fill('[data-testid=board-asset]', X);
  await page.fill('[data-testid=board-amount]', '500');
  await page.click('[data-testid=board-go]');
  let m = await msgOf(page, '[data-testid=board-msg]');
  if (await page.isVisible('[data-testid=board-sign]')) { await page.click('[data-testid=board-sign]'); m = await msgOf(page, '[data-testid=board-msg]'); }
  check(/below the server's smallest leaf/.test(m), 'a board of 500 is refused, in the wallet\'s words', m.replace(/\s+/g, ' '));
  await shot(page, 'board-refused');
  const mempoolBefore = await rpc('getrawmempool');
  await page.fill('[data-testid=board-amount]', '2000000');
  await page.click('[data-testid=board-go]');
  await page.waitForSelector('[data-testid=board-quote]:not([hidden])', { timeout: 120000 });
  const boardFee = (await page.textContent('[data-testid=board-fee]')).trim();
  check(/^\d[\d,]* /.test(boardFee), 'the board\'s fee is shown before anything is signed', boardFee);
  await shot(page, 'board-quote');
  await page.click('[data-testid=board-sign]');
  m = await msgOf(page, '[data-testid=board-msg]');
  const boardTxid = (m.match(/Boarded: ([0-9a-f]{64})/) || [])[1];
  check(!!boardTxid, 'the board is registered and broadcast', boardTxid);
  const boardTx = await rpc('getrawtransaction', [boardTxid, true]);
  const feeOuts = boardTx.vout.filter((o) => o.scriptPubKey.type === 'fee');
  check(feeOuts.length === 1 && feeOuts[0].asset === X && String(Math.round(feeOuts[0].value * 1e8)) === boardFee.split(' ')[0].replace(/,/g, ''),
    'the board transaction pays exactly the fee shown, in the boarded asset', `${Math.round(feeOuts[0].value * 1e8)} of ${feeOuts[0].asset.slice(0, 8)}…`);
  const mempoolAfter = await rpc('getrawmempool');
  check(mempoolAfter.includes(boardTxid) && !mempoolBefore.includes(boardTxid), 'the board transaction is in the node\'s mempool');
  await ctl('/produce'); await ctl('/bury');
  check(await confirmations(boardTxid) >= 1, 'the board transaction is in a block, buried', boardTxid);
  await syncNow(page);
  await nav(page, 'coins');
  await page.waitForSelector('[data-testid=coins] table');
  let coinsText = await page.textContent('[data-testid=coins]');
  check(/2,000,000/.test(coinsText) && /live/.test(coinsText), 'the board is a live coin of 2,000,000 once final');
  await shot(page, 'board-live');

  // --- 6. Receive: a request shown and copied; B pays it ---
  await nav(page, 'receive');
  await page.fill('[data-testid=receive-asset]', X);
  await page.fill('[data-testid=receive-amount]', '300000');
  await page.click('[data-testid=receive-go]');
  await page.waitForSelector('#r-out:not([hidden])');
  const request = (await page.textContent('[data-testid=request]')).trim();
  check(/^arca:[0-9a-f]+$/.test(request), 'a request is shown', request.slice(0, 40) + '…');
  await page.click('[data-testid=request-copy]');
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  check(clip === request, 'the request is copied to the clipboard');
  await shot(page, 'receive-request');
  const mp1 = await rpc('getrawmempool');
  const paid = await cli(B, ['send', clip]);
  check(paid.ok, 'B pays the request out of round', paid.json && paid.json.sent);
  check(JSON.stringify(await rpc('getrawmempool')) === JSON.stringify(mp1), 'a payment out of round puts nothing in the mempool');
  await syncNow(page);
  await nav(page, 'coins');
  await page.waitForFunction(() => /operator-confirmed/.test(document.querySelector('[data-testid=coins]').textContent), null, { timeout: 60000 });
  coinsText = await page.textContent('[data-testid=coins]');
  check(/300,000/.test(coinsText), 'the 300,000 received is held, operator-confirmed');
  await shot(page, 'received-operator-confirmed');

  // --- 7. Send: to B's request; the same request again is refused ---
  const bReq = (await cli(B, ['receive', '--asset', X])).json.request;
  await nav(page, 'send');
  await page.fill('[data-testid=send-request]', bReq);
  await page.fill('[data-testid=send-amount]', '400000');
  await page.click('[data-testid=send-go]');
  m = await msgOf(page, '[data-testid=send-msg]');
  check(/^Sent/.test(m), 'the app pays B 400,000', m.split('\n')[0]);
  const bMail = (await cli(B, ['mailbox'])).json;
  check(bMail.accepted.some((c) => c.value === '400000' && c.asset === X), 'B\'s mailbox accepts the 400,000', bMail.accepted.map((c) => c.value));
  await shot(page, 'sent');
  await page.click('[data-testid=send-go]');
  m = await msgOf(page, '[data-testid=send-msg]');
  check(/key_reused/.test(m), 'paying one request twice is refused, in the server\'s words', m.replace(/\s+/g, ' '));
  const bAny = (await cli(B, ['receive'])).json.request;
  await page.fill('[data-testid=send-request]', bAny);
  await page.fill('[data-testid=send-asset]', '');
  await page.click('[data-testid=send-go]');
  m = await msgOf(page, '[data-testid=send-msg]');
  check(/no asset is a default/.test(m), 'a request naming no asset, and none chosen, is refused: no asset is a default', m.replace(/\s+/g, ' '));
  await shot(page, 'send-refusals');

  // --- 8. Settle now: the fee shown before signing, then a round ---
  await nav(page, 'coins');
  await page.waitForSelector('[data-testid=coins] table');
  const coins = (await page.evaluate(() => window.arca.run('coins'))).result;
  const recvd = coins.find((c) => c.state === 'live' && c.value === '300000');
  check(!!recvd && recvd.standing === 'operator-confirmed', 'the received coin is live and operator-confirmed', recvd && recvd.leaf_id);
  await page.click(`[data-testid=settle-${recvd.leaf_id}]`);
  await page.waitForSelector('[data-testid=quote-fee]');
  const fee = (await page.textContent('[data-testid=quote-fee]')).trim();
  check(fee === '0', 'the refresh fee is shown before anything is signed', `${fee} (the harness charges none)`);
  await shot(page, 'settle-quote');
  await page.click('[data-testid=quote-confirm]');
  m = await msgOf(page, '[data-testid=quote-msg]');
  check(/Handed over/.test(m), 'the coin is handed to the next round on the fees shown');
  const round = await ctl('/round');
  check(!!round.round, 'the operator builds the round', round);
  check(await confirmations(round.round) >= 1, 'the round is in a block, buried and final', round.round);
  await syncNow(page);
  const after = (await page.evaluate(() => window.arca.run('coins'))).result;
  const settled = after.find((c) => c.state === 'live' && c.kind === 'batch' && c.value === '300000');
  const given = after.find((c) => c.leaf_id === recvd.leaf_id);
  check(!!settled && given.state === 'spent', 'settled: a batch leaf of 300,000 on the round, the coin given up spent', settled && settled.leaf_id);
  await nav(page, 'coins');
  await shot(page, 'settled');

  // --- 9. The exit drill on that leaf ---
  await nav(page, 'exit');
  await page.selectOption('[data-testid=exit-coin]', settled.leaf_id);
  const exitRun = async (shotName) => {
    const before = await page.$$eval('[data-testid=exit-step]', (e) => e.length);
    await page.click('[data-testid=exit-go]');
    await page.waitForSelector('[data-testid=exit-quote]:not([hidden])', { timeout: 120000 });
    if (await page.isVisible('[data-testid=exit-follow]')) log('     the quote:', (await page.textContent('[data-testid=exit-msg]')).replace(/\s+/g, ' '));
    if (shotName) await shot(page, shotName);
    await page.click('[data-testid=exit-sign]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid=exit-step]').length > n, before, { timeout: 300000 });
    return page.textContent('[data-testid=exit-step]');
  };
  let step = await exitRun('exit-1-quote');
  const unroll = [...step.matchAll(/published ([0-9a-f]{64})/g)].map((x) => x[1]);
  check(/state: unrolling/.test(step) && unroll.length >= 1, 'run 1: the leaf\'s path is published', unroll);
  await shot(page, 'exit-1-unrolling');
  await ctl('/produce');
  for (const t of unroll) check(await confirmations(t) >= 1, 'an unroll transaction is in a block', t);
  step = await exitRun();
  check(/state: waiting/.test(step), 'run 2: the claim waits for the exit delay', step.match(/state: \S+/)?.[0]);
  const early = await page.textContent('[data-testid=exit-step] [data-testid=exit-next]').catch(() => '');
  log('     the wallet says:', early);
  await shot(page, 'exit-2-waiting');
  await ctl('/advance', { seconds: 131000 });
  await ctl('/produce');
  step = await exitRun('exit-3-quote');
  const claim = [...step.matchAll(/claim ([0-9a-f]{64})/g)].map((x) => x[1]);
  check(/state: claimed/.test(step) && claim.length === 1, 'run 3: once the delay has run, the claim is published', step.match(/claim [0-9a-f]{64}[^\n]*/)?.[0]);
  await ctl('/produce'); await ctl('/bury');
  check(await confirmations(claim[0]) >= 1, 'the claim is in a block', claim[0]);
  const claimTx = await rpc('getrawtransaction', [claim[0], true]);
  const paidOut = claimTx.vout.filter((o) => o.asset === X && o.value > 0).map((o) => Math.round(o.value * 1e8));
  check(paidOut.some((x) => x > 299000), 'the claim pays the leaf to the wallet, less its fee', paidOut);
  step = await exitRun('exit-4-follow');
  check(/state: exited/.test(step), 'run 4: the coin is exited once its claim is final', step.match(/state: \S+/)?.[0]);
  await shot(page, 'exit-4-exited');

  // --- 10. The schedule: the app syncs by itself on the library's schedule ---
  await nav(page, 'schedule');
  await page.waitForSelector('[data-testid=schedule-next] .kv');
  let sch = (await page.evaluate(() => window.arca.run('schedule'))).result;
  check(sch.next_sync_at > sch.now && !sch.due, 'nothing is due now; the next sync is the coins\' free window', { now: sch.now, next: sch.next_sync_at });
  await shot(page, 'schedule');
  const syncsBefore = (await appState(page)).sync.history.length;
  const parts0 = (await page.evaluate(() => window.arca.run('participations'))).result.length;
  const tAdvance = Date.now();
  await ctl('/advance', { seconds: sch.next_sync_at - sch.now + 120 });
  await ctl('/produce');
  // No click: the app reads the schedule every 3 s here and syncs when due.
  // Wait for that sync to end, so its participation has reached the operator.
  const autoDone = await until('the app to sync by itself', async () => {
    const h = (await appState(page)).sync.history;
    return h.length > syncsBefore && h.find((x) => x.at >= tAdvance && /^due/.test(x.reason) && x.ok);
  });
  const parts1 = (await walletRun(page, 'participations')).result;
  check(parts1.length > parts0 && autoDone, 'in the free window the app synced by itself and asked the refresh', `${autoDone.reason}, ${(autoDone.ms / 1000).toFixed(1)} s`);
  const r2 = await ctl('/round');
  check(!!r2.round && await confirmations(r2.round) >= 1, 'the operator\'s round runs and is final', r2.round);
  // The schedule wakes for a coin handed to a refresh an hour on: move the
  // chain's clock that far, and the app's own sync completes it.
  sch = (await walletRun(page, 'schedule')).result;
  log('     the schedule after the round:', { now: sch.now, next: sch.next_sync_at, due: sch.due });
  await ctl('/advance', { seconds: Math.max(0, sch.next_sync_at - sch.now) + 60 });
  await ctl('/produce');
  await until('the app\'s own sync to complete the refresh', async () => {
    const p = await walletRun(page, 'participations');
    return p.ok && p.result.filter((x) => x.state === 'released').length >= 2;
  });
  const parts = (await page.evaluate(() => window.arca.run('participations'))).result;
  check(parts.filter((x) => x.state === 'released').length >= 2, 'the app\'s own sync completed the refresh it asked for', parts.map((x) => x.state));
  await nav(page, 'schedule');
  await page.waitForSelector('[data-testid=sync-history] table');
  await shot(page, 'schedule-auto-synced');

  // --- 11. Refusals and settings ---
  await nav(page, 'refusals');
  await page.waitForSelector('[data-testid=session-refusals] .refusal');
  const sess = await page.textContent('[data-testid=session-refusals]');
  check(/below the server's smallest leaf/.test(sess) && /key_reused/.test(sess) && /no asset is a default/.test(sess), 'the session\'s refusals are listed in the wallet\'s words');
  await shot(page, 'refusals');
  await nav(page, 'settings');
  await page.waitForSelector('[data-testid=settings-operator]');
  check((await page.textContent('[data-testid=settings-operator]')).trim() === st.server, 'settings show the operator the wallet joined');
  await shot(page, 'settings');
  await nav(page, 'wallet');
  await page.waitForSelector(`[data-testid=row-${X}]`);
  await shot(page, 'wallet-final');
  const finalA = (await cli(DIR, ['balance'])).json;
  const coinsA = (await cli(DIR, ['coins'])).json;

  // The manager's own log: every run of arca, with its time and outcome.
  fs.writeFileSync(path.join(OUT, 'app-a-runs.log'), (await page.evaluate(() => window.arca.logs())).join('\n') + '\n');
  // A clean stop: the app quits, and no arca run of it is left.
  await app.close();
  check(true, 'the app quits cleanly');

  // --- 12. A second fresh install restores the wallet from its mnemonic ---
  const homeR = path.join(WORK, 'app-r');
  ({ app, page } = await launch(homeR, 'R'));
  await page.waitForSelector('.view.active[data-view=join]');
  await page.fill('[data-testid=node-url]', st.node_url);
  await page.fill('[data-testid=node-user]', st.node_user);
  await page.fill('[data-testid=node-pass]', st.node_password);
  await page.fill('[data-testid=operator-url]', st.server);
  await page.check('[data-testid=wallet-restore]');
  await page.fill('[data-testid=mnemonic-in]', words.join(' '));
  await join(page);
  await shot(page, 'restore-joined');
  await page.click('[data-testid=join-continue]');
  await syncNow(page);
  const rs = await appState(page);
  const finalR = (await cli(rs.datadir, ['balance'])).json;
  const coinsR = (await cli(rs.datadir, ['coins'])).json;
  const liveA = coinsA.filter((c) => c.state === 'live').map((c) => c.leaf_id).sort();
  const liveR = coinsR.filter((c) => c.state === 'live').map((c) => c.leaf_id).sort();
  check(liveA.length > 0 && liveA.every((l) => liveR.includes(l)), 'every coin the wallet holds live, the restored wallet holds live', liveA);
  check(JSON.stringify(finalA.sequentia_onchain) === JSON.stringify(finalR.sequentia_onchain), 'and the same on-chain coins', finalR.sequentia_onchain);
  // What the restored wallet holds live beyond the original's: each is
  // reported, with what the chain says of it.
  for (const l of liveR.filter((x) => !liveA.includes(x))) {
    const orig = coinsA.find((c) => c.leaf_id === l);
    const claim = ((orig && orig.note) || '').match(/claimed by ([0-9a-f]{64})/);
    const conf = claim ? await confirmations(claim[1]) : null;
    log(`FINDING the restored wallet holds ${l.slice(0, 16)}… (${orig ? orig.value : '?'}) live; the original holds it ${orig ? orig.state : 'not at all'}` +
      `${claim ? `, its claim ${claim[1].slice(0, 16)}… in a block with ${conf} confirmation(s)` : ''}: the Arca balance counts it beside the on-chain coin its claim paid`);
    extraLive.push({ leaf: l, original: orig && orig.state, claim: claim && claim[1], confirmations: conf });
  }
  await nav(page, 'wallet');
  await page.waitForSelector(`[data-testid=row-${X}]`);
  await shot(page, 'restored-wallet');
  await app.close();

  check(pageErrors.length === 0, 'no error in the window', pageErrors);
  log(`\nall passed: ${checks} checks, ${shots} screenshots${extraLive.length ? `; ${extraLive.length} finding(s) reported` : ''}`);
}

// The log is flushed before the process ends.
const end = (code) => LOG.end(() => process.exit(code));
main().then(() => { fs.rmSync(WORK, { recursive: true, force: true }); end(0); })
  .catch((e) => { log('DRIVE FAILED:', e.stack || String(e)); console.error(`work directory kept: ${WORK}`); end(1); });
