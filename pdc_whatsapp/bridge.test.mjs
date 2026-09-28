import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOptions, createLedger, createHandler, createUpstreamWatchdog } from './bridge.mjs';

const token = 'x'.repeat(40);
const options = { token, sender: '15550000001', recipient: '15550000002' };

async function serve(wa, ledger = createLedger(join(mkdtempSync(join(tmpdir(), 'pdc-')), 'sent.json'))) {
  const server = http.createServer(createHandler({ options, ledger, wa }));
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, auth = `Bearer ${token}`) => fetch(base + '/send', {
    method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { base, send, ledger, close: () => server.close() };
}
const online = (onSend = async () => 'WAID1') => ({ status: () => ({ connected: true, paired: true, accountOk: true }), send: onSend });
const msg = { to: '+15550000002', text: 'hello', idempotencyKey: 'trello:board:card1' };

test('rejects missing or wrong token', async () => {
  const s = await serve(online());
  assert.equal((await s.send(msg, '')).status, 401);
  assert.equal((await s.send(msg, 'Bearer wrong')).status, 401);
  s.close();
});

test('only the configured recipient can be messaged', async () => {
  let calls = 0; const s = await serve(online(async () => { calls++; return 'id'; }));
  assert.equal((await s.send({ ...msg, to: '+15550000003' })).status, 403);
  assert.equal(calls, 0); s.close();
});

test('sends to the recipient JID and deduplicates by idempotency key', async () => {
  const sent = []; const s = await serve(online(async (jid, text) => { sent.push([jid, text]); return 'WAID1'; }));
  const first = await s.send(msg); assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { status: 'sent', id: 'WAID1' });
  const again = await (await s.send(msg)).json();
  assert.equal(again.duplicate, true);
  assert.deepEqual(sent, [['15550000002@s.whatsapp.net', 'hello']]);
  s.close();
});

test('disconnected bridge returns 503 without recording the key', async () => {
  let up = false;
  const s = await serve({ status: () => ({ connected: up, paired: true, accountOk: true }), send: async () => 'id2' });
  assert.equal((await s.send(msg)).status, 503);
  up = true; assert.equal((await s.send(msg)).status, 200);
  s.close();
});

test('failed send is remembered as unknown and never resent', async () => {
  let calls = 0; const s = await serve(online(async () => { calls++; throw new Error('socket closed'); }));
  assert.equal((await s.send(msg)).status, 502);
  const retry = await s.send(msg); assert.equal(retry.status, 409);
  assert.equal((await retry.json()).status, 'unknown'); assert.equal(calls, 1);
  s.close();
});

test('in-flight sends survive a restart as unknown', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pdc-')), 'sent.json');
  createLedger(file).set('k', { state: 'sending' });
  assert.equal(createLedger(file).get('k').state, 'unknown');
});

test('rejects malformed bodies and keys', async () => {
  const s = await serve(online());
  assert.equal((await s.send({ ...msg, text: '' })).status, 400);
  assert.equal((await s.send({ ...msg, idempotencyKey: 'bad key/../' })).status, 400);
  assert.equal((await s.send({ ...msg, text: 'a'.repeat(5000) })).status, 400);
  const health = await (await fetch(s.base + '/health')).json();
  assert.deepEqual(health, { ok: true, connected: true, paired: true });
  s.close();
});

test('options require a long token and international numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-')), file = join(dir, 'options.json');
  writeFileSync(file, JSON.stringify({ api_token: token, sender_number: '+15550000001', recipient_number: '+15550000002' }));
  assert.deepEqual(loadOptions(file), { ...options, notifications: true, offlineMinutes: 10, workerUrl: '', upstreamMinutes: 15 });
  writeFileSync(file, JSON.stringify({ api_token: token, sender_number: '+15550000001', recipient_number: '+15550000002',
    ha_notifications: false, offline_notify_minutes: 30, worker_url: 'https://w.example.dev/', upstream_alert_minutes: 0 }));
  assert.deepEqual(loadOptions(file), { ...options, notifications: false, offlineMinutes: 30, workerUrl: 'https://w.example.dev', upstreamMinutes: 0 });
  writeFileSync(file, JSON.stringify({ api_token: 'short', sender_number: '+15550000001', recipient_number: '+15550000002' }));
  assert.throws(() => loadOptions(file));
});

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(200, 1)]).toString('base64');
const withGroups = (onImage = async () => 'IMG1') => ({
  ...online(), sendImage: onImage, groups: async () => [{ id: '120363000000000001@g.us', name: 'Home', size: 3 }],
});
const post = (s, path, body) => fetch(s.base + path, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('images go to the recipient or a joined group only', async () => {
  const sent = []; const s = await serve(withGroups(async (jid, buf, caption) => { sent.push([jid, buf.length, caption]); return 'IMG1'; }));
  const img = { image: jpeg, caption: 'Motion', idempotencyKey: 'sentinel:e1:1' };
  assert.equal((await post(s, '/send-image', { ...img, to: '120363000000000001@g.us' })).status, 200);
  assert.equal((await post(s, '/send-image', { ...img, to: '+15550000002', idempotencyKey: 'sentinel:e1:2' })).status, 200);
  assert.equal((await post(s, '/send-image', { ...img, to: '120363999999999999@g.us', idempotencyKey: 'sentinel:e1:3' })).status, 403);
  assert.equal((await post(s, '/send-image', { ...img, to: '+15550000003', idempotencyKey: 'sentinel:e1:4' })).status, 403);
  assert.equal((await post(s, '/send-image', { ...img, image: 'aGVsbG8=', to: '+15550000002', idempotencyKey: 'sentinel:e1:5' })).status, 400);
  assert.deepEqual(sent.map(x => x[0]), ['120363000000000001@g.us', '15550000002@s.whatsapp.net']);
  // Text sends still refuse groups.
  assert.equal((await post(s, '/send', { to: '120363000000000001@g.us', text: 'hi', idempotencyKey: 'k9' })).status, 403);
  s.close();
});

test('lists chats for authorised callers', async () => {
  const s = await serve(withGroups());
  const r = await fetch(s.base + '/chats', { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual(await r.json(), { recipient: '+15550000002', groups: [{ id: '120363000000000001@g.us', name: 'Home', size: 3 }] });
  assert.equal((await fetch(s.base + '/chats')).status, 401);
  s.close();
});

test('only an authenticated heartbeat counts as Worker contact; local sends do not', async () => {
  let contacts = 0;
  const ledger = createLedger(join(mkdtempSync(join(tmpdir(), 'pdc-')), 'sent.json'));
  const server = http.createServer(createHandler({ options, ledger, wa: online(), upstream: { contact: () => contacts++ } }));
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const beat = auth => fetch(base + '/heartbeat', { method: 'POST', headers: { Authorization: auth } });
  assert.equal((await beat('Bearer wrong')).status, 401);
  assert.equal(contacts, 0);
  const res = await beat(`Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, connected: true });
  assert.equal(contacts, 1);
  await fetch(base + '/send', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
  assert.equal(contacts, 1); // e.g. Sentinel sending locally must not mask a dead tunnel
  server.close();
});

test('watchdog alerts once after silence, repeats every 6 hours, and reports recovery', async () => {
  let t = 0; const sent = [], notes = [];
  let accept = true;
  const w = createUpstreamWatchdog({ minutes: 15, clock: () => t, send: async text => { if (accept) sent.push(text); return accept; }, notify: m => notes.push(m) });
  t = 14 * 60000; await w.tick();
  assert.equal(sent.length, 0);
  t = 16 * 60000; accept = false; await w.tick(); // WhatsApp offline: retried next minute
  assert.equal(sent.length, 0); assert.equal(notes.length, 1); assert.match(notes[0], /Cloudflared/);
  accept = true; t += 60000; await w.tick();
  assert.equal(sent.length, 1); assert.match(sent[0], /not getting through/);
  t += 60000; await w.tick();
  assert.equal(sent.length, 1); // no spam
  t += 6 * 3600000; await w.tick();
  assert.equal(sent.length, 2); // reminder while it lasts
  w.contact(); assert.equal(notes.at(-1), null); // HA notification dismissed
  await w.tick();
  assert.equal(sent.length, 3); assert.match(sent[2], /getting through again/);
  t += 60 * 60000; w.contact(); await w.tick();
  assert.equal(sent.length, 3); // healthy: silent
});

test('watchdog with 0 minutes is off; recovery before any alert is silent', async () => {
  let t = 0; const sent = [];
  const off = createUpstreamWatchdog({ minutes: 0, clock: () => t, send: async x => sent.push(x) });
  t = 99 * 3600000; await off.tick();
  const w = createUpstreamWatchdog({ minutes: 15, clock: () => t, send: async () => false, notify: () => {} });
  t += 20 * 60000; await w.tick(); // WhatsApp down, nothing delivered
  w.contact(); await w.tick();
  assert.equal(sent.length, 0);
});
