// API for the PDC WhatsApp Bridge add-on: its dashboard, and the WhatsApp
// outbox it collects messages from. Authenticated with the shared bearer token
// (BAILEYS_TOKEN). Server-to-server only: no CORS headers, never called from a
// browser.
import { withMonitorSettings, effectiveSettings, saveMonitorSettings, MONITOR_SETTINGS, monitorTrelloGet, resolveWatchedLists, inQuietHours } from './trello-monitor.mjs';

const ID = /^[a-f0-9]{24}$/;
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function authorized(request, env) {
  const given = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  const token = String(env.BAILEYS_TOKEN || '');
  if (!given || token.length < 32) return false;
  const digest = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = (await Promise.all([digest(given), digest(token)])).map(x => new Uint8Array(x));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const created = id => ID.test(id || '') ? parseInt(id.slice(0, 8), 16) : null;
const sourceUrl = desc => /(https?:\/\/[^\s"')\]]+)/.exec(String(desc || ''))?.[1] || '';

// Compact, display-ready shape of a job row.
export function dashboardJob(r) {
  const card = parse(r.card_json, {});
  return {
    id: r.card_id, name: card.name || '', url: card.shortUrl || '', list: card._listName || '', writer: card._writer || 'Unassigned',
    source: sourceUrl(card.desc), created: created(r.card_id), firstSeen: r.first_seen, checkedAt: r.checked_at,
    check: r.check_status, send: r.send_status, sid: r.message_sid, attempts: r.attempts, nextCheck: r.next_check,
    nextSend: r.next_send, error: r.last_error, meta: parse(r.check_meta, null),
    findings: (parse(r.result_json, []) || []).map(f => ({
      verdict: f.verdict, confidence: f.confidence, reason: f.reason,
      title: f.candidate?.title || '', list: f.candidate?.status || '', writer: f.candidate?.writer || 'Unassigned',
      url: f.candidate?.editLink || '', created: f.candidate?.date ? Math.floor(Date.parse(f.candidate.date) / 1000) || null : created(f.candidate?.cardId),
    })),
  };
}

function settingsPayload(env) {
  return {
    values: effectiveSettings(env),
    stored: env._storedSettings || [],
    fields: Object.keys(MONITOR_SETTINGS),
  };
}

async function dashboard(env, url) {
  const db = env.DB, board = env.TRELLO_MONITOR_BOARD_ID || '';
  const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 600));
  const t = Math.floor(Date.now() / 1000);
  const one = (q, ...a) => db.prepare(q).bind(...a).first();
  const all = async (q, ...a) => (await db.prepare(q).bind(...a).all()).results;
  const [state, total, jobs, counts, scans, health, delivery, poll, queued] = await Promise.all([
    one('SELECT initialized,last_ok,last_error,lease_until FROM trello_monitor_state WHERE board_id=?', board),
    one('SELECT COUNT(*) AS n FROM trello_monitor_jobs WHERE board_id=?', board),
    all('SELECT * FROM trello_monitor_jobs WHERE board_id=? ORDER BY first_seen DESC, card_id DESC LIMIT ?', board, limit),
    all('SELECT check_status,send_status,COUNT(*) AS count FROM trello_monitor_jobs WHERE board_id=? GROUP BY check_status,send_status', board),
    all('SELECT hour,scans,failures,cards,checks,flagged,sent,last_at,last_ms,last_ok FROM trello_monitor_scans WHERE board_id=? AND hour>=? ORDER BY hour', board, t - 14 * 86400).catch(() => []),
    all('SELECT kind,active,last_sent,last_value FROM trello_monitor_health WHERE board_id=?', board).catch(() => []),
    one("SELECT next_allowed FROM trello_monitor_delivery WHERE provider='baileys'").catch(() => null),
    one("SELECT next_allowed FROM trello_monitor_delivery WHERE provider='bridge_poll'").catch(() => null),
    one("SELECT COUNT(*) AS n, MIN(created) AS oldest FROM trello_monitor_wa_outbox WHERE status='queued'").catch(() => null),
  ]);
  return {
    now: t, board,
    settings: settingsPayload(env),
    quietNow: inQuietHours(env, t),
    ai: { mimo: Boolean(String(env.MIMO_KEYS || '').trim()), gemini: Boolean(String(env.GEMINI_KEYS || '').trim()) },
    state, total: Number(total?.n || 0), counts, scans, health,
    nextSendAllowed: delivery?.next_allowed || 0,
    outbox: { lastPoll: poll?.next_allowed || null, queued: Number(queued?.n || 0), oldest: queued?.oldest || null },
    jobs: jobs.map(dashboardJob),
  };
}

async function lists(env) {
  const raw = await monitorTrelloGet(`/boards/${env.TRELLO_MONITOR_BOARD_ID}/lists`, { filter: 'open', fields: 'name,closed' }, env);
  let watched = [], error = null;
  try { watched = resolveWatchedLists(raw, env); } catch (e) { error = e.message; }
  return { lists: raw.map(l => ({ id: l.id, name: l.name, watched: watched.includes(l.id) })), error };
}

// Recheck: run the AI comparison again on the next tick. The alert keeps its
// idempotency key, so a card that was already alerted is not messaged twice
// unless the add-on also clears that key (which is what "resend" does).
async function jobAction(env, action, cardId) {
  const db = env.DB, board = env.TRELLO_MONITOR_BOARD_ID;
  if (!ID.test(cardId || '')) return reply({ error: 'bad card id' }, 400);
  const res = action === 'recheck'
    ? await db.prepare(`UPDATE trello_monitor_jobs SET check_status='pending',attempts=0,next_check=0,last_error=NULL,send_status='none'
        WHERE board_id=? AND card_id=? AND send_status NOT IN ('pending','sending')`).bind(board, cardId).run()
    : await db.prepare(`UPDATE trello_monitor_jobs SET send_status='pending',next_send=0,last_error=NULL
        WHERE board_id=? AND card_id=? AND check_status='checked' AND result_json IS NOT NULL AND result_json<>'[]'
        AND send_status IN ('failed','uncertain','skipped','dry_run','accepted')`).bind(board, cardId).run();
  if (!Number(res.meta?.changes)) return reply({ error: action === 'recheck' ? 'This pitch is busy sending; try again in a minute' : 'Only checked pitches with findings can be resent' }, 409);
  // Queue a fresh copy (the add-on clears its own ledger entry for this key too).
  if (action === 'resend') await db.prepare("DELETE FROM trello_monitor_wa_outbox WHERE key=? AND status<>'queued'").bind(`trello:${board}:${cardId}`).run();
  return reply({ ok: true, key: `trello:${board}:${cardId}`, sending: env.TRELLO_MONITOR_SEND === 'true' });
}

// Outbox: the bridge polls for queued messages and reports each result.
// Only the first report for a key counts; sent/unknown/failed are final.
const OUTBOX_KEY = /^[\w:.-]{1,120}$/;
async function outbox(env) {
  const t = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO trello_monitor_delivery(provider,next_allowed) VALUES ('bridge_poll',?) ON CONFLICT(provider) DO UPDATE SET next_allowed=excluded.next_allowed").bind(t).run();
  const rows = (await env.DB.prepare("SELECT key,recipient,text FROM trello_monitor_wa_outbox WHERE status='queued' ORDER BY created,key LIMIT 10").bind().all()).results;
  return { messages: rows.map(r => ({ key: r.key, to: r.recipient, text: r.text })) };
}
async function outboxAck(env, body) {
  const { key, status } = body || {};
  if (!OUTBOX_KEY.test(key || '') || !['sent', 'unknown', 'failed'].includes(status)) return reply({ error: 'bad ack' }, 400);
  const id = status === 'sent' && typeof body.id === 'string' ? body.id.slice(0, 64) : null;
  const error = typeof body.error === 'string' ? body.error.slice(0, 200) : null;
  const t = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare("UPDATE trello_monitor_wa_outbox SET status=?,message_id=?,error=?,updated=? WHERE key=? AND status='queued'")
    .bind(status, id, error, t, key).run();
  // Show the pitch's delivery right away instead of on the monitor's next check
  // of the outbox (same outcome sendWhatsAppText would report then).
  const alert = /^trello:([a-f0-9]{24}):([a-f0-9]{24})$/.exec(key);
  if (alert && Number(res.meta?.changes)) {
    await env.DB.prepare(`UPDATE trello_monitor_jobs SET send_status=?,message_sid=?,last_error=? WHERE board_id=? AND card_id=? AND send_status='pending'`)
      .bind({ sent: 'accepted', unknown: 'uncertain', failed: 'failed' }[status], id,
        status === 'sent' ? null : status === 'unknown' ? 'WhatsApp bridge could not confirm the send; check WhatsApp before retrying' : (error || 'WhatsApp bridge refused the message'),
        alert[1], alert[2]).run();
  }
  await env.DB.prepare("DELETE FROM trello_monitor_wa_outbox WHERE status<>'queued' AND updated<?").bind(t - 30 * 86400).run();
  return reply({ ok: true, updated: Number(res.meta?.changes || 0) });
}

// One-time move of the monitor to the bridge add-on (2026-10-01): the Worker's
// free-plan CPU cap kept killing runs. Pauses the Worker monitor, waits for
// any running tick, then hands the add-on everything it needs to continue
// exactly where the Worker stopped: state, history, settings, queued alerts
// and the Trello/AI keys. Afterwards the Worker's lock is held for good, so it
// can never run alongside the add-on. Once the add-on confirms (…/done), this
// endpoint answers 410, so the keys can't be fetched again with the bridge token. Undo: see MONITOR-SETUP.md.
export const HANDOVER_OWNER = 'moved-to-pi';
async function handover(env, live) {
  const db = env.DB, board = env.TRELLO_MONITOR_BOARD_ID, t = Math.floor(Date.now() / 1000);
  const all = async (q, ...a) => (await db.prepare(q).bind(...a).all()).results;
  const done = await db.prepare("SELECT value FROM trello_monitor_settings WHERE key='handed_over'").bind().first();
  if (done) return reply({ error: 'The monitor already moved to the add-on' }, 410);
  // Settings exactly as the Worker applies them now (stored or Worker variables).
  const settings = Object.fromEntries(Object.entries(MONITOR_SETTINGS)
    .filter(([k, s]) => live._storedSettings?.includes(k) || live[s.env] !== undefined)
    .map(([k, s]) => [k, String(live[s.env])]));
  // The first call remembers whether monitoring was on, then stops new Worker ticks.
  const before = await db.prepare("SELECT value FROM trello_monitor_settings WHERE key='enabled_before_handover'").bind().first();
  settings.enabled = before ? before.value : String(live.TRELLO_MONITOR_ENABLED ?? 'false');
  if (!before) await db.prepare("INSERT INTO trello_monitor_settings(key,value,updated_at) VALUES ('enabled_before_handover',?,?)").bind(settings.enabled, t).run();
  await db.prepare("INSERT OR REPLACE INTO trello_monitor_settings(key,value,updated_at) VALUES ('enabled','false',?)").bind(t).run();
  // Take the lock for good; a tick still running makes the add-on retry shortly.
  await db.prepare('INSERT OR IGNORE INTO trello_monitor_state(board_id) VALUES (?)').bind(board).run();
  const lock = await db.prepare('UPDATE trello_monitor_state SET owner=?,lease_until=? WHERE board_id=? AND (lease_until<? OR owner=?)')
    .bind(HANDOVER_OWNER, 4102444800, board, t, HANDOVER_OWNER).run();
  if (!Number(lock.meta?.changes)) return reply({ error: 'A Worker check is still running; try again in a minute' }, 409);
  const payload = {
    board, settings,
    secrets: { TRELLO_KEY: env.TRELLO_KEY || '', TRELLO_TOKEN: env.TRELLO_TOKEN || '', MIMO_KEYS: env.MIMO_KEYS || '', GEMINI_KEYS: env.GEMINI_KEYS || '' },
    tables: {
      trello_monitor_state: await all('SELECT board_id,initialized,last_ok,last_error FROM trello_monitor_state WHERE board_id=?', board),
      trello_monitor_jobs: await all('SELECT * FROM trello_monitor_jobs WHERE board_id=?', board),
      trello_monitor_health: await all('SELECT * FROM trello_monitor_health WHERE board_id=?', board).catch(() => []),
      trello_monitor_scans: await all('SELECT * FROM trello_monitor_scans WHERE board_id=?', board).catch(() => []),
      trello_monitor_wa_outbox: await all('SELECT * FROM trello_monitor_wa_outbox').catch(() => []),
    },
  };
  return reply(payload);
}
// The add-on confirms it saved the handover; only then is it final.
async function handoverDone(env) {
  const lock = await env.DB.prepare('SELECT owner FROM trello_monitor_state WHERE board_id=?').bind(env.TRELLO_MONITOR_BOARD_ID).first();
  if (lock?.owner !== HANDOVER_OWNER) return reply({ error: 'No handover in progress' }, 409);
  const t = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT OR IGNORE INTO trello_monitor_settings(key,value,updated_at) VALUES ('handed_over',?,?)").bind(String(t), t).run();
  return reply({ ok: true });
}

// Returns a Response for /bridge/* paths, or null for anything else.
export async function handleBridgeApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/bridge/')) return null;
  if (!await authorized(request, env)) return reply({ error: 'unauthorized' }, 401);
  if (!env.DB) return reply({ error: 'Monitor database not bound' }, 503);
  const live = await withMonitorSettings(env);
  try {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'POST /bridge/handover') return handover(env, live);
    if (route === 'POST /bridge/handover/done') return handoverDone(env);
    if (route === 'GET /bridge/outbox') return reply(await outbox(env));
    if (route === 'POST /bridge/outbox/ack') return outboxAck(env, await request.json().catch(() => null));
    if (route === 'GET /bridge/dashboard') return reply(await dashboard(live, url));
    if (route === 'GET /bridge/lists') return reply(await lists(live));
    if (route === 'POST /bridge/settings') {
      const body = await request.json().catch(() => null);
      const result = await saveMonitorSettings(env.DB, body?.settings);
      if (result.errors) return reply(result, 400);
      return reply({ ...result, settings: settingsPayload(await withMonitorSettings(env)) });
    }
    const job = /^POST \/bridge\/jobs\/([a-f0-9]{24})\/(recheck|resend)$/.exec(route);
    if (job) return jobAction(live, job[2], job[1]);
    return reply({ error: 'not found' }, 404);
  } catch (e) {
    const message = /^Trello read failed \(\d{3}\)$/.test(e?.message) ? e.message : 'Dashboard request failed; inspect Cloudflare logs';
    console.error('bridge api', e?.message);
    return reply({ error: message }, 500);
  }
}
