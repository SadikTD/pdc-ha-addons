// PDC WhatsApp bridge: one Baileys session, one allowed recipient. Pitch alerts
// are collected from the pitch-checker Worker's outbox over outbound HTTPS, so
// nothing needs to connect into this Pi. Local apps (Sentinel) use POST /send.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';

export const DATA = process.env.DATA_DIR || '/data';
const MAX_TEXT = 4096;
const MAX_IMAGE_BODY = 8 * 1024 * 1024; // base64 JPEG snapshots
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
    // Read-only access to the OS Curveball Asana project; the OS monitor waits until it's set.
    asanaToken: String(o.asana_token || '').trim(),
    // 0 turns the "Worker can't reach this bridge" watchdog off.
    upstreamMinutes: Math.min(1440, Math.max(0, Number(o.upstream_alert_minutes ?? 15) || 0)),
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

// `wa` exposes { status(): {connected, paired, accountOk}, send(jid, text): Promise<id>,
// sendImage(jid, jpeg, caption): Promise<id>, groups(): Promise<[{id, name, size}]> }.
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
    const route = `${req.method} ${url.pathname}`;
    if (!['POST /send', 'POST /send-image', 'GET /chats'].includes(route)) return reply(res, 404, { status: 'not_found' });
    if (!tokenMatches(req.headers.authorization, options.token)) {
      note('rejected', 'Request with a wrong or missing token');
      return reply(res, 401, { status: 'unauthorized' });
    }

    // Chats a sender may pick: the configured recipient plus the groups this account is in.
    if (route === 'GET /chats') {
      if (!wa.status().connected) return reply(res, 503, { status: 'unavailable' });
      try {
        const groups = (await wa.groups()).map(g => ({ id: g.id, name: g.name, size: g.size })).sort((a, b) => a.name.localeCompare(b.name));
        return reply(res, 200, { recipient: `+${options.recipient}`, groups });
      } catch (e) { return reply(res, 502, { status: 'unknown', error: String(e?.message || e).slice(0, 200) }); }
    }

    const image = route === 'POST /send-image';
    let body;
    try { body = await readJson(req, image ? MAX_IMAGE_BODY : undefined); } catch (e) { return reply(res, e.message === 'too_large' ? 413 : 400, { status: 'bad_request' }); }
    const text = typeof (image ? body?.caption : body?.text) === 'string' ? (image ? body.caption : body.text) : '';
    const key = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey : '';
    const media = image && typeof body?.image === 'string' ? Buffer.from(body.image, 'base64') : null;
    if ((!image && !text.trim()) || text.length > MAX_TEXT || !/^[\w:.-]{1,120}$/.test(key)) return reply(res, 400, { status: 'bad_request' });
    if (image && (!media || media.length < 100 || media[0] !== 0xff || media[1] !== 0xd8)) return reply(res, 400, { status: 'bad_request', error: 'image must be a base64 JPEG' });
    // A leaked token must never let anyone message arbitrary numbers: only the recipient,
    // or (for images) a group this account is already a member of.
    let jid = null;
    if (digits(body.to) === options.recipient && !String(body.to).includes('@')) jid = `${options.recipient}@s.whatsapp.net`;
    else if (image && /^[\d-]{5,40}@g\.us$/.test(String(body.to))) {
      const groups = await wa.groups().catch(() => []);
      if (groups.some(g => g.id === body.to)) jid = body.to;
    }
    if (!jid) {
      note('rejected', 'Send request for a chat other than the recipient or a joined group');
      return reply(res, 403, { status: 'recipient_not_allowed' });
    }

    const previous = ledger.get(key);
    if (previous?.state === 'sent') return reply(res, 200, { status: 'sent', id: previous.id, duplicate: true });
    if (previous?.state === 'sending') return reply(res, 409, { status: 'in_progress' });
    if (previous?.state === 'unknown') return reply(res, 409, { status: 'unknown' });

    const s = wa.status();
    if (!s.connected || !s.accountOk) return reply(res, 503, { status: 'unavailable', connected: s.connected, paired: s.paired });

    ledger.set(key, { state: 'sending', text: image ? `[image] ${text}`.trim() : text, to: jid.endsWith('@g.us') ? jid : options.recipient, sentAt: null, error: null });
    try {
      const id = image ? await wa.sendImage(jid, media, text) : await wa.send(jid, text);
      ledger.set(key, { state: 'sent', id, sentAt: Date.now() });
      log(`sent ${key}`);
      return reply(res, 200, { status: 'sent', id });
    } catch (e) {
      // Nothing left the Pi: the caller may simply retry later.
      if (e?.notSent) { ledger.delete(key); return reply(res, 503, { status: 'unavailable', connected: false, paired: true }); }
      ledger.set(key, { state: 'unknown', error: String(e?.message || e).slice(0, 200) });
      log(`send failed for ${key}: ${e?.message || e}`);
      note('send_failed', `${key}: ${e?.message || e}`);
      return reply(res, 502, { status: 'unknown' });
    }
  };
}

// Calls the pitch-checker Worker's /bridge/* API, signed in with api_token.
export function remoteApi(options, fetcher = fetch) {
  return (path, init = {}) => fetcher(options.workerUrl + path, {
    ...init, redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
  });
}

// Collects queued pitch alerts (GET /bridge/outbox), sends each through the
// idempotency ledger, and reports the result (POST /bridge/outbox/ack). `api`
// answers those routes: the monitor in this add-on (local-monitor.mjs), or the
// Worker until the monitor has moved here. A key already in the ledger is
// re-reported, never re-sent, so a lost ack or a restart can't cause a
// duplicate. `upstream` is told about each successful poll.
export function createOutboxPoller({ options, ledger, wa, events, upstream, fetcher = fetch, api = null, spacingMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let busy = false, failing = false;
  const call = api || remoteApi(options, fetcher);
  const ack = (key, status, extra = {}) => call('/bridge/outbox/ack', { method: 'POST', body: JSON.stringify({ key, status, ...extra }) })
    .then(r => r.ok).catch(() => false);
  return {
    async poll() {
      if (busy || (!api && !options.workerUrl)) return;
      busy = true;
      try {
        let messages;
        try {
          const res = await call('/bridge/outbox');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          messages = (await res.json())?.messages;
          if (!Array.isArray(messages)) throw new Error('unexpected response');
        } catch (e) {
          if (!failing) { failing = true; log(`Can't reach the pitch-checker Worker: ${e?.message || e}`); }
          return;
        }
        if (failing) { failing = false; log('Reached the pitch-checker Worker again'); }
        upstream?.contact();
        for (const m of messages) {
          if (typeof m?.key !== 'string' || !/^[\w:.-]{1,120}$/.test(m.key)) continue;
          const prev = ledger.get(m.key);
          if (prev?.state === 'sent') { await ack(m.key, 'sent', { id: prev.id }); continue; }
          if (prev?.state === 'unknown') { await ack(m.key, 'unknown', { error: prev.error || null }); continue; }
          if (prev?.state === 'sending') continue;
          if (digits(m.to) !== options.recipient || String(m.to).includes('@') || typeof m.text !== 'string' || !m.text.trim() || m.text.length > MAX_TEXT) {
            events?.add('rejected', `Outbox message ${m.key} is not for the configured recipient or is malformed`);
            await ack(m.key, 'failed', { error: 'recipient_not_allowed or malformed message' });
            continue;
          }
          const s = wa.status();
          if (!s.connected || !s.accountOk) break; // stays queued; the next poll retries
          ledger.set(m.key, { state: 'sending', text: m.text, to: options.recipient, sentAt: null, error: null });
          try {
            const id = await wa.send(`${options.recipient}@s.whatsapp.net`, m.text);
            ledger.set(m.key, { state: 'sent', id, sentAt: Date.now() });
            log(`sent ${m.key}`);
            await ack(m.key, 'sent', { id });
          } catch (e) {
            if (e?.notSent) { ledger.delete(m.key); break; } // stays queued; sent after the reconnect
            const error = String(e?.message || e).slice(0, 200);
            ledger.set(m.key, { state: 'unknown', error });
            log(`send failed for ${m.key}: ${error}`);
            events?.add('send_failed', `${m.key}: ${error}`);
            await ack(m.key, 'unknown', { error });
          }
          await sleep(spacingMs);
        }
      } finally { busy = false; }
    },
  };
}

// Watches for the Worker becoming unreachable (Pi internet down, wrong
// worker_url or token, Worker broken). The Worker can't report that itself,
// but WhatsApp may still work, so the bridge tells the recipient directly:
// once, again every `repeatMs` while it lasts, and once more when it's back.
// `send(text)` resolves true when WhatsApp accepted the message.
export function createUpstreamWatchdog({ minutes, send, notify = () => {}, events, clock = Date.now, repeatMs = 6 * 3600000 }) {
  let last = clock(), down = false, lastAlert = null, recoveryDue = false;
  const since = () => Math.round((clock() - last) / 60000);
  return {
    contact() {
      last = clock();
      if (down) { down = false; recoveryDue = lastAlert !== null; notify(null); events?.add('upstream_ok', 'Reaching the pitch-checker Worker again'); }
    },
    lastContact: () => last,
    async tick() {
      if (!minutes) return;
      if (!down && clock() - last > minutes * 60000) {
        down = true;
        events?.add('upstream_lost', `Could not reach the pitch-checker Worker for ${since()} minutes`);
        notify(`This bridge hasn't been able to reach the pitch-checker Worker for ${since()} minutes, so duplicate-pitch alerts can't be collected. Check the Pi's internet connection and the Worker address and token in the add-on settings. Alerts wait in the queue and send once it's fixed.`);
      }
      if (down && (lastAlert === null || clock() - lastAlert >= repeatMs)) {
        const text = ['⚠️ *Pitch alerts are not getting through*', '',
          `The WhatsApp bridge in Home Assistant hasn't been able to reach the pitch checker for ${since()} minutes, so duplicate-pitch alerts can't be collected.`, '',
          'Check the PDC WhatsApp Bridge add-on (Worker address and token) and the internet connection. New alerts are queued and will be sent once it is fixed.'].join('\n');
        if (await send(text).catch(() => false)) lastAlert = clock();
      }
      if (recoveryDue && await send('✅ *Pitch alerts are getting through again*\n\nThe WhatsApp bridge can reach the pitch checker again. Any queued alerts will arrive over the next few minutes.').catch(() => false)) {
        recoveryDue = false; lastAlert = null;
      }
    },
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
