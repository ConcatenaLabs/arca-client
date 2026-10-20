'use strict';
// The window. Everything it shows of the wallet comes from a run of the arca
// client, through window.arca; a refusal is shown in the wallet's own words.

const $ = (id) => document.getElementById(id);

// An element: h('div', {class: 'x', 'data-testid': 'y'}, child, 'text', …).
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'onclick') e.addEventListener('click', v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let state = null;
let labels = {};
const sessionRefusals = [];

// --- formatting ----------------------------------------------------------------
function group(n) {
  const s = String(n);
  if (!/^[0-9]+$/.test(s)) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function assetName(id) {
  if (!id) return '';
  if (id === 'BTC') return 'BTC';
  return labels[id] || `${id.slice(0, 8)}…${id.slice(-4)}`;
}
function assetEl(id) { return h('span', { class: 'asset', title: id }, assetName(id)); }
function median(t) {
  if (t == null) return '—';
  const d = new Date(Number(t) * 1000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
function rel(t, now) {
  if (t == null || now == null) return '';
  let s = Number(t) - Number(now);
  const past = s < 0; s = Math.abs(s);
  const d = Math.floor(s / 86400); const hr = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  const txt = d ? `${d} d ${hr} h` : hr ? `${hr} h ${m} min` : `${m} min`;
  return past ? `${txt} ago` : `in ${txt}`;
}
function reference(v) {
  if (v == null) return '—';
  const n = BigInt(v);
  const whole = n / 100000000n; const frac = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${group(whole.toString())}${frac ? '.' + frac : ''}`;
}

// --- messages ----------------------------------------------------------------------
function refusalEl(r, context) {
  const tag = [r.kind, r.code, r.status].filter((x) => x != null && x !== '').join(' · ');
  return h('div', { class: 'refusal', 'data-testid': 'refusal' },
    h('div', { class: 'rk' }, context ? `${context} — refused (${tag})` : `Refused (${tag})`),
    h('div', { class: 'rm', 'data-testid': 'refusal-message' }, r.message));
}
function show(el, out, okText, context) {
  clear(el); el.className = 'msg';
  if (out.ok) {
    el.classList.add('ok');
    el.append(h('div', { class: 'okline' }, okText || 'Done.'));
    for (const n of out.notes || []) el.append(h('div', { class: 'note' }, n));
  } else {
    sessionRefusals.unshift({ at: new Date(), context, refusal: out.refusal });
    el.append(refusalEl(out.refusal, context));
    for (const n of out.notes || []) el.append(h('div', { class: 'note' }, n));
  }
}
function pending(el, text) { clear(el); el.className = 'msg'; el.append(h('div', { class: 'busy' }, text)); }
function jsonBlock(v) { return h('details', { class: 'raw' }, h('summary', {}, 'The wallet\'s answer'), h('pre', {}, JSON.stringify(v, null, 2))); }

async function run(command, args) { return arca.run(command, args); }

// --- navigation ----------------------------------------------------------------------
const loaders = {};
function go(view) {
  for (const s of document.querySelectorAll('.view')) s.classList.toggle('active', s.dataset.view === view);
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('active', b.dataset.view === view);
  document.body.dataset.view = view;
  if (loaders[view]) loaders[view]().catch((e) => console.error(e));
}
for (const b of document.querySelectorAll('.nav')) b.addEventListener('click', () => go(b.dataset.view));

async function refreshState() {
  state = await arca.state();
  document.body.classList.toggle('nowallet', !state.joined);
  const r = state.runner.running;
  $('run-label').textContent = r ? `running: arca ${r.command}${state.runner.queued ? ` (+${state.runner.queued})` : ''}` : '';
  renderSyncLabel(state.sync);
  return state;
}
function renderSyncLabel(s) {
  const dot = $('sync-dot'); const label = $('sync-label');
  if (!s) return;
  if (s.busy) { dot.className = 'dot busy'; label.textContent = 'syncing…'; return; }
  const last = s.lastSync;
  if (!last) { dot.className = 'dot off'; label.textContent = !state.joined ? 'no wallet yet' : s.enabled ? 'waiting for the first sync' : 'sync is off'; return; }
  dot.className = last.ok ? 'dot on' : 'dot bad';
  label.textContent = `${last.ok ? 'synced' : 'sync refused'} ${new Date(last.at).toLocaleTimeString()}`;
}

// --- join -----------------------------------------------------------------------------
function joinForm() {
  return {
    url: $('j-node-url').value.trim(), cookie: $('j-node-cookie').value.trim(),
    user: $('j-node-user').value.trim(), password: $('j-node-pass').value,
  };
}
for (const r of document.querySelectorAll('input[name=w-src]')) {
  r.addEventListener('change', () => { $('j-mnemonic').hidden = document.querySelector('input[name=w-src]:checked').value !== 'restore'; });
}
$('j-node-test').addEventListener('click', async () => {
  pending($('j-node-msg'), 'Asking the node…');
  await arca.setNode(joinForm());
  const out = await arca.testNode();
  if (!out.ok) return show($('j-node-msg'), out, null, 'the node');
  const t = out.result;
  const anchors = t.anchors && !t.anchors.error ? 'answers getanchorstatus' : `getanchorstatus: ${t.anchors && t.anchors.error}`;
  show($('j-node-msg'), { ok: true, notes: [`chain ${t.chain}, ${group(t.blocks)} blocks${t.ibd ? ', still catching up' : ''}`,
    `transaction index: ${t.txindex === true ? 'on' : t.txindex === false ? 'off — start the node with -txindex' : 'unknown'}`, anchors] }, 'The node answers.');
});
$('j-join').addEventListener('click', async () => {
  const restore = document.querySelector('input[name=w-src]:checked').value === 'restore';
  await arca.setNode(joinForm());
  await arca.setOperator({ url: $('j-op-url').value.trim() });
  pending($('j-msg'), restore ? 'Creating the wallet and restoring it from what the operator serves to its mailbox key…' : 'Creating the wallet…');
  $('j-join').disabled = true;
  const out = await arca.join(restore ? { mnemonic: $('j-mnemonic').value } : {});
  $('j-join').disabled = false;
  if (!out.ok) return show($('j-msg'), out, null, 'join');
  show($('j-msg'), out, 'Joined.');
  const i = out.result;
  const body = clear($('j-done-body'));
  body.append(kv([
    ['Operator key, pinned', h('code', { 'data-testid': 'operator-key' }, i.operator || '')],
    ['Mailbox key', h('code', {}, i.mailbox || '')],
    ['Chain', i.chain || (i.server_info && i.server_info.chain) || ''],
  ]));
  if (i.operator_key_check) body.append(h('p', { class: 'warnline', 'data-testid': 'operator-key-check' }, i.operator_key_check));
  if (i.restore) {
    body.append(h('h2', { class: 'sub' }, 'Restored'));
    if (i.restore.error) body.append(refusalEl(i.restore.error, 'restore'));
    else body.append(h('p', {}, `${(i.restore.restored || []).length || i.restore.served || 0} coin(s) served and checked.`), jsonBlock(i.restore));
  }
  $('j-backup').hidden = restore;
  if (!restore) {
    const words = await arca.mnemonic();
    const w = clear($('j-words'));
    (words || '').split(/\s+/).forEach((x, n) => w.append(h('span', { class: 'word' }, h('i', {}, String(n + 1)), x)));
  }
  $('j-done').hidden = false;
  await refreshState();
});
$('j-continue').addEventListener('click', async () => { await arca.setBackedUp(); await refreshState(); go('wallet'); });

function kv(pairs) {
  const d = h('div', { class: 'kv' });
  for (const [k, v] of pairs) d.append(h('div', { class: 'k' }, k), h('div', { class: 'v' }, v == null ? '—' : v));
  return d;
}

// --- wallet ---------------------------------------------------------------------------
const STATE_ORDER = ['live', 'operator-confirmed', 'pending', 'receiving', 'sending', 'given', 'forfeited', 'offered', 'paying', 'exiting'];
function reading(el) { clear(el).append(h('p', { class: 'busy' }, 'Reading the wallet…')); return el; }
loaders.wallet = async () => {
  reading($('w-rows'));
  $('w-total').textContent = '…';
  labels = await arca.assetLabels();
  const out = await run('balance');
  const rows = clear($('w-rows'));
  if (!out.ok) { show($('w-msg'), out, null, 'balance'); return; }
  clear($('w-msg'));
  const b = out.result;
  $('w-total').textContent = b.total && b.total.value != null ? `${reference(b.total.value)}` : '—';
  $('w-total-unit').textContent = b.total && b.total.value != null ? `reference units · ${group(b.total.value)} atoms of the reference unit` : '';
  $('w-total-note').textContent = (b.total && b.total.note) || '';
  const btcRail = state.rails.find((r) => r.id === 'bitcoin');
  for (const row of b.rows || []) {
    const isBtc = row.asset === 'BTC';
    const parts = [];
    if (isBtc) {
      parts.push(h('div', { class: 'split' }, btcRail ? btcRail.note : ''));
      // What the wallet says of its Bitcoin side, once this build carries it.
      if (btcRail && btcRail.installed && b.bitcoin && b.bitcoin.note) parts.push(h('div', { class: 'split dim' }, b.bitcoin.note));
    } else {
      const states = (b.arca && b.arca[row.asset]) || {};
      const bits = [];
      if (b.sequentia_onchain && b.sequentia_onchain[row.asset] && b.sequentia_onchain[row.asset] !== '0') bits.push(`${group(b.sequentia_onchain[row.asset])} on-chain`);
      const keys = Object.keys(states).sort((x, y) => STATE_ORDER.indexOf(x) - STATE_ORDER.indexOf(y));
      for (const k of keys) if (states[k] !== '0') bits.push(`${group(states[k])} ${k}`);
      parts.push(h('div', { class: 'split' }, bits.join(' · ')));
      if (row.value) parts.push(h('div', { class: 'split dim' }, `worth ${reference(row.value)} reference units`));
    }
    rows.append(h('div', { class: `bal${isBtc ? ' btc' : ''}`, 'data-testid': `row-${isBtc ? 'BTC' : row.asset}` },
      h('div', { class: 'top' }, isBtc ? h('span', { class: 'asset' }, 'BTC') : assetEl(row.asset),
        h('span', { class: 'chain' }, isBtc ? 'Bitcoin' : 'Sequentia')),
      h('div', { class: 'total', 'data-testid': 'row-total' }, `${group(row.total)} ${row.unit === 'sat' ? 'sat' : 'atoms'}`),
      ...parts));
  }
  if (b.total && b.total.unvalued) rows.append(h('p', { class: 'hint' }, `Not in the total, the node having no rate for them: ${b.total.unvalued.map(assetName).join(', ')}.`));
  fillAssets(b);
};
$('w-refresh').addEventListener('click', () => loaders.wallet());
$('w-sync').addEventListener('click', async () => { await arca.syncNow(); await refreshState(); loaders.wallet(); });

function fillAssets(b) {
  const ids = new Set([...Object.keys(b.arca || {}), ...Object.keys(b.sequentia_onchain || {})]);
  const dl = clear($('asset-list'));
  for (const id of ids) dl.append(h('option', { value: id }, assetName(id)));
}

// --- board -----------------------------------------------------------------------------
$('b-addr').addEventListener('click', async () => {
  const out = await run('address');
  const el = clear($('b-addr-out'));
  if (!out.ok) return el.append(refusalEl(out.refusal, 'address'));
  const a = out.result.address || out.result;
  el.append(h('code', { 'data-testid': 'address-text' }, typeof a === 'string' ? a : JSON.stringify(a)),
    h('button', { class: 'ghost small', onclick: () => arca.copy(typeof a === 'string' ? a : JSON.stringify(a)) }, 'Copy'));
});
// A board: its fee, size and coins shown first, then signed on that very fee.
let boardQuote = null;
function boardArgs() { return { asset: $('b-asset').value.trim(), amount: $('b-amount').value.trim(), fee_asset: $('b-fee').value.trim() || null }; }
function feeText(f) { return f ? `${group(f.amount)} ${assetName(f.asset)}` : '—'; }
$('b-go').addEventListener('click', async () => {
  $('b-quote').hidden = true; boardQuote = null;
  pending($('b-msg'), 'Building the board at the node\'s fee floor now…');
  const a = boardArgs();
  const out = await run('board_quote', a);
  if (!out.ok) return show($('b-msg'), out, null, 'board');
  clear($('b-msg'));
  const q = out.result;
  boardQuote = { args: a, fee: q.fee };
  clear($('b-quote-body')).append(kv([
    ['Boards', `${group(q.value)} ${assetName(q.asset)}`],
    ['Fee', h('b', { 'data-testid': 'board-fee' }, feeText(q.fee))],
    ['Size', `${q.vsize} vB`],
    ['Spends', `${(q.inputs || []).length} on-chain coin(s)`],
  ]), h('p', { class: 'hint' }, q.note || ''));
  $('b-quote').hidden = false;
});
$('b-cancel').addEventListener('click', () => { $('b-quote').hidden = true; boardQuote = null; });
$('b-sign').addEventListener('click', async () => {
  if (!boardQuote) return;
  $('b-quote').hidden = true;
  pending($('b-msg'), 'Registering the board with the operator, then broadcasting it…');
  const out = await run('board', Object.assign({}, boardQuote.args, { shown: boardQuote.fee }));
  boardQuote = null;
  show($('b-msg'), out, out.ok ? `Boarded: ${out.result.txid || ''}` : null, 'board');
  if (out.ok) $('b-msg').append(jsonBlock(out.result));
  loaders.board();
});
loaders.board = async () => {
  reading($('b-list'));
  const out = await run('boards');
  const el = clear($('b-list'));
  if (!out.ok) return el.append(refusalEl(out.refusal, 'boards'));
  const list = Array.isArray(out.result) ? out.result : out.result.boards || [];
  if (!list.length) return el.append(h('p', { class: 'hint' }, 'No board yet.'));
  el.append(table(['Board transaction', 'Coin', 'By the server', 'By the chain', 'In the wallet'], list.map((b) => [
    h('code', { title: (b.server && b.server.txid) || '' }, ((b.server && b.server.txid) || '').slice(0, 16) + '…'),
    h('code', { title: b.leaf_id }, (b.leaf_id || '').slice(0, 12) + '…'),
    (b.server && b.server.state) || '—', b.finality || '—', b.state || '—'])));
};

// --- send --------------------------------------------------------------------------------
$('s-go').addEventListener('click', async () => {
  pending($('s-msg'), 'Building the transfer and asking the operator to co-sign…');
  const out = await run('send', { request: $('s-req').value.trim(), amount: $('s-amount').value.trim() || null, asset: $('s-asset').value.trim() || null });
  show($('s-msg'), out, out.ok ? `Sent ${group(out.result.sent && (out.result.sent.value || out.result.sent.amount) || $('s-amount').value)}: the operator co-signed and posted the coin to the receiver's mailbox.` : null, 'send');
  if (out.ok) $('s-msg').append(jsonBlock(out.result));
});

// --- receive ---------------------------------------------------------------------------
$('r-go').addEventListener('click', async () => {
  pending($('r-msg'), 'Drawing a fresh key…');
  const out = await run('receive', { asset: $('r-asset').value.trim() || null, amount: $('r-amount').value.trim() || null });
  if (!out.ok) { $('r-out').hidden = true; return show($('r-msg'), out, null, 'receive'); }
  clear($('r-msg'));
  const req = out.result.request || out.result.text || '';
  $('r-req').textContent = req;
  $('r-out').hidden = false;
  $('r-copied').textContent = '';
  const until = out.result.details ? out.result.details.until : out.result.until;
  const lapses = until != null ? `For one payment. It lapses ${median(until)}.` : 'For one payment.';
  $('r-msg').append(h('div', { class: 'note' }, lapses));
  loaders.receive();
});
$('r-copy').addEventListener('click', async () => { await arca.copy($('r-req').textContent); $('r-copied').textContent = 'Copied.'; });
loaders.receive = async () => {
  const out = await run('schedule');
  const el = clear($('r-list'));
  if (!out.ok) return el.append(refusalEl(out.refusal, 'schedule'));
  const reqs = out.result.receive_requests || [];
  if (!reqs.length) return el.append(h('p', { class: 'hint' }, 'None.'));
  el.append(table(['Key', 'Asset', 'Amount', 'State', 'Lapses', ''], reqs.map((r) => [
    h('code', {}, String(r.owner).slice(0, 16)), r.asset ? assetEl(r.asset) : 'any', r.amount ? group(r.amount) : 'any', r.state,
    r.lapses_at != null ? `${median(r.lapses_at)} (${rel(r.lapses_at, out.result.now)})` : 'never',
    h('button', { class: 'ghost small', onclick: async () => { const o = await run('forget_request', { owner: r.owner }); if (!o.ok) sessionRefusals.unshift({ at: new Date(), context: 'forget', refusal: o.refusal }); loaders.receive(); } }, 'Forget')])));
};

// --- coins and settle now -----------------------------------------------------------------
let quoteFor = null;
loaders.coins = async () => {
  reading($('c-list'));
  const [out, sch] = await Promise.all([run('coins'), run('schedule')]);
  const el = clear($('c-list'));
  if (!out.ok) return el.append(refusalEl(out.refusal, 'coins'));
  const now = sch.ok ? sch.result.now : null;
  const coins = Array.isArray(out.result) ? out.result : out.result.coins || [];
  const held = coins.filter((c) => !['spent', 'exited'].includes(c.state));
  const gone = coins.filter((c) => ['spent', 'exited'].includes(c.state));
  if (!coins.length) return el.append(h('p', { class: 'hint' }, 'No coin yet.'));
  const rowOf = (c) => [
    h('code', { title: c.leaf_id }, c.leaf_id.slice(0, 10) + '…'), assetEl(c.asset), group(c.value || c.amount || ''),
    h('span', { class: `st st-${c.standing || c.state}`, 'data-testid': `state-${c.leaf_id}` }, c.standing && c.standing !== c.state ? `${c.state} · ${c.standing}` : c.state),
    c.kind || (c.rests_on_board ? 'board' : '—'),
    c.exit_by != null ? h('span', {}, median(c.exit_by), h('br'), h('small', {}, rel(c.exit_by, now))) : '—',
    c.refresh_from != null ? h('span', {}, median(c.refresh_from), h('br'), h('small', {}, rel(c.refresh_from, now))) : '—',
    h('span', { class: 'acts' },
      c.state === 'live'
        ? h('button', { class: 'ghost small', 'data-testid': `settle-${c.leaf_id}`, onclick: () => quote([c.leaf_id]) }, 'Settle now') : null,
      !['spent', 'exited', 'lost'].includes(c.state) ? h('button', { class: 'ghost small', 'data-testid': `exit-${c.leaf_id}`, onclick: () => { exitCoin = c.leaf_id; go('exit'); } }, 'Exit drill') : null),
  ];
  el.append(table(['Coin', 'Asset', 'Value', 'State', 'Kind', 'Exit by', 'Refresh from', ''], held.map(rowOf)));
  for (const c of held) {
    if (c.note) el.append(h('p', { class: 'note' }, `${c.leaf_id.slice(0, 12)}…: ${c.note}`));
    if (c.exit_fee && c.exit_fee.note) el.append(h('p', { class: 'note' }, `${c.leaf_id.slice(0, 12)}…: ${c.exit_fee.note}`));
  }
  if (held[0] && held[0].sync) el.append(h('p', { class: 'hint' }, held[0].sync));
  if (gone.length) el.append(h('details', {}, h('summary', {}, `${gone.length} spent or exited`), table(['Coin', 'Asset', 'Value', 'State', 'Kind', 'Exit by', 'Refresh from', ''], gone.map(rowOf))));
  el.append(jsonBlock(out.result));
};
$('c-refresh').addEventListener('click', () => loaders.coins());
$('c-settle-all').addEventListener('click', () => quote([]));
async function quote(leaves) {
  $('c-quote').hidden = false;
  clear($('c-quote-msg'));
  const body = clear($('c-quote-body'));
  body.append(h('div', { class: 'busy' }, 'Asking the operator for its fee schedule…'));
  const out = await run('quote', { leaves });
  clear(body);
  if (!out.ok) { quoteFor = null; $('c-quote-go').disabled = true; return body.append(refusalEl(out.refusal, 'settle now')); }
  quoteFor = { leaves, shown: out.result.coins };
  $('c-quote-go').disabled = false;
  body.append(table(['Coin', 'Asset', 'Value', 'Fee', 'Share', 'Schedule'], out.result.coins.map((c) => [
    h('code', {}, String(c.leaf_id).slice(0, 12) + '…'), assetEl(c.asset), group(c.value), h('b', { 'data-testid': 'quote-fee' }, group(c.fee)),
    `${c.ppm} ppm of the coin (the wallet's bound: ${c.bound_ppm})${c.free_window ? ', in its free window' : ''}`,
    h('small', {}, c.schedule && typeof c.schedule === 'object'
      ? `${c.schedule.refresh_ppm} ppm + ${group(c.schedule.refresh_base)} atoms a coin` : String(c.schedule || ''))])));
}
$('c-quote-cancel').addEventListener('click', () => { $('c-quote').hidden = true; quoteFor = null; });
$('c-quote-go').addEventListener('click', async () => {
  if (!quoteFor) return;
  pending($('c-quote-msg'), 'Signing for exactly these fees and handing the coins to the operator\'s next round…');
  const out = await run('participate', { leaves: quoteFor.leaves, shown: quoteFor.shown });
  show($('c-quote-msg'), out, 'Handed over: the refresh runs in the operator\'s next round, and the sync after that round is final completes it.', 'settle now');
  if (out.ok) $('c-quote-msg').append(jsonBlock(out.result));
  quoteFor = null; $('c-quote-go').disabled = true;
  loaders.coins();
});

// --- schedule ------------------------------------------------------------------------------
loaders.schedule = async () => {
  await refreshState();
  $('sc-auto').checked = state.sync.enabled;
  reading($('sc-next'));
  const out = await run('schedule');
  const next = clear($('sc-next'));
  if (!out.ok) { next.append(refusalEl(out.refusal, 'schedule')); return; }
  const s = out.result;
  next.append(kv([
    ['The chain\'s median time', median(s.now)],
    ['Next sync', s.next_sync_at == null ? 'nothing waits' : `${median(s.next_sync_at)} (${rel(s.next_sync_at, s.now)})`],
    ['Due', s.due ? 'now' : 'no'],
    ['Why', s.why || '—'],
    ['The app syncs at', state.sync.target != null ? `${median(state.sync.target)} (${rel(state.sync.target, s.now)}), the earliest time the wallet has named` : '—'],
    ['On the schedule', state.sync.enabled ? `yes: the app looks every ${Math.round(state.sync.pollMs / 1000)} s, syncs when that time comes or the wallet says a sync is due, and at least daily` : 'no'],
  ]));
  $('sc-note').textContent = s.note || '';
  const c = clear($('sc-coins'));
  const coins = s.coins || [];
  if (!coins.length) c.append(h('p', { class: 'hint' }, 'No coin held off the chain.'));
  else c.append(table(['Coin', 'State', 'Daily from', 'Refresh from', 'Home from', 'Exit by'], coins.map((x) => [
    h('code', {}, x.leaf_id.slice(0, 12) + '…'), x.state,
    `${median(x.sync_daily_from)}`, `${median(x.refresh_from)} (${rel(x.refresh_from, s.now)})`, `${median(x.home_from)}`, `${median(x.exit_by)} (${rel(x.exit_by, s.now)})`])));
  const hist = clear($('sc-hist'));
  const list = state.sync.history || [];
  if (!list.length) hist.append(h('p', { class: 'hint' }, 'No sync yet in this run of the app.'));
  else hist.append(table(['When', 'Why', 'Took', 'Outcome'], list.map((x) => [new Date(x.at).toLocaleString(), x.reason, `${(x.ms / 1000).toFixed(1)} s`,
    x.ok ? 'ok' : h('span', { class: 'bad' }, x.refusal ? x.refusal.message : 'refused')])));
};
$('sc-auto').addEventListener('change', async (e) => { await arca.setAutoSync(e.target.checked); loaders.schedule(); });
$('sc-sync').addEventListener('click', async () => { await arca.syncNow(); loaders.schedule(); });

// --- exit drill --------------------------------------------------------------------------------
let exitCoin = null;
const exitStates = {};
loaders.exit = async () => {
  const out = await run('coins');
  const sel = clear($('x-coin'));
  if (!out.ok) return;
  const coins = (Array.isArray(out.result) ? out.result : out.result.coins || []).filter((c) => !['spent'].includes(c.state));
  for (const c of coins) exitStates[c.leaf_id] = c.state;
  for (const c of coins) sel.append(h('option', { value: c.leaf_id, selected: c.leaf_id === exitCoin }, `${c.leaf_id.slice(0, 16)}… · ${assetName(c.asset)} · ${group(c.value || '')} · ${c.state}`));
};
// An exit: what this run would broadcast, and at what fees, shown first;
// then broadcast on those very fees.
let exitQuote = null;
$('x-go').addEventListener('click', async () => {
  const leaf = $('x-coin').value;
  exitCoin = leaf;
  $('x-quote').hidden = true; exitQuote = null;
  pending($('x-msg'), 'Building this run at the node\'s fee floor now…');
  const fee_asset = $('x-fee').value.trim() || null;
  const out = await run('exit_quote', { leaf_id: leaf, fee_asset });
  if (!out.ok) {
    show($('x-msg'), out, null, 'exit');
    // A coin on its way out whose path is all on the chain has nothing left
    // to publish at a fee: a run follows its claim. On an empty set of fees
    // the wallet broadcasts nothing that pays one.
    if (exitStates[leaf] === 'exiting') {
      exitQuote = { leaf_id: leaf, fee_asset, shown: {} };
      clear($('x-quote-body')).append(h('p', { class: 'note', 'data-testid': 'exit-follow' },
        'The coin is on its way out. A run follows what is on the chain, its claim included, and publishes nothing that pays a fee.'));
      $('x-sign').textContent = 'Follow the exit';
      $('x-quote').hidden = false;
    }
    return;
  }
  $('x-sign').textContent = 'Broadcast';
  clear($('x-msg'));
  const q = out.result;
  exitQuote = { leaf_id: leaf, fee_asset, shown: q.unroll || {} };
  const body = clear($('x-quote-body'));
  const steps = q.steps || [];
  if (steps.length) {
    body.append(table(['Transaction', 'Size', 'Fee', 'Paid by'], steps.map((t, i) => [`${i + 1}`, `${t.vsize} vB`,
      (t.fee || []).map(feeText).join(' + ') || '0', t.paid_by || ''])));
  } else body.append(h('p', { class: 'note', 'data-testid': 'exit-nothing' }, 'Nothing to publish before the claim: the coin\'s path is on the chain.'));
  if (q.claim && !q.claim.error) body.append(h('p', { class: 'note', 'data-testid': 'exit-claim-quote' }, `The claim, once the exit delay of ${Math.round(q.exit_delay_seconds / 3600)} h has run: ${q.claim.vsize} vB, fee ${(q.claim.fee || []).map(feeText).join(' + ')}, paying ${group(q.claim.pays || '')}.`));
  else if (q.claim && q.claim.error) body.append(h('p', { class: 'note' }, `The claim: ${q.claim.error}`));
  body.append(h('p', { class: 'hint' }, q.note || ''));
  $('x-quote').hidden = false;
});
$('x-cancel').addEventListener('click', () => { $('x-quote').hidden = true; exitQuote = null; });
$('x-sign').addEventListener('click', async () => {
  if (!exitQuote) return;
  const { leaf_id: leaf } = exitQuote;
  $('x-quote').hidden = true;
  pending($('x-msg'), 'Taking the coin as far towards the chain as the chain allows now…');
  const out = await run('exit', exitQuote);
  exitQuote = null;
  show($('x-msg'), out, 'This run is done: what it published, and where the coin stands, are below.', 'exit');
  const entry = h('div', { class: 'panel step', 'data-testid': 'exit-step' }, h('div', { class: 'k' }, `${new Date().toLocaleTimeString()} · ${leaf.slice(0, 16)}…`));
  if (out.ok) {
    const r = out.result;
    if (r.state) entry.append(h('div', { class: 'okline', 'data-testid': 'exit-state' }, `state: ${r.state}`));
    for (const tx of r.broadcast || []) {
      const fee = (tx.fee || []).map(feeText).join(' + ');
      entry.append(h('div', { class: 'note', 'data-testid': 'exit-tx' }, 'published ', h('code', {}, tx.txid), ` · ${tx.vsize} vB${fee ? ` · fee ${fee}` : ''}`));
    }
    if (r.claim) {
      const c = typeof r.claim === 'string' ? { txid: r.claim } : r.claim;
      entry.append(h('div', { class: 'note', 'data-testid': 'exit-claim' }, 'claim ', h('code', {}, c.txid),
        c.vsize ? ` · ${c.vsize} vB` : '', c.pays ? ` · pays ${group(c.pays)} to ${c.to || 'the wallet'}` : '', c.finality ? ` · ${c.finality}` : ''));
    }
    if (r.next) entry.append(h('div', { class: 'note', 'data-testid': 'exit-next' }, r.next));
    if (r.error) entry.append(h('div', { class: 'note bad', 'data-testid': 'exit-error' }, r.error));
    if (r.note) entry.append(h('div', { class: 'note' }, r.note));
    for (const n of r.notes || []) entry.append(h('div', { class: 'note' }, typeof n === 'string' ? n : JSON.stringify(n)));
    entry.append(jsonBlock(r));
  } else entry.append(refusalEl(out.refusal, 'exit'));
  $('x-log').prepend(entry);
  loaders.exit();
});

// --- refusals ------------------------------------------------------------------------------------
loaders.refusals = async () => {
  reading($('f-list'));
  const s = clear($('f-session'));
  if (!sessionRefusals.length) s.append(h('p', { class: 'hint' }, 'None in this session.'));
  for (const r of sessionRefusals) s.append(h('div', {}, h('small', { class: 'dim' }, r.at.toLocaleTimeString()), refusalEl(r.refusal, r.context)));
  const out = await run('refusals');
  const el = clear($('f-list'));
  if (!out.ok) return el.append(refusalEl(out.refusal, 'refusals'));
  const list = Array.isArray(out.result) ? out.result : out.result.refusals || [];
  if (!list.length) return el.append(h('p', { class: 'hint' }, 'None.'));
  for (const r of list.slice().reverse()) {
    el.append(h('div', { class: 'refusal' }, h('div', { class: 'rk' }, [r.at != null ? median(r.at) : '', r.what || r.kind || ''].filter(Boolean).join(' · ')),
      h('div', { class: 'rm', 'data-testid': 'wallet-refusal' }, r.reason || r.message || JSON.stringify(r))));
  }
};
$('f-refresh').addEventListener('click', () => loaders.refusals());

// --- settings --------------------------------------------------------------------------------------
loaders.settings = async () => {
  await refreshState();
  clear($('st-wallet')).append(...kv([
    ['Directory', h('code', {}, state.datadir)],
    ['Client', h('code', {}, state.arca.bin || 'not found')],
    ['Client build', state.arca.version ? state.arca.version.split('\n').filter(Boolean).join(' · ') : (state.mode === 'attached' ? 'attached' : '—')],
    ['App', state.appVersion],
  ]).childNodes);
  const p = clear($('st-pinned'));
  if (state.joined) {
    const out = await run('info');
    if (out.ok) {
      const i = out.result;
      p.append(...kv([
        ['Operator address', h('code', { 'data-testid': 'settings-operator' }, i.server || (state.operator && state.operator.url) || '')],
        ['Operator key, pinned', h('code', {}, i.operator || '')],
        ['Node', h('code', {}, i.node_url || i.node || state.node.url)],
        ['Chain', i.chain || ''],
      ]).childNodes);
      p.append(h('p', { class: 'hint' }, 'The wallet pins its node and operator when it joins. To use another, restore the mnemonic in a new wallet directory against them.'));
    } else p.append(refusalEl(out.refusal, 'info'));
  } else {
    p.append(...kv([['Node', h('code', {}, state.node.url)], ['Operator address', h('code', {}, state.operator.url || '—')]]).childNodes);
  }
  for (const r of document.querySelectorAll('input[name=st-mode]')) r.checked = r.value === state.mode;
  $('st-bin').value = state.attached.bin || ''; $('st-dir').value = state.attached.datadir || '';
  $('st-log').textContent = (await arca.logs()).slice(-200).join('\n');
};
$('st-node-test').addEventListener('click', async () => {
  pending($('st-node-msg'), 'Asking the node…');
  const out = await arca.testNode();
  if (!out.ok) return show($('st-node-msg'), out, null, 'the node');
  const t = out.result;
  show($('st-node-msg'), { ok: true, notes: [`chain ${t.chain}, ${group(t.blocks)} blocks`, `transaction index: ${t.txindex ? 'on' : 'off'}`] }, 'The node answers.');
});
$('st-mode-save').addEventListener('click', async () => {
  const mode = document.querySelector('input[name=st-mode]:checked').value;
  await arca.setMode({ mode, bin: $('st-bin').value, datadir: $('st-dir').value });
  await refreshState();
  show($('st-mode-msg'), { ok: true }, mode === 'attached' ? `Attached to the wallet in ${state.datadir}.` : 'Using the client this app carries.');
  if (!state.joined && mode === 'bundled') go('join');
});

// --- tables -------------------------------------------------------------------------------------
function table(head, rows) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c)))))));
}

// --- live updates -------------------------------------------------------------------------------
arca.onSyncEvent(async (e) => {
  if (e.type === 'sync-start') { $('sync-dot').className = 'dot busy'; $('sync-label').textContent = 'syncing…'; }
  if (e.type === 'sync') {
    if (!e.sync.ok) sessionRefusals.unshift({ at: new Date(e.sync.at), context: 'sync', refusal: e.sync.refusal });
    await refreshState();
    const v = document.body.dataset.view;
    if (['wallet', 'coins', 'schedule'].includes(v)) loaders[v]();
  }
});
setInterval(() => { refreshState().catch(() => {}); }, 2000);

(async () => {
  await refreshState();
  const st = state;
  $('j-node-url').value = st.node.url || '';
  $('j-node-user').value = st.node.user || '';
  $('j-node-cookie').value = st.node.cookie || '';
  $('j-op-url').value = (st.operator && st.operator.url) || '';
  go(st.joined ? 'wallet' : 'join');
})();
