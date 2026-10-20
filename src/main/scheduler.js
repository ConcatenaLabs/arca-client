'use strict';
// SyncScheduler keeps the wallet synced on the wallet library's own schedule
// while the app runs. `arca schedule` says when `sync` must next run
// (`next_sync_at`, a median time of the chain, and `due`), asking nothing of
// the operator; the scheduler asks it every `pollMs` and runs `arca sync` when
// it is due. It also runs `sync` when the app starts with a wallet, and at
// least once a day whatever the schedule says, as the wallet asks of every
// program that holds coins off the chain or waits for a payment.
//
// The schedule is in the chain's median time, not this machine's clock, so
// the scheduler never computes a wait from a date. It keeps the earliest
// `next_sync_at` it has been given since the last sync (`target`), and syncs
// once the chain's `now` reaches it. Holding the date matters: for a coin
// handed to a refresh, the wallet names a time an hour on from whenever it is
// asked, so `due` alone would never come.

const DAY_MS = 24 * 3600 * 1000;

class SyncScheduler {
  // runner: an ArcaRunner. opts: {pollMs, onEvent?(event)}
  constructor(runner, opts = {}) {
    this.runner = runner;
    this.pollMs = opts.pollMs || 120000;
    this.onEvent = opts.onEvent || null;
    this.timer = null;
    this.enabled = false;
    this.busy = false;
    this.lastSchedule = null;   // the last answer of `schedule`
    this.lastSync = null;       // {at, ok, result?|refusal?, reason}
    this.lastSyncOkAt = 0;
    this.target = null;         // the median time the schedule named for the next sync
    this.history = [];          // the last syncs, newest first
  }

  emit(e) { if (this.onEvent) { try { this.onEvent(e); } catch { /* best effort */ } } }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this._arm(0, 'the app started');
  }

  stop() {
    this.enabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _arm(ms, reason) {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(reason).catch(() => {}), ms);
  }

  // One look at the schedule, and a sync if it is due, or if the first look
  // of this run of the app, or a day since the last sync that succeeded.
  async tick(reason = 'the schedule') {
    if (this.busy || !this.runner.exists()) { this._arm(this.pollMs, 'the schedule'); return; }
    this.busy = true;
    try {
      let why = null;
      try {
        const { result } = await this.runner.run(['schedule']);
        this.lastSchedule = Object.assign({ read_at: Date.now(), target: this.target }, result);
        this.emit({ type: 'schedule', schedule: this.lastSchedule });
        if (result.due) why = result.why ? `due: ${result.why}` : 'due on the schedule';
        else if (this.target != null && result.now >= this.target) why = 'due: the time the schedule named';
        this.hold(result.next_sync_at);
      } catch (e) {
        this.lastSchedule = { read_at: Date.now(), error: e.refusal || { kind: 'client', message: e.message } };
        this.emit({ type: 'schedule', schedule: this.lastSchedule });
      }
      if (!why && reason === 'the app started') why = 'the app started';
      if (!why && Date.now() - this.lastSyncOkAt >= DAY_MS) why = 'a day since the last sync';
      if (why) await this.syncNow(why);
    } finally {
      this.busy = false;
      this._arm(this.pollMs, 'the schedule');
    }
  }

  // Runs `sync` now, for `reason`, and reads the schedule it leaves.
  async syncNow(reason = 'asked for') {
    const at = Date.now();
    this.emit({ type: 'sync-start', reason, at });
    let entry;
    try {
      const { result, notes } = await this.runner.run(['sync']);
      entry = { at, ok: true, reason, result, notes };
      this.lastSyncOkAt = Date.now();
      if (result && result.schedule) {
        // A sync names the next time afresh.
        this.target = null;
        this.hold(result.schedule.next_sync_at);
        this.lastSchedule = Object.assign({ read_at: Date.now(), target: this.target }, result.schedule);
        this.emit({ type: 'schedule', schedule: this.lastSchedule });
      }
    } catch (e) {
      entry = { at, ok: false, reason, refusal: e.refusal || { kind: 'client', message: e.message }, notes: e.notes || [] };
    }
    entry.ms = Date.now() - at;
    this.lastSync = entry;
    this.history.unshift(entry);
    if (this.history.length > 50) this.history.length = 50;
    this.emit({ type: 'sync', sync: entry });
    return entry;
  }

  // Keeps the earliest time the schedule has named.
  hold(next) {
    if (next == null) return;
    this.target = this.target == null ? next : Math.min(this.target, next);
  }

  status() {
    return {
      enabled: this.enabled, pollMs: this.pollMs, busy: this.busy, target: this.target,
      schedule: this.lastSchedule, lastSync: this.lastSync,
      history: this.history.map((h) => ({ at: h.at, ok: h.ok, reason: h.reason, ms: h.ms, refusal: h.refusal || null })),
    };
  }
}

module.exports = { SyncScheduler, DAY_MS };
