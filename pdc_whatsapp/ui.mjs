// Home Assistant sidebar dashboard (Ingress). Serves www/ and a small JSON API:
// bridge status, message history and events come from this add-on; pitch checks,
// verdicts and monitor settings come from the pitch-checker Worker's /bridge/*
// API, authenticated with the same api_token the Worker uses to send.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, log } from './bridge.mjs';

const WWW = fileURLToPath(new URL('./www/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// The Supervisor's ingress proxy; loopback is allowed for local development.
const ALLOWED = new Set(['172.30.32.2', '127.0.0.1', '::1']);
const PHONE = /^\+[1-9]\d{7,14}$/;
const MONITOR_CACHE_MS = 8000;
const STARTED = Date.now().toString(36);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Validates the add-on options the Settings page may change.
export function validateBridgeSettings(changes) {
  const clean = {}, errors = {};
  for (const [key, value] of Object.entries(changes || {})) {
    if (key === 'recipient_number' || key === 'sender_number') {
      if (typeof value === 'string' && PHONE.test(value.replace(/[\s-]/g, ''))) clean[key] = value.replace(/[\s-]/g, '');
      else errors[key] = 'Use the full international number, e.g. +8801XXXXXXXXX';
    } else if (key === 'ha_notifications') {
      if (typeof value === 'boolean') clean[key] = value; else errors[key] = 'Must be on or off';
    } else if (key === 'offline_notify_minutes') {
      if (Number.isInteger(value) && value >= 1 && value <= 1440) clean[key] = value; else errors[key] = 'Whole minutes from 1 to 1440';
    } else if (key === 'worker_url') {
      const v = String(value || '').trim().replace(/\/+$/, '');
      if (v === '' || /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v)) clean[key] = v; else errors[key] = 'Use the Worker address, e.g. https://name.account.workers.dev';
    } else errors[key] = 'Unknown setting';
  }
  return { clean, errors };
}

export function createUiHandler({ options, ledger, wa, events, version, supervisor, restart, fetcher = fetch, optionsFile = `${DATA}/options.json` }) {
  let monitorCache = null;

  const worker = async (path, init = {}) => {
    if (!options.workerUrl) throw new HttpError(503, 'Set the Worker address in Settings to see pitch checks');
    let res;
    try {
      res = await fetcher(options.workerUrl + path, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
      });
    } catch { throw new HttpError(502, "Couldn't reach the pitch-checker Worker"); }
    const body = await res.json().catch(() => null);
    if (res.status === 401) throw new HttpError(502, "The Worker didn't accept this add-on's api_token (it must equal the Worker's BAILEYS_TOKEN)");
    if (!res.ok && res.status !== 400 && res.status !== 409) throw new HttpError(502, body?.error || `Worker error (${res.status})`);
    return { status: res.status, body };
  };

  const monitor = async fresh => {
    if (!fresh && monitorCache && Date.now() - monitorCache.at < MONITOR_CACHE_MS) return monitorCache.data;
    const { body } = await worker('/bridge/dashboard');
    monitorCache = { at: Date.now(), data: body };
    return body;
  };

  const safeOptions = () => ({
    recipient_number: `+${options.recipient}`, sender_number: `+${options.sender}`,
    ha_notifications: options.notifications, offline_notify_minutes: options.offlineMinutes,
    worker_url: options.workerUrl, api_token_set: options.token.length >= 32,
  });

  const status = () => {
    const messages = ledger.list(), day = Date.now() - 86400000;
    return {
      version, now: Date.now(), bridge: wa.status(), settings: safeOptions(),
      messages: {
        total: messages.length,
        sent: messages.filter(m => m.state === 'sent').length,
        sent24h: messages.filter(m => m.state === 'sent' && (m.sentAt || m.at) > day).length,
        problems: messages.filter(m => m.state === 'unknown' || m.state === 'sending').length,
        last: messages.find(m => m.state === 'sent') || null,
      },
    };
  };

  async function saveBridgeSettings(changes) {
    const { clean, errors } = validateBridgeSettings(changes);
    if (Object.keys(errors).length) return [400, { errors }];
    const current = safeOptions();
    const changed = Object.fromEntries(Object.entries(clean).filter(([k, v]) => v !== current[k]));
    if (!Object.keys(changed).length) return [200, { ok: true, changed: [], restart: false }];
    // The Worker addresses alerts to its own recipient setting and this bridge
    // only messages its configured recipient, so both must change together.
    if (changed.recipient_number) {
      const { status: code, body } = await worker('/bridge/settings', { method: 'POST', body: JSON.stringify({ settings: { recipient: changed.recipient_number } }) });
      if (code !== 200) return [400, { errors: { recipient_number: body?.errors?.recipient || "The Worker didn't accept this number" } }];
    }
    if (process.env.SUPERVISOR_TOKEN) {
      const info = await supervisor('GET', '/addons/self/info');
      const stored = info.status === 200 ? info.body?.data?.options : null;
      if (!stored) return [502, { error: "Couldn't read the current settings from Home Assistant" }];
      const saved = await supervisor('POST', '/addons/self/options', { options: { ...stored, ...changed } });
      if (saved.status !== 200) return [502, { error: saved.body?.message || `Home Assistant didn't accept the settings (${saved.status})` }];
    } else { // local development: no Supervisor, write options.json directly
      const stored = JSON.parse(await readFile(optionsFile, 'utf8'));
      await writeFile(optionsFile + '.tmp', JSON.stringify({ ...stored, ...changed }, null, 2));
      await rename(optionsFile + '.tmp', optionsFile);
    }
    events.add('settings', `Changed ${Object.keys(changed).join(', ')}; restarting to apply`);
    log('Settings changed:', Object.keys(changed).join(', '));
    restart();
    return [200, { ok: true, changed: Object.keys(changed), restart: true }];
  }

  async function sendTest(text) {
    const s = wa.status();
    if (!s.connected || !s.accountOk) throw new HttpError(409, 'WhatsApp is not connected right now');
    const key = `ui-test-${Date.now()}`;
    const body = String(text || '').trim().slice(0, 1000) || '🧪 *Test message*\n\nPDC Monitor can reach you on WhatsApp.';
    ledger.set(key, { state: 'sending', text: body, to: options.recipient, sentAt: null, error: null });
    try {
      const id = await wa.send(`${options.recipient}@s.whatsapp.net`, body);
      ledger.set(key, { state: 'sent', id, sentAt: Date.now() });
      events.add('test', 'Test message sent from the dashboard');
      return { ok: true, key, id };
    } catch (e) {
      ledger.set(key, { state: 'unknown', error: String(e?.message || e).slice(0, 200) });
      throw new HttpError(502, `WhatsApp didn't confirm the test message: ${e?.message || e}`);
    }
  }

  async function api(req, path) {
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/status') return [200, status()];
    if (route === 'GET /api/messages') return [200, { messages: ledger.list().slice(0, 1000) }];
    if (route === 'GET /api/events') return [200, { events: events.list() }];
    if (route === 'GET /api/monitor') return [200, await monitor(false)];
    if (route === 'GET /api/lists') return [200, (await worker('/bridge/lists')).body];
    if (route === 'POST /api/monitor/settings') {
      const body = await readBody(req);
      const { status: code, body: result } = await worker('/bridge/settings', { method: 'POST', body: JSON.stringify({ settings: body.settings }) });
      if (code === 200) { monitorCache = null; events.add('settings', `Monitor settings changed: ${Object.keys(body.settings || {}).join(', ')}`); }
      return [code, result];
    }
    const job = /^POST \/api\/jobs\/([a-f0-9]{24})\/(recheck|resend)$/.exec(route);
    if (job) {
      const { status: code, body } = await worker(`/bridge/jobs/${job[1]}/${job[2]}`, { method: 'POST' });
      // Clear this bridge's record of the alert so the Worker's retry really sends.
      if (code === 200 && job[2] === 'resend') ledger.delete(body.key);
      if (code === 200) { monitorCache = null; events.add(job[2], `${job[2] === 'resend' ? 'Resend' : 'Recheck'} requested for card ${job[1]}`); }
      return [code, body];
    }
    if (route === 'POST /api/test') return [200, await sendTest((await readBody(req)).text)];
    if (route === 'POST /api/relink') { await wa.relink(); return [200, { ok: true }]; }
    if (route === 'GET /api/settings') return [200, safeOptions()];
    if (route === 'POST /api/settings') return saveBridgeSettings((await readBody(req)).changes);
    throw new HttpError(404, 'Not found');
  }

  return async (req, res) => {
    const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!ALLOWED.has(addr)) { res.writeHead(403); return res.end('Forbidden'); }
    const path = new URL(req.url, 'http://ui').pathname;
    if (path.startsWith('/api/')) {
      let code, body;
      try { [code, body] = await api(req, path); } catch (e) {
        code = e instanceof HttpError ? e.status : 500; body = { error: e instanceof HttpError ? e.message : 'Internal error' };
        if (!(e instanceof HttpError)) log('Dashboard API error:', e?.stack || e);
      }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const file = normalize(join(WWW, path === '/' ? 'index.html' : path));
    if (!file.startsWith(normalize(WWW))) { res.writeHead(404); return res.end(); }
    try {
      let data = await readFile(file);
      // Version-stamped asset URLs, so an add-on update never runs against stale files.
      if (extname(file) === '.html') data = data.toString('utf8').replaceAll('__V__', encodeURIComponent(`${version}-${STARTED}`));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  };
}
