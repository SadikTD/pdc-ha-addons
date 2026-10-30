// The Gamurs Kanban board as a pitch source, next to each site's old platform
// (Trello, the AotF sheet, Asana). Writers are moving to the board, so for a
// while a pitch may be on either one: each site's scan reads both, and its
// older pitches include the board's last 90 days too. A board pitch in Pitched
// counts as a new pitch; the rest are earlier pitches to compare against.
// Sites listed in board_only_sites stop reading their old platform (its 90
// days of history are still compared against until they run out).
//
// The board is read with one fixed GET, /api/feed/pitches, and told about
// duplicates with one fixed POST, /api/feed/duplicates, both with board_token.
import { effectiveSettings } from './monitor/trello-monitor.mjs';
import { platformOf } from './slack-layout.mjs';

export const BOARD_SLUG = { wgtc: 'wgtc', aotf: 'aotf', os: 'os-curveball', tms: 'tms' };
export const BOARD_PITCHED = 'board_pitched';
const HISTORY_EVERY = 15 * 60000;
const clean = (s, n = 180) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function loadBoardPitches(options, site, days, fetcher = fetch) {
  const url = new URL(`${options.boardUrl}/api/feed/pitches`);
  url.searchParams.set('site', BOARD_SLUG[site.id]);
  url.searchParams.set('days', String(days));
  const res = await fetcher(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${options.boardToken}`, Accept: 'application/json' },
  });
  if (res.status === 401) throw new Error('Kanban board rejected the feed token (401); check board_token');
  if (!res.ok) throw new Error(`Kanban board read failed (${res.status})`);
  const json = await res.json().catch(() => null);
  if (!Array.isArray(json?.pitches)) throw new Error('Kanban board read failed (invalid response)');
  return json.pitches.map(p => ({
    id: `kb${clean(p.id, 20)}`, name: clean(p.title, 2000), desc: (p.sources || []).map(s => clean(s, 500)).join('\n'),
    idList: p.col === 'pitched' ? BOARD_PITCHED : 'board', closed: false,
    shortUrl: /^https?:\/\//.test(p.url || '') ? p.url : '',
    _listName: `Board · ${clean(p.colLabel || p.col, 90)}`, _writer: clean(p.writer, 180) || 'Unassigned',
    _site: site.label, _created: p.created || null,
  }));
}

const boardOn = options => Boolean(options.boardUrl && options.boardToken && options.boardEnabled !== false);

// A site's loader plus the board's pitches from the same reference window.
export function withBoard(load, site, options, fetcher = fetch) {
  if (!boardOn(options) || !BOARD_SLUG[site.id]) return load;
  const oldPlatform = !options.boardOnly?.includes(site.id);
  return async env => {
    const [own, board] = await Promise.all([
      oldPlatform ? load(env) : { cards: [], watched: [] },
      loadBoardPitches(options, site, effectiveSettings(env).reference_days + 1, fetcher),
    ]);
    return { cards: [...own.cards, ...board], watched: [...own.watched, BOARD_PITCHED] };
  };
}

// A site's older pitches plus the board's last `days` days, re-read every 15
// minutes. A failed read keeps the last copy (logged once until it recovers).
export function withBoardHistory(history, options, { days = 90, fetcher = fetch, clock = Date.now, log = () => {} } = {}) {
  if (!boardOn(options)) return history;
  const cache = {}; // site id -> { at, cards, failing }
  const wrapped = async site => {
    const older = await history(site);
    if (!BOARD_SLUG[site.id]) return older;
    const c = cache[site.id] ||= { at: -Infinity, cards: [], failing: false };
    if (clock() - c.at >= HISTORY_EVERY) {
      try {
        c.cards = (await loadBoardPitches(options, site, days, fetcher)).map(card => ({ ...card, idList: 'history' }));
        c.at = clock();
        if (c.failing) log(`${site.label}: board pitches (up to ${days} days) are updating again`);
        c.failing = false;
      } catch (e) {
        if (!c.failing) log(`${site.label}: board pitches (up to ${days} days) couldn't be updated, so the last copy is used: ${String(e?.message || e).slice(0, 160)}`);
        c.failing = true;
      }
    }
    return [...older, ...c.cards];
  };
  wrapped.status = history.status;
  return wrapped;
}

// Duplicates found for board pitches (ids kb…) are also sent to the board,
// which flags the card and comments on it as "Editorial Duplicates". Same rule
// as the Slack alerts (alert verdicts and minimum confidence, sending on), but
// not held back by quiet hours: a flag on a card pings nobody. The board stores
// each card/match pair once, so a resend after a lost answer is harmless.
// Each job is sent until the board answers 200 (or "Card not found");
// failures retry with backoff. Only checks from the last 3 days are sent, so
// switching this on doesn't flag old cards.
const FLAG_WINDOW = 3 * 86400, FLAG_BATCH = 10;
export async function pushBoardFlags({ db, options, sites, settings, qualifies, fetcher = fetch, clock = Date.now, log = () => {} }) {
  if (!boardOn(options) || settings.TRELLO_MONITOR_SEND !== 'true') return 0;
  db.sqlite.exec(`CREATE TABLE IF NOT EXISTS board_flags (board_id TEXT NOT NULL, card_id TEXT NOT NULL, sent_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (board_id, card_id))`);
  const t = Math.floor(clock() / 1000);
  const jobs = db.sqlite.prepare(`SELECT j.board_id, j.card_id, j.result_json FROM trello_monitor_jobs j
      LEFT JOIN board_flags f ON f.board_id = j.board_id AND f.card_id = j.card_id
     WHERE j.card_id LIKE 'kb%' AND j.check_status = 'checked' AND j.checked_at >= ? AND f.sent_at IS NULL AND COALESCE(f.next_try, 0) <= ?
     ORDER BY j.checked_at LIMIT ?`).all(t - FLAG_WINDOW, t, FLAG_BATCH);
  const save = db.sqlite.prepare(`INSERT INTO board_flags (board_id, card_id, sent_at, attempts, next_try, last_error) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT (board_id, card_id) DO UPDATE SET sent_at = excluded.sent_at, attempts = attempts + 1,
      next_try = ? + MIN(3600, 60 * (1 << MIN(attempts, 6))), last_error = excluded.last_error`);
  let sent = 0;
  for (const job of jobs) {
    const site = sites.find(s => BOARD_SLUG[s.id] && s.board(settings) === job.board_id);
    let findings = [];
    try { findings = JSON.parse(job.result_json || '[]').filter(qualifies); } catch { /* unreadable: nothing to send */ }
    if (!site || !findings.length) { save.run(job.board_id, job.card_id, t, 0, null, t); continue; } // nothing to flag
    const body = {
      site: BOARD_SLUG[site.id], cardId: job.card_id.slice(2),
      matches: findings.slice(0, 5).map(f => {
        const c = f.candidate || {};
        return { key: `${c.cardId || clean(c.title, 120)}`, title: clean(c.title, 500), url: clean(c.editLink, 2000), platform: platformOf(c.cardId, site),
          writer: clean(c.writer, 120), verdict: f.verdict, confidence: f.confidence, reason: clean(f.reason, 600) };
      }),
    };
    let error = null;
    try {
      const res = await fetcher(`${options.boardUrl.replace(/\/$/, '')}/api/feed/duplicates`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${options.boardToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      // 404 "Card not found": the pitch was deleted, so there is nothing to flag. Any other 404 is a board
      // that doesn't have this endpoint yet, and is retried.
      const gone = res.status === 404 && (await res.json().catch(() => null))?.error === 'Card not found';
      if (res.status === 401) error = 'Kanban board rejected the feed token (401); check board_token';
      else if (!res.ok && !gone) error = `Kanban board flag failed (${res.status})`;
    } catch (e) { error = `Kanban board flag failed: ${String(e?.message || e).slice(0, 120)}`; }
    if (error) { save.run(job.board_id, job.card_id, null, t + 60, error, t); log(`${site.label}: ${error}`); continue; }
    save.run(job.board_id, job.card_id, t, 0, null, t);
    sent++;
  }
  return sent;
}
