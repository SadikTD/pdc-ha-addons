import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openD1, createLocalMonitor } from './local-monitor.mjs';
import { createOutboxPoller, createLedger } from './bridge.mjs';
import { runTrelloMonitor, withMonitorSettings } from './monitor/trello-monitor.mjs';
import { handleBridgeApi } from './monitor/bridge-api.mjs';

const board = 'a'.repeat(24), lists = ['1'.repeat(24)], token = 't'.repeat(40);
const card = (n, name = 'Example pitch') => ({ id: n.toString(16).padStart(24, '0'), name, idList: lists[0], shortUrl: `https://trello.com/c/${n}`, closed: false });
const engine = {
  normalize: c => (c.name.trim().length < 3 ? null : { title: c.name, keywords: [], normalizedUrl: '', editLink: c.shortUrl }),
  shortlist: () => [], parse: JSON.parse, prompt: () => '', call: async () => '{}',
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pdc-monitor-'));
  let cards = [card(1)];
  const load = async () => ({ cards, watched: lists });
  const worker = { DB: openD1(':memory:'), TRELLO_MONITOR_BOARD_ID: board, TRELLO_MONITOR_ENABLED: 'true', TRELLO_MONITOR_SEND: 'true',
    TRELLO_KEY: 'trello-key', TRELLO_TOKEN: 'trello-token', MIMO_KEYS: 'mimo', BAILEYS_TOKEN: token, BAILEYS_RECIPIENT: '+15551234567' };
  const fetcher = (url, init) => handleBridgeApi(new Request(url, { method: init.method, body: init.body, headers: init.headers }), worker);
  const events = [];
  const options = { token, recipient: '15551234567', workerUrl: 'https://worker.example' };
  const monitor = createLocalMonitor({ options, events: { add: (type, detail) => events.push({ type, detail }) }, fetcher, engine,
    dependencies: { load }, file: join(dir, 'monitor.db'), configFile: join(dir, 'monitor.json') });
  const sent = [];
  const wa = { status: () => ({ connected: true, accountOk: true }), send: async (_jid, text) => { sent.push(text); return `WA${sent.length}`; } };
  const poller = createOutboxPoller({ options, ledger: createLedger(join(dir, 'sent.json')), wa, api: monitor.api, spacingMs: 0, sleep: async () => {} });
  return { dir, worker, monitor, poller, sent, events, load, setCards: c => { cards = c; } };
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
