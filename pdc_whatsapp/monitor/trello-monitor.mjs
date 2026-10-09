// Cloud-only state. This module never mutates Trello.
const LIST_NAMES = ['Up For Grabs (Priority)', 'Pitched', 'Approved', 'Writing - 3 Days or Less (3 card max)'];
const ID = /^[a-f0-9]{24}$/;
const now = () => Math.floor(Date.now() / 1000);
const changed = r => Number(r.meta?.changes || 0) > 0;
const clean = (s, n = 180) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const titleKey = s => clean(s, 5000).normalize('NFKC').toLowerCase();
const sql = (db, query, ...args) => db.prepare(query).bind(...args);

// ---------------------------------------------------------------------------
// Settings changed from the PDC WhatsApp Bridge dashboard. They live in D1 so
// they apply on the next tick without a redeploy; a stored value overrides the
// matching Worker variable, and deleting it falls back to that variable.
// ---------------------------------------------------------------------------
export const ALERT_VERDICTS = ['duplicate', 'same_story', 'near_miss'];
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const bool = v => { if (typeof v !== 'boolean') throw new Error('must be true or false'); return String(v); };
const int = (lo, hi) => v => { if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`must be a whole number from ${lo} to ${hi}`); return String(v); };
export const MONITOR_SETTINGS = {
  enabled: { env: 'TRELLO_MONITOR_ENABLED', fallback: 'false', parse: v => v === 'true', store: bool },
  sending: { env: 'TRELLO_MONITOR_SEND', fallback: 'false', parse: v => v === 'true', store: bool },
  list_ids: { env: 'TRELLO_MONITOR_LIST_IDS', fallback: '', parse: v => v.split(',').map(x => x.trim()).filter(Boolean), store: v => {
    if (!Array.isArray(v) || v.length > 8 || v.some(id => !ID.test(id)) || new Set(v).size !== v.length) throw new Error('must be up to eight distinct Trello list IDs');
    return v.join(',');
  } },
  recipient: { env: 'BAILEYS_RECIPIENT', fallback: '', parse: v => v, store: v => {
    if (!/^\+[1-9]\d{7,14}$/.test(v)) throw new Error('must be a full international number, e.g. +15551234567');
    return v;
  } },
  alert_verdicts: { env: 'MONITOR_ALERT_VERDICTS', fallback: ALERT_VERDICTS.join(','), parse: v => v.split(',').filter(x => ALERT_VERDICTS.includes(x)), store: v => {
    if (!Array.isArray(v) || !v.length || v.some(x => !ALERT_VERDICTS.includes(x))) throw new Error('pick at least one of ' + ALERT_VERDICTS.join(', '));
    return [...new Set(v)].join(',');
  } },
  min_confidence: { env: 'MONITOR_MIN_CONFIDENCE', fallback: '0', parse: v => Number(v) || 0, store: int(0, 100) },
  quiet_hours: { env: 'MONITOR_QUIET_HOURS', fallback: '', parse: v => v, store: v => {
    if (v !== '' && !(typeof v === 'string' && v.split('-').length === 2 && v.split('-').every(p => HHMM.test(p)))) throw new Error('must be empty or HH:MM-HH:MM');
    return v;
  } },
  health_alerts: { env: 'MONITOR_HEALTH_ALERTS', fallback: 'true', parse: v => v !== 'false', store: bool },
  reference_days: { env: 'MONITOR_REFERENCE_DAYS', fallback: '7', parse: v => Math.min(14, Math.max(1, Number(v) || 7)), store: int(1, 14) },
  // The AotF sheet and OS Asana monitors (pitch-sources.mjs, add-on only).
  // `enabled` above stays the WGTC Trello switch.
  aotf_enabled: { env: 'AOTF_MONITOR_ENABLED', fallback: 'true', parse: v => v === 'true', store: bool },
  os_enabled: { env: 'OS_MONITOR_ENABLED', fallback: 'true', parse: v => v === 'true', store: bool },
};

export function effectiveSettings(env) {
  return Object.fromEntries(Object.entries(MONITOR_SETTINGS).map(([k, s]) => [k, s.parse(String(env[s.env] ?? s.fallback))]));
}

// Returns env with stored overrides layered on top (bindings stay reachable
// through the prototype). A missing table or DB leaves env untouched.
export async function withMonitorSettings(env) {
  if (!env?.DB) return env;
  let rows;
  try { rows = (await sql(env.DB, 'SELECT key,value FROM trello_monitor_settings').all()).results; } catch { return env; }
  const overrides = {}, stored = [];
  for (const { key, value } of rows) {
    if (!MONITOR_SETTINGS[key]) continue;
    overrides[MONITOR_SETTINGS[key].env] = value; stored.push(key);
  }
  return Object.assign(Object.create(env), overrides, { _storedSettings: stored });
}

export async function saveMonitorSettings(db, changes, clock = now) {
  const errors = {}, writes = [];
  for (const [key, value] of Object.entries(changes || {})) {
    const setting = MONITOR_SETTINGS[key];
    if (!setting) { errors[key] = 'unknown setting'; continue; }
    if (value === null) { writes.push(sql(db, 'DELETE FROM trello_monitor_settings WHERE key=?', key)); continue; }
    try { writes.push(sql(db, `INSERT INTO trello_monitor_settings(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, setting.store(value), clock())); }
    catch (e) { errors[key] = e.message; }
  }
  if (Object.keys(errors).length) return { errors };
  if (writes.length) await db.batch(writes);
  return { ok: true, changed: Object.keys(changes || {}) };
}

export function alertFilter(env) {
  const { alert_verdicts: verdicts, min_confidence: min } = effectiveSettings(env);
  return f => verdicts.includes(f.verdict) && f.confidence >= min;
}

// Quiet hours are Bangladesh time (UTC+6, no daylight saving). Alerts wait
// in the outbox and go out when the window ends.
export function inQuietHours(env, t = now()) {
  const window = effectiveSettings(env).quiet_hours;
  if (!window) return false;
  const [from, to] = window.split('-').map(p => { const [h, m] = p.split(':').map(Number); return h * 60 + m; });
  const minute = Math.floor(t / 60 + 360) % 1440;
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

// Hourly scan counters for the dashboard's heartbeat chart (14 days kept).
async function recordScan(db, board, s) {
  const t = now(), hour = Math.floor(t / 3600) * 3600;
  try {
    await db.batch([
      sql(db, `INSERT INTO trello_monitor_scans(board_id,hour,scans,failures,cards,checks,flagged,sent,last_at,last_ms,last_ok)
        VALUES (?,?,1,?,?,?,?,?,?,?,?) ON CONFLICT(board_id,hour) DO UPDATE SET scans=scans+1,failures=failures+excluded.failures,
        cards=CASE WHEN excluded.cards>0 THEN excluded.cards ELSE cards END,checks=checks+excluded.checks,flagged=flagged+excluded.flagged,
        sent=sent+excluded.sent,last_at=excluded.last_at,last_ms=excluded.last_ms,last_ok=excluded.last_ok`,
        board, hour, s.ok ? 0 : 1, s.cards || 0, s.checked || 0, s.flagged || 0, s.accepted || 0, t, s.ms, s.ok ? 1 : 0),
      sql(db, 'DELETE FROM trello_monitor_scans WHERE board_id=? AND hour<?', board, hour - 14 * 86400),
    ]);
  } catch { /* stats must never break a tick */ }
}

export async function monitorTrelloGet(path, params, env, fetcher = fetch) {
  const board = env.TRELLO_MONITOR_BOARD_ID;
  if (!ID.test(board || '')) throw new Error('Invalid monitor board ID');
  const allowed = path === `/boards/${board}/lists` || path === `/boards/${board}/members` ||
    /^\/lists\/[a-f0-9]{24}\/cards$/.test(path) ||
    path === `/tokens/${encodeURIComponent(env.TRELLO_TOKEN)}`;
  if (!allowed) throw new Error('Trello read endpoint not allowed');
  const url = new URL('https://api.trello.com/1' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetcher(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `OAuth oauth_consumer_key="${encodeURIComponent(env.TRELLO_KEY)}", oauth_token="${encodeURIComponent(env.TRELLO_TOKEN)}"` },
  });
  if (!res.ok) throw new Error(`Trello read failed (${res.status})`);
  return res.json();
}

// The user chose to reuse their existing token, which has broader permissions.
// We require board read access; all actual Trello requests remain fixed GETs.
export function assertTrelloReadAccess(token, board) {
  const permissions = token?.permissions;
  if (!Array.isArray(permissions) || !permissions.some(p => p.read === true &&
      (p.idModel === '*' || p.idModel === board))) {
    throw new Error('Trello token does not grant read access to the configured board');
  }
}
export function resolveWatchedLists(lists, env) {
  const configured = String(env.TRELLO_MONITOR_LIST_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  // Preserve a previous three-list ID configuration while adding Writing
  // (lists picked on the dashboard are taken exactly as chosen).
  if (configured.length === 3 && !env._storedSettings?.includes('list_ids')) {
    const writing = lists.filter(l => !l.closed && clean(l.name).toLowerCase() === LIST_NAMES[3].toLowerCase());
    if (writing.length === 1 && !configured.includes(writing[0].id)) configured.push(writing[0].id);
  }
  const watched = configured.length ? configured : LIST_NAMES.map(name => {
    const matches = lists.filter(l => !l.closed && clean(l.name).toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected one open list named ${name}; configure list IDs`);
    return matches[0].id;
  });
  if (!watched.length || watched.length > 8 || new Set(watched).size !== watched.length || watched.some(id => !lists.some(l => l.id === id && !l.closed))) {
    throw new Error('Configure one to eight distinct open monitor lists on this board');
  }
  return watched;
}

export async function loadMonitorCards(env, get = monitorTrelloGet) {
  const token = await get(`/tokens/${encodeURIComponent(env.TRELLO_TOKEN)}`, {}, env);
  assertTrelloReadAccess(token, env.TRELLO_MONITOR_BOARD_ID);
  const lists = await get(`/boards/${env.TRELLO_MONITOR_BOARD_ID}/lists`, { filter: 'open', fields: 'name,closed' }, env);
  if (!Array.isArray(lists)) throw new Error('Invalid Trello lists response');
  const watched = resolveWatchedLists(lists, env);
  const members = await get(`/boards/${env.TRELLO_MONITOR_BOARD_ID}/members`, { fields: 'fullName,username' }, env);
  if (!Array.isArray(members)) throw new Error('Invalid Trello members response');
  const memberNames = new Map(members.map(m => [m.id, m.fullName || m.username || 'Unknown member']));
  const cards = new Map();
  let requests = 0;
  // Match the existing browser checker's reference window (seven days unless
  // changed on the dashboard) instead
  // of repeatedly downloading years of archived cards. Always inspect every
  // open card in the four watched lists, including older cards moved there.
  const cutoff = new Date(Date.now() - effectiveSettings(env).reference_days * 86400000);
  const cutoffId = Math.floor(cutoff.getTime() / 1000).toString(16).padStart(8, '0') + '0000000000000000';
  const scans = [
    ...lists.filter(l => watched.includes(l.id)).map(list => ({ list, active: true })),
    ...lists.map(list => ({ list, active: false })),
  ];
  for (const { list, active } of scans) {
    let before;
    for (;;) {
      if (++requests > 20) throw new Error('Board exceeds monitor scan budget: ' + lists.length + ' open lists; no partial checks performed');
      const params = { filter: active ? 'open' : 'all', fields: 'name,desc,idList,idMembers,closed,shortUrl', limit: '1000', sort: '-id' };
      if (!active) params.since = cutoff.toISOString();
      if (before) params.before = before;
      const page = await get(`/lists/${list.id}/cards`, params, env);
      if (!Array.isArray(page)) throw new Error('Invalid Trello cards response');
      for (const card of page) {
        if (!ID.test(card.id || '') || card.idList !== list.id) throw new Error('Invalid Trello card identity');
        if (active || card.id >= cutoffId) cards.set(card.id, { ...card, _listName: list.name, _writer: (card.idMembers || []).map(id => memberNames.get(id) || 'Unknown member').join(' · ') || 'Unassigned' });
      }
      if (page.length < 1000) break;
      const next = page.map(c => c.id).sort()[0];
      if (!next || (before && next >= before)) throw new Error('Trello pagination did not advance');
      before = next;
    }
  }
  return { cards: [...cards.values()], watched };
}

// A site the monitor watches; each keeps its own state, history and alerts
// under its own board_id. WGTC on Trello is defined here; the AotF sheet and
// OS Asana sites are in pitch-sources.mjs (add-on only).
// `settle` (seconds): wait before checking a new pitch, and check its latest
// version: rows and tasks are typed in place, unlike Trello cards. A pitch
// that disappears meanwhile is marked 'gone' and never checked.
export const TRELLO_SITE = {
  id: 'wgtc', label: 'WGTC', platform: 'Trello', place: 'List', item: 'card', settle: 0,
  board: env => env.TRELLO_MONITOR_BOARD_ID,
  enabled: env => env.TRELLO_MONITOR_ENABLED === 'true',
  validate(env) {
    if (!ID.test(env.TRELLO_MONITOR_BOARD_ID || '') || !env.TRELLO_KEY || !env.TRELLO_TOKEN) throw new Error('Monitor configuration incomplete');
  },
  needs: () => null, // what's missing before it can run, in plain words
  load: env => loadMonitorCards(env),
  alertKey: (board, cardId) => `trello:${board}:${cardId}`,
  safeError: m => m === 'Trello token does not grant read access to the configured board' || /^Trello read failed \(\d{3}\)$/.test(m),
};

// Normalizing every board card costs ~5 ms of CPU (keyword extraction), so a
// run does it once per card and reuses it for every check in that run.
const normalized = new WeakMap();
function candidateOf(c, engine) {
  let byCard = normalized.get(engine);
  if (!byCard) normalized.set(engine, byCard = new WeakMap());
  if (!byCard.has(c)) byCard.set(c, { ...engine.normalize(c, {}), writer: c._writer || 'Unassigned', cardId: c.id });
  return byCard.get(c);
}

// `meta` collects how the verdict was reached, for the dashboard.
export async function checkMonitorCard(card, cards, env, engine, meta = {}) {
  const target = engine.normalize(card, {});
  if (!target) throw new Error('Card title is not ready');
  const candidates = cards.filter(c => c.id !== card.id).map(c => candidateOf(c, engine)).filter(c => c.title);
  meta.compared = candidates.length;
  const exact = candidates.filter(c => titleKey(c.title) === titleKey(target.title) ||
    (target.normalizedUrl && c.normalizedUrl === target.normalizedUrl));
  if (exact.length) {
    meta.method = 'exact';
    return exact.map(candidate => ({ candidate, verdict: 'duplicate', confidence: 100, reason: 'Exact title or source URL match' }));
  }
  const shortlist = engine.shortlist(target.keywords, candidates);
  meta.shortlisted = shortlist.length;
  meta.method = shortlist.length ? 'ai' : 'keywords';
  if (!shortlist.length) return [];
  const parsed = engine.parse(await engine.call(engine.prompt(target, shortlist), env, undefined, meta));
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length !== shortlist.length) {
    throw new Error(`Incomplete AI verdict (${meta.engine || 'AI'}: ${!parsed ? 'unreadable JSON' : `${Array.isArray(parsed.results) ? parsed.results.length : 0} of ${shortlist.length} answers`}); retry pending`);
  }
  const seen = new Set();
  return parsed.results.map(item => {
    if (!Number.isInteger(item.id) || item.id < 1 || item.id > shortlist.length || seen.has(item.id) ||
        !['duplicate', 'same_story', 'near_miss', 'different'].includes(item.verdict) ||
        !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 100) throw new Error('Invalid AI verdict; retry pending');
    seen.add(item.id);
    return { candidate: shortlist[item.id - 1], verdict: item.verdict, confidence: item.confidence, reason: clean(item.reason, 250) };
  }).filter(f => f.verdict !== 'different').sort((a, b) => b.confidence - a.confidence);
}

// Isolated provider calls: no shared audit budget or unbounded key rotation.
export async function monitorLLM(prompt, env, fetcher = fetch, meta = {}) {
  const mimo = String(env.MIMO_KEYS || '').split(',').map(x => x.trim()).find(Boolean);
  const gemini = String(env.GEMINI_KEYS || '').split(',').map(x => x.trim()).find(Boolean);
  const attempts = [];
  // MiMo needs ~12 s for a few candidates and over 30 s for a full shortlist of 25.
  if (mimo) attempts.push({ name: 'MiMo', timeout: 55000, url: 'https://api.xiaomimimo.com/v1/chat/completions', headers: { 'api-key': mimo }, body: {
    model: 'mimo-v2.5', messages: [{ role: 'user', content: prompt }], temperature: 0.1,
    max_completion_tokens: 4096, response_format: { type: 'json_object' }, thinking: { type: 'disabled' },
  }, extract: j => j.choices?.[0]?.message?.content });
  if (gemini) attempts.push({ name: 'Gemini', timeout: 30000, url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    headers: { 'x-goog-api-key': gemini }, body: { contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: 'application/json' } },
    extract: j => j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') });
  // Why each provider failed, in our own words only (never response bodies or keys).
  const failures = [];
  for (const a of attempts) {
    try {
      const res = await fetcher(a.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(a.timeout),
        headers: { 'Content-Type': 'application/json', ...a.headers }, body: JSON.stringify(a.body) });
      if (!res.ok) { failures.push(`${a.name}: HTTP ${res.status}`); continue; }
      const answer = a.extract(await res.json());
      if (answer) { meta.engine = a.name; if (failures.length) meta.aiFailures = failures; return answer; }
      failures.push(`${a.name}: empty answer`);
    } catch (e) { failures.push(`${a.name}: ${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}`); }
  }
  meta.aiFailures = failures;
  throw new Error(`AI unavailable (${failures.join('; ') || 'no AI keys'})`);
}

// Self-hosted Baileys bridge (github.com/SadikTD/pdc-ha-addons, pdc_whatsapp) on
// the Home Assistant Pi. Messages wait in the D1 outbox until the bridge
// collects them over plain outbound HTTPS (GET /bridge/outbox) and reports the
// result (POST /bridge/outbox/ack). Nothing connects into the Pi, so no tunnel,
// Cloudflared add-on or open port is involved.
export function baileysConfig(env) {
  if (!env.DB || String(env.BAILEYS_TOKEN || '').trim().length < 32 || !/^\+[1-9]\d{7,14}$/.test(env.BAILEYS_RECIPIENT || '')) {
    throw new Error('Baileys configuration incomplete: set DB binding, token and recipient');
  }
}

export function formatPitchTime(value, cardId) {
  const date = value ? new Date(value) : ID.test(cardId || '') ? new Date(parseInt(cardId.slice(0, 8), 16) * 1000) : null;
  if (!date || !Number.isFinite(date.getTime())) return 'Unknown';
  return BDT_FORMAT.format(date) + ' (BDT)';
}
const BDT_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

// `qualifies` picks the findings the dashboard's alert rules allow; if the
// rules changed after the alert was queued, all findings are used instead.
export function buildMonitorAlert(job, qualifies = () => true, site = TRELLO_SITE) {
  const card = JSON.parse(job.card_json), all = JSON.parse(job.result_json);
  const findings = all.some(qualifies) ? all.filter(qualifies) : all;
  if (!findings.length) throw new Error('No findings to notify');
  const best = findings[0];
  const heading = {
    duplicate: '🔴 *Duplicate pitch found',
    same_story: '🟠 *Similar story found',
    near_miss: '🟡 *Possible pitch overlap',
  }[best.verdict] || '🟡 *Possible pitch overlap';
  const sameTitle = titleKey(card.name) === titleKey(best.candidate.title);
  const existingList = clean(best.candidate.status, 100);
  const link = (label, url) => clean(url, 300) ? ['', `🔗 *${label}*`, clean(url, 300)] : [];
  return [
    `${heading} · ${site.label}*`,
    '',
    '📝 *New pitch*',
    clean(card.name, 450),
    `👤 *Writer:* ${clean(card._writer || 'Unassigned', 180)}`,
    `📍 *${site.place}:* ${clean(card._listName || 'Unknown', 100)}`,
    `🕒 *Created:* ${card._createdLabel || formatPitchTime(card._created || null, card.id)}`,
    '',
    '📌 *Existing pitch*',
    sameTitle ? 'Same title as above.' : clean(best.candidate.title, 450),
    `👤 *Writer:* ${clean(best.candidate.writer || 'Unassigned', 180)}`,
    `📍 *${site.place}:* ${existingList || 'Unknown'}`,
    `🕒 *Created:* ${best.candidate.dateLabel || formatPitchTime(best.candidate.date, best.candidate.cardId)}`,
    '',
    '*Why it matched*',
    clean(best.reason, 280),
    `Confidence: ${best.confidence}%`,
    ...link(`Open new ${site.item}`, card.shortUrl),
    ...link(`Open existing ${site.item}`, best.candidate.editLink),
    ...(findings.length > 1 ? ['', `*Also found:* ${findings.length - 1} more possible match${findings.length === 2 ? '' : 'es'}.`] : []),
  ].join('\n');
}
export function sendMonitorAlert(job, env, site = TRELLO_SITE) {
  return sendWhatsAppText(buildMonitorAlert(job, alertFilter(env), site), site.alertKey(job.board_id, job.card_id), env);
}

// Queues the message once per idempotency key and reports what the bridge has
// done with it so far. Callers retry `pending` every minute; a repeat call
// never queues the same key twice, and the bridge's own ledger also refuses
// to send a key twice.
export async function sendWhatsAppText(text, idempotencyKey, env) {
  baileysConfig(env);
  const t = now();
  await sql(env.DB, `INSERT OR IGNORE INTO trello_monitor_wa_outbox(key,recipient,text,status,created,updated) VALUES (?,?,?,'queued',?,?)`,
    idempotencyKey, env.BAILEYS_RECIPIENT, text, t, t).run();
  const row = await sql(env.DB, 'SELECT status,message_id,error,created FROM trello_monitor_wa_outbox WHERE key=?', idempotencyKey).first();
  if (row?.status === 'sent') return { status: 'accepted', sid: String(row.message_id || '').slice(0, 64) || null, error: null };
  if (row?.status === 'unknown') return { status: 'uncertain', error: 'WhatsApp bridge could not confirm the send; check WhatsApp before retrying' };
  if (row?.status === 'failed') return { status: 'failed', error: clean(row.error || 'WhatsApp bridge refused the message', 200) };
  const waited = Math.max(0, Math.round((t - (row?.created || t)) / 60));
  return { status: 'pending', retryIn: 60, error: waited < 2 ? 'Waiting for the WhatsApp bridge to collect it' : `Waiting ${waited} min for the WhatsApp bridge to collect it; check the add-on` };
}

// Shared D1 reservation survives restarts and spaces monitor sends at least
// six seconds apart, including ticks for different boards sharing this DB.
export async function reserveWhatsAppSlot(db, dependencies = {}) {
  const time = dependencies.clock || now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await sql(db, "INSERT OR IGNORE INTO trello_monitor_delivery(provider,next_allowed) VALUES ('baileys',0)").run();
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = time();
    const claim = await sql(db, "UPDATE trello_monitor_delivery SET next_allowed=? WHERE provider='baileys' AND next_allowed<=?", t + 6, t).run();
    if (changed(claim)) return true;
    const row = await sql(db, "SELECT next_allowed FROM trello_monitor_delivery WHERE provider='baileys'").first();
    await sleep(Math.min(6000, Math.max(1000, (row.next_allowed - time()) * 1000)));
  }
  return false; // Leave the message pending for the next minute, without sending.
}

// ---------------------------------------------------------------------------
// Self-monitoring: WhatsApp the recipient when the monitor itself is broken,
// instead of failing silently. Each problem alerts once, repeats every 6 hours
// while it lasts, and sends a single "recovered" message when it clears.
// (If the bridge itself is down, the Home Assistant add-on raises its own
// notification, since WhatsApp can't be reached.)
// ---------------------------------------------------------------------------
const HEALTH_REPEAT = 6 * 3600;
const bdtTime = t => formatPitchTime(new Date(t * 1000).toISOString());

export async function checkMonitorHealth(env, dependencies = {}, site = TRELLO_SITE) {
  if (env.TRELLO_MONITOR_SEND !== 'true' || !effectiveSettings(env).health_alerts) return [];
  const db = env.DB, board = site.board(env), t = (dependencies.clock || now)();
  const name = `${site.label} (${site.platform})`;
  if (inQuietHours(env, t)) return []; // re-evaluated every tick, so it goes out after the window
  const send = dependencies.sendText || sendWhatsAppText;
  const sent = [];
  const deliver = async (text, key) => {
    if (!await reserveWhatsAppSlot(db, dependencies)) return false;
    const result = await send(text, key, env);
    if (result.status === 'accepted') sent.push(key);
    return result.status === 'accepted';
  };
  const row = kind => sql(db, 'SELECT * FROM trello_monitor_health WHERE board_id=? AND kind=?', board, kind).first();
  const save = (kind, active, lastSent, lastValue) => sql(db,
    `INSERT INTO trello_monitor_health(board_id,kind,active,last_sent,last_value) VALUES (?,?,?,?,?)
     ON CONFLICT(board_id,kind) DO UPDATE SET active=excluded.active,last_sent=excluded.last_sent,last_value=excluded.last_value`,
    board, kind, active, lastSent, lastValue).run();

  const state = await sql(db, 'SELECT last_ok,last_error FROM trello_monitor_state WHERE board_id=?', board).first();
  const stuck = await sql(db, `SELECT COUNT(*) AS n FROM trello_monitor_jobs WHERE board_id=? AND check_status='pending' AND first_seen<?`, board, t - 3600).first();
  const problems = [
    { kind: 'scan', active: Boolean(state?.last_ok && state.last_ok < t - 1800),
      alert: () => [`⚠️ *Pitch monitor problem · ${site.label}*`, '',
        `The ${name} monitor hasn't completed a scan since ${bdtTime(state.last_ok)}, so new pitches aren't being checked.`, '',
        `Reason: ${clean(state.last_error || 'unknown', 200)}`].join('\n'),
      ok: `✅ *Pitch monitor recovered · ${site.label}*\n\n${name} scans are working again.` },
    { kind: 'ai', active: Number(stuck?.n) > 0,
      alert: () => [`⚠️ *Pitch monitor problem · ${site.label}*`, '',
        `${stuck.n} new ${site.label} pitch${stuck.n === 1 ? '' : 'es'} couldn't be checked for over an hour. The AI service (MiMo/Gemini) may be failing or out of quota.`].join('\n'),
      ok: `✅ *Pitch monitor recovered · ${site.label}*\n\nAll waiting ${site.label} pitches have now been checked.` },
  // The HA add-on watches scans from outside the run (a hung run can't report
  // itself), so this in-run scan check would only send a second message there.
  ].filter(p => !(p.kind === 'scan' && env.MONITOR_SCAN_WATCHDOG === 'external'));
  for (const p of problems) {
    const prev = await row(p.kind);
    if (p.active && (!prev?.active || t - prev.last_sent >= HEALTH_REPEAT)) {
      if (await deliver(p.alert(), `health:${board}:${p.kind}:${Math.floor(t / HEALTH_REPEAT)}`)) await save(p.kind, 1, t, null);
    } else if (!p.active && prev?.active) {
      if (await deliver(p.ok, `health:${board}:${p.kind}:ok:${prev.last_sent}`)) await save(p.kind, 0, prev.last_sent, null);
    }
  }

  // Alerts that failed or may not have arrived: report each new one once.
  const bad = (await sql(db, `SELECT card_json FROM trello_monitor_jobs WHERE board_id=? AND send_status IN ('failed','uncertain') ORDER BY checked_at DESC`, board).all()).results;
  const prev = await row('delivery');
  if (!prev) await save('delivery', 0, 0, bad.length); // start counting from now
  else if (bad.length > prev.last_value) {
    const fresh = bad.slice(0, bad.length - prev.last_value);
    const links = fresh.slice(0, 5).map(r => { try { return clean(JSON.parse(r.card_json).shortUrl, 150); } catch { return ''; } }).filter(Boolean);
    const text = [`⚠️ *Pitch alert not delivered · ${site.label}*`, '',
      `${fresh.length} duplicate alert${fresh.length === 1 ? '' : 's'} may not have reached WhatsApp. Check ${fresh.length === 1 ? `this ${site.item}` : `these ${site.item}s`}:`,
      ...links].join('\n');
    if (await deliver(text, `health:${board}:delivery:${bad.length}`)) await save('delivery', 0, t, bad.length);
  } else if (bad.length < prev.last_value) await save('delivery', 0, prev.last_sent, bad.length);
  return sent;
}

async function safeHealthCheck(env, dependencies, site) {
  try { await checkMonitorHealth(env, dependencies, site); } catch { /* never let self-monitoring break a tick */ }
}

// A run that Cloudflare kills (e.g. CPU limit) can't release its lock, so the
// lock is short and renewed before every slow step; a dead run blocks the
// next ones for at most LEASE seconds. New AI checks stop after CHECK_BUDGET.
// (A 300 s lease let one killed run block five ticks, so the AI backlog grew
// for hours on 2026-10-01.)
const LEASE = 120, CHECK_BUDGET = 60; // a renewal always precedes a check (≤ 85 s)

// Queues found duplicates in the WhatsApp outbox (or reads their status).
// No send spacing here: the bridge add-on spaces the actual WhatsApp sends.
async function queueAlerts(env, dependencies, board, report, site) {
  const db = env.DB, t = now();
  // A tick that died mid-send is resubmitted: the bridge's idempotency key
  // returns the original result instead of sending twice.
  await sql(db, `UPDATE trello_monitor_jobs SET send_status='pending',last_error='Interrupted send; retrying safely' WHERE board_id=? AND send_status='sending'`, board).run();
  const outbox = (await sql(db, `SELECT * FROM trello_monitor_jobs WHERE board_id=? AND send_status='pending' AND next_send<=? ORDER BY first_seen,card_id LIMIT 5`, board, t).all()).results;
  for (const job of outbox) {
    const claim = await sql(db, `UPDATE trello_monitor_jobs SET send_status='sending' WHERE board_id=? AND card_id=? AND send_status='pending'`, board, job.card_id).run();
    if (!changed(claim)) continue;
    const result = await (dependencies.send || sendMonitorAlert)(job, env, site);
    await sql(db, `UPDATE trello_monitor_jobs SET send_status=?,message_sid=?,last_error=?,next_send=? WHERE board_id=? AND card_id=?`,
      result.status, result.sid || null, result.error || null, now() + (result.retryIn || 300), board, job.card_id).run();
    if (result.status === 'accepted') report.accepted++;
  }
}

export function runTrelloMonitor(env, engine, dependencies = {}) {
  return runPitchMonitor(env, engine, dependencies, TRELLO_SITE);
}

export async function runPitchMonitor(env, engine, dependencies = {}, site = TRELLO_SITE) {
  if (!site.enabled(env)) return { disabled: true };
  const db = env.DB, board = site.board(env);
  if (!db) throw new Error('Monitor configuration incomplete');
  site.validate(env);
  if (env.TRELLO_MONITOR_SEND === 'true') baileysConfig(env);
  const owner = crypto.randomUUID(), started = now();
  await sql(db, 'INSERT OR IGNORE INTO trello_monitor_state(board_id) VALUES (?)', board).run();
  const lock = await sql(db, `UPDATE trello_monitor_state SET owner=?, lease_until=? WHERE board_id=? AND lease_until<?`, owner, started + LEASE, board, started).run();
  if (!changed(lock)) return { busy: true };
  const report = { checked: 0, flagged: 0, accepted: 0 }, stats = { cards: 0 };
  try {
    const state = await sql(db, 'SELECT * FROM trello_monitor_state WHERE board_id=?', board).first();
    const { cards, watched } = await (dependencies.load || site.load)(env);
    stats.cards = cards.length;
    const eligible = cards.filter(c => !c.closed && watched.includes(c.idList));
    // Baseline and marker commit atomically: a failed initial scan cannot seed a partial baseline.
    const existing = (await sql(db, 'SELECT card_id FROM trello_monitor_jobs WHERE board_id=?', board).all()).results;
    const known = new Set(existing.map(r => r.card_id));
    const inserts = eligible.filter(c => !known.has(c.id) && (!state.initialized || clean(c.name).length >= 3)).map(c => sql(db,
      `INSERT OR IGNORE INTO trello_monitor_jobs(board_id,card_id,card_json,check_status,first_seen,next_check) VALUES (?,?,?,?,?,?)`,
      board, c.id, JSON.stringify(c), state.initialized ? 'pending' : 'baseline', started, site.settle ? started + site.settle : 0));
    if (!state.initialized) {
      await db.batch([...inserts, sql(db, 'UPDATE trello_monitor_state SET initialized=1,last_ok=?,last_error=NULL WHERE board_id=? AND owner=?', started, board, owner)]);
      await recordScan(db, board, { ok: true, cards: cards.length, ms: Date.now() - started * 1000 });
      return { baseline: eligible.length };
    }
    if (inserts.length) await db.batch(inserts);
    // The scan itself succeeded; slow AI checks below must not make it look stale.
    await sql(db, 'UPDATE trello_monitor_state SET last_ok=?,last_error=NULL WHERE board_id=? AND owner=?', now(), board, owner).run();
    const renew = () => sql(db, 'UPDATE trello_monitor_state SET lease_until=? WHERE board_id=? AND owner=?', now() + LEASE, board, owner).run();
    const sending = env.TRELLO_MONITOR_SEND === 'true';
    // Alerts already found and the self-monitoring go out BEFORE the AI checks:
    // a check is what gets a run killed (CPU limit), and a killed run must not
    // hold back duplicates that were found earlier.
    if (sending && !inQuietHours(env)) { await renew(); await queueAlerts(env, dependencies, board, report, site); }
    await safeHealthCheck(env, dependencies, site);
    const pending = (await sql(db, `SELECT * FROM trello_monitor_jobs WHERE board_id=? AND check_status='pending' AND next_check<=? ORDER BY first_seen,card_id LIMIT 5`, board, started).all()).results;
    const qualifies = alertFilter(env);
    const discovered = new Set(eligible.filter(e => !known.has(e.id)).map(e => e.id));
    const byId = new Map(cards.map(c => [c.id, c]));
    for (const job of pending) {
      if (now() - started > CHECK_BUDGET) break; // the rest wait for the next run
      await renew();
      let card = JSON.parse(job.card_json);
      if (site.settle) {
        const latest = byId.get(job.card_id);
        if (!latest) { // deleted (or its row was edited away) before it was checked
          await sql(db, `UPDATE trello_monitor_jobs SET check_status='gone',checked_at=?,last_error=NULL WHERE board_id=? AND card_id=? AND check_status='pending'`, now(), board, job.card_id).run();
          continue;
        }
        const fresh = JSON.stringify(latest);
        if (titleKey(latest.name) !== titleKey(card.name) || clean(latest.name).length < 3) { // still being typed: wait until it stops changing
          await sql(db, `UPDATE trello_monitor_jobs SET card_json=?,next_check=? WHERE board_id=? AND card_id=?`, fresh, now() + site.settle, board, job.card_id).run();
          continue;
        }
        if (fresh !== job.card_json) await sql(db, `UPDATE trello_monitor_jobs SET card_json=? WHERE board_id=? AND card_id=?`, fresh, board, job.card_id).run();
        card = latest;
      }
      // Count the attempt and schedule the retry BEFORE checking: if the run is
      // killed mid-check, this card backs off instead of being first in line
      // (and killing the run) every time.
      await sql(db, `UPDATE trello_monitor_jobs SET attempts=attempts+1,next_check=? WHERE board_id=? AND card_id=?`,
        now() + Math.min(3600, 60 * 2 ** Math.min(job.attempts, 6)), board, job.card_id).run();
      try {
        // No self matches. Break ties between concurrently discovered cards by card ID.
        const peers = cards.filter(c => c.id !== card.id && (!discovered.has(c.id) || c.id < card.id));
        const meta = {}, t0 = Date.now();
        const result = await checkMonitorCard(card, peers, env, engine, meta);
        meta.ms = Date.now() - t0;
        // Findings outside the alert rules are kept but not sent ('skipped').
        const sendStatus = !result.length ? 'none' : !result.some(qualifies) ? 'skipped' : env.TRELLO_MONITOR_SEND === 'true' ? 'pending' : 'dry_run';
        await sql(db, `UPDATE trello_monitor_jobs SET check_status='checked',result_json=?,checked_at=?,send_status=?,attempts=0,last_error=NULL WHERE board_id=? AND card_id=?`,
          JSON.stringify(result), now(), sendStatus, board, job.card_id).run();
        await sql(db, 'UPDATE trello_monitor_jobs SET check_meta=? WHERE board_id=? AND card_id=?', JSON.stringify(meta), board, job.card_id).run().catch(() => {});
        report.checked++; if (result.length) report.flagged++;
      } catch (e) {
        // Only our own error messages are stored (they contain no secrets or AI output).
        const reason = /^(AI unavailable \(.*?\)|Incomplete AI verdict \(.*?\)|Invalid AI verdict|Card title is not ready)/.exec(String(e?.message || ''))?.[1];
        await sql(db, `UPDATE trello_monitor_jobs SET last_error=? WHERE board_id=? AND card_id=?`,
          clean(`Check failed${reason ? `: ${reason}` : ''}; retry pending`, 250), board, job.card_id).run();
      }
    }
    // Duplicates found in this run go out straight away when the run survives.
    if (sending && report.flagged && !inQuietHours(env)) { await renew(); await queueAlerts(env, dependencies, board, report, site); }
    await recordScan(db, board, { ok: true, ...stats, ...report, ms: Date.now() - started * 1000 });
    return report;
  } catch (error) {
    const message = String(error?.message || '');
    const safeMessage = site.safeError(message) ? message : 'Monitor tick failed; inspect Cloudflare logs';
    await sql(db, 'UPDATE trello_monitor_state SET last_error=? WHERE board_id=? AND owner=?', safeMessage, board, owner).run();
    await recordScan(db, board, { ok: false, ...stats, ...report, ms: Date.now() - started * 1000 });
    await safeHealthCheck(env, dependencies, site);
    throw error;
  } finally {
    await sql(db, 'UPDATE trello_monitor_state SET owner=NULL,lease_until=0 WHERE board_id=? AND owner=?', board, owner).run();
  }
}
