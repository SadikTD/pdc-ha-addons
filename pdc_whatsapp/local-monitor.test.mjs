import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openD1, createLocalMonitor, guardedFetch, retryReads, SITES } from './local-monitor.mjs';
import { createOutboxPoller, createLedger } from './bridge.mjs';
import { runTrelloMonitor, withMonitorSettings, TRELLO_SITE } from './monitor/trello-monitor.mjs';
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
    file: join(dir, 'monitor.db'), configFile: join(dir, 'monitor.json'), watchFile: join(dir, 'watch.json'),
    sites: [TRELLO_SITE], ...extra, dependencies: { load, ...extra.dependencies },
    limits: { fetch: async url => { throw new Error(`test tried the network: ${url}`); }, ...extra.limits } });
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
  assert.match(s.sent[1], /🚨 \*Duplicate\*/);
  assert.ok(!s.sent[1].includes('➕'), 'the {more} line is left out for a single match');
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

test('the sheet and Asana sites scan beside Trello, each on its own, and a stuck one alerts by name', async () => {
  let sheetHang = false;
  const alerts = [], settle = () => new Promise(r => setImmediate(r));
  const sheetRows = [{ id: 'p1', name: 'An AotF pitch', idList: 'pitches', closed: false, shortUrl: '', _site: 'AotF' }];
  const osTasks = [{ id: '11', name: 'An OS pitch', idList: 'open', closed: false, shortUrl: '', _site: 'OS' }];
  const loaders = {
    aotf: async () => (sheetHang ? new Promise(() => {}) : { cards: sheetRows, watched: ['pitches'] }),
    os: async () => ({ cards: osTasks, watched: ['open'] }),
  };
  // Real clock (scan times are stored in real seconds); "stale" after 1.5 s.
  const s = setup({ sites: SITES, limits: { stale: 1500 }, dependencies: { loaders }, onAlert: async (text, recovered, site) => { alerts.push({ text, recovered, site: site?.id }); return true; } });
  await runTrelloMonitor(s.worker, engine, { load: s.load });
  await s.monitor.tick();
  const dash = async () => s.monitor.api('/bridge/dashboard').then(r => r.json());
  let d = await dash();
  assert.deepEqual(d.sites.map(x => [x.id, x.state?.initialized ?? null]), [['wgtc', 1], ['aotf', 1], ['os', null]], 'OS waits for its token');
  assert.equal(d.sites.find(x => x.id === 'os').needs, 'Add your Asana access token in Settings to start');

  // A hung sheet read never holds up Trello.
  sheetHang = true; s.setCards([card(1), card(2)]);
  s.monitor.tick(); await settle(); await new Promise(r => setTimeout(r, 300));
  d = await dash();
  assert.equal(d.jobs.find(j => j.id === card(2).id)?.check, 'checked', 'Trello carried on');
  assert.notEqual(s.monitor.health().sites.aotf.running, null);
  await new Promise(r => setTimeout(r, 2000));
  await s.monitor.tick(); // Trello keeps scanning meanwhile
  await s.monitor.watch();
  assert.deepEqual(alerts.map(a => a.site), ['aotf'], 'only AotF is stale');
  assert.match(alerts[0].text, /stopped scanning · AotF/);
  assert.match(alerts[0].text, /AotF \(Google Sheet\)/);
  s.monitor.stop();
});

test('a read that times out, drops or gets a server error is tried once more; others are not', async () => {
  const calls = [], sleep = async () => {};
  const flaky = answers => async (url, init) => { calls.push(init); const a = answers.shift(); if (a instanceof Error) throw a; return new Response('{}', { status: a }); };
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal((await retryReads(flaky([timeout, 200]), { sleep })('https://api.trello.com/1/x', { method: 'GET', signal: AbortSignal.timeout(1) })).status, 200);
  assert.equal(calls[1].signal.aborted, false, 'the retry gets a fresh deadline');
  assert.equal((await retryReads(flaky([503, 200]), { sleep })('https://api.trello.com/1/x', {})).status, 200);
  assert.equal((await retryReads(flaky([new TypeError('fetch failed'), 429]), { sleep })('https://x', {})).status, 429, 'only one retry');
  calls.length = 0;
  assert.equal((await retryReads(flaky([401]), { sleep })('https://x', {})).status, 401); assert.equal(calls.length, 1, 'a refusal is final');
  await assert.rejects(retryReads(flaky([timeout]), { sleep })('https://ai', { method: 'POST' })); assert.equal(calls.length, 2, 'AI requests are never repeated');
});

test('one failed scan stays out of the Activity page; three in a row are reported, then the recovery', async () => {
  let fail = false;
  const s = setup();
  const failing = { load: async () => { if (fail) throw new Error('fetch failed'); return { cards: [card(1)], watched: lists }; } };
  const m = createLocalMonitor({ options: { token, recipient: '15551234567', workerUrl: 'https://worker.example' }, events: { add: (type, detail) => s.events.push({ type, detail }) },
    fetcher: (url, init) => handleBridgeApi(new Request(url, { method: init.method, body: init.body, headers: init.headers }), s.worker), engine, dependencies: failing,
    file: join(s.dir, 'm2.db'), configFile: join(s.dir, 'm2.json'), watchFile: join(s.dir, 'w2.json'), sites: [TRELLO_SITE], limits: { fetch: async () => { throw new Error('network'); } } });
  await runTrelloMonitor(s.worker, engine, { load: s.load });
  await m.tick();
  const errors = () => s.events.filter(e => e.type === 'monitor_error' || e.type === 'monitor_ok').map(e => e.type);
  fail = true; await m.tick(); await m.tick();
  assert.deepEqual(errors(), [], 'two blips are not news');
  fail = false; await m.tick(); fail = true; await m.tick(); await m.tick();
  assert.deepEqual(errors(), [], 'a success in between starts the count again');
  await m.tick();
  assert.deepEqual(errors(), ['monitor_error']);
  assert.match(s.events.find(e => e.type === 'monitor_error').detail, /^WGTC: Scan failed 3 times in a row: fetch failed/);
  await m.tick(); await m.tick();
  assert.deepEqual(errors(), ['monitor_error'], 'an outage is reported once, not every minute');
  fail = false; await m.tick();
  assert.deepEqual(errors(), ['monitor_error', 'monitor_ok']);
  m.stop(); s.monitor.stop();
});
