// PDC WhatsApp bridge: one Baileys session, one allowed recipient, one
// authenticated HTTP endpoint for the pitch-checker Worker.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';

export const DATA = process.env.DATA_DIR || '/data';
const MAX_TEXT = 4096;
const LEDGER_LIMIT = 1000;

const digits = s => String(s || '').replace(/\D/g, '');
export const log = (...a) => console.log(new Date().toISOString(), ...a);

export function loadOptions(file = `${DATA}/options.json`) {
  const o = JSON.parse(readFileSync(file, 'utf8'));
  const options = {
    token: String(o.api_token || ''), sender: digits(o.sender_number), recipient: digits(o.recipient_number),
    notifications: o.ha_notifications !== false,
    offlineMinutes: Math.min(1440, Math.max(1, Number(o.offline_notify_minutes) || 10)),
    workerUrl: String(o.worker_url || '').trim().replace(/\/+$/, ''),
  };
  if (options.token.length < 32) throw new Error('api_token must be at least 32 characters');
  if (!/^[1-9]\d{7,14}$/.test(options.sender) || !/^[1-9]\d{7,14}$/.test(options.recipient)) {
    throw new Error('sender_number and recipient_number must be full international numbers, e.g. +15551234567');
  }
  return options;
}

// Idempotency ledger. A key is written as "sending" BEFORE the message goes to
// WhatsApp, so a crash mid-send is remembered as "unknown" instead of resent.
// Entries also keep the message text and timestamps for the dashboard (local
// to this add-on's /data only). `set` merges into the existing entry.
export function createLedger(file = `${DATA}/sent.json`) {
  let entries = {};
  try { entries = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
  for (const e of Object.values(entries)) if (e.state === 'sending') e.state = 'unknown';
  const save = () => {
    const keys = Object.keys(entries);
    if (keys.length > LEDGER_LIMIT) keys.sort((a, b) => entries[a].at - entries[b].at)
      .slice(0, keys.length - LEDGER_LIMIT).forEach(k => delete entries[k]);
    writeFileSync(file + '.tmp', JSON.stringify(entries));
    renameSync(file + '.tmp', file);
  };
  return {
    get: key => entries[key],
    set(key, value) { entries[key] = { created: Date.now(), ...entries[key], ...value, at: Date.now() }; save(); },
    delete(key) { const had = key in entries; delete entries[key]; if (had) save(); return had; },
    list: () => Object.entries(entries).map(([key, e]) => ({ key, ...e })).sort((a, b) => b.at - a.at),
  };
}

function tokenMatches(header, token) {
  const given = /^Bearer (.+)$/.exec(header || '')?.[1] || '';
  const a = createHash('sha256').update(given).digest(), b = createHash('sha256').update(token).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

// `wa` exposes { status(): {connected, paired, accountOk}, send(jid, text): Promise<id> }.
// `events` (optional) records rejected requests and send results for the dashboard.
export function createHandler({ options, ledger, wa, events }) {
  const note = (type, detail) => events?.add(type, detail);
  const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  return async (req, res) => {
    const url = new URL(req.url, 'http://bridge');
    if (req.method === 'GET' && url.pathname === '/health') {
      const s = wa.status();
      return reply(res, 200, { ok: s.connected && s.accountOk, connected: s.connected, paired: s.paired });
    }
    if (req.method !== 'POST' || url.pathname !== '/send') return reply(res, 404, { status: 'not_found' });
    if (!tokenMatches(req.headers.authorization, options.token)) {
      note('rejected', 'Send request with a wrong or missing token');
      return reply(res, 401, { status: 'unauthorized' });
    }

    let body;
    try { body = await readJson(req); } catch (e) { return reply(res, e.message === 'too_large' ? 413 : 400, { status: 'bad_request' }); }
    const text = typeof body?.text === 'string' ? body.text : '';
    const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '';
    if (!text.trim() || text.length > MAX_TEXT || !/^[\w:.-]{1,120}$/.test(key)) return reply(res, 400, { status: 'bad_request' });
    // A leaked token must never let anyone message arbitrary numbers.
    if (digits(body.to) !== options.recipient) {
      note('rejected', 'Send request for a number other than the recipient');
      return reply(res, 403, { status: 'recipient_not_allowed' });
    }

    const previous = ledger.get(key);
    if (previous?.state === 'sent') return reply(res, 200, { status: 'sent', id: previous.id, duplicate: true });
    if (previous?.state === 'sending') return reply(res, 409, { status: 'in_progress' });
    if (previous?.state === 'unknown') return reply(res, 409, { status: 'unknown' });

    const s = wa.status();
    if (!s.connected || !s.accountOk) return reply(res, 503, { status: 'unavailable', connected: s.connected, paired: s.paired });

    ledger.set(key, { state: 'sending', text, to: options.recipient, sentAt: null, error: null });
    try {
      const id = await wa.send(`${options.recipient}@s.whatsapp.net`, text);
      ledger.set(key, { state: 'sent', id, sentAt: Date.now() });
      log(`sent ${key}`);
      return reply(res, 200, { status: 'sent', id });
    } catch (e) {
      ledger.set(key, { state: 'unknown', error: String(e?.message || e).slice(0, 200) });
      log(`send failed for ${key}: ${e?.message || e}`);
      note('send_failed', `${key}: ${e?.message || e}`);
      return reply(res, 502, { status: 'unknown' });
    }
  };
}


// Connection and activity log for the dashboard: newest last, capped, and
// written at most every few seconds so a burst of events costs one write.
export function createEventLog(file = `${DATA}/events.json`, limit = 500) {
  let items = [];
  try { items = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
  let timer = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    try { writeFileSync(file + '.tmp', JSON.stringify(items)); renameSync(file + '.tmp', file); } catch (e) { log('Could not save events:', e?.message); }
  };
  return {
    add(type, detail = '') {
      items.push({ at: Date.now(), type, detail: String(detail).slice(0, 300) });
      if (items.length > limit) items = items.slice(-limit);
      timer ||= setTimeout(flush, 3000);
      timer.unref?.();
    },
    list: () => items.slice().reverse(),
    flush,
  };
}
