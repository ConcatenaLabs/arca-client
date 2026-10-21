'use strict';
// The database the operators the app runs keep their state in: a PostgreSQL
// cluster of the app's own, in the profile's directory, which the app
// initialises, starts, stops and backs up. arcad keeps its database there
// (`arca`), and Bark's server its own (`bark_captaind`).
//
// The cluster runs PostgreSQL's server programs installed on the machine
// (`apt install postgresql`, or a build of its own): the app
// looks in the usual places, or uses the directory the runner names.
//
//   - It listens on 127.0.0.1 alone, on a port the app picks below Linux's
//     ephemeral range, with no Unix socket, and every role logs in with a
//     password (SCRAM): the superuser's and each daemon's, drawn by the app and
//     kept in files only their owner can read.
//   - Its durability settings are PostgreSQL's defaults (fsync,
//     synchronous_commit and full_page_writes on), and every commit is
//     archived as it happens (archive_mode on): each WAL segment is copied to
//     the backup directory the runner names, which a base backup completes.
//     That is the database's backup: a restore is to the latest commit, the
//     base backup with every archived segment to its end, never an older copy.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Daemon, sleep } = require('./daemon');
const { newPassword, writeSecret, readSecret } = require('./secrets');

const ADMIN = 'arca_admin';
const NEEDED = ['initdb', 'postgres', 'psql', 'pg_basebackup'];

function exeName(n) { return process.platform === 'win32' ? `${n}.exe` : n; }
function hasAll(dir) { return !!dir && NEEDED.every((n) => { try { return fs.existsSync(path.join(dir, exeName(n))); } catch { return false; } }); }

// The directories PostgreSQL's programs are usually found in, newest version
// first, then those on the PATH.
function candidates() {
  const out = [];
  for (const base of ['/usr/lib/postgresql', '/usr/pgsql', 'C:\\Program Files\\PostgreSQL']) {
    let vs;
    try { vs = fs.readdirSync(base); } catch { continue; }
    vs.sort((a, b) => Number(b) - Number(a) || b.localeCompare(a));
    for (const v of vs) out.push(path.join(base, v, 'bin'));
  }
  for (const d of ['/usr/local/pgsql/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) out.push(d);
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) out.push(d);
  return out;
}

// The directory to use: the one named, when it holds every program needed,
// else the first usual one that does.
function findPostgres(named) {
  if (named) return hasAll(named) ? named : null;
  return candidates().find(hasAll) || null;
}

function run(bin, args, { env = {}, input = '', timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: Object.assign({}, process.env, env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(bin)} ${args[0] || ''}: ${(err || out).trim().split('\n').slice(-3).join(' · ') || `exited ${code}`}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// SQL literals and identifiers for the few statements the app writes itself,
// from names and passwords it drew (hex) or fixed names.
function ident(s) { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`not a plain name: ${s}`); return `"${s}"`; }
function literal(s) { return `'${String(s).replace(/'/g, "''")}'`; }

class Postgres {
  // opts: {home (the directory everything of the database lives in), binDir,
  // port, backupDir}
  constructor(opts) {
    this.home = opts.home;
    this.binDir = opts.binDir;
    this.port = opts.port;
    this.backupDir = opts.backupDir || null;
    this.dataDir = path.join(this.home, 'data');
    this.secrets = path.join(this.home, 'secrets');
    this.daemon = new Daemon({
      name: 'PostgreSQL', bin: this.bin('postgres'), args: ['-D', this.dataDir],
      logFile: path.join(this.home, 'log', 'postgres.log'), pidFile: path.join(this.home, 'run', 'postgres.pid'),
      pidFromFile: path.join(this.dataDir, 'postmaster.pid'), stopSignal: 'SIGINT', graceMs: 120000,
    });
  }

  bin(n) { return this.binDir ? path.join(this.binDir, exeName(n)) : null; }
  initialised() { return fs.existsSync(path.join(this.dataDir, 'PG_VERSION')); }
  version() { try { return fs.readFileSync(path.join(this.dataDir, 'PG_VERSION'), 'utf8').trim(); } catch { return null; } }
  adminPassword() { return readSecret(path.join(this.secrets, `${ADMIN}.password`)); }

  // Where each WAL segment is copied as it is written: the backup directory's
  // `wal`, or nowhere yet (a command that keeps them until it is named, so
  // nothing is lost before).
  archiveCommand() {
    if (!this.backupDir) return 'false';
    const dir = path.join(this.backupDir, 'wal');
    // PostgreSQL substitutes %p (the segment's path) and %f (its name); a
    // segment archived already is never overwritten.
    return `test ! -f '${dir.replace(/'/g, '')}/%f' && cp %p '${dir.replace(/'/g, '')}/%f'`;
  }

  // Initialises the cluster once. Never touches one that exists.
  async init() {
    if (this.initialised()) return false;
    if (!this.binDir) throw new Error('PostgreSQL\'s server programs were not found: install PostgreSQL, or name the directory that holds initdb and postgres');
    const pwFile = path.join(this.secrets, `${ADMIN}.password`);
    if (!fs.existsSync(pwFile)) writeSecret(pwFile, newPassword());
    fs.mkdirSync(path.dirname(this.dataDir), { recursive: true, mode: 0o700 });
    if (this.backupDir) fs.mkdirSync(path.join(this.backupDir, 'wal'), { recursive: true, mode: 0o700 });
    await run(this.bin('initdb'), ['-D', this.dataDir, '-U', ADMIN, '--pwfile', pwFile, '--auth', 'scram-sha-256', '-E', 'UTF8', '--locale', 'C']);
    const conf = [
      '', '# Written by the Arca client when it made this cluster.',
      "listen_addresses = '127.0.0.1'", `port = ${this.port}`, "unix_socket_directories = ''",
      'fsync = on', 'synchronous_commit = on', 'full_page_writes = on',
      'wal_level = replica', 'archive_mode = on', `archive_command = ${literal(this.archiveCommand())}`,
      'max_connections = 100', '',
    ].join('\n');
    fs.appendFileSync(path.join(this.dataDir, 'postgresql.conf'), conf);
    return true;
  }

  // Points the archive at the backup directory, read again by a running
  // server (archive_command reloads without a restart).
  async setBackupDir(dir) {
    this.backupDir = dir;
    fs.mkdirSync(path.join(dir, 'wal'), { recursive: true, mode: 0o700 });
    const f = path.join(this.dataDir, 'postgresql.auto.conf');
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { /* none yet */ }
    text = text.split('\n').filter((l) => !/^archive_command\s*=/.test(l)).join('\n').replace(/\n*$/, '\n');
    fs.writeFileSync(f, `${text}archive_command = ${literal(this.archiveCommand())}\n`, { mode: 0o600 });
    const pid = this.daemon.pid();
    if (pid) process.kill(pid, 'SIGHUP');
  }

  env() { return { PGPASSWORD: this.adminPassword(), PGHOST: '127.0.0.1', PGPORT: String(this.port), PGUSER: ADMIN, PGCONNECT_TIMEOUT: '5' }; }

  async psql(sql, db = 'postgres') {
    return (await run(this.bin('psql'), ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { env: this.env() })).trim();
  }

  async ready() { try { await this.psql('select 1'); return true; } catch { return false; } }

  async start() {
    await this.init();
    if (!this.daemon.pid()) await this.daemon.start(1000);
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      if (await this.ready()) return true;
      if (!this.daemon.pid()) throw new Error(`PostgreSQL stopped: ${this.daemon.log(5).join(' · ')}`);
      await sleep(300);
    }
    throw new Error(`PostgreSQL did not answer within a minute: ${this.daemon.log(5).join(' · ')}`);
  }

  stop() { return this.daemon.stop(); }
  status() { return Object.assign(this.daemon.status(), { port: this.port, version: this.version(), bin: this.binDir, backupDir: this.backupDir }); }

  // A role and a database it owns, each made once; the role's password is
  // drawn here and kept in the cluster's secrets. Answers the password.
  async ensureDatabase(db, role) {
    const pwFile = path.join(this.secrets, `${role}.password`);
    if (!fs.existsSync(pwFile)) writeSecret(pwFile, newPassword());
    const pw = readSecret(pwFile);
    if (!(await this.psql(`select 1 from pg_roles where rolname = ${literal(role)}`))) {
      await this.psql(`create role ${ident(role)} login password ${literal(pw)}`);
    }
    if (!(await this.psql(`select 1 from pg_database where datname = ${literal(db)}`))) {
      await this.psql(`create database ${ident(db)} owner ${ident(role)}`);
    }
    return pw;
  }

  // A base backup of the whole cluster into `<backupDir>/base-<time>`, which
  // with the archived WAL after it restores the database to its latest commit.
  async baseBackup() {
    if (!this.backupDir) throw new Error('name a backup directory first');
    const dir = path.join(this.backupDir, `base-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await run(this.bin('pg_basebackup'), ['-D', dir, '-F', 'tar', '-z', '-X', 'fetch', '-c', 'fast', '--no-password'], { env: this.env(), timeoutMs: 1800000 });
    return dir;
  }
}

module.exports = { Postgres, findPostgres, candidates, ADMIN, literal, ident };
