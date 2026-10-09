// The pitch monitor, running in this add-on. It watches three sites, each on
// its own and only against its own pitches: WGTC (Trello), AotF (Google Sheet)
// and OS (Asana). Trello moved here from the pitch-checker Worker on
// 2026-10-01 (Cloudflare's free-plan CPU cap kept killing Worker runs); the
// sheet and Asana were added on 2026-10-09.
//
// monitor/*.mjs and monitor/monitor-schema.sql are unmodified copies from the
// pitch-checker project (trello-monitor.mjs, pitch-sources.mjs, bridge-api.mjs,
// match-engine.mjs), so the Pi runs exactly the code tested there. A local SQLite file stands in
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
import { runPitchMonitor, monitorLLM, withMonitorSettings, loadMonitorCards, monitorTrelloGet, formatPitchTime, TRELLO_SITE } from './monitor/trello-monitor.mjs';
import { AOTF_SITE, OS_SITE } from './monitor/pitch-sources.mjs';
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
const SERVICES = { 'api.trello.com': 'Trello', 'docs.google.com': 'Google Sheets', 'app.asana.com': 'Asana', 'api.xiaomimimo.com': 'the MiMo AI', 'generativelanguage.googleapis.com': 'the Gemini AI' };
export const SITES = [TRELLO_SITE, AOTF_SITE, OS_SITE];
const siteName = site => `${site.label} (${site.platform})`;
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
// `onAlert(text, recovered, site)` tells the recipient about one site.
// `sites` and `dependencies.loaders[siteId]` let tests run without the network.
export function createLocalMonitor({ options, events, onRun = () => {}, onAlert = async () => false, onStuck = () => {}, fetcher = fetch, engine, dependencies = {},
  file = `${DATA}/monitor.db`, configFile = `${DATA}/monitor.json`, watchFile = `${DATA}/monitor-watch.json`, clock = Date.now, limits = {}, sites = SITES }) {
  const db = openD1(file);
  let config = null;
  try { config = JSON.parse(readFileSync(configFile, 'utf8')); } catch { /* not moved yet */ }
  const remote = remoteApi(options, fetcher);
  const runLimit = limits.run ?? RUN_LIMIT, staleAlert = limits.stale ?? STALE_ALERT;
  // Each site's calls are tracked on their own, so a stall names the right service.
  const inFlight = Object.fromEntries(sites.map(s => [s.id, new Set()]));
  const guard = id => guardedFetch(limits.fetch || fetch, inFlight[id], limits.call ?? CALL_LIMIT);
  const guarded = Object.fromEntries(sites.map(s => [s.id, guard(s.id)]));
  const engineFor = site => engine || { ...monitorEngine, call: (prompt, e, _fetcher, meta) => monitorLLM(prompt, e, guarded[site.id], meta) };
  const loaders = {
    [TRELLO_SITE.id]: dependencies.load || (e => loadMonitorCards(e, (path, params, e2) => monitorTrelloGet(path, params, e2, guarded[TRELLO_SITE.id]))),
    ...Object.fromEntries(sites.filter(s => s !== TRELLO_SITE).map(s => [s.id, dependencies.loaders?.[s.id] || (e => s.load(e, guarded[s.id]))])),
  };
  const depsFor = site => ({ ...dependencies, load: loaders[site.id] });
  let general = null, moving = false, timer = null, watchTimer = null;
  // Per site: the run in progress, hangs in a row, the current problem, and
  // when this add-on first tried it (so a site that has never worked alerts too).
  const runs = Object.fromEntries(sites.map(s => [s.id, { running: null, stalls: 0, problem: null, problemSince: null, firstTry: null }]));
  // Per site { at, lastOk } while a "scans stopped" alert is out. Before 3.1
  // the file held the Trello alert only, as `alerted`.
  let alerted = {};
  try { const saved = JSON.parse(readFileSync(watchFile, 'utf8')); alerted = saved.sites || (saved.alerted ? { [TRELLO_SITE.id]: saved.alerted } : {}); } catch { /* none yet */ }

  const env = () => ({
    DB: db, TRELLO_MONITOR_BOARD_ID: config.board, ...config.secrets,
    ASANA_TOKEN: options.asanaToken || '',
    BAILEYS_TOKEN: options.token, BAILEYS_RECIPIENT: `+${options.recipient}`,
    TRELLO_MONITOR_ENABLED: 'false', TRELLO_MONITOR_SEND: 'false', // the moved settings decide
    MONITOR_SCAN_WATCHDOG: 'external', // watch() alerts on stalled scans
    _sites: sites,
  });
  // The Worker's /bridge/* API (dashboard, settings, outbox), answered here.
  const api = (path, init = {}) => handleBridgeApi(new Request(`http://monitor${path}`, {
    method: init.method || 'GET', body: init.body,
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
  }), env());

  // Problems moving the monitor here (no site involved).
  const problem = message => {
    if (message === general) return;
    general = message;
    if (message) { log(message); events.add('monitor_error', message); }
  };
  // A site's scan problem, logged once until it changes or clears.
  const siteProblem = (site, message, type = 'monitor_error') => {
    const r = runs[site.id];
    if (message === r.problem) return;
    if (message && !r.problem) r.problemSince = clock();
    r.problem = message;
    if (message) { log(`${site.label}: ${message}`); events.add(type, `${site.label}: ${message}`); }
    else { r.problemSince = null; log(`${siteName(site)} scans are running normally again`); events.add('monitor_ok', `${siteName(site)} scans are running normally again`); }
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

  const waitingOn = site => {
    const oldest = [...inFlight[site.id]].sort((a, b) => a.since - b.since)[0];
    return oldest ? service(oldest.host) : null;
  };
  const boardOf = site => site.board(env());

  // One site's scan. Sites run side by side and never wait for each other.
  async function runSite(site, settings, started) {
    const r = runs[site.id];
    if (r.running) {
      const age = clock() - r.running.since;
      if (age < runLimit) return;
      // Abandon the hung run and free its lock so the next scan can start;
      // its owner-guarded writes can't touch the state once the lock is gone.
      r.stalls++;
      const on = waitingOn(site);
      const message = `A scan got stuck for ${minutes(age)}${on ? ` waiting for ${on} to answer` : ''}. ${r.stalls > 1
        ? 'That happened twice in a row, so the add-on is restarting itself.' : 'It was stopped and scanning carries on.'}`;
      siteProblem(site, message, 'monitor_stuck');
      r.running = null;
      db.sqlite.prepare('UPDATE trello_monitor_state SET owner=NULL,lease_until=0 WHERE board_id=?').run(boardOf(site));
      if (r.stalls > 1) return onStuck(`${site.label}: ${message}`);
    }
    // Switched off, or still waiting for its token: nothing to do or report.
    if (!site.enabled(settings) || site.needs?.(settings)) { r.firstTry = null; if (r.problem) siteProblem(site, null); return; }
    r.firstTry ??= started;
    const run = r.running = { since: started };
    try {
      const report = await runPitchMonitor(settings, engineFor(site), depsFor(site), site);
      if (r.running !== run) return; // abandoned meanwhile
      r.stalls = 0;
      if (!report?.busy) siteProblem(site, null);
      await onRun(report);
    } catch (e) {
      if (r.running !== run) return;
      r.stalls = 0;
      siteProblem(site, `Scan failed: ${String(e?.message || e).slice(0, 200)}`);
      await onRun(null);
    } finally { if (r.running === run) r.running = null; }
  }

  async function tick() {
    const started = clock();
    if (!config) {
      if (moving) return; // the move is still in progress
      moving = true;
      try { await takeOver(); } catch (e) { problem(`Couldn't move the pitch monitor here: ${String(e?.message || e).slice(0, 200)}`); } finally { moving = false; }
      if (!config) return;
    }
    if (!config.confirmed) await confirm();
    problem(null);
    const settings = await withMonitorSettings(env());
    await Promise.all(sites.map(site => runSite(site, settings, started)));
  }

  const saveWatch = () => { try { writeFileSync(watchFile, JSON.stringify({ sites: alerted })); } catch { /* best effort */ } };
  const lastOkMs = site => {
    const row = config && db.sqlite.prepare('SELECT last_ok FROM trello_monitor_state WHERE board_id=?').get(boardOf(site));
    return row?.last_ok ? row.last_ok * 1000 : null;
  };
  // On its own timer, never inside a scan, so a hung scan can't silence it.
  async function watch() {
    if (!config) return;
    const settings = await withMonitorSettings(env());
    for (const site of sites) {
      const r = runs[site.id], lastOk = lastOkMs(site), now = clock(), sent = alerted[site.id];
      const on = site.enabled(settings) && !site.needs?.(settings);
      // A site that has never finished a scan counts from its first try here.
      const since = lastOk || r.firstTry;
      const stale = Boolean(on && since && now - since > staleAlert);
      if (stale && (!sent || now - sent.at >= ALERT_REPEAT)) {
        const waiting = waitingOn(site);
        const reason = r.problem || (r.running ? `A scan has been running for ${minutes(now - r.running.since)}${waiting ? `, waiting for ${waiting} to answer` : ''}.` : 'Unknown; see the add-on log.');
        const text = [`⚠️ *Pitch monitor stopped scanning · ${site.label}*`, '',
          lastOk ? `No ${siteName(site)} scan has finished since ${formatPitchTime(new Date(lastOk).toISOString())}, so new ${site.label} pitches aren't being checked.`
            : `${siteName(site)} scans haven't worked once since ${formatPitchTime(new Date(r.firstTry).toISOString())}, so new ${site.label} pitches aren't being checked.`, '',
          `Reason: ${reason}`, '',
          "It keeps retrying every minute, and you'll get a message when it's working again. Details: PDC Monitor in Home Assistant, Activity page."].join('\n');
        if (await onAlert(text, false, site)) { alerted[site.id] = { at: now, lastOk }; saveWatch(); events.add('monitor_alert', `Sent a WhatsApp alert that ${site.label} scans stopped`); }
      } else if (!stale && sent) {
        const text = `✅ *Pitch monitor working again · ${site.label}*\n\n${siteName(site)} scans are running again. Pitches that came in meanwhile are being checked now.`;
        if (await onAlert(text, true, site)) { delete alerted[site.id]; saveWatch(); events.add('monitor_alert', `Sent a WhatsApp message that ${site.label} scans recovered`); }
      }
    }
  }

  const siteHealth = site => {
    const r = runs[site.id];
    return {
      problem: r.problem, problemSince: r.problemSince, lastOk: lastOkMs(site),
      running: r.running ? { since: r.running.since, waitingOn: waitingOn(site) } : null,
    };
  };
  return {
    active: () => Boolean(config),
    api,
    tick,
    watch,
    // For the dashboard: what is wrong right now, per site, in plain words.
    // The top-level fields are WGTC's, as before there were three sites.
    health: () => {
      const bySite = config ? Object.fromEntries(sites.map(s => [s.id, siteHealth(s)])) : {};
      const wgtc = bySite[TRELLO_SITE.id] || { problem: null, problemSince: null, lastOk: null, running: null };
      return { ...wgtc, problem: wgtc.problem || general, general, sites: bySite };
    },
    start() {
      tick(); timer = setInterval(tick, INTERVAL);
      watchTimer = setInterval(() => watch().catch(e => log('Monitor watchdog failed:', e?.message || e)), INTERVAL);
    },
    stop() { clearInterval(timer); clearInterval(watchTimer); db.sqlite.close(); },
  };
}
