// End to end with a fake board, WordPress, AI and bridge: a pitch with no sources gets the
// 3-minute alert, gets checked once sources appear, and a published article is checked
// and alerted once, with the AI's made-up evidence thrown away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, createSettings } from '../src/store.mjs';
import { createRules } from '../src/rules.mjs';
import { createMonitor } from '../src/monitor.mjs';
import { createBridge } from '../src/alerts.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/wegotthiscovered.com.json', import.meta.url), 'utf8'))[0];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'edmon-'));
  let now = Date.parse('2026-11-23T12:00:00Z');
  const clock = () => now;
  const db = openDb(dir), settings = createSettings(dir), rules = createRules(dir);
  settings.save({ boardUrl: 'https://board.test', boardToken: 'tok', geminiKey: 'g', bridgeUrl: 'http://bridge.test', bridgeToken: 'b'.repeat(32), whatsappTo: '+8801700000000',
    sites: { tms: { enabled: false }, os: { enabled: false }, aotf: { enabled: false } } });
  const card = { id: '42', title: 'A man says his neighbor stole his packages', col: 'pitched', colLabel: 'Pitched', stage: 'pitch', status: 'pitch_card',
    created: new Date(now).toISOString(), writer: 'Ann', sources: [], url: 'https://board.test/b/wgtc/c/42', description: '', editUrl: '', publishUrl: '' };
  const sent = [], aiPrompts = [];
  let live = false;
  const fetcher = async (u, init = {}) => {
    const url = String(u);
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://board.test/api/feed/pitches')) return json({ site: 'wgtc', pitches: [card] });
    if (url.startsWith('http://bridge.test/send')) { sent.push(JSON.parse(init.body)); return json({ ok: true }); }
    if (url.includes('generativelanguage.googleapis.com')) {
      aiPrompts.push(JSON.parse(init.body).contents[0].parts[0].text);
      const findings = [{ rule: 'value.tone', severity: 'check', evidence: 'words that are not in the article at all', note: 'made up' },
        { rule: 'not.a.rule', severity: 'problem', evidence: 'x', note: 'x' }];
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ findings }) }] } }] });
    }
    if (url.startsWith('https://wegotthiscovered.com/wp-json/wp/v2/posts/1970974')) return live ? json({ ...fixture, status: 'publish', date_gmt: '2026-11-23T13:00:00' }) : json({ code: 'rest_forbidden' }, 401);
    if (url.startsWith('https://wegotthiscovered.com/wp-json/wp/v2/tags')) return json([]);
    return new Response('nope', { status: 404 });
  };
  const bridge = createBridge({ settings, fetcher });
  const monitor = createMonitor({ db, settings, rules, bridge, fetcher, web: fetcher, clock });
  return { db, monitor, card, sent, aiPrompts, advance: ms => { now += ms; }, goLive: () => { live = true; } };
}

test('pitch: 3-minute no-sources alert, then checked when sources appear', async () => {
  const t = setup();
  await t.monitor.tick();
  assert.equal(t.db.prepare(`SELECT status FROM checks WHERE kind = 'pitch'`).get().status, 'waiting_sources');
  assert.equal(t.sent.length, 0);
  t.advance(3 * 60000 + 1000);
  await t.monitor.tick();
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /No sources after 3 minutes/);
  await t.monitor.tick();
  assert.equal(t.sent.length, 1, 'the no-sources alert is sent once');

  t.card.sources = ['https://www.tiktok.com/@someone/video/7400000000000000000'];
  t.card.description = 'He says the neighbor took three boxes. Posted Nov 22';
  await t.monitor.tick();
  const c = t.db.prepare(`SELECT * FROM checks WHERE kind = 'pitch'`).get();
  assert.equal(c.status, 'done');
  const findings = JSON.parse(c.findings);
  // That TikTok id is from mid-2024: far older than a week.
  assert.ok(findings.some(f => f.rule === 'pitch.fresh' && f.severity === 'problem'));
  assert.ok(!findings.some(f => f.by === 'ai'), 'AI findings with made-up evidence or unknown rules are dropped');
  assert.match(t.aiPrompts[0], /Every pitch must hit at least one of the three Cs/, 'the guide goes to the AI word for word');
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[1].text, /Pitch needs a look/);
  assert.match(t.sent[1].text, /Fresh enough/);
});

test('article: waits while scheduled, then checks once it is live and alerts once', async () => {
  const t = setup();
  t.card.sources = ['https://truthsocial.com/@realDonaldTrump/posts/117661238591305263'];
  t.card.description = 'Trump blames Democrats. Posted Nov 22';
  t.card.col = 'scheduled'; t.card.stage = 'publish';
  t.card.editUrl = 'https://wegotthiscovered.com/wp-admin/post.php?post=1970974&action=edit';
  await t.monitor.tick();
  assert.equal(t.db.prepare(`SELECT status FROM checks WHERE kind = 'article'`).get().status, 'waiting_publish');
  t.goLive();
  t.advance(5 * 60000 + 1000);
  await t.monitor.tick();
  const a = t.db.prepare(`SELECT * FROM checks WHERE kind = 'article'`).get();
  assert.equal(a.status, 'done');
  const rules = JSON.parse(a.findings).map(f => f.rule);
  for (const r of ['format.words', 'links.anchor-length']) assert.ok(rules.includes(r), r);
  assert.ok(!rules.includes('embed.present'));
  const articleMsgs = t.sent.filter(m => /Published article needs a look/.test(m.text));
  assert.equal(articleMsgs.length, 1);
  assert.match(articleMsgs[0].text, /Article: https:\/\/wegotthiscovered.com\/politics\//);
  t.monitor.recheck(a.id);
  await t.monitor.tick();
  assert.equal(t.sent.filter(m => /Published article needs a look/.test(m.text)).length, 1, 'same findings never send twice');
});
