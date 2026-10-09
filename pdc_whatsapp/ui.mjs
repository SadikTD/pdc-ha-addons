// Home Assistant sidebar dashboard (Ingress). Serves www/ and a small JSON API:
// bridge status, message history and events come from this add-on; pitch checks,
// verdicts and monitor settings come from the /bridge/* API of the pitch monitor,
// which runs in this add-on (local-monitor.mjs) once it has moved from the
// Worker; until then from the Worker, signed in with api_token.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA, log, remoteApi, alertTarget } from './bridge.mjs';
import { buildMonitorAlert, checkAlertTemplate, DEFAULT_ALERT_TEMPLATE, ALERT_PLACEHOLDERS } from './monitor/trello-monitor.mjs';
import { AOTF_SITE } from './monitor/pitch-sources.mjs';

const WWW = fileURLToPath(new URL('./www/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// The Supervisor's ingress proxy; loopback is allowed for local development.
const ALLOWED = new Set(['172.30.32.2', '127.0.0.1', '::1']);
const PHONE = /^\+[1-9]\d{7,14}$/;
const GROUP = /^[\d-]{5,40}@g\.us$/;
const MONITOR_CACHE_MS = 8000;
const STARTED = Date.now().toString(36);

// Made-up duplicate for the "Send test" button under Settings › Alert message.
const SAMPLE_SHEET = 'https://docs.google.com/spreadsheets/d/example/edit#gid=0';
const SAMPLE_ALERT = {
  card_json: JSON.stringify({ name: 'A Bronx mother was allegedly pushed off a 15th-floor balcony holding her baby, and a neighbor says she heard someone plead', _writer: 'Kelsey', _listName: 'Approved', _created: '2026-10-09T14:49:00Z', shortUrl: `${SAMPLE_SHEET}&range=F12` }),
  result_json: JSON.stringify([
    { verdict: 'duplicate', confidence: 92, reason: 'Same event: woman and baby found below a high-rise balcony.', candidate: { title: "A New York witness says she heard a woman yell 'please don't do this!' before a woman and a baby were found below a balcony", writer: 'Abdul', status: 'Submitted (archived)', date: '2026-10-06T03:12:00Z', editLink: `${SAMPLE_SHEET}&range=F7` } },
    { verdict: 'same_story', confidence: 70, reason: 'x', candidate: { title: 'Another pitch' } },
  ]),
};
export const sampleAlert = template => buildMonitorAlert(SAMPLE_ALERT, () => true, AOTF_SITE, template);

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
    } else if (key === 'alert_group') {
      // '' sends alerts to the recipient number.
      if (value === '' || GROUP.test(String(value))) clean[key] = String(value); else errors[key] = 'Pick your number or one of the groups';
    } else if (key === 'asana_token') {
      // Asana personal access tokens are printable ASCII with no spaces (e.g. 2/123…/456…:abc…).
      const v = String(value ?? '').trim();
      if (/^[\x21-\x7e]{20,300}$/.test(v)) clean[key] = v; else errors[key] = 'Paste the whole Asana personal access token';
    } else if (key === 'worker_url') {
      const v = String(value || '').trim().replace(/\/+$/, '');
      if (v === '' || /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(v)) clean[key] = v; else errors[key] = 'Use the Worker address, e.g. https://name.account.workers.dev';
    } else errors[key] = 'Unknown setting';
  }
  return { clean, errors };
}

// `localMonitor()` returns the in-add-on monitor's API, or null before it has moved.
export function createUiHandler({ options, ledger, wa, events, version, supervisor, restart, fetcher = fetch, localMonitor = () => null, monitorHealth = () => null, optionsFile = `${DATA}/options.json`, target = alertTarget(options, wa, events) }) {
  let monitorCache = null;
  const remote = remoteApi(options, fetcher);

  const worker = async (path, init = {}) => {
    const local = localMonitor();
    if (!local && !options.workerUrl) throw new HttpError(503, 'Set the Worker address in Settings to see pitch checks');
    let res;
    try { res = await (local || remote)(path, init); }
    catch (e) {
      if (local) { log('Monitor API error:', e?.stack || e); throw new HttpError(500, 'The pitch monitor had an internal error; see the add-on log'); }
      throw new HttpError(502, "Couldn't reach the pitch-checker Worker");
    }
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
    asana_token_set: Boolean(options.asanaToken), // never the token itself
    alert_group: options.alertGroup,
  });

  const status = () => {
    const messages = ledger.list(), day = Date.now() - 86400000;
    return {
      version, now: Date.now(), bridge: wa.status(), settings: safeOptions(), alertTemplate: { default: DEFAULT_ALERT_TEMPLATE, placeholders: ALERT_PLACEHOLDERS }, monitorHost: localMonitor() ? 'pi' : 'worker',
      monitorHealth: monitorHealth(),
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
    const changed = Object.fromEntries(Object.entries(clean).filter(([k, v]) => (k === 'asana_token' ? v !== options.asanaToken : v !== current[k])));
    if (!Object.keys(changed).length) return [200, { ok: true, changed: [], restart: false }];
    // Only a group the sender is in right now (WhatsApp would refuse the rest).
    if (changed.alert_group) {
      const groups = await wa.groups().catch(() => null);
      if (!groups) return [409, { errors: { alert_group: "WhatsApp isn't connected, so the group can't be checked; try again in a minute" } }];
      if (!groups.some(g => g.id === changed.alert_group)) return [400, { errors: { alert_group: 'The sender number is not in that group' } }];
    }
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
    const label = k => ({ asana_token: 'Asana token', alert_group: changed.alert_group ? 'alerts now go to a WhatsApp group' : 'alerts now go to the number' }[k] || k);
    events.add('settings', `Changed ${Object.keys(changed).map(label).join(', ')}; restarting to apply`);
    log('Settings changed:', Object.keys(changed).join(', '));
    restart();
    return [200, { ok: true, changed: Object.keys(changed), restart: true }];
  }

  async function sendTest(text) {
    const s = wa.status();
    if (!s.connected || !s.accountOk) throw new HttpError(409, 'WhatsApp is not connected right now');
    const key = `ui-test-${Date.now()}`;
    const t = await target(String(text || '').trim().slice(0, 4000) || '🧪 *Test message*\n\nPDC Monitor can reach you on WhatsApp.');
    ledger.set(key, { state: 'sending', text: t.text, to: t.to, sentAt: null, error: null });
    try {
      const id = await wa.send(t.jid, t.text);
      ledger.set(key, { state: 'sent', id, sentAt: Date.now() });
      events.add('test', 'Test message sent from the dashboard');
      return { ok: true, key, id };
    } catch (e) {
      if (e?.notSent) { ledger.delete(key); throw new HttpError(409, 'WhatsApp is reconnecting; try again in a few seconds'); }
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
    // /api/jobs/<card>/<action> (WGTC, as before) or /api/jobs/<site>/<id>/<action>.
    const job = /^POST \/api\/jobs\/(?:([a-z]{1,12})\/([A-Za-z0-9]{1,40})|([a-f0-9]{24}))\/(recheck|resend)$/.exec(route);
    if (job) {
      const [, site, id = job[3], , action] = job;
      const { status: code, body } = await worker(`/bridge/jobs/${site ? `${site}/${id}` : id}/${action}`, { method: 'POST' });
      // Clear this bridge's record of the alert so the retry really sends.
      if (code === 200 && action === 'resend') ledger.delete(body.key);
      if (code === 200) { monitorCache = null; events.add(action, `${action === 'resend' ? 'Resend' : 'Recheck'} requested for ${site ? `${site.toUpperCase()} pitch` : 'card'} ${id}`); }
      return [code, body];
    }
    if (route === 'POST /api/test') return [200, await sendTest((await readBody(req)).text)];
    if (route === 'POST /api/test-alert') {
      const { template = '' } = await readBody(req);
      try { checkAlertTemplate(template); } catch (e) { throw new HttpError(400, `Alert message ${e.message}`); }
      return [200, await sendTest(`🧪 *Test alert* (made-up pitch)

${sampleAlert(template)}`)];
    }
    if (route === 'POST /api/relink') { await wa.relink(); return [200, { ok: true }]; }
    if (route === 'GET /api/settings') return [200, safeOptions()];
    // Chats alerts can go to: the recipient number and the groups the sender is in.
    if (route === 'GET /api/chats') {
      const groups = await wa.groups().catch(() => null);
      if (!groups) throw new HttpError(409, "WhatsApp isn't connected, so the groups can't be listed right now");
      return [200, { recipient: `+${options.recipient}`, groups: groups.map(g => ({ id: g.id, name: g.name, size: g.size })).sort((a, b) => a.name.localeCompare(b.name)) }];
    }
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
