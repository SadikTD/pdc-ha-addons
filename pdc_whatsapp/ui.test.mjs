import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, createEventLog } from './bridge.mjs';
import { createUiHandler, validateBridgeSettings } from './ui.mjs';

const token = 'x'.repeat(40);
const board = 'b'.repeat(24), card = 'c'.repeat(24);

async function serve({ worker = async () => Response.json({}), connected = true, remote, groups = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-ui-'));
  const optionsFile = join(dir, 'options.json');
  writeFileSync(optionsFile, JSON.stringify({ api_token: token, sender_number: '+15550000001', recipient_number: '+15550000002' }));
  const options = { token, sender: '15550000001', recipient: '15550000002', notifications: true, offlineMinutes: 10, workerUrl: 'https://w.example.dev' };
  const ledger = createLedger(join(dir, 'sent.json')), events = createEventLog(join(dir, 'events.json'));
  const calls = [], sent = [];
  let restarted = 0;
  const wa = { status: () => ({ connected, accountOk: connected, paired: true }), send: async (jid, text) => { sent.push([jid, text]); return 'WA9'; }, relink: async () => {},
    groups: async () => { if (!connected) throw new Error('not connected'); return groups; } };
  const handler = createUiHandler({
    options, ledger, wa, events, version: '9.9.9', optionsFile, supervisor: async () => ({ status: null }), restart: () => { restarted++; },
    fetcher: async (url, init) => { calls.push({ url, init }); return worker(url, init); },
  });
  const server = http.createServer((req, res) => {
    if (remote) Object.defineProperty(req.socket, 'remoteAddress', { value: remote });
    handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = p => fetch(base + p);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { get, post, ledger, events, calls, sent, optionsFile, restarts: () => restarted, close: () => server.close() };
}

test('only the ingress proxy (and loopback) may connect', async () => {
  const s = await serve({ remote: '172.30.33.9' });
  assert.equal((await s.get('/api/status')).status, 403);
  s.close();
  const t = await serve({ remote: '::ffff:172.30.32.2' });
  assert.equal((await t.get('/api/status')).status, 200);
  t.close();
});

test('serves the dashboard with version-stamped assets and blocks path traversal', async () => {
  const s = await serve();
  const html = await (await s.get('/')).text();
  assert.match(html, /app\.js\?v=9\.9\.9-/);
  assert.ok(!html.includes('__V__'));
  assert.equal((await s.get('/app.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await s.get('/..%2f..%2fbridge.mjs')).status, 404);
  s.close();
});

test('status never exposes the api token', async () => {
  const s = await serve();
  const body = await (await s.get('/api/status')).text();
  assert.ok(!body.includes(token));
  assert.equal(JSON.parse(body).settings.recipient_number, '+15550000002');
  s.close();
});

test('monitor data is fetched from the Worker with the bridge token', async () => {
  const s = await serve({ worker: async () => Response.json({ jobs: [], now: 1 }) });
  assert.deepEqual(await (await s.get('/api/monitor')).json(), { jobs: [], now: 1 });
  assert.equal(s.calls[0].url, 'https://w.example.dev/bridge/dashboard');
  assert.equal(s.calls[0].init.headers.Authorization, `Bearer ${token}`);
  await s.get('/api/monitor'); assert.equal(s.calls.length, 1, 'cached briefly');
  s.close();
});

test('Worker auth failures and outages become readable errors', async () => {
  const s = await serve({ worker: async () => new Response('{}', { status: 401 }) });
  const r = await s.get('/api/monitor');
  assert.equal(r.status, 502); assert.match((await r.json()).error, /api_token/);
  s.close();
  const t = await serve({ worker: async () => { throw new Error('offline'); } });
  assert.match((await (await t.get('/api/monitor')).json()).error, /Couldn't reach/);
  t.close();
});

test('resend clears the bridge ledger entry so the alert really goes out again', async () => {
  const key = `trello:${board}:${card}`;
  const s = await serve({ worker: async () => Response.json({ ok: true, key, sending: true }) });
  s.ledger.set(key, { state: 'sent', id: 'OLD' });
  const r = await s.post(`/api/jobs/${card}/resend`);
  assert.equal(r.status, 200); assert.equal(s.ledger.get(key), undefined);
  assert.equal(s.calls[0].url, `https://w.example.dev/bridge/jobs/${card}/resend`);
  s.close();
});

test('a refused resend leaves the ledger alone', async () => {
  const key = `trello:${board}:${card}`;
  const s = await serve({ worker: async () => Response.json({ error: 'busy' }, { status: 409 }) });
  s.ledger.set(key, { state: 'sent', id: 'OLD' });
  assert.equal((await s.post(`/api/jobs/${card}/resend`)).status, 409);
  assert.equal(s.ledger.get(key).state, 'sent');
  s.close();
});

test('test message goes to the recipient and is recorded', async () => {
  const s = await serve();
  const r = await (await s.post('/api/test')).json();
  assert.equal(r.ok, true); assert.equal(s.sent[0][0], '15550000002@s.whatsapp.net');
  assert.equal(s.ledger.get(r.key).state, 'sent'); assert.ok(s.ledger.get(r.key).text.includes('Test message'));
  s.close();
  const t = await serve({ connected: false });
  assert.equal((await t.post('/api/test')).status, 409);
  t.close();
});

test('alert message test sends a made-up pitch in the given layout, and rejects unknown placeholders', async () => {
  const s = await serve();
  assert.match((await (await s.get('/api/status')).json()).alertTemplate.default, /\{new_title\}/);
  assert.equal((await s.post('/api/test-alert', {})).status, 200);
  assert.match(s.sent[0][1], /^🧪 \*Test alert\* \(made-up pitch\)\n\n🟦 \*AotF\* · 🚨 \*Duplicate\*\n/);
  assert.equal((await s.post('/api/test-alert', { template: '{site}: {new_title} ({confidence})\nExtra: {old_link}' })).status, 200);
  assert.ok(s.sent[1][1].endsWith('AotF: A Bronx mother was allegedly pushed off a 15th-floor balcony holding her baby, and a neighbor says she heard someone pl… (92%)\nExtra: https://docs.google.com/spreadsheets/d/example/edit#gid=0&range=F7'));
  const bad = await s.post('/api/test-alert', { template: 'Hi {writer}' });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /unknown placeholder \{writer\}/);
  assert.equal(s.sent.length, 2);
  s.close();
});

test('bridge settings are validated; a recipient change updates the Worker first', async () => {
  assert.deepEqual(Object.keys(validateBridgeSettings({ recipient_number: '123', worker_url: 'http://x', bogus: 1, offline_notify_minutes: 0 }).errors).sort(),
    ['bogus', 'offline_notify_minutes', 'recipient_number', 'worker_url']);
  const s = await serve({ worker: async () => Response.json({ ok: true }) });
  const r = await (await s.post('/api/settings', { changes: { recipient_number: '+1 555 000 0009', offline_notify_minutes: 30 } })).json();
  assert.deepEqual(r, { ok: true, changed: ['recipient_number', 'offline_notify_minutes'], restart: true });
  assert.deepEqual(JSON.parse(s.calls[0].init.body), { settings: { recipient: '+15550000009' } });
  const saved = JSON.parse(readFileSync(s.optionsFile, 'utf8'));
  assert.equal(saved.recipient_number, '+15550000009'); assert.equal(saved.offline_notify_minutes, 30); assert.equal(saved.api_token, token);
  assert.equal(s.restarts(), 1);
  s.close();
});

test('a recipient the Worker rejects is not saved to the add-on', async () => {
  const s = await serve({ worker: async () => Response.json({ errors: { recipient: 'nope' } }, { status: 400 }) });
  const r = await s.post('/api/settings', { changes: { recipient_number: '+15550000009' } });
  assert.equal(r.status, 400); assert.equal((await r.json()).errors.recipient_number, 'nope');
  assert.equal(JSON.parse(readFileSync(s.optionsFile, 'utf8')).recipient_number, '+15550000002');
  assert.equal(s.restarts(), 0);
  s.close();
});

test('event log is capped and newest first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-ev-'));
  const log = createEventLog(join(dir, 'e.json'), 3);
  for (let i = 0; i < 5; i++) log.add('t', String(i));
  log.flush();
  assert.deepEqual(log.list().map(e => e.detail), ['4', '3', '2']);
  assert.deepEqual(createEventLog(join(dir, 'e.json')).list().map(e => e.detail), ['4', '3', '2']);
});

test('dashboard script parses (a syntax error leaves every page blank)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('./www/app.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('AotF and OS pitches are rechecked and resent through their own site route', async () => {
  const key = 'pitch:aotf:p0123456789abcdef0123x2';
  const s = await serve({ worker: async () => Response.json({ ok: true, key, sending: true }) });
  s.ledger.set(key, { state: 'sent', id: 'OLD' });
  const r = await s.post('/api/jobs/aotf/p0123456789abcdef0123x2/resend');
  assert.equal(r.status, 200); assert.equal(s.ledger.get(key), undefined);
  assert.equal(s.calls[0].url, 'https://w.example.dev/bridge/jobs/aotf/p0123456789abcdef0123x2/resend');
  assert.equal((await s.post('/api/jobs/os/1211995119491663/recheck')).status, 200);
  assert.equal(s.calls[1].url, 'https://w.example.dev/bridge/jobs/os/1211995119491663/recheck');
  assert.equal((await s.post('/api/jobs/os/bad-id!/recheck')).status, 404);
  s.close();
});

test('the Asana token is saved to the add-on but never shown back', async () => {
  assert.equal(validateBridgeSettings({ asana_token: 'short' }).errors.asana_token, 'Paste the whole Asana personal access token');
  const s = await serve();
  const tok = 'fake-asana-token-for-tests-only-123';
  assert.equal((await (await s.get('/api/settings')).json()).asana_token_set, false);
  const r = await (await s.post('/api/settings', { changes: { asana_token: ` ${tok} ` } })).json();
  assert.deepEqual(r, { ok: true, changed: ['asana_token'], restart: true });
  assert.equal(JSON.parse(readFileSync(s.optionsFile, 'utf8')).asana_token, tok);
  const listed = JSON.stringify([await (await s.get('/api/settings')).json(), await (await s.get('/api/status')).json(), await (await s.get('/api/events')).json()]);
  assert.equal(listed.includes(tok), false);
  s.close();
});

test('alerts can be pointed at a group the sender is in, and only such a group', async () => {
  const group = '120363012345678901@g.us';
  assert.equal(validateBridgeSettings({ alert_group: 'someone@s.whatsapp.net' }).errors.alert_group, 'Pick your number or one of the groups');
  const s = await serve({ groups: [{ id: group, name: 'Pitch alerts', size: 4 }, { id: '1203630999@g.us', name: 'Another', size: 9 }] });
  assert.deepEqual(await (await s.get('/api/chats')).json(), { recipient: '+15550000002', groups: [{ id: '1203630999@g.us', name: 'Another', size: 9 }, { id: group, name: 'Pitch alerts', size: 4 }] });
  assert.equal((await s.post('/api/settings', { changes: { alert_group: '1203639999999@g.us' } })).status, 400, 'not a member');
  assert.equal(s.restarts(), 0);
  assert.deepEqual(await (await s.post('/api/settings', { changes: { alert_group: group } })).json(), { ok: true, changed: ['alert_group'], restart: true });
  assert.equal(JSON.parse(readFileSync(s.optionsFile, 'utf8')).alert_group, group);
  s.close();
  const off = await serve({ connected: false });
  assert.equal((await off.get('/api/chats')).status, 409);
  assert.equal((await off.post('/api/settings', { changes: { alert_group: group } })).status, 409);
  off.close();
});
