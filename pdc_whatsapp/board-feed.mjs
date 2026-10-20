// The Gamurs Kanban board as a pitch source, next to each site's old platform
// (Trello, the AotF sheet, Asana). Writers are moving to the board, so for a
// while a pitch may be on either one: each site's scan reads both, and its
// older pitches include the board's last 90 days too. A board pitch in Pitched
// counts as a new pitch; the rest are earlier pitches to compare against.
// Sites listed in board_only_sites stop reading their old platform (its 90
// days of history are still compared against until they run out).
//
// READ-ONLY: one fixed GET, /api/feed/pitches on the board, with board_token.
import { effectiveSettings } from './monitor/trello-monitor.mjs';

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
