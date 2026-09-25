import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOptions, createLedger, createHandler } from './bridge.mjs';

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
  assert.deepEqual(loadOptions(file), { ...options, notifications: true, offlineMinutes: 10, workerUrl: '' });
  writeFileSync(file, JSON.stringify({ api_token: token, sender_number: '+15550000001', recipient_number: '+15550000002',
    ha_notifications: false, offline_notify_minutes: 30, worker_url: 'https://w.example.dev/' }));
  assert.deepEqual(loadOptions(file), { ...options, notifications: false, offlineMinutes: 30, workerUrl: 'https://w.example.dev' });
  writeFileSync(file, JSON.stringify({ api_token: 'short', sender_number: '+15550000001', recipient_number: '+15550000002' }));
  assert.throws(() => loadOptions(file));
});
