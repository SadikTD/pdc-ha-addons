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
import { runTrelloMonitor, monitorLLM, withMonitorSettings, loadMonitorCards, monitorTrelloGet, formatPitchTime } from './monitor/trello-monitor.mjs';
import { handleBridgeApi } from './monitor/bridge-api.mjs';
import { monitorEngine } from './monitor/match-engine.mjs';
import { DATA, log, remoteApi } from './bridge.mjs';

const SCHEMA = new URL('./monitor/monitor-schema.sql', import.meta.url);
const INTERVAL = 60000;
// On 2026-10-02 one run hung for 15 hours: every later tick saw it still
// "running" and quietly skipped, and the self-monitoring that would have
// raised the alarm runs inside that same run. So: every outside call has a
// hard deadline (body included), a run past RUN_LIMIT is abandoned (a second
// one in a row restarts the add-on), and a watchdog OUTSIDE the run alerts
// when no scan has finished for STALE_ALERT.
const CALL_LIMIT = 70000; // above the longest per-call timeout (MiMo, 55 s)
const RUN_LIMIT = 4 * 60000; // a healthy run takes under two minutes
const STALE_ALERT = 10 * 60000;
const ALERT_REPEAT = 3 * 3600000;
const SERVICES = { 'api.trello.com': 'Trello', 'api.xiaomimimo.com': 'the MiMo AI', 'generativelanguage.googleapis.com': 'the Gemini AI' };
const service = host => SERVICES[host] || host;
const minutes = ms => `${Math.max(1, Math.round(ms / 60000))} min`;

// fetch with a deadline that also covers reading the body, so no outside call
// can hold a run forever. Records what is in flight for the stall report.
export function guardedFetch(fetcher, inFlight, limit = CALL_LIMIT) {
  return async (url, init = {}) => {
    const call = { host: new URL(String(url)).host, since: Date.now() };
    inFlight.add(call);
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const res = await fetcher(url, init);
          const body = await res.arrayBuffer();
          return new Response([101, 204, 205, 304].includes(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`${service(call.host)} did not answer within ${Math.round(limit / 1000)} s`), { name: 'TimeoutError' })), limit);
        }),
      ]);
    } finally { clearTimeout(timer); inFlight.delete(call); }
  };
}

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

// `onAlert(text, recovered)` tells the recipient (WhatsApp + Home Assistant)
// that scans stopped or recovered, resolving true once WhatsApp accepted it.
// `onStuck(message)` restarts the add-on after hung runs twice in a row.
export function createLocalMonitor({ options, events, onRun = () => {}, onAlert = async () => false, onStuck = () => {}, fetcher = fetch, engine, dependencies = {},
  file = `${DATA}/monitor.db`, configFile = `${DATA}/monitor.json`, watchFile = `${DATA}/monitor-watch.json`, clock = Date.now, limits = {} }) {
  const db = openD1(file);
  let config = null;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { /* not moved yet */ }
  const remote = remoteApi(options, fetcher);
  const runLimit = limits.run ?? RUN_LIMIT, staleAlert = limits.stale ?? STALE_ALERT;
  // Trello and AI calls made by the monitor's defaults go through the guard.
  const inFlight = new Set(), guarded = guardedFetch(limits.fetch || fetch, inFlight, limits.call ?? CALL_LIMIT);
  engine ||= { ...monitorEngine, call: (prompt, e, _fetcher, meta) => monitorLLM(prompt, e, guarded, meta) };
  dependencies = { load: e => loadMonitorCards(e, (path, params, e2) => monitorTrelloGet(path, params, e2, guarded)), ...dependencies };
  let running = null, stalls = 0, lastProblem = null, problemSince = null, timer = null, watchTimer = null;
  let alerted = null; // { at, lastOk } while a "scans stopped" alert is out
  try { alerted = JSON.parse(readFileSync(watchFile, 'utf8')).alerted || null; } catch { /* none yet */ }

  const env = () => ({
    DB: db, TRELLO_MONITOR_BOARD_ID: config.board, ...config.secrets,
    BAILEYS_TOKEN: options.token, BAILEYS_RECIPIENT: `+${options.recipient}`,
    TRELLO_MONITOR_ENABLED: 'false', TRELLO_MONITOR_SEND: 'false', // the moved settings decide
    MONITOR_SCAN_WATCHDOG: 'external', // watch() alerts on stalled scans
  });
  // The Worker's /bridge/* API (dashboard, settings, outbox), answered here.
  const api = (path, init = {}) => handleBridgeApi(new Request(`http://monitor${path}`, {
    method: init.method || 'GET', body: init.body,
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
  }), env());

  const problem = (message, type = 'monitor_error') => {
    if (message === lastProblem) return;
    if (message && !lastProblem) problemSince = clock();
    lastProblem = message;
    if (message) { log(message); events.add(type, message); }
    else { problemSince = null; log('Pitch monitor is running normally again'); events.add('monitor_ok', 'Pitch monitor is running normally again'); }
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

  const waitingOn = () => {
    const oldest = [...inFlight].sort((a, b) => a.since - b.since)[0];
    return oldest ? service(oldest.host) : null;
  };

  async function tick() {
    if (running) {
      const age = clock() - running.since;
      if (age < runLimit) return;
      // Abandon the hung run and free its lock so the next scan can start;
      // its owner-guarded writes can't touch the state once the lock is gone.
      stalls++;
      const on = waitingOn();
      const message = `A scan got stuck for ${minutes(age)}${on ? ` waiting for ${on} to answer` : ''}. ${stalls > 1
        ? 'That happened twice in a row, so the add-on is restarting itself.' : 'It was stopped and scanning carries on.'}`;
      problem(message, 'monitor_stuck');
      running = null;
      if (config) db.sqlite.prepare('UPDATE trello_monitor_state SET owner=NULL,lease_until=0 WHERE board_id=?').run(config.board);
      if (stalls > 1) return onStuck(message);
    }
    const run = running = { since: clock() };
    try {
      if (!config) await takeOver();
      if (!config) return;
      if (!config.confirmed) await confirm();
      const report = await runTrelloMonitor(await withMonitorSettings(env()), engine, dependencies);
      if (running !== run) return; // abandoned meanwhile
      stalls = 0;
      if (!report?.busy) problem(null);
      await onRun(report);
    } catch (e) {
      if (running !== run) return;
      stalls = 0;
      problem(`Scan failed: ${String(e?.message || e).slice(0, 200)}`);
      await onRun(null);
    } finally { if (running === run) running = null; }
  }

  const saveWatch = () => { try { writeFileSync(watchFile, JSON.stringify({ alerted })); } catch { /* best effort */ } };
  const lastOkMs = () => {
    const row = config && db.sqlite.prepare('SELECT last_ok FROM trello_monitor_state WHERE board_id=?').get(config.board);
    return row?.last_ok ? row.last_ok * 1000 : null;
  };
  // On its own timer, never inside a scan, so a hung scan can't silence it.
  async function watch() {
    if (!config) return;
    const settings = await withMonitorSettings(env());
    const lastOk = lastOkMs(), now = clock();
    const stale = Boolean(settings.TRELLO_MONITOR_ENABLED === 'true' && lastOk && now - lastOk > staleAlert);
    if (stale && (!alerted || now - alerted.at >= ALERT_REPEAT)) {
      const on = waitingOn();
      const reason = lastProblem || (running ? `A scan has been running for ${minutes(now - running.since)}${on ? `, waiting for ${on} to answer` : ''}.` : 'Unknown; see the add-on log.');
      const text = ['⚠️ *Pitch monitor stopped scanning*', '',
        `No Trello scan has finished since ${formatPitchTime(new Date(lastOk).toISOString())}, so new pitches aren't being checked.`, '',
        `Reason: ${reason}`, '',
        "It keeps retrying every minute, and you'll get a message when it's working again. Details: PDC Monitor in Home Assistant, Activity page."].join('\n');
      if (await onAlert(text, false)) { alerted = { at: now, lastOk }; saveWatch(); events.add('monitor_alert', 'Sent a WhatsApp alert that scans stopped'); }
    } else if (!stale && alerted) {
      const text = '✅ *Pitch monitor working again*\n\nTrello scans are running again. Pitches that came in meanwhile are being checked now.';
      if (await onAlert(text, true)) { alerted = null; saveWatch(); events.add('monitor_alert', 'Sent a WhatsApp message that scans recovered'); }
    }
  }

  return {
    active: () => Boolean(config),
    api,
    tick,
    watch,
    // For the dashboard: what is wrong right now, in plain words.
    health: () => ({
      problem: lastProblem, problemSince, lastOk: lastOkMs(),
      running: running ? { since: running.since, waitingOn: waitingOn() } : null,
    }),
    start() {
      tick(); timer = setInterval(tick, INTERVAL);
      watchTimer = setInterval(() => watch().catch(e => log('Monitor watchdog failed:', e?.message || e)), INTERVAL);
    },
    stop() { clearInterval(timer); clearInterval(watchTimer); db.sqlite.close(); },
  };
}
