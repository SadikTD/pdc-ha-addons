// SQLite in /data: the cards seen on the board, one pitch check and one article check per
// card, the WhatsApp messages sent and an event log. Settings live in settings.json.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODELS } from './ai.mjs';
import { SITES } from './sites.mjs';

export function openDb(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'editorial.db'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS cards (key TEXT PRIMARY KEY, site TEXT NOT NULL, card_id TEXT NOT NULL, title TEXT, writer TEXT, col TEXT, col_label TEXT,
      stage TEXT, created INTEGER, url TEXT, description TEXT, sources TEXT, edit_url TEXT, publish_url TEXT, first_seen INTEGER, last_seen INTEGER);
    CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, card_key TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, verdict TEXT, findings TEXT, info TEXT, error TEXT, input_hash TEXT, created INTEGER NOT NULL,
      started_at INTEGER, finished_at INTEGER, next_try INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      rechecks INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0, alerted_key TEXT, sources_alerted INTEGER,
      UNIQUE (card_key, kind));
    CREATE INDEX IF NOT EXISTS checks_status ON checks (status, next_try);
    CREATE INDEX IF NOT EXISTS checks_finished ON checks (finished_at);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, card_key TEXT,
      text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, idem TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL);`);
  return db;
}

export function logEvent(db, level, text) {
  db.prepare('INSERT INTO events (at, level, text) VALUES (?, ?, ?)').run(Date.now(), level, String(text).slice(0, 1000));
  db.prepare('DELETE FROM events WHERE id < (SELECT MAX(id) - 3000 FROM events)').run();
  console.log(new Date().toISOString(), level, text);
}

export const DEFAULT_SETTINGS = {
  boardUrl: '', boardToken: '',
  geminiKeys: [], geminiModel: DEFAULT_MODELS.gemini, factModel: 'gemini-3.6-flash', mimoKeys: [], mimoModel: DEFAULT_MODELS.mimo,
  bridgeUrl: '', bridgeToken: '', whatsappTo: '',
  sendWhatsApp: true, alertProblems: true, alertChecks: true, alertHealth: true,
  sourcesMinutes: 3, charsPerLine: 100, backfillMinutes: 30, checkImage: true, rulesAutoRefresh: false,
  sites: Object.fromEntries(SITES.map(s => [s.id, { enabled: true, primaryCategory: s.primaryCategory }])),
};
export const SECRET = ['boardToken', 'bridgeToken'];
export const KEY_LISTS = ['geminiKeys', 'mimoKeys'];

export function createSettings(dataDir) {
  const file = join(dataDir, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first start */ }
  // Older settings had one key per provider; it becomes the first of the list.
  const lists = s => Object.fromEntries(['gemini', 'mimo'].map(p => [`${p}Keys`, [...new Set([...(s[`${p}Keys`] || []), s[`${p}Key`]].filter(Boolean))]]));
  const merge = s => ({ ...DEFAULT_SETTINGS, ...s, ...lists(s), geminiKey: undefined, mimoKey: undefined, sites: Object.fromEntries(SITES.map(x => [x.id, { ...DEFAULT_SETTINGS.sites[x.id], ...(s.sites?.[x.id] || {}) }])) });
  let current = merge(saved);
  return {
    get: () => current,
    save(changes) {
      for (const k of KEY_LISTS) if (changes[k] && !Array.isArray(changes[k])) changes = { ...changes, [k]: [...new Set([...changes[k].keep.map(i => current[k][i]).filter(Boolean), ...changes[k].add])].slice(0, 10) };
      const sites = Object.fromEntries(Object.entries(current.sites).map(([id, s]) => [id, { ...s, ...(changes.sites?.[id] || {}) }]));
      current = merge({ ...current, ...changes, sites });
      writeFileSync(`${file}.tmp`, JSON.stringify(current, null, 2));
      renameSync(`${file}.tmp`, file);
      return current;
    },
    // For the dashboard: secrets only say whether they're set.
    public: (status = new Map()) => Object.fromEntries(Object.entries(current).filter(([, v]) => v !== undefined).map(([k, v]) => [k,
      SECRET.includes(k) ? (v ? `set, ends ${String(v).slice(-4)}` : '')
        : KEY_LISTS.includes(k) ? v.map((key, i) => ({ i, ends: key.slice(-4), ...(status.get(key) || {}) })) : v])),
  };
}

const VALID = {
  boardUrl: v => v === '' || /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(v), bridgeUrl: v => v === '' || /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(v),
  whatsappTo: v => v === '' || /^\+[1-9]\d{7,14}$/.test(v), geminiModel: v => /^[\w.-]{3,60}$/.test(v), mimoModel: v => /^[\w.-]{3,60}$/.test(v), factModel: v => /^[\w.-]{3,60}$/.test(v),
  sourcesMinutes: v => Number.isInteger(v) && v >= 1 && v <= 120, charsPerLine: v => Number.isInteger(v) && v >= 40 && v <= 200,
  backfillMinutes: v => Number.isInteger(v) && v >= 0 && v <= 1440,
};
export function validateSettings(changes) {
  const clean = {}, errors = {};
  for (const [k, v0] of Object.entries(changes || {})) {
    const v = typeof v0 === 'string' ? v0.trim() : v0;
    if (KEY_LISTS.includes(k)) {
      // { keep: [indexes of saved keys], add: [new keys] }; resolved against the saved list on save.
      const keep = Array.isArray(v?.keep) ? v.keep.filter(Number.isInteger) : null, add = Array.isArray(v?.add) ? v.add.map(x => String(x).trim()).filter(Boolean) : [];
      if (!keep || add.length > 10 || add.some(x => x.length > 400 || /\s/.test(x))) errors[k] = 'Paste each whole key, with no spaces'; else clean[k] = { keep, add };
    } else if (SECRET.includes(k)) { if (typeof v === 'string' && v.length <= 400 && !/\s/.test(v)) clean[k] = v; else errors[k] = 'Paste the whole key, with no spaces'; }
    else if (VALID[k]) { if (VALID[k](v)) clean[k] = typeof v === 'string' ? v.replace(/\/$/, '') : v; else errors[k] = 'Not a valid value'; }
    else if (typeof DEFAULT_SETTINGS[k] === 'boolean') { if (typeof v === 'boolean') clean[k] = v; else errors[k] = 'Must be on or off'; }
    else if (k === 'sites' && v && typeof v === 'object') {
      clean.sites = {};
      for (const s of SITES) if (v[s.id]) {
        const x = v[s.id], out = {};
        if ('enabled' in x) out.enabled = Boolean(x.enabled);
        if ('primaryCategory' in x) { if (/^[\w &'-]{0,40}$/.test(String(x.primaryCategory))) out.primaryCategory = String(x.primaryCategory).trim(); else errors[`sites.${s.id}`] = 'Category names only'; }
        clean.sites[s.id] = out;
      }
    } else errors[k] = 'Unknown setting';
  }
  return { clean, errors };
}
