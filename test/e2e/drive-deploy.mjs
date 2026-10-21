// The Deploy screen driven end to end: one install of the app (the runner)
// starts an operator from its Deploy screen, and a second install (a wallet)
// joins it from the key and route the runner's screen shows, then boards,
// pays and refreshes. The operator is stopped and started from the runner's
// app with work in flight, and nothing is lost. The same for a Bitcoin ark.
//
//   Sequentia: a second Arca operator (the first is arca's test harness,
//   bark-cli/tests/arca_operator_for_browsers.rs, whose anchored regtest chain
//   and node this one runs on), arcad and arca-signer as the app carries them,
//   its state in the app's own PostgreSQL cluster.
//
//   Bitcoin: Bark's captaind and watchmand as the app carries them, against a
//   Bitcoin Core 31 on regtest that this drive starts; the wallet's Bitcoin
//   side (Bark's client, made from its mnemonic) joins it.
//
//   ARCA_OPERATOR_CONTROL=127.0.0.1:18640 DEPLOY_PG_BIN=/usr/lib/postgresql/16/bin \
//   DEPLOY_CORE_BIN=/opt/bitcoin-31.1/bin DEPLOY_CORE28_BIN=/opt/bitcoin-28.0/bin \
//     node test/e2e/drive-deploy.mjs <evidence dir>
//
// DEPLOY_PORT_BASE (default 23700) is the first of the loopback ports it
// uses. DEPLOY_PHASES picks `seq`, `btc` or both (the default). Every step is
// clicked in a window (offscreen), photographed, and checked at the node.
// ARCA_CLIENT_APP names a packaged app's executable to drive.
import { _electron as electron } from 'playwright-core';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTROL = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'test-results', 'drive-deploy'));
const ARCA = process.env.ARCA_CLIENT_ARCA || path.join(ROOT, 'build', 'arca-linux-x64', 'bin', 'arca');
const BARK = process.env.ARCA_CLIENT_BARK || path.join(ROOT, 'build', 'bark-linux-x64', 'bin', 'bark');
const PG_BIN = process.env.DEPLOY_PG_BIN || '';
const CORE = process.env.DEPLOY_CORE_BIN;
const CORE28 = process.env.DEPLOY_CORE28_BIN || '';
const PORT = Number(process.env.DEPLOY_PORT_BASE || 23700);
const PHASES = (process.env.DEPLOY_PHASES || 'seq,btc').split(',');
fs.mkdirSync(OUT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(process.env.DEPLOY_WORK || os.tmpdir(), 'dd-'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms = 240000, each) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    if (each) await each();
    await sleep(1500);
  }
}
function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const p = execFile(bin, args, { env: Object.assign({}, process.env, opts.env || {}), maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      const s = stdout.trim(); const i = s.indexOf('{'); const k = s.indexOf('[');
      const at = [i, k].filter((x) => x >= 0).sort((x, y) => x - y)[0];
      let j; try { j = JSON.parse(at === undefined ? s : s.slice(at)); } catch { j = s; }
      resolve({ ok: !err, json: j, stderr: stderr.trim() });
    });
    p.stdin.end(opts.stdin || '');
  });
}
const cli = (dir, args, opts = {}) => run(ARCA, ['--datadir', dir, '--witness-patience', '5', ...args], { env: { ARCA_NODE_PASSWORD: opts.password || '' } });
const bark = (dir, ...args) => run(BARK, ['--datadir', dir, '--quiet', ...args]);

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
  await page.setViewportSize({ width: 1240, height: 860 }).catch(() => {});
  await page.waitForSelector('body');
  return { app, page };
}
async function quit(app) {
  const i = apps.indexOf(app); if (i >= 0) apps.splice(i, 1);
  await Promise.race([app.close(), sleep(60000)]);
}
// A screenshot of the window, or of one panel of it (`sel`), scrolled into view.
async function shot(page, name, sel) {
  shots++;
  const f = path.join(OUT, `${String(shots).padStart(2, '0')}-${name}.png`);
  if (sel) {
    // The main pane scrolls on its own: the window is made as tall as the
    // panel for its picture, then put back.
    const el = page.locator(sel).first();
    const hgt = await el.evaluate((e) => e.getBoundingClientRect().height);
    await page.setViewportSize({ width: 1240, height: Math.max(860, Math.ceil(hgt) + 120) }).catch(() => {});
    await el.scrollIntoViewIfNeeded();
    await el.screenshot({ path: f });
    await page.setViewportSize({ width: 1240, height: 860 }).catch(() => {});
  } else await page.screenshot({ path: f, fullPage: true });
  log(`shot ${path.basename(f)}`);
}
async function nav(page, view) { await page.click(`.nav[data-view=${view}]`); await page.waitForSelector(`.view.active[data-view=${view}]`); }
async function msgOf(page, sel, timeout = 300000) {
  await page.waitForFunction((s) => { const e = document.querySelector(s); return e && e.textContent.trim() && !e.querySelector('.busy'); }, sel, { timeout });
  return (await page.textContent(sel)).replace(/\s+/g, ' ').trim();
}
// Clicks a Deploy button and answers its message once the action has ended.
async function deployClick(page, testid, msgId, timeout = 400000) {
  await page.evaluate((m) => { const e = document.querySelector(`[data-testid=${m}]`); while (e.firstChild) e.removeChild(e.firstChild); }, msgId);
  await page.click(`[data-testid=${testid}]`);
  return msgOf(page, `[data-testid=${msgId}]`, timeout);
}
const deployState = (page) => page.evaluate(() => window.arca.deployState());
const deployRun = (page, action, a) => page.evaluate(([x, y]) => window.arca.deploy(x, y), [action, a || {}]);
const walletRun = (page, c, a) => page.evaluate(([cmd, args]) => window.arca.run(cmd, args), [c, a || {}]);
const btc = (page, c, a) => page.evaluate(([cmd, args]) => window.arca.btc(cmd, args), [c, a || {}]);
const summary = async (page) => { const s = await page.evaluate(() => window.arca.btcSummary()); if (!s.ok) throw new Error(JSON.stringify(s.refusal)); return s.result; };
async function appState(page) { return page.evaluate(() => window.arca.state()); }
async function syncNow(page) {
  const asked = async () => (await appState(page)).sync.history.filter((x) => x.reason === 'asked for');
  const n = (await asked()).length;
  await page.evaluate(() => window.arca.syncNow());
  await until('the sync asked for', async () => (await asked()).length > n, 300000);
  return (await asked())[0];
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const pidsOf = (st, side) => Object.fromEntries(st[side].daemons.map((d) => [d.name, d.pid]));

// The Sequentia operator's mining: a block, buried two Bitcoin blocks deep.
const produce = async () => { await ctl('/produce'); };
const bury = async () => { await ctl('/produce'); await ctl('/bury'); };
async function liveCoins(page) {
  const out = await walletRun(page, 'coins');
  if (!out.ok) return null;
  return out.result;
}

// ------------------------------------------------------------------------------------------------
async function sequentia(st, R, W) {
  const X = st.x; const Y = st.y;
  const LISTEN = `127.0.0.1:${PORT + 20}`;
  const ROUTE = `http://${LISTEN}`;

  // --- S1. The runner: Deploy, before anything is made ---
  await R.page.waitForSelector('[data-testid=nav-deploy]');
  check(await R.page.isVisible('[data-testid=nav-deploy]'), 'a fresh install, without a wallet, offers Deploy (developer mode is on by default)');
  await nav(R.page, 'deploy');
  const commit = (await R.page.textContent('[data-testid=deploy-commitments]')).replace(/\s+/g, ' ');
  check(/Funds in its pools/.test(commit) && /Staying online/.test(commit) && /exit deadlines its holders rely on/.test(commit),
    'the screen says what running an operator commits the runner to', commit.slice(0, 160));
  await shot(R.page, 'deploy-fresh');
  await R.page.fill('[data-testid=deploy-pg-bin]', PG_BIN);
  await R.page.fill('[data-testid=deploy-pg-port]', String(PORT + 10));
  await R.page.fill('[data-testid=deploy-backup-dir]', path.join(WORK, 'backup'));
  await R.page.fill('[data-testid=ds-node-url]', st.node_url);
  await R.page.fill('[data-testid=ds-node-user]', st.node_user);
  await R.page.fill('[data-testid=ds-node-pass]', st.node_password);
  await R.page.fill('[data-testid=ds-listen]', LISTEN);
  await R.page.fill('[data-testid=ds-route]', ROUTE);
  await R.page.fill('[data-testid=ds-round]', '10');
  check(await R.page.inputValue('[data-testid=ds-delay-min]') === '254' && await R.page.inputValue('[data-testid=ds-delay-max]') === '338',
    'the exit delays default to the specification\'s 36 to 48 hours, [254, 338]');
  let m = await deployClick(R.page, 'ds-node-test', 'ds-node-msg');
  check(/The node answers: elementsregtest/.test(m) && /anchors validated/.test(m), 'the node is tested from the Deploy screen', m);
  m = await deployClick(R.page, 'ds-create', 'ds-msg');
  check(/none is served by default/.test(m), 'an operator with no asset named is refused: none is served by default', m);
  check(!(await deployState(R.page)).sequentia.exists, 'nothing was made');
  // The runner's choice: X with the node's rate, Y with none, in that order.
  await R.page.click('[data-testid=ds-add-asset]');
  await R.page.click('[data-testid=ds-add-asset]');
  const rows = await R.page.$$('[data-testid=ds-asset-row]');
  await (await rows[0].$('[data-testid=ds-asset-id]')).fill(X);
  await (await rows[0].$('[data-testid=ds-asset-min]')).fill('1000');
  await (await rows[0].$('[data-testid=ds-asset-rate]')).selectOption('node');
  await (await rows[1].$('[data-testid=ds-asset-id]')).fill(Y);
  await (await rows[1].$('[data-testid=ds-asset-min]')).fill('5000');
  await shot(R.page, 'deploy-seq-settings', '[data-testid=deploy-seq]');
  m = await deployClick(R.page, 'ds-create', 'ds-msg');
  const S = (m.match(/Made the operator ([0-9a-f]{64})/) || [])[1];
  check(!!S, 'the operator is made: its key drawn on this machine', S);
  let ds = await deployState(R.page);
  const seqDir = ds.sequentia.dir;
  check(seqDir.startsWith(R.home), 'the operator lives in the runner\'s profile', seqDir);
  for (const f of ['secrets/operator.key', 'secrets/wallet.mnemonic', 'signer/signer.record']) {
    check((fs.statSync(path.join(seqDir, f)).mode & 0o777) === 0o600, `${f} is its owner's alone`);
  }
  const cfg = fs.readFileSync(path.join(R.home, 'config', 'config.json'), 'utf8');
  check(!cfg.includes(fs.readFileSync(path.join(seqDir, 'secrets', 'operator.key'), 'utf8').trim()), 'the app\'s settings hold no operator key');
  check(ds.sequentia.record.entries === 0 && /keepers=none/.test(ds.sequentia.record.header), 'the signer\'s record is new, with no keepers', ds.sequentia.record.header);

  // --- S2. Start ---
  m = await deployClick(R.page, 'ds-start', 'ds-msg');
  check(/The operator runs and answers/.test(m), 'the operator is started from the app', m);
  ds = await deployState(R.page);
  const pids1 = pidsOf(ds, 'sequentia');
  const exe = (pid) => fs.readlinkSync(`/proc/${pid}/exe`);
  check(Object.values(pids1).every((p) => exe(p).startsWith(path.join(R.home, 'deploy', 'bin'))),
    'the daemons run from binaries installed in the profile, not from inside the app', Object.values(pids1).map(exe));
  check(Object.values(pids1).every((p) => p && alive(p)) && ds.postgres.running, 'arca-signer, arcad and PostgreSQL run', { ...pids1, postgres: ds.postgres.pid });
  const info = await (await fetch(`${ROUTE}/v1/info`)).json();
  check(info.operator === S, 'the route answers GET /v1/info with the operator key', info.operator);
  check(info.assets.map((a) => a.asset).join() === [X, Y].join(), 'it serves the runner\'s assets, in the runner\'s order, and no other', info.assets.map((a) => a.asset.slice(0, 8)));
  check(info.assets[0].rate && info.assets[0].rate.source === 'node' && !info.assets[0].rate.stale && !info.assets[1].rate,
    'X\'s rate comes from the node; Y has no rate source', info.assets[0].rate);
  check(info.exit_delay_units && info.exit_delay_units.min === 254 && info.exit_delay_units.max === 338, 'it publishes exit delays of 254 to 338 units', info.exit_delay_units);
  const arcadToml = fs.readFileSync(path.join(seqDir, 'arcad.toml'), 'utf8');
  check((fs.statSync(path.join(seqDir, 'arcad.toml')).mode & 0o777) === 0o600 && !/fee_assets/.test(arcadToml), 'arcad.toml is its owner\'s alone and names no fee asset of its own');
  await R.page.click('[data-testid=deploy-refresh]');
  await R.page.waitForSelector('[data-testid=ds-share-text]');
  const share = (await R.page.textContent('[data-testid=ds-share-text]')).trim();
  check(share.includes(S) && share.includes(ROUTE), 'the screen shows the key and route to give wallets', share.replace(/\s+/g, ' '));
  await R.page.waitForSelector('[data-testid=ds-info-key]');
  await shot(R.page, 'deploy-seq-running', '[data-testid=deploy-seq]');

  // --- S3. Funding its pools from the screen ---
  await R.page.click('[data-testid=ds-address]');
  await R.page.waitForSelector('[data-testid=ds-funding-script]');
  const script = (await R.page.textContent('[data-testid=ds-funding-script]')).trim();
  const fundX = await ctl('/fund', { script, asset: X, amount: 20000000 });
  const fundY = await ctl('/fund', { script, asset: Y, amount: 2000000 });
  await bury(); await bury();
  check(true, 'the operator\'s wallet is paid 20,000,000 X and 2,000,000 Y at the address the screen handed out', [fundX.txid, fundY.txid]);
  await shot(R.page, 'deploy-seq-funding', '[data-testid=deploy-seq]');

  // --- S4. A wallet in a second profile joins from the key and route ---
  await W.page.waitForSelector('.view.active[data-view=join]');
  await W.page.fill('[data-testid=node-url]', st.node_url);
  await W.page.fill('[data-testid=node-user]', st.node_user);
  await W.page.fill('[data-testid=node-pass]', st.node_password);
  await W.page.fill('[data-testid=operator-url]', ROUTE);
  const wrongKey = S.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  await W.page.fill('[data-testid=operator-key-in]', wrongKey);
  await W.page.click('[data-testid=join]');
  m = await msgOf(W.page, '[data-testid=join-msg]');
  check(/shows the operator key .* not .*the wallet it made was removed, and nothing was boarded/.test(m), 'joined with another key: refused, and the wallet made is removed', m);
  check(!(await appState(W.page)).joined && !fs.existsSync(path.join(W.home, 'sequentia', 'mnemonic')), 'no wallet is left behind');
  await shot(W.page, 'join-wrong-key-refused');
  await W.page.fill('[data-testid=operator-key-in]', S);
  await W.page.click('[data-testid=join]');
  await W.page.waitForSelector('[data-testid=join-done]:not([hidden])', { timeout: 300000 });
  const pinned = (await W.page.textContent('[data-testid=operator-key]')).trim();
  check(pinned === S, 'the wallet joins the app\'s operator and pins its key', pinned);
  await shot(W.page, 'joined-app-operator');
  await W.page.click('[data-testid=join-continue]');

  // --- S5. Board ---
  await nav(W.page, 'board');
  await W.page.click('[data-testid=get-address]');
  const wAddr = (await W.page.textContent('[data-testid=address-text]')).trim();
  const wv = await rpc('validateaddress', [wAddr]);
  await ctl('/fund', { script: wv.scriptPubKey, asset: X, amount: 5000000 });
  await produce();
  await W.page.fill('[data-testid=board-asset]', X);
  await W.page.fill('[data-testid=board-amount]', '2000000');
  await W.page.click('[data-testid=board-go]');
  await W.page.waitForSelector('[data-testid=board-quote]:not([hidden])', { timeout: 120000 });
  const boardFee = (await W.page.textContent('[data-testid=board-fee]')).trim();
  check(/^\d[\d,]* /.test(boardFee), 'the board\'s fee is shown before anything is signed', boardFee);
  await W.page.click('[data-testid=board-sign]');
  m = await msgOf(W.page, '[data-testid=board-msg]');
  const boardTxid = (m.match(/Boarded: ([0-9a-f]{64})/) || [])[1];
  check(!!boardTxid, 'the board is registered with the app\'s operator and broadcast', boardTxid);
  await until('the board to be live', async () => {
    await syncNow(W.page);
    const c = await liveCoins(W.page);
    return c && c.find((x) => x.state === 'live' && x.value === '2000000');
  }, 300000, bury);
  check(true, 'the board is a live coin of 2,000,000 X, credited by the app\'s operator once final');
  await nav(W.page, 'coins');
  await shot(W.page, 'board-live');

  // --- S6. The counterpart C, on the command line, against the same route ---
  const C = path.join(WORK, 'cli-c');
  const cc = await cli(C, ['create', '--server', ROUTE, '--node-url', st.node_url, '--node-user', st.node_user], { password: st.node_password });
  check(cc.ok && cc.json.operator === S, 'a command-line wallet C joins the app\'s operator', cc.json && cc.json.operator);
  const cAddr = (await cli(C, ['address'])).json;
  await ctl('/fund', { script: cAddr.script_pubkey, asset: X, amount: 3000000 });
  await produce();
  check((await cli(C, ['board', X, '1500000'])).ok, 'C boards 1,500,000 X');
  await until('C\'s board to be live', async () => { await cli(C, ['sync']); const b = (await cli(C, ['coins'])).json; return Array.isArray(b) && b.some((x) => x.state === 'live'); }, 300000, bury);

  // --- S7. Pay: the wallet pays C out of round ---
  const cReq = (await cli(C, ['receive', '--asset', X])).json.request;
  await nav(W.page, 'send');
  await W.page.fill('[data-testid=send-request]', cReq);
  await W.page.fill('[data-testid=send-amount]', '400000');
  await W.page.click('[data-testid=send-go]');
  m = await msgOf(W.page, '[data-testid=send-msg]');
  check(/^Sent/.test(m), 'the wallet pays C 400,000 X through the app\'s operator', m.slice(0, 100));
  const cMail = (await cli(C, ['mailbox'])).json;
  check(cMail.accepted.some((c) => c.value === '400000' && c.asset === X), 'C\'s mailbox accepts the 400,000', cMail.accepted.map((c) => c.value));
  await shot(W.page, 'paid-c');
  // C pays the wallet 300,000: an operator-confirmed coin to refresh.
  const wReq1 = (await walletRun(W.page, 'receive', { asset: X, amount: '300000' })).result.request;
  check((await cli(C, ['send', wReq1])).ok, 'C pays the wallet 300,000 X out of round');
  await syncNow(W.page);
  let coins = await liveCoins(W.page);
  const recvd = coins.find((c) => c.state === 'live' && c.value === '300000');
  check(!!recvd && recvd.standing === 'operator-confirmed', 'the wallet holds it, operator-confirmed', recvd && recvd.leaf_id);

  const sumX = (cs) => cs.filter((c) => c.state === 'live' && c.asset === X).reduce((a, c) => a + BigInt(c.value), 0n);
  const L0 = sumX(coins);
  log('     the wallet\'s live X before the work in flight:', L0.toString(), '(2,000,000 boarded − 400,000 paid − the transfer\'s fee margin + 300,000 received)');

  // --- S8. Work in flight, then the operator stopped and started from the app ---
  // (a) C pays the wallet 50,000, which waits in its mailbox, unread.
  const wReq2 = (await walletRun(W.page, 'receive', { asset: X, amount: '50000' })).result.request;
  check((await cli(C, ['send', wReq2])).ok, 'in flight: C pays the wallet 50,000 X, unread in its mailbox');
  // (b) A second board, in a block and not yet final.
  await nav(W.page, 'board');
  await W.page.fill('[data-testid=board-amount]', '100000');
  await W.page.click('[data-testid=board-go]');
  await W.page.waitForSelector('[data-testid=board-quote]:not([hidden])', { timeout: 120000 });
  await W.page.click('[data-testid=board-sign]');
  m = await msgOf(W.page, '[data-testid=board-msg]');
  const board2 = (m.match(/Boarded: ([0-9a-f]{64})/) || [])[1];
  check(!!board2, 'in flight: a board of 100,000 X is registered and broadcast', board2);
  await produce();
  // (c) The 300,000 handed to a refresh; the operator builds its round.
  const mp0 = new Set(await rpc('getrawmempool'));
  await nav(W.page, 'coins');
  await W.page.waitForSelector(`[data-testid=settle-${recvd.leaf_id}]`);
  await W.page.click(`[data-testid=settle-${recvd.leaf_id}]`);
  await W.page.waitForSelector('[data-testid=quote-fee]');
  await W.page.click('[data-testid=quote-confirm]');
  m = await msgOf(W.page, '[data-testid=quote-msg]');
  check(/Handed over/.test(m), 'in flight: the 300,000 is handed to the operator\'s next round, its fee shown first', m.slice(0, 120));
  const roundTx = await until('the app\'s operator to broadcast its round', async () => (await rpc('getrawmempool')).find((t) => !mp0.has(t)), 120000);
  check(true, 'the app\'s operator builds and broadcasts the round on its own timer', roundTx);
  await shot(W.page, 'in-flight');
  ds = await deployState(R.page);
  const entriesBefore = ds.sequentia.record.entries;
  // Stop.
  m = await deployClick(R.page, 'ds-stop', 'ds-msg');
  check(/arcad stopped \(SIGINT\)/.test(m) && /arca-signer stopped \(SIGTERM\)/.test(m) && /PostgreSQL stopped \(SIGINT\)/.test(m),
    'the operator is stopped from the app, each on its own signal, none killed', m);
  ds = await deployState(R.page);
  check(Object.values(pids1).every((p) => !alive(p)) && !ds.postgres.running, 'no process of the operator runs');
  await R.page.click('[data-testid=deploy-refresh]');
  await R.page.waitForSelector('[data-testid=daemon-arcad]');
  await shot(R.page, 'deploy-seq-stopped', '[data-testid=deploy-seq]');
  // The chain goes on while it is down: the round and the board are buried.
  await bury(); await bury();
  check(await (async () => (await rpc('getrawtransaction', [roundTx, true])).confirmations >= 1)(), 'while the operator is down, its round is mined and buried', roundTx);
  const down = await syncNow(W.page);
  log('     the wallet\'s sync while the operator is down:', down.ok ? 'ok' : down.refusal);
  const downCoins = await liveCoins(W.page);
  const openWhileDown = {
    given: (downCoins.find((x) => x.leaf_id === recvd.leaf_id) || {}).state,
    batch300: downCoins.some((x) => x.state === 'live' && x.kind === 'batch' && x.value === '300000'),
    p50: downCoins.some((x) => x.state === 'live' && x.value === '50000'),
    b100: downCoins.some((x) => x.state === 'live' && x.value === '100000'),
  };
  check(openWhileDown.given === 'given' && !openWhileDown.batch300 && !openWhileDown.p50, 'while the operator is down, the refresh and the payment are still open in the wallet', openWhileDown);
  const boardsDown = (await walletRun(W.page, 'boards')).result || [];
  const b2Down = boardsDown.find((b) => b.state === 'live' && b.server && b.server.error);
  check(!!b2Down && /Connection refused/.test(b2Down.server.error), 'and the board, final on the chain, cannot be asked of the operator', b2Down && b2Down.server.error);
  await nav(W.page, 'coins');
  await shot(W.page, 'operator-down-coins');
  // Start.
  m = await deployClick(R.page, 'ds-start', 'ds-msg');
  check(/The operator runs and answers/.test(m), 'the operator is started again from the app', m);
  ds = await deployState(R.page);
  const info2 = await (await fetch(`${ROUTE}/v1/info`)).json();
  check(info2.operator === S && ds.sequentia.record.entries >= entriesBefore, 'the same key, and the signer\'s record whole', { entriesBefore, after: ds.sequentia.record.entries });
  // Everything in flight completes.
  let final = null;
  await until('the refresh, the payment and the board to complete', async () => {
    await syncNow(W.page);
    const c = await liveCoins(W.page);
    if (!c) return false;
    const live = c.filter((x) => x.state === 'live');
    const batch = live.find((x) => x.kind === 'batch' && x.value === '300000');
    const p50 = live.find((x) => x.value === '50000');
    const b100 = live.find((x) => x.value === '100000');
    final = { batch: !!batch, p50: !!p50, b100: !!b100, given: (c.find((x) => x.leaf_id === recvd.leaf_id) || {}).state };
    return batch && p50 && b100 ? live : false;
  }, 400000, bury);
  check(final.given === 'spent', 'the refresh completed: a batch leaf of 300,000 from the round, the coin given up spent', final);
  check(final.p50, 'the 50,000 paid while in flight arrived');
  const boardsUp = (await walletRun(W.page, 'boards')).result || [];
  const b2Up = boardsUp.find((b) => b.leaf_id === b2Down.leaf_id);
  log('     the board, as the operator answers for it now:', b2Up);
  check(final.b100 && b2Up && b2Up.server && b2Up.server.state === 'credited', 'the board of 100,000 made while in flight is credited by the operator after the restart', b2Up && b2Up.server);
  coins = await liveCoins(W.page);
  const liveX = sumX(coins);
  check(liveX === L0 + 150000n, 'nothing lost: the wallet\'s live X is what it held before, plus the 50,000 paid and the 100,000 boarded (the refresh charged no fee)', `${L0} -> ${liveX}`);
  await nav(W.page, 'coins');
  await shot(W.page, 'after-restart-coins');

  // --- S9. The operator outlives the app ---
  ds = await deployState(R.page);
  const pids2 = pidsOf(ds, 'sequentia');
  await quit(R.app);
  check(Object.values(pids2).every((p) => alive(p)), 'the runner\'s app is closed, and the operator still runs', pids2);
  check((await (await fetch(`${ROUTE}/v1/info`)).json()).operator === S, 'and still answers');
  const r2 = await launch(R.home, 'runner');
  R.app = r2.app; R.page = r2.page;
  await nav(R.page, 'deploy');
  await R.page.waitForSelector('[data-testid=daemon-arcad]');
  ds = await deployState(R.page);
  check(JSON.stringify(pidsOf(ds, 'sequentia')) === JSON.stringify(pids2), 'the app, started again, finds the operator it left running by its PIDs', pidsOf(ds, 'sequentia'));
  await shot(R.page, 'deploy-seq-found-again', '[data-testid=deploy-seq]');
  // It works, not only runs: the wallet pays through it again.
  const cReq2 = (await cli(C, ['receive', '--asset', X])).json.request;
  const again = await walletRun(W.page, 'send', { request: cReq2, amount: '10000' });
  check(again.ok, 'after the runner\'s app was closed and opened again, the wallet pays C 10,000 X through the operator', again.ok ? again.result.sent || 'sent' : again.refusal);

  // --- S10. Key and record, logs, backup ---
  await R.page.waitForSelector('[data-testid=ds-record-entries]');
  const entries = Number((await R.page.textContent('[data-testid=ds-record-entries]')).replace(/,/g, ''));
  check(entries > 0 && (await R.page.textContent('[data-testid=ds-operator-key]')).trim() === S, 'the screen shows the operator key and its record, with its entries', entries);
  await R.page.selectOption('[data-testid=deploy-log-which]', 'arcad');
  await R.page.click('[data-testid=deploy-log-read]');
  await R.page.waitForFunction(() => document.querySelector('[data-testid=deploy-log]').textContent.length > 0);
  const arcadLog = await R.page.textContent('[data-testid=deploy-log]');
  check(/arcad listening on/.test(arcadLog) && /the app stopped it/.test(arcadLog), 'arcad\'s log is read in the app, the stop and both starts in it');
  await shot(R.page, 'deploy-logs', '[data-testid=deploy-log]');
  m = await deployClick(R.page, 'deploy-backup', 'deploy-backup-msg');
  check(/operator\.key/.test(m) && /wallet\.mnemonic/.test(m) && /base-/.test(m), 'a backup is written from the app: the secrets, the configuration and a base backup', m.slice(0, 200));
  const bdir = path.join(WORK, 'backup');
  const seqB = fs.readdirSync(bdir).find((d) => d.startsWith('sequentia-'));
  check(fs.readFileSync(path.join(bdir, seqB, 'operator.key'), 'utf8') === fs.readFileSync(path.join(seqDir, 'secrets', 'operator.key'), 'utf8'), 'the backed-up key is the operator\'s');
  check(!fs.existsSync(path.join(bdir, seqB, 'signer.record')), 'the signer\'s record is not copied: it is never restored from a copy');
  check(fs.readdirSync(path.join(bdir, 'wal')).length > 0, 'the database\'s WAL is archived in the backup directory as it is written', fs.readdirSync(path.join(bdir, 'wal')).length);
  await shot(R.page, 'deploy-backup', '[data-testid=deploy-backup-msg]');
  return { S, ROUTE };
}

// ------------------------------------------------------------------------------------------------
async function startCore(bin, dir, port, rpcport) {
  fs.mkdirSync(dir, { recursive: true });
  const p = spawn(path.join(bin, 'bitcoind'), [`-datadir=${dir}`, '-regtest', '-server', '-txindex', `-port=${port}`, `-rpcport=${rpcport}`, '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1',
    '-listen=0', '-connect=0', '-dnsseed=0', '-fallbackfee=0.0001', '-printtoconsole=0'], { stdio: 'ignore', detached: true });
  p.unref();
  fs.writeFileSync(path.join(dir, 'drive.pid'), String(p.pid));
  const cli = (...a) => run(path.join(bin, 'bitcoin-cli'), [`-datadir=${dir}`, '-regtest', `-rpcport=${rpcport}`, ...a]);
  await until(`bitcoind on ${rpcport}`, async () => (await cli('getblockcount')).ok, 60000);
  return { pid: p.pid, cli, url: `http://127.0.0.1:${rpcport}/`, cookie: path.join(dir, 'regtest', '.cookie') };
}
async function stopCore(c) { if (!c) return; await c.cli('stop'); await until('bitcoind to stop', async () => !alive(c.pid), 60000).catch(() => {}); }

async function bitcoin(st, R, W, cores) {
  const core = await startCore(CORE, path.join(WORK, 'btc'), PORT + 40, PORT + 41);
  cores.push(core);
  const ver = (await core.cli('getnetworkinfo')).json;
  log('Bitcoin Core', ver.subversion);
  await core.cli('createwallet', 'miner');
  const minerAddr = (await core.cli('-rpcwallet=miner', 'getnewaddress')).json;
  const mine = async (n) => core.cli('generatetoaddress', String(n), minerAddr);
  await mine(101);
  const LISTEN = `127.0.0.1:${PORT + 45}`;
  const ROUTE = `http://${LISTEN}`;

  await nav(R.page, 'deploy');
  await R.page.selectOption('[data-testid=db-net]', 'regtest');
  await R.page.fill('[data-testid=db-listen]', LISTEN);
  await R.page.fill('[data-testid=db-admin]', String(PORT + 46));
  await R.page.fill('[data-testid=db-route]', ROUTE);
  await R.page.fill('[data-testid=db-round]', '10');
  await R.page.fill('[data-testid=db-life]', '432');
  await R.page.fill('[data-testid=db-delta]', '12');
  await R.page.fill('[data-testid=db-confs]', '2');
  // B1. Bitcoin Core 28 is refused before anything is made.
  if (CORE28) {
    const old = await startCore(CORE28, path.join(WORK, 'btc28'), PORT + 50, PORT + 51);
    cores.push(old);
    await R.page.fill('[data-testid=db-core-url]', old.url);
    await R.page.fill('[data-testid=db-core-cookie]', old.cookie);
    let m0 = await deployClick(R.page, 'db-core-test', 'db-core-msg');
    check(/needs Bitcoin Core 31 or later/.test(m0) && /Satoshi:28/.test(m0), 'Bitcoin Core 28 is refused: Bark\'s server needs 31 or later', m0);
    m0 = await deployClick(R.page, 'db-create', 'db-msg');
    check(/needs Bitcoin Core 31 or later/.test(m0) && !(await deployState(R.page)).bitcoin.exists, 'making the ark against it is refused, and nothing is made', m0);
    await shot(R.page, 'deploy-btc-core28-refused', '[data-testid=deploy-btc]');
    await stopCore(old); cores.splice(cores.indexOf(old), 1);
  } else log('     not run: the Core 28 refusal (DEPLOY_CORE28_BIN unset)');
  await R.page.fill('[data-testid=db-core-url]', core.url);
  await R.page.fill('[data-testid=db-core-cookie]', core.cookie);
  let m = await deployClick(R.page, 'db-core-test', 'db-core-msg');
  check(/Satoshi:31/.test(m) && /regtest/.test(m), 'Bitcoin Core 31 answers the test', m);
  m = await deployClick(R.page, 'db-create', 'db-msg');
  check(/Made the Bitcoin ark on regtest/.test(m), 'the Bitcoin ark is made: captaind\'s key drawn on this machine', m);
  let ds = await deployState(R.page);
  const arkDir = ds.bitcoin.dir;
  check((fs.statSync(path.join(arkDir, 'captaind', 'mnemonic')).mode & 0o777) === 0o600, 'captaind\'s mnemonic is its owner\'s alone');
  m = await deployClick(R.page, 'db-start', 'db-msg');
  const K = (m.match(/server key (0[23][0-9a-f]{64})/) || [])[1];
  check(!!K, 'the ark is started from the app and gives its server key', m);
  ds = await deployState(R.page);
  const bp1 = pidsOf(ds, 'bitcoin');
  check(Object.values(bp1).every((p) => p && alive(p)), 'captaind and watchmand run', bp1);
  check(Object.values(bp1).every((p) => fs.readlinkSync(`/proc/${p}/exe`).startsWith(path.join(R.home, 'deploy', 'bin'))), 'they run from binaries installed in the profile');
  await R.page.click('[data-testid=deploy-refresh]');
  await R.page.waitForSelector('[data-testid=db-round-address]', { timeout: 60000 });
  const roundAddr = (await R.page.textContent('[data-testid=db-round-address]')).trim();
  const share = (await R.page.textContent('[data-testid=db-share-text]')).trim();
  check(share.includes(K) && share.includes(ROUTE), 'the screen shows the server key and route to give wallets', share.replace(/\s+/g, ' '));
  await core.cli('-rpcwallet=miner', 'sendtoaddress', roundAddr, '5');
  await mine(6);
  await until('the round wallet to hold 5 BTC', async () => {
    const w = await deployRun(R.page, 'ark-wallet');
    return w.ok && w.result.rounds && Number(w.result.rounds.total_balance || w.result.rounds.confirmed_balance || 0) >= 500000000 ? w : null;
  }, 120000, () => mine(1));
  check(true, 'the round wallet is funded with 5 BTC at the address the screen shows', roundAddr);
  await R.page.click('[data-testid=deploy-refresh]');
  await R.page.waitForSelector('[data-testid=db-server-key]');
  await shot(R.page, 'deploy-btc-running', '[data-testid=deploy-btc]');

  // B2. The wallet's Bitcoin side joins from the key and route.
  await nav(W.page, 'bitcoin');
  await W.page.waitForSelector('[data-testid=btc-join]:not([hidden])');
  await W.page.selectOption('[data-testid=btc-network]', 'regtest');
  await W.page.fill('[data-testid=btc-ark]', ROUTE);
  await W.page.check('[data-testid=btc-src-bitcoind]');
  await W.page.fill('[data-testid=btc-core-url]', core.url);
  await W.page.fill('[data-testid=btc-core-cookie]', core.cookie);
  await W.page.fill('[data-testid=btc-ark-key]', K.replace(/.$/, (c) => (c === '0' ? '1' : '0')));
  await W.page.click('[data-testid=btc-create]');
  m = await msgOf(W.page, '[data-testid=btc-create-msg]');
  check(/shows the server key .* not .*no wallet was made/.test(m) && !(await appState(W.page)).bitcoin.wallet, 'joined with another server key: refused, and no Bitcoin wallet is made', m);
  await shot(W.page, 'btc-join-wrong-key');
  await W.page.fill('[data-testid=btc-ark-key]', K);
  await W.page.click('[data-testid=btc-create]');
  m = await msgOf(W.page, '[data-testid=btc-create-msg]');
  check(/Joined the Bitcoin ark on regtest/.test(m), 'the wallet\'s Bitcoin side joins the app\'s ark', m.slice(0, 120));
  const wInfo = await btc(W.page, 'ark_info');
  check(wInfo.ok && wInfo.result.server_pubkey === K, 'Bark\'s wallet reads the same server key', wInfo.ok ? wInfo.result.server_pubkey : wInfo.refusal);

  // B3. Board.
  await W.page.click('[data-testid=btc-onchain-address]');
  await W.page.waitForSelector('[data-testid=btc-onchain-address-text]');
  const onAddr = (await W.page.textContent('[data-testid=btc-onchain-address-text]')).trim();
  await core.cli('-rpcwallet=miner', 'sendtoaddress', onAddr, '0.02');
  await mine(1);
  await until('the wallet\'s on-chain funds', async () => (await summary(W.page)).onchain.confirmed_sat >= 2000000, 120000, () => mine(1));
  await W.page.fill('[data-testid=btc-board-amount]', '400000');
  await W.page.click('[data-testid=btc-board-go]');
  await W.page.waitForSelector('[data-testid=btc-board-quote]:not([hidden])');
  const fee = (await W.page.textContent('[data-testid=btc-board-fee]')).trim();
  check(/sat/.test(fee), 'the ark\'s board fee is shown before signing', fee);
  await W.page.click('[data-testid=btc-board-sign]');
  m = await msgOf(W.page, '[data-testid=btc-board-msg]');
  check(/Boarded/i.test(m), 'the wallet boards 400,000 sat into the app\'s ark', m.slice(0, 120));
  await until('the board to be spendable', async () => (await summary(W.page)).ark.spendable_sat > 0, 180000, async () => { await mine(1); await btc(W.page, 'maintain'); });
  check(true, 'the board is spendable in the ark', (await summary(W.page)).ark.spendable_sat);
  await nav(W.page, 'bitcoin');
  await shot(W.page, 'btc-boarded');

  // B4. Pay: a Bark wallet D on the command line, in the same ark.
  const D = path.join(WORK, 'bark-d');
  const dc = await run(BARK, ['--datadir', D, '--quiet', 'create', '--regtest', '--ark', ROUTE, '--bitcoind', core.url, '--bitcoind-cookie', core.cookie]);
  check(dc.ok, 'a command-line Bark wallet D joins the app\'s ark', dc.stderr.slice(-200));
  const dOn = (await bark(D, 'onchain', 'address')).json.address;
  await core.cli('-rpcwallet=miner', 'sendtoaddress', dOn, '0.01');
  await mine(1);
  await until('D\'s funding', async () => (await bark(D, 'onchain', 'balance')).json.confirmed_sat >= 1000000, 60000, () => mine(1));
  check((await bark(D, 'board', '300000 sats')).ok, 'D boards 300,000 sat');
  await until('D\'s board', async () => (await bark(D, 'balance')).json.spendable_sat > 0, 180000, async () => { await mine(1); await bark(D, 'maintain'); });
  const dAddr = (await bark(D, 'address')).json;
  const dBefore = (await bark(D, 'balance')).json.spendable_sat;
  await W.page.fill('[data-testid=btc-send-dest]', String(dAddr));
  await W.page.fill('[data-testid=btc-send-amount]', '20000');
  await W.page.click('[data-testid=btc-send-go]');
  m = await msgOf(W.page, '[data-testid=btc-send-msg]');
  check(!/refused/i.test(m), 'the payment is made in the app', m.slice(0, 120));
  await until('D to hold the payment', async () => { await bark(D, 'maintain'); return (await bark(D, 'balance')).json.spendable_sat >= dBefore + 20000; }, 120000);
  check(true, 'the wallet pays D 20,000 sat in the app\'s ark, and D holds it', `${dBefore} -> ${(await bark(D, 'balance')).json.spendable_sat}`);
  await shot(W.page, 'btc-paid');

  // B5. Refresh.
  const vt0 = (await btc(W.page, 'vtxos')).result.map((v) => v.id);
  await W.page.click('[data-testid=btc-refresh-all]');
  m = await msgOf(W.page, '[data-testid=btc-refresh-msg]');
  check(/Handed to the next round/.test(m), 'every leaf is handed to the app\'s ark\'s next round', m.slice(0, 120));
  await until('new leaves from the round', async () => {
    const v = (await btc(W.page, 'vtxos')).result.filter((x) => x.state.type === 'spendable');
    return v.length && v.every((x) => !vt0.includes(x.id));
  }, 240000, async () => { await mine(1); await btc(W.page, 'maintain'); });
  check(true, 'refreshed: the leaves are new ones from the ark\'s round');
  await page_refresh(W.page);
  await shot(W.page, 'btc-refreshed');

  // B6. Work in flight; the ark stopped and started from the app.
  const s0 = await summary(W.page);
  const wArk = (await btc(W.page, 'address')).result;
  check((await bark(D, 'send', String(wArk), '10000 sats')).ok, 'in flight: D pays the wallet 10,000 sat in the ark');
  await W.page.fill('[data-testid=btc-board-amount]', '50000');
  await W.page.click('[data-testid=btc-board-go]');
  await W.page.waitForSelector('[data-testid=btc-board-quote]:not([hidden])');
  await W.page.click('[data-testid=btc-board-sign]');
  m = await msgOf(W.page, '[data-testid=btc-board-msg]');
  const boarded = Number(((m.match(/Boarded ([\d,]+) sat/) || [])[1] || '').replace(/,/g, ''));
  check(boarded > 0 && boarded < 50000, 'in flight: a board of 50,000 sat is broadcast, unconfirmed; it holds 50,000 less its fee', `${boarded} sat`);
  m = await deployClick(R.page, 'db-stop', 'db-msg');
  check(/watchmand stopped \(SIGTERM\)/.test(m) && /captaind stopped \(SIGTERM\)/.test(m), 'the ark is stopped from the app, neither killed', m);
  check(Object.values(bp1).every((p) => !alive(p)), 'no process of the ark runs');
  await mine(3);
  const downMaintain = await btc(W.page, 'maintain');
  const sDown = await summary(W.page).catch((e) => ({ error: e.message }));
  log('     while the ark is down: maintain', downMaintain.ok ? 'ok' : downMaintain.refusal, '; the ark side', sDown.ark || sDown);
  check(!downMaintain.ok || !sDown.ark || sDown.ark.spendable_sat === s0.ark.spendable_sat, 'while the ark is down, neither the payment nor the board has reached the wallet');
  await R.page.click('[data-testid=deploy-refresh]');
  await shot(R.page, 'deploy-btc-stopped', '[data-testid=deploy-btc]');
  m = await deployClick(R.page, 'db-start', 'db-msg');
  check(m.includes(K), 'the ark is started again from the app, with the same server key', m);
  await until('the payment and the board to arrive', async () => {
    const s = await summary(W.page);
    log('     the wallet\'s Bitcoin ark:', s.ark);
    return s.ark.spendable_sat >= s0.ark.spendable_sat + 10000 + boarded ? s : null;
  }, 300000, async () => { await mine(1); await btc(W.page, 'maintain'); });
  const s1 = await summary(W.page);
  check(s1.ark.spendable_sat === s0.ark.spendable_sat + 10000 + boarded, 'nothing lost: the 10,000 paid and the board made while in flight are spendable',
    `${s0.ark.spendable_sat} -> ${s1.ark.spendable_sat}`);
  await page_refresh(W.page);
  await shot(W.page, 'btc-after-restart');
  await nav(R.page, 'deploy');
  await R.page.click('[data-testid=deploy-refresh]');
  await R.page.waitForSelector('[data-testid=db-server-key]');
  await shot(R.page, 'deploy-btc-running-again', '[data-testid=deploy-btc]');
}
async function page_refresh(page) {
  await nav(page, 'bitcoin');
  await page.click('[data-testid=btc-refresh]');
  await page.waitForSelector('[data-testid=btc-total]');
}

// ------------------------------------------------------------------------------------------------
async function main() {
  const st = await ctl('/state');
  log('operator harness:', { server: st.server, node: st.node_url, X: st.x, Y: st.y, tip: st.tip });
  log('app:', process.env.ARCA_CLIENT_APP || ROOT);
  log('work:', WORK);
  const R = { home: path.join(WORK, 'runner') }; const W = { home: path.join(WORK, 'wallet') };
  Object.assign(R, await launch(R.home, 'runner'));
  Object.assign(W, await launch(W.home, 'wallet'));
  const cores = [];
  try {
    if (PHASES.includes('seq')) await sequentia(st, R, W);
    if (PHASES.includes('btc')) {
      if (!PHASES.includes('seq')) throw new Error('the Bitcoin phase runs after the Sequentia one: the wallet joins an operator first');
      if (!CORE) throw new Error('DEPLOY_CORE_BIN names no Bitcoin Core 31');
      await bitcoin(st, R, W, cores);
    }
    if (PHASES.includes('seq')) {
      const end = await deployState(R.page);
      check(end.sequentia.daemons.every((d) => d.running), 'at the end, the Sequentia operator still runs, every process of it', pidsOf(end, 'sequentia'));
    }
    check(pageErrors.length === 0, 'no page error in either window', pageErrors);
  } finally {
    // Everything the runner's app started is stopped from it.
    try {
      if (R.page) {
        for (const a of ['ark-stop', 'seq-stop']) {
          const r = await deployRun(R.page, a);
          log(`cleanup ${a}:`, r.ok ? r.result : r.refusal);
        }
      }
    } catch (e) { log('cleanup:', e.message); }
    for (const a of apps.slice()) await quit(a).catch(() => {});
    for (const c of cores) await stopCore(c).catch(() => {});
    log(`${checks} checks, ${shots} screenshots`);
  }
}

main().then(() => { LOG.end(); process.exit(0); }).catch((e) => { log('DRIVE FAILED', e.stack || e.message); LOG.end(); setTimeout(() => process.exit(1), 500); });
