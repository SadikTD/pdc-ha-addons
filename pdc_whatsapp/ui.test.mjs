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

async function serve({ worker = async () => Response.json({}), connected = true, remote } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-ui-'));
  const optionsFile = join(dir, 'options.json');
  writeFileSync(optionsFile, JSON.stringify({ api_token: token, sender_number: '+15550000001', recipient_number: '+15550000002' }));
  const options = { token, sender: '15550000001', recipient: '15550000002', notifications: true, offlineMinutes: 10, workerUrl: 'https://w.example.dev' };
  const ledger = createLedger(join(dir, 'sent.json')), events = createEventLog(join(dir, 'events.json'));
  const calls = [], sent = [];
  let restarted = 0;
  const wa = { status: () => ({ connected, accountOk: connected, paired: true }), send: async (jid, text) => { sent.push([jid, text]); return 'WA9'; }, relink: async () => {} };
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
