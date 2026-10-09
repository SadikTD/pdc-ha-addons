// The AotF Google Sheet and the OS Curveball Asana project, watched by the
// pitch monitor in the PDC WhatsApp Bridge add-on next to WGTC's Trello board
// (TRELLO_SITE in trello-monitor.mjs). Each site only checks pitches against
// its own pitches. READ-ONLY: every request is a fixed GET.
//
// Rows and tasks are turned into the monitor's card shape: { id, name, desc,
// idList, closed, shortUrl, _listName, _writer, _site, _created, _createdLabel }.
// idList 'pitches' / 'open' marks the ones that count as new pitches; the
// rest are only earlier pitches to compare against.
import { effectiveSettings } from './trello-monitor.mjs';

const clean = (s, n = 180) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const titleKey = s => clean(s, 5000).normalize('NFKC').toLowerCase();
const DAY = 86400000;
async function hash(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes.slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Earlier pitches are read from this many days back: the reference window
// plus one day, so a time-zone difference can't cut off the oldest day.
const historyDays = env => effectiveSettings(env).reference_days + 1;

// ============================================================================
// AotF: Google Sheet, tabs Pitches (current) and The Archive (older)
// ============================================================================
export const AOTF_SHEET_ID = '1TWqeKUtzaZfh-SIzcBgLShTAvCJUzDAHaEuyljugdoM';
// Tabs by their permanent id: for a wrong tab name or id, Google quietly
// answers with another tab, so names are never used.
export const AOTF_TABS = { pitches: '1645815743', archive: '6476884' };
// Read by column position like the browser checker (headers have changed before).
const COL = { date: 0, writer: 2, source: 3, source2: 4, title: 5, status: 6 };
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${AOTF_SHEET_ID}`;
const DATE_CELL = /^Date\((\d{4}),(\d{1,2}),(\d{1,2})(?:,(\d{1,2}),(\d{1,2}),(\d{1,2}))?/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function sheetQuery(gid, query, fetcher = fetch) {
  const url = new URL(`${SHEET_URL}/gviz/tq`);
  url.searchParams.set('tqx', 'out:json');
  url.searchParams.set('gid', gid);
  url.searchParams.set('headers', '1');
  if (query) url.searchParams.set('tq', query);
  const res = await fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (res.status !== 200) throw new Error(`AotF sheet read failed (${res.status})`);
  const text = await res.text();
  const start = text.indexOf('setResponse('), end = text.lastIndexOf(')');
  let data = null;
  try { data = JSON.parse(text.slice(start + 'setResponse('.length, end)); } catch { /* below */ }
  // A sign-in page instead of data means the sheet is no longer shared.
  if (start < 0 || !data) throw new Error("AotF sheet isn't readable; is it still shared with anyone who has the link?");
  if (data.status !== 'ok') throw new Error(`AotF sheet query failed (${clean(data.errors?.[0]?.reason || data.status, 40)})`);
  const cols = data.table?.cols || [];
  if (cols.length < 8 || !['date', 'datetime'].includes(cols[COL.date]?.type) || !Array.isArray(data.table.rows)) {
    const tab = gid === AOTF_TABS.pitches ? 'Pitches' : 'The Archive';
    throw new Error(`AotF sheet: the ${tab} tab doesn't look right (column A should hold dates, F the titles); not checking until it's fixed`);
  }
  return data.table.rows.map(r => r?.c || []);
}

const cellText = c => (c?.v == null ? '' : clean(c.v, 2000));
// The spreadsheet's own time zone (File › Settings): every time in it is
// California time, e.g. 9:04 PM in Bangladesh is typed in as 8:04 AM.
// ponytail: fixed here; update it if the sheet's time zone setting ever changes.
export const SHEET_TZ = 'America/Los_Angeles';
const TZ_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: SHEET_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
const tzOffset = t => {
  const p = Object.fromEntries(TZ_PARTS.formatToParts(t).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
};
// Sheet wall-clock time -> the real moment (daylight saving included).
export function sheetTime(y, mo, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo, d, h, mi, s);
  const first = wall - tzOffset(wall);
  return wall - tzOffset(first);
}
// A gviz date cell. The Archive tab has the time of day; the Pitches tab's
// cells are formatted as day only, so their time comes from `times` (below).
function cellDate(c, time) {
  const m = DATE_CELL.exec(String(c?.v ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; // month is 0-based
  if (!Number.isFinite(Date.UTC(y, mo, d))) return null;
  const hms = m[4] != null ? [Number(m[4]), Number(m[5]), Number(m[6])]
    : time && time.y === y && time.mo === mo && time.d === d ? [time.h, time.mi, time.s] : null;
  if (hms) return { t: sheetTime(y, mo, d, ...hms), label: '' };
  return { t: Date.UTC(y, mo, d), label: `${d} ${MONTHS[mo]} ${y}` };
}

// The Pitches tab's times, read from its .xlsx download (the gviz feed drops
// them because column A is formatted as day only). Returns sheet row ->
// { y, mo, d, h, mi, s } in sheet time. Any failure just means no times.
export async function loadPitchTimes(fetcher = fetch) {
  try {
    const res = await fetcher(`${SHEET_URL}/export?format=xlsx&gid=${AOTF_TABS.pitches}`, { method: 'GET', signal: AbortSignal.timeout(20000) });
    if (res.status !== 200) return new Map();
    const xml = await unzipEntry(new Uint8Array(await res.arrayBuffer()), 'xl/worksheets/sheet1.xml');
    const times = new Map();
    for (const [, row, v] of (xml || '').matchAll(/<c r="A(\d+)"[^>]*>(?:<f>[^<]*<\/f>)?<v>([\d.]+)<\/v>/g)) {
      // Spreadsheet serial: days since 30 Dec 1899, the fraction is the time.
      const w = new Date(Math.round((Number(v) - 25569) * 86400) * 1000);
      times.set(Number(row), { y: w.getUTCFullYear(), mo: w.getUTCMonth(), d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), s: w.getUTCSeconds() });
    }
    return times;
  } catch { return new Map(); }
}
// One file out of a .zip, without a zip library.
async function unzipEntry(zip, name) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) return null;
  let p = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const method = view.getUint16(p + 10, true), size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extra = view.getUint16(p + 30, true), comment = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    if (new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)) === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = zip.subarray(start, start + size);
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8) return null;
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    p += 46 + nameLen + extra + comment;
  }
  return null;
}

export async function loadAotfRows(env, fetcher = fetch, clock = Date.now) {
  // Today in Bangladesh time; the archive is filtered by Google, so only the
  // last few days of its thousands of rows are downloaded.
  const bdtToday = Math.floor((clock() + 6 * 3600000) / DAY) * DAY;
  const cutoff = bdtToday - historyDays(env) * DAY;
  const since = new Date(cutoff).toISOString().slice(0, 10);
  const [pitches, archive, times] = await Promise.all([
    sheetQuery(AOTF_TABS.pitches, null, fetcher),
    sheetQuery(AOTF_TABS.archive, `select * where A >= date '${since}'`, fetcher),
    loadPitchTimes(fetcher),
  ]);
  const read = (cells, tab, row) => {
    const name = cellText(cells[COL.title]);
    if (!name || titleKey(name) === 'proposed title') return null; // blank row, or a header that slipped through
    // A time is only used when its day matches the row's, in case rows moved between the two reads.
    const date = cellDate(cells[COL.date], row && times.get(row));
    const status = cellText(cells[COL.status]);
    return {
      name, date, tab, row,
      writer: cellText(cells[COL.writer]),
      desc: [cellText(cells[COL.source]), cellText(cells[COL.source2])].filter(Boolean).join('\n'),
      status: tab === 'archive' ? (status ? `${status} (archived)` : 'Archived') : status || 'Pitches tab',
    };
  };
  // Header is row 1, so the n-th data row (0-based) is sheet row n + 2.
  const current = pitches.map((c, i) => read(c, 'pitches', i + 2)).filter(Boolean);
  const same = r => `${titleKey(r.name)}|${titleKey(r.writer)}|${r.desc}`;
  const live = new Set(current.map(same));
  // While a row is being moved to The Archive it can show up in both tabs; the
  // archived copy would look like an exact duplicate of itself.
  const older = archive.map(c => read(c, 'archive', null)).filter(r => r && r.date && r.date.t >= cutoff && !live.has(same(r)));
  // A row keeps its id while it stays in the tab: title plus how many rows
  // above it in the same tab have the same title (not the row number, which
  // shifts whenever rows above it are archived or deleted).
  const seen = new Map();
  const cards = [];
  for (const r of [...current, ...older]) {
    const key = `${r.tab}|${titleKey(r.name)}`;
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    cards.push({
      id: `${r.tab === 'pitches' ? 'p' : 'a'}${await hash(key)}${n > 1 ? `x${n}` : ''}`,
      name: r.name, desc: r.desc, idList: r.tab, closed: false,
      shortUrl: r.row ? `${SHEET_URL}/edit#gid=${AOTF_TABS.pitches}&range=F${r.row}` : `${SHEET_URL}/edit#gid=${AOTF_TABS.archive}`,
      _listName: r.status, _writer: r.writer || 'Unassigned', _site: 'AotF',
      _created: r.date ? new Date(r.date.t).toISOString() : null, _createdLabel: r.date ? r.date.label : 'Unknown', // '' when the time is known
    });
  }
  // Every row still on the Pitches tab is a current pitch, whatever its date.
  return { cards, watched: ['pitches'] };
}

export const AOTF_SITE = {
  id: 'aotf', label: 'AotF', emoji: '🟦', platform: 'Google Sheet', place: 'Status', item: 'pitch', settle: 45,
  board: () => 'aotf',
  enabled: env => effectiveSettings(env).aotf_enabled,
  validate() {},
  needs: () => null,
  load: (env, fetcher) => loadAotfRows(env, fetcher),
  alertKey: (board, cardId) => `pitch:${board}:${cardId}`,
  safeError: m => /^AotF sheet/.test(m),
};

// ============================================================================
// OS: Asana project "OS Curveball"
// ============================================================================
export const OS_PROJECT_ID = '1211995119491663';
const GID = /^\d{1,24}$/;
const OPT_FIELDS = 'name,notes,completed,created_at,assignee.name,memberships.project.gid,memberships.section.name,permalink_url,custom_fields.name,custom_fields.display_value';

export async function asanaGet(path, params, env, fetcher = fetch) {
  if (path !== `/projects/${OS_PROJECT_ID}/tasks`) throw new Error('Asana read endpoint not allowed');
  const url = new URL('https://app.asana.com/api/1.0' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetcher(url, {
    method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${env.ASANA_TOKEN}`, Accept: 'application/json' },
  });
  if (res.status === 401) throw new Error('Asana rejected the access token (401); add a new one in PDC Monitor Settings');
  if (res.status === 403 || res.status === 404) throw new Error(`Asana token can't see the OS Curveball project (${res.status})`);
  if (!res.ok) throw new Error(`Asana read failed (${res.status})`);
  return res.json();
}

export async function loadOsTasks(env, fetcher = fetch, clock = Date.now) {
  const cutoff = clock() - historyDays(env) * DAY;
  const tasks = [];
  let offset = null;
  for (let page = 0; ; page++) {
    // Same request as the browser checker; fails closed instead of checking a partial list.
    if (page >= 30) throw new Error('Asana project exceeds the monitor scan budget; no partial checks performed');
    const params = { opt_fields: OPT_FIELDS, limit: '100', modified_since: new Date(cutoff).toISOString() };
    if (offset) params.offset = offset;
    const json = await asanaGet(`/projects/${OS_PROJECT_ID}/tasks`, params, env, fetcher);
    if (!Array.isArray(json?.data)) throw new Error('Asana read failed (invalid response)');
    tasks.push(...json.data);
    offset = json.next_page?.offset;
    if (!offset) break;
  }
  // A link in many task descriptions is template text (a style guide, say),
  // not a source; it must not make every pitch an "exact duplicate".
  const firstLink = t => /(https?:\/\/[^\s"')\]]+)/.exec(String(t?.notes || ''))?.[1] || '';
  const uses = new Map();
  for (const t of tasks) { const l = firstLink(t); if (l) uses.set(l, (uses.get(l) || 0) + 1); }
  const cards = [];
  for (const t of tasks) {
    if (!GID.test(String(t?.gid || ''))) throw new Error('Asana read failed (invalid task id)');
    const created = Date.parse(t.created_at);
    // Older tasks edited recently aren't recent pitches.
    if (!Number.isFinite(created) || created < cutoff) continue;
    const status = (t.custom_fields || []).find(f => f?.name === 'Article Status')?.display_value;
    const section = (t.memberships || []).find(m => m?.project?.gid === OS_PROJECT_ID)?.section?.name
      || (t.memberships || []).find(m => m?.section?.name)?.section?.name;
    cards.push({
      id: String(t.gid), name: clean(t.name, 2000), desc: (uses.get(firstLink(t)) || 0) >= 5 ? '' : firstLink(t),
      idList: t.completed ? 'completed' : 'open', closed: false,
      shortUrl: /^https:\/\/app\.asana\.com\//.test(t.permalink_url || '') ? t.permalink_url : '',
      _listName: clean(status || section || (t.completed ? 'Completed' : 'Open'), 100),
      _writer: clean(t.assignee?.name, 180) || 'Unassigned', _site: 'OS', _created: new Date(created).toISOString(),
    });
  }
  return { cards, watched: ['open'] };
}

export const OS_SITE = {
  id: 'os', label: 'OS', emoji: '⬛', platform: 'Asana', place: 'Status', item: 'task', settle: 45,
  board: () => 'os',
  enabled: env => effectiveSettings(env).os_enabled,
  validate(env) { if (!env.ASANA_TOKEN) throw new Error('Asana access token missing; add it in PDC Monitor Settings'); },
  needs: env => (env.ASANA_TOKEN ? null : 'Add your Asana access token in Settings to start'),
  load: (env, fetcher) => loadOsTasks(env, fetcher),
  alertKey: (board, cardId) => `pitch:${board}:${cardId}`,
  safeError: m => /^Asana/.test(m),
};
