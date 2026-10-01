// The Trello pitch monitor, running in this add-on. It moved here from the
// pitch-checker Worker on 2026-10-01: Cloudflare's free-plan CPU cap kept
// killing Worker runs, which delayed alerts by up to half an hour.
//
// monitor/*.mjs and monitor/monitor-schema.sql are unmodified copies from the
// pitch-checker project (trello-monitor.mjs, bridge-api.mjs, match-engine.mjs),
// so the Pi runs exactly the code the Worker ran. A local SQLite file stands in
// for Cloudflare D1, and the Worker's /bridge/* API is answered in-process.
//
// First start: the add-on asks the Worker to hand over (POST /bridge/handover).
// The Worker pauses its monitor, waits for a running check, and returns the
// state, history, settings, queued alerts and Trello/AI keys. Once they are
// saved here the add-on confirms (POST /bridge/handover/done) and the Worker
// refuses to hand them out again. Until then nothing changes: the Worker keeps
// monitoring and this add-on keeps collecting its alerts.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { runTrelloMonitor, monitorLLM, withMonitorSettings } from './monitor/trello-monitor.mjs';
import { handleBridgeApi } from './monitor/bridge-api.mjs';
import { monitorEngine } from './monitor/match-engine.mjs';
import { DATA, log, remoteApi } from './bridge.mjs';

const SCHEMA = new URL('./monitor/monitor-schema.sql', import.meta.url);
const INTERVAL = 60000;

// Cloudflare D1's API (prepare/bind/run/first/all/batch) over node:sqlite.
export function openD1(file) {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  sqlite.exec(readFileSync(SCHEMA, 'utf8'));
  const statement = (query, args) => ({
    exec: () => ({ meta: { changes: Number(sqlite.prepare(query).run(...args).changes) } }),
    async run() { return this.exec(); },
    async first() { return sqlite.prepare(query).get(...args) ?? null; },
    async all() { return { results: sqlite.prepare(query).all(...args) }; },
  });
  return {
    sqlite,
    prepare: query => ({ bind: (...args) => statement(query, args) }),
    // Atomic like D1. Synchronous, so no other work can slip into the transaction.
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(s => s.exec()); sqlite.exec('COMMIT'); return results; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}

const TABLE = /^trello_monitor_(state|jobs|health|scans|wa_outbox)$/;
const COLUMN = /^[a-z_]+$/;
export async function importHandover(db, payload) {
  if (!/^[a-f0-9]{24}$/.test(payload?.board || '')) throw new Error('handover has no board');
  if (!payload.secrets?.TRELLO_KEY || !payload.secrets?.TRELLO_TOKEN) throw new Error('handover has no Trello keys');
  const writes = [];
  for (const [table, rows] of Object.entries(payload.tables || {})) {
    if (!TABLE.test(table) || !Array.isArray(rows)) continue;
    for (const row of rows) {
      const cols = Object.keys(row).filter(c => COLUMN.test(c));
      writes.push(db.prepare(`INSERT OR REPLACE INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(c => row[c])));
    }
  }
  const t = Math.floor(Date.now() / 1000);
  for (const [key, value] of Object.entries(payload.settings || {})) {
    writes.push(db.prepare(`INSERT OR REPLACE INTO trello_monitor_settings(key,value,updated_at) VALUES (?,?,?)`).bind(key, String(value), t));
  }
  await db.batch(writes);
}

function writePrivate(file, data) {
  writeFileSync(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
  renameSync(file + '.tmp', file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function createLocalMonitor({ options, events, onRun = () => {}, fetcher = fetch, engine = { ...monitorEngine, call: monitorLLM }, dependencies = {},
  file = `${DATA}/monitor.db`, configFile = `${DATA}/monitor.json` }) {
  const db = openD1(file);
  let config = null;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { /* not moved yet */ }
  const remote = remoteApi(options, fetcher);
  let running = false, lastProblem = null, timer = null;

  const env = () => ({
    DB: db, TRELLO_MONITOR_BOARD_ID: config.board, ...config.secrets,
    BAILEYS_TOKEN: options.token, BAILEYS_RECIPIENT: `+${options.recipient}`,
    TRELLO_MONITOR_ENABLED: 'false', TRELLO_MONITOR_SEND: 'false', // the moved settings decide
  });
  // The Worker's /bridge/* API (dashboard, settings, outbox), answered here.
  const api = (path, init = {}) => handleBridgeApi(new Request(`http://monitor${path}`, {
    method: init.method || 'GET', body: init.body,
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
  }), env());

  const problem = message => {
    if (message === lastProblem) return;
    lastProblem = message;
    if (message) { log(message); events.add('monitor_error', message); } else log('Pitch monitor is running normally again');
  };

  async function takeOver() {
    if (!options.workerUrl) return problem('Set the Worker address in Settings so the pitch monitor can move to this add-on');
    let res;
    try { res = await remote('/bridge/handover', { method: 'POST' }); }
    catch { return problem("Couldn't reach the Worker to move the pitch monitor here; retrying every minute"); }
    if (res.status === 409) return; // a Worker check is finishing; next minute
    if (!res.ok) return problem(`The Worker didn't hand over the pitch monitor (${res.status}); retrying every minute`);
    const payload = await res.json();
    await importHandover(db, payload);
    const saved = { board: payload.board, secrets: payload.secrets, movedAt: Date.now(), confirmed: false };
    writePrivate(configFile, saved);
    config = saved;
    log(`Pitch monitor moved here from the Worker (${payload.tables?.trello_monitor_jobs?.length || 0} pitches of history)`);
    events.add('monitor_moved', 'Pitch monitor moved here from the Cloudflare Worker');
  }
  // Until confirmed, the Worker would hand the keys out again; confirm once saved.
  async function confirm() {
    try {
      const res = await remote('/bridge/handover/done', { method: 'POST' });
      if (!res.ok && res.status !== 410) return;
      config = { ...config, confirmed: true };
      writePrivate(configFile, config);
    } catch { /* next minute */ }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      if (!config) await takeOver();
      if (!config) return;
      if (!config.confirmed) await confirm();
      const report = await runTrelloMonitor(await withMonitorSettings(env()), engine, dependencies);
      problem(null);
      await onRun(report);
    } catch (e) {
      problem(`Pitch monitor run failed: ${String(e?.message || e).slice(0, 200)}`);
      await onRun(null);
    } finally { running = false; }
  }

  return {
    active: () => Boolean(config),
    api,
    tick,
    start() { tick(); timer = setInterval(tick, INTERVAL); },
    stop() { clearInterval(timer); db.sqlite.close(); },
  };
}
