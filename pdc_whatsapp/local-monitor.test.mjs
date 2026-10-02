import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openD1, createLocalMonitor, guardedFetch } from './local-monitor.mjs';
import { createOutboxPoller, createLedger } from './bridge.mjs';
import { runTrelloMonitor, withMonitorSettings } from './monitor/trello-monitor.mjs';
import { handleBridgeApi } from './monitor/bridge-api.mjs';

const board = 'a'.repeat(24), lists = ['1'.repeat(24)], token = 't'.repeat(40);
const card = (n, name = 'Example pitch') => ({ id: n.toString(16).padStart(24, '0'), name, idList: lists[0], shortUrl: `https://trello.com/c/${n}`, closed: false });
const engine = {
  normalize: c => (c.name.trim().length < 3 ? null : { title: c.name, keywords: [], normalizedUrl: '', editLink: c.shortUrl }),
  shortlist: () => [], parse: JSON.parse, prompt: () => '', call: async () => '{}',
};

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-monitor-'));
  let cards = [card(1)], hang = false;
  const load = async () => (hang ? new Promise(() => {}) : { cards, watched: lists });
  const worker = { DB: openD1(':memory:'), TRELLO_MONITOR_BOARD_ID: board, TRELLO_MONITOR_ENABLED: 'true', TRELLO_MONITOR_SEND: 'true',
    TRELLO_KEY: 'trello-key', TRELLO_TOKEN: 'trello-token', MIMO_KEYS: 'mimo', BAILEYS_TOKEN: token, BAILEYS_RECIPIENT: '+15551234567' };
  const fetcher = (url, init) => handleBridgeApi(new Request(url, { method: init.method, body: init.body, headers: init.headers }), worker);
  const events = [];
  const options = { token, recipient: '15551234567', workerUrl: 'https://worker.example' };
  const monitor = createLocalMonitor({ options, events: { add: (type, detail) => events.push({ type, detail }) }, fetcher, engine,
    dependencies: { load }, file: join(dir, 'monitor.db'), configFile: join(dir, 'monitor.json'), watchFile: join(dir, 'watch.json'), ...extra });
  const sent = [];
  const wa = { status: () => ({ connected: true, accountOk: true }), send: async (_jid, text) => { sent.push(text); return `WA${sent.length}`; } };
  const poller = createOutboxPoller({ options, ledger: createLedger(join(dir, 'sent.json')), wa, api: monitor.api, spacingMs: 0, sleep: async () => {} });
  return { dir, worker, monitor, poller, sent, events, load, setCards: c => { cards = c; }, setHang: h => { hang = h; } };
}

test('the monitor moves from the Worker once, keeps its history and alerts from the Pi', async () => {
  const s = setup();
  await runTrelloMonitor(s.worker, engine, { load: s.load }); // Worker baseline
  // An alert the Worker queued but the bridge hadn't collected yet.
  await s.worker.DB.prepare("INSERT INTO trello_monitor_wa_outbox(key,recipient,text,status,created,updated) VALUES ('trello:x:queued','+15551234567','Queued on the Worker','queued',1,1)").bind().run();
  // A Worker check still running: the move waits.
  await s.worker.DB.prepare("UPDATE trello_monitor_state SET owner='tick',lease_until=?").bind(Math.floor(Date.now() / 1000) + 60).run();
  await s.monitor.tick();
  assert.equal(s.monitor.active(), false);
  await s.worker.DB.prepare('UPDATE trello_monitor_state SET owner=NULL,lease_until=0').bind().run();

  await s.monitor.tick();
  assert.equal(s.monitor.active(), true);
  const saved = JSON.parse(readFileSync(join(s.dir, 'monitor.json'), 'utf8'));
  assert.equal(saved.confirmed, true); assert.equal(saved.secrets.TRELLO_TOKEN, 'trello-token');
  if (process.platform !== 'win32') assert.equal(statSync(join(s.dir, 'monitor.json')).mode & 0o777, 0o600);
  assert.equal((await s.monitor.api('/bridge/dashboard').then(r => r.json())).total, 1, 'history carried over');
  // The Worker is off for good and won't hand the keys out again.
  assert.deepEqual(await runTrelloMonitor(await withMonitorSettings(s.worker), engine, { load: s.load }), { disabled: true });
  const again = await handleBridgeApi(new Request('https://w/bridge/handover', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), s.worker);
  assert.equal(again.status, 410);

  // A duplicate pitch appears: checked on the Pi and sent in the same run.
  s.setCards([card(1), card(2)]);
  await s.monitor.tick();
  await s.poller.poll();
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0], 'Queued on the Worker');
  assert.match(s.sent[1], /Duplicate pitch found/);
  assert.ok(s.events.some(e => e.type === 'monitor_moved'));
  // The next run records the delivery and does not send again.
  await s.monitor.tick(); await s.poller.poll();
  assert.equal(s.sent.length, 2);
  const job = (await s.monitor.api('/bridge/dashboard').then(r => r.json())).jobs.find(j => j.id === card(2).id);
  assert.equal(job.send, 'accepted');
  s.monitor.stop();
});

test('settings saved on the dashboard apply to the Pi monitor', async () => {
  const s = setup();
  await runTrelloMonitor(s.worker, engine, { load: s.load });
  await s.monitor.tick();
  const res = await s.monitor.api('/bridge/settings', { method: 'POST', body: JSON.stringify({ settings: { sending: false } }) });
  assert.equal(res.status, 200);
  s.setCards([card(1), card(2)]);
  await s.monitor.tick(); await s.poller.poll();
  assert.equal(s.sent.length, 0);
  const job = (await s.monitor.api('/bridge/dashboard').then(r => r.json())).jobs.find(j => j.id === card(2).id);
  assert.equal(job.send, 'dry_run');
  s.monitor.stop();
});

test('a hung scan is abandoned, a second one restarts the add-on, and the watchdog alerts from outside the scan', async () => {
  let t = Date.now();
  const alerts = [], stuck = [];
  const settle = () => new Promise(r => setImmediate(r));
  const s = setup({ clock: () => t, onAlert: async (text, recovered) => { alerts.push({ text, recovered }); return true; }, onStuck: m => stuck.push(m) });
  await runTrelloMonitor(s.worker, engine, { load: s.load });
  await s.monitor.tick();
  assert.equal(s.monitor.active(), true);

  s.setHang(true);
  s.monitor.tick(); await settle(); // never finishes, like the Trello read on 2026-10-02
  t += 60000; await s.monitor.tick();
  assert.equal(s.events.filter(e => e.type === 'monitor_stuck').length, 0, 'a slow scan is left alone');
  t += 4 * 60000; s.monitor.tick(); await settle();
  assert.match(s.events.find(e => e.type === 'monitor_stuck').detail, /stuck for 5 min/);
  assert.equal(stuck.length, 0, 'the first hang only abandons the run');
  assert.equal(s.monitor.health().running !== null, true, 'the next scan started');

  t += 6 * 60000; await s.monitor.watch();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /stopped scanning/);
  assert.match(alerts[0].text, /Reason: A scan got stuck/);
  await s.monitor.watch();
  assert.equal(alerts.length, 1, 'one alert, not one a minute');

  t += 4 * 60000; await s.monitor.tick();
  assert.equal(stuck.length, 1, 'a second hang in a row restarts the add-on');

  s.setHang(false); t = Date.now();
  await s.monitor.tick();
  assert.equal(s.monitor.health().problem, null);
  await s.monitor.watch();
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].recovered, true);
  assert.match(alerts[1].text, /working again/);
  s.monitor.stop();
});

test('the stalled-scan alert survives WhatsApp being offline', async () => {
  let t = Date.now(), online = false;
  const alerts = [];
  const s = setup({ clock: () => t, onAlert: async text => { if (online) alerts.push(text); return online; } });
  await runTrelloMonitor(s.worker, engine, { load: s.load });
  await s.monitor.tick();
  s.setHang(true); s.monitor.tick();
  t += 11 * 60000;
  await s.monitor.watch();
  online = true; await s.monitor.watch();
  assert.equal(alerts.length, 1, 'retried once WhatsApp is back');
  assert.match(alerts[0], /A scan has been running for 11 min/);
  s.monitor.stop();
});

test('an outside call that never finishes its reply is cut off', async () => {
  const inFlight = new Set();
  const never = async () => ({ status: 200, statusText: 'OK', headers: new Headers(), arrayBuffer: () => new Promise(() => {}) });
  await assert.rejects(guardedFetch(never, inFlight, 50)('https://api.trello.com/1/boards'),
    e => e.name === 'TimeoutError' && /Trello did not answer within/.test(e.message));
  assert.equal(inFlight.size, 0);
  const ok = guardedFetch(async () => new Response('{"a":1}', { status: 200 }), inFlight, 1000);
  assert.deepEqual(await (await ok('https://example.test/')).json(), { a: 1 });
});
