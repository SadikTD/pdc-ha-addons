import test from 'node:test';
import assert from 'node:assert/strict';
import { slackAlert, slackText } from './slack-layout.mjs';
import { AOTF_SITE } from './monitor/pitch-sources.mjs';

const job = (verdict, extra = []) => ({
  card_json: JSON.stringify({ name: 'Mother & baby <found> below balcony', _writer: 'Kelsey', _listName: 'Approved', _created: '2026-10-09T14:49:00Z', shortUrl: 'https://docs.google.com/x?a=1|2' }),
  result_json: JSON.stringify([{ verdict, confidence: 92, reason: 'Same event.', candidate: { title: 'Witness heard a plea', writer: 'Abdul', status: 'Submitted', date: '2026-10-06T03:12:00Z', editLink: 'https://docs.google.com/y' } }, ...extra]),
});

test('duplicate alert: coloured bar by verdict, both pitches as links, buttons, escaped text', () => {
  const m = slackAlert(job('duplicate', [{ verdict: 'possible', confidence: 50, candidate: { title: 'Other' } }]), () => true, AOTF_SITE);
  assert.equal(m.text, '*🚨 Duplicate pitch · AotF (Google Sheet)*  ·  92% match');
  const [a] = m.attachments;
  assert.equal(a.color, '#E01E5A');
  const text = JSON.stringify(a.blocks);
  assert.match(a.blocks[0].text.text, /^\*🆕 New pitch\*\n<https:\/\/docs\.google\.com\/x\?a=1%7C2\|Mother &amp; baby &lt;found&gt; below balcony>\nKelsey · Approved · <!date\^1791557340\^\{date_short_pretty\} at \{time\}\|9 Oct, 8:49 PM BDT>$/);
  assert.match(a.blocks[1].text.text, /<https:\/\/docs\.google\.com\/y\|Witness heard a plea>/);
  assert.deepEqual(a.blocks.find(b => b.type === 'actions').elements.map(e => [e.text.text, e.url, e.style]),
    [['Open new pitch', 'https://docs.google.com/x?a=1|2', 'primary'], ['Open earlier pitch', 'https://docs.google.com/y', undefined]]);
  assert.doesNotMatch(text, /more possible match/);
  assert.equal(slackAlert(job('same_story'), () => true, AOTF_SITE).attachments[0].color, '#ECB22E');
});

test('a pitch without links gets plain titles and no buttons', () => {
  const j = job('possible'); const card = JSON.parse(j.card_json); delete card.shortUrl; j.card_json = JSON.stringify(card);
  const r = JSON.parse(j.result_json); delete r[0].candidate.editLink; j.result_json = JSON.stringify(r);
  const { attachments: [a] } = slackAlert(j, () => true, AOTF_SITE);
  assert.equal(a.color, '#36C5F0'); assert.equal(a.blocks.some(b => b.type === 'actions'), false);
  assert.match(a.blocks[0].text.text, /\nMother &amp; baby &lt;found&gt; below balcony\n/);
  // A sheet row that only knows its day keeps the day, with no timezone tag.
  const day = job('possible'), c = JSON.parse(day.card_json); c._createdLabel = '9 Oct 2026'; day.card_json = JSON.stringify(c);
  assert.match(slackAlert(day, () => true, AOTF_SITE).attachments[0].blocks[0].text.text, /Kelsey · Approved · 9 Oct$/);
});

test('other messages: headline above a green or yellow bar', () => {
  assert.deepEqual(slackText('✅ *Pitch monitor recovered · OS*\n\nScans <work> again.'),
    { text: '✅ *Pitch monitor recovered · OS*', attachments: [{ color: '#2EB67D', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Scans &lt;work&gt; again.' } }] }] });
  assert.equal(slackText('⚠️ *Problem*\nx').attachments[0].color, '#ECB22E');
  assert.deepEqual(slackText('one line'), { text: 'one line' });
});

test('a pitch on the Kanban board names the board, not the site platform', () => {
  const j = job('duplicate'); j.card_json = JSON.stringify({ ...JSON.parse(j.card_json), id: 'kb13' });
  assert.equal(slackAlert(j, () => true, AOTF_SITE).text, '*🚨 Duplicate pitch · AotF (Kanban Board)*  ·  92% match');
});
