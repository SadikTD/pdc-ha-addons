import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOptions, createLedger, createHandler, createUpstreamWatchdog, createOutboxPoller, alertTarget } from './bridge.mjs';

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
  assert.deepEqual(loadOptions(file), { ...options, notifications: true, offlineMinutes: 10, workerUrl: '', asanaToken: '', alertGroup: '', upstreamMinutes: 15 });
  writeFileSync(file, JSON.stringify({ api_token: token, sender_number: '+15550000001', recipient_number: '+15550000002',
    ha_notifications: false, offline_notify_minutes: 30, worker_url: 'https://w.example.dev/', upstream_alert_minutes: 0, asana_token: ' 2/123/456:abc ', alert_group: '120363012345678901@g.us' }));
  assert.deepEqual(loadOptions(file), { ...options, notifications: false, offlineMinutes: 30, workerUrl: 'https://w.example.dev', asanaToken: '2/123/456:abc', alertGroup: '120363012345678901@g.us', upstreamMinutes: 0 });
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

test('outbox poller sends queued alerts once, acks results, and never resends a known key', async () => {
  const ledger = createLedger(join(mkdtempSync(join(tmpdir(), 'pdc-')), 'sent.json'));
  let queue = [
    { key: 'trello:b:c1', to: '+15550000002', text: 'duplicate found' },
    { key: 'trello:b:c2', to: '+15559999999', text: 'wrong recipient' },
    { key: 'bad key!', to: '+15550000002', text: 'ignored' },
  ];
  const acks = [], sends = [], calls = [];
  let contacts = 0, down = false;
  const fetcher = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, redirect: init.redirect });
    if (down) throw new Error('offline');
    if (url.endsWith('/bridge/outbox')) return Response.json({ messages: queue });
    acks.push(JSON.parse(init.body)); return Response.json({ ok: true });
  };
  const wa = online(async (jid, text) => { sends.push({ jid, text }); return 'WA1'; });
  const p = createOutboxPoller({ options: { ...options, workerUrl: 'https://w.example' }, ledger, wa, fetcher, sleep: async () => {}, upstream: { contact: () => contacts++ } });
  await p.poll();
  assert.deepEqual(sends, [{ jid: '15550000002@s.whatsapp.net', text: 'duplicate found' }]);
  assert.deepEqual(acks, [{ key: 'trello:b:c1', status: 'sent', id: 'WA1' }, { key: 'trello:b:c2', status: 'failed', error: 'recipient_not_allowed or malformed message' }]);
  assert.equal(calls[0].url, 'https://w.example/bridge/outbox');
  assert.equal(calls[0].auth, `Bearer ${token}`); assert.equal(calls[0].redirect, 'manual');
  assert.equal(contacts, 1);
  // Ack lost: the Worker still lists it. Re-reported from the ledger, not re-sent.
  queue = [queue[0]]; acks.length = 0;
  await p.poll();
  assert.equal(sends.length, 1);
  assert.deepEqual(acks, [{ key: 'trello:b:c1', status: 'sent', id: 'WA1' }]);
  // Worker unreachable: no contact recorded, nothing thrown.
  down = true; await p.poll(); assert.equal(contacts, 2);
});

test('outbox poller waits while WhatsApp is offline and reports failed sends as unknown', async () => {
  const ledger = createLedger(join(mkdtempSync(join(tmpdir(), 'pdc-')), 'sent.json'));
  const acks = [];
  const fetcher = async (url, init) => url.endsWith('/bridge/outbox')
    ? Response.json({ messages: [{ key: 'health:x:1', to: '+15550000002', text: 'hi' }] })
    : (acks.push(JSON.parse(init.body)), Response.json({ ok: true }));
  const offline = { status: () => ({ connected: false, paired: true, accountOk: false }), send: async () => { throw new Error('should not send'); } };
  await createOutboxPoller({ options: { ...options, workerUrl: 'https://w.example' }, ledger, wa: offline, fetcher, sleep: async () => {} }).poll();
  assert.deepEqual(acks, []); assert.equal(ledger.get('health:x:1'), undefined);
  const flaky = online(async () => { throw new Error('send timeout'); });
  await createOutboxPoller({ options: { ...options, workerUrl: 'https://w.example' }, ledger, wa: flaky, fetcher, sleep: async () => {} }).poll();
  assert.equal(acks[0].status, 'unknown'); assert.equal(ledger.get('health:x:1').state, 'unknown');
  // No worker_url: never polls.
  let polled = false;
  await createOutboxPoller({ options, ledger, wa: flaky, fetcher: async () => { polled = true; }, sleep: async () => {} }).poll();
  assert.equal(polled, false);
});

test('watchdog alerts once after silence, repeats every 6 hours, and reports recovery', async () => {
  let t = 0; const sent = [], notes = [];
  let accept = true;
  const w = createUpstreamWatchdog({ minutes: 15, clock: () => t, send: async text => { if (accept) sent.push(text); return accept; }, notify: m => notes.push(m) });
  t = 14 * 60000; await w.tick();
  assert.equal(sent.length, 0);
  t = 16 * 60000; accept = false; await w.tick(); // WhatsApp offline: retried next minute
  assert.equal(sent.length, 0); assert.equal(notes.length, 1); assert.match(notes[0], /Worker address and token/);
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

test('a send into a dead connection (ping failed) stays queued and goes out after the reconnect', async () => {
  const notSent = () => Object.assign(new Error('WhatsApp connection was dead; reconnecting'), { notSent: true });
  // Direct /send (Sentinel, netmon): 503 like "offline", and a retry really sends.
  let dead = true, calls = 0;
  const s = await serve(online(async () => { calls++; if (dead) throw notSent(); return 'WA9'; }));
  assert.equal((await s.send(msg)).status, 503);
  assert.equal(s.ledger.get(msg.idempotencyKey), undefined, 'not marked unknown');
  dead = false; assert.equal((await s.send(msg)).status, 200); assert.equal(calls, 2);
  s.close();

  // Pitch alerts from the outbox: no ack, nothing marked unknown; sent on the next poll.
  const ledger = createLedger(join(mkdtempSync(join(tmpdir(), 'pdc-')), 'sent.json'));
  const acks = [];
  const fetcher = async (url, init) => url.endsWith('/bridge/outbox')
    ? Response.json({ messages: [{ key: 'trello:b:c9', to: '+15550000002', text: 'duplicate found' }] })
    : (acks.push(JSON.parse(init.body)), Response.json({ ok: true }));
  let alive = false;
  const wa = online(async () => { if (!alive) throw notSent(); return 'WA10'; });
  const p = createOutboxPoller({ options: { ...options, workerUrl: 'https://w.example' }, ledger, wa, fetcher, sleep: async () => {} });
  await p.poll();
  assert.deepEqual(acks, []); assert.equal(ledger.get('trello:b:c9'), undefined);
  alive = true; await p.poll();
  assert.deepEqual(acks, [{ key: 'trello:b:c9', status: 'sent', id: 'WA10' }]);
});

test('alerts go to the chosen group, and to the number (saying why) once the sender has left it', async () => {
  const group = '120363012345678901@g.us', sent = [], events = [];
  let groups = [{ id: group, name: 'Pitch alerts', size: 3 }];
  const wa = { status: () => ({ connected: true, accountOk: true }), groups: async () => groups, send: async (jid, text) => { sent.push([jid, text]); return 'WA' + sent.length; } };
  const opts = { ...options, alertGroup: group };
  assert.deepEqual(await alertTarget(options, wa)('hi'), { jid: '15550000002@s.whatsapp.net', to: '15550000002', text: 'hi' });
  assert.deepEqual(await alertTarget(opts, wa)('hi'), { jid: group, to: group, text: 'hi' });
  const dir = mkdtempSync(join(tmpdir(), 'pdc-')), ledger = createLedger(join(dir, 'sent.json'));
  let queue = [{ key: 'pitch:aotf:p1', to: '+15550000002', text: 'Duplicate pitch found' }];
  const api = async path => (path === '/bridge/outbox' ? Response.json({ messages: queue.splice(0) }) : Response.json({ ok: true }));
  const poller = createOutboxPoller({ options: opts, ledger, wa, api, events: { add: (t, d) => events.push(t) }, sleep: async () => {} });
  await poller.poll();
  assert.deepEqual(sent[0], [group, 'Duplicate pitch found']); assert.equal(ledger.get('pitch:aotf:p1').to, group);
  groups = []; queue = [{ key: 'pitch:os:2', to: '+15550000002', text: 'Similar story found' }];
  await poller.poll();
  assert.equal(sent[1][0], '15550000002@s.whatsapp.net'); assert.match(sent[1][1], /^Similar story found\n\n_\(This was meant for the WhatsApp group/);
  assert.deepEqual(events, ['group_missing']);
  // Offline (groups unknown): it keeps aiming at the group; the send itself waits for the reconnect.
  assert.equal((await alertTarget(opts, { groups: async () => { throw new Error('not connected'); } })('x')).jid, group);
});
