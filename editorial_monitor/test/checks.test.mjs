import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RULES } from '../src/catalog.mjs';
import { headlineChecks, pitchChecks, articleChecks, postedFromUrl, metaLooksTyped, mediaId } from '../src/checks.mjs';
import { sentences, caseStyle, badCensoring, curseWords, articleBlocks, links } from '../src/text.mjs';
import { normalize } from '../src/wp.mjs';
import { SITES } from '../src/sites.mjs';
import { vetFindings } from '../src/ai.mjs';

const rules = id => headlineChecks(id).map(f => f.rule);
const guide = k => readFileSync(new URL(`../rules/${k}.txt`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

test('every rule quotes its guide word for word', () => {
  for (const [id, r] of Object.entries(RULES)) assert.ok(guide(r.guide).includes(r.quote.replace(/\s+/g, ' ')), id);
});

test('headline rules', () => {
  assert.deepEqual(rules('A man says his neighbor stole his packages'), []);
  assert.ok(rules('Internet Reacts To Viral Video Of The Year').includes('headline.case'));
  assert.ok(rules('A well-known chef walks out').includes('headline.dashes'));
  assert.ok(rules('He called it "pure evil"').includes('headline.quotes'));
  assert.ok(rules('Trump speaks: Biden answers').includes('headline.colon'));
  assert.ok(!rules('Trump blames Democrats: ‘It will only get worse’').includes('headline.colon'), 'a colon before a quote is fine');
  assert.ok(rules('Police find cocaine in the car').includes('headline.bad-words'));
  assert.ok(rules('A man is accused of rape in Ohio').includes('headline.sa'));
  assert.ok(rules('x'.repeat(150)).includes('headline.length'));
});

test('sentences and case', () => {
  assert.equal(sentences('Mr. Smith went to Washington. He said, “It is fine.” Then he left.').length, 3);
  assert.equal(sentences('The U.S. Army said so on Friday at 3 p.m. and left.').length, 1);
  assert.equal(caseStyle('Donald Trump Meets Vladimir Putin In Alaska'), 'title');
  assert.equal(caseStyle('Donald Trump meets Vladimir Putin in Alaska'), 'ok');
});

test('curse words and censoring', () => {
  assert.deepEqual(curseWords('what the fuck'), ['fuck']);
  assert.deepEqual(curseWords('Moby-Dick and Dick Cheney'), []);
  assert.deepEqual(badCensoring('he said f*** and **** and f***ing'), []);
  assert.deepEqual(badCensoring('the f-word, fck and s–k'), ['f-word', 'fck', 's–k']);
});

test('post dates from TikTok and X ids', () => {
  assert.equal(new Date(postedFromUrl('https://www.tiktok.com/@a/video/7709562051269610766')).toISOString().slice(0, 10), '2026-11-18');
  assert.equal(new Date(postedFromUrl('https://x.com/a/status/1859000000000000000')).getUTCFullYear(), 2024);
  assert.equal(mediaId('https://www.tiktok.com/player/v1/7709562051269610766?x=1'), '7709562051269610766');
});

test('pitch: post date and freshness', () => {
  const created = '2026-11-23T12:00:00Z';
  const old = pitchChecks({ title: 'A man says his neighbor stole his packages', description: 'TikTok of a neighbor', sources: ['https://www.tiktok.com/@a/video/7400000000000000000'], created });
  assert.ok(old.some(f => f.rule === 'pitch.post-date'));
  assert.ok(old.some(f => f.rule === 'pitch.fresh'));
  const ok = pitchChecks({ title: 'A man says his neighbor stole his packages', description: 'Posted Nov 22', sources: ['https://www.tiktok.com/@a/video/7709562051269610766'], created });
  assert.deepEqual(ok.map(f => f.rule), []);
  const before = pitchChecks({ title: 'A man says his neighbor stole his packages', description: null, descriptionKnown: false, sources: ['https://www.tiktok.com/@a/video/7709562051269610766'], created });
  assert.deepEqual(before.map(f => f.rule), [], 'without the description field (older board), description rules are skipped');
});

test('real articles: shape, interlinks, image, SEO', () => {
  const wgtc = SITES.find(s => s.id === 'wgtc'), tms = SITES.find(s => s.id === 'tms'), os = SITES.find(s => s.id === 'os');
  const read = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}.json`, import.meta.url), 'utf8')).map(normalize);
  const [stock] = read('wegotthiscovered.com');
  const r1 = articleChecks(stock, { site: wgtc }).findings.map(f => f.rule);
  for (const r of ['format.words', 'links.anchor-length']) assert.ok(r1.includes(r), r);
  assert.ok(!r1.includes('format.shape'), 'no embed is fine: p p p h2 p is the whole shape');
  assert.ok(!r1.includes('image.present'));

  const mamdani = read('www.themarysue.com').find(p => /84,000/.test(p.title));
  const r2 = articleChecks(mamdani, { site: tms }).findings;
  assert.ok(r2.some(f => f.rule === 'seo.title'), 'Yoast default SEO title means it was not filled in');
  assert.ok(r2.some(f => f.rule === 'image.title' && /date/.test(f.note)));

  const car = read('www.operationsports.com')[0];
  const r3 = articleChecks(car, { site: os }).findings;
  assert.ok(!r3.some(f => f.rule === 'links.repeat'), 'empty leftover <a> tags are not links');
  assert.ok(!r3.some(f => f.rule === 'category.primary'), 'OS files under Curveball');

  const noImage = { ...stock, image: null };
  assert.ok(articleChecks(noImage, { site: wgtc }).findings.some(f => f.rule === 'image.present' && f.severity === 'problem'));
});

test('meta description: Yoast fallback vs typed', () => {
  assert.equal(metaLooksTyped({ metaDescription: 'They tried to return it after a month', excerpt: '<p>They tried to return it after a month</p>', content: '<p>Other</p>' }), false);
  assert.equal(metaLooksTyped({ metaDescription: 'Stories of sperm whales headbutting', excerpt: '', content: '<p>Stories of sperm whales headbutting have existed.</p>' }), false);
  assert.equal(metaLooksTyped({ metaDescription: 'Read this shocking story now', excerpt: '<p>A man said</p>', content: '<p>A man said hello.</p>' }), true);
});

test('blocks: embeds, bare links and links', () => {
  const b = articleBlocks('<p>One <a href="https://a.test">A</a><a href="https://a.test"></a>.</p><h2>Two</h2><p>https://www.facebook.com/x/posts/1</p><figure class="wp-block-embed is-provider-tiktok"><div class="wp-block-embed__wrapper">https://www.tiktok.com/@a/video/1234567890123456789</div></figure>');
  assert.deepEqual(b.map(x => x.type), ['p', 'h2', 'bare-link', 'embed']);
  assert.equal(b[3].provider, 'tiktok');
  assert.equal(links(b[0].html).length, 1);
});

test('AI findings must use known rules and quote real material', () => {
  const kept = vetFindings({ findings: [
    { rule: 'value.tone', severity: 'problem', evidence: 'with her conscience muted', note: 'Sarcasm.' },
    { rule: 'value.tone', severity: 'problem', evidence: 'not in the text', note: 'x' },
    { rule: 'format.words', severity: 'problem', evidence: 'with her', note: 'code rule' },
    { rule: 'image.banned', severity: 'problem', evidence: 'a handgun is visible', note: 'NewsBreak bans guns.' },
  ] }, 'article', 'She left, with her conscience muted, and went home.');
  assert.deepEqual(kept.map(k => k.rule), ['value.tone', 'image.banned']);
});

test('AI keys: a rate-limited key rests and the next one answers', async () => {
  const { callModel } = await import('../src/ai.mjs');
  const seen = [];
  const fetcher = async (url, init) => {
    const key = init.headers['x-goog-api-key'] || init.headers['api-key'];
    seen.push(key);
    if (key === 'g1') return new Response('{}', { status: 429 });
    const text = JSON.stringify({ findings: [] });
    return new Response(JSON.stringify(key.startsWith('g') ? { candidates: [{ content: { parts: [{ text }] } }] } : { choices: [{ message: { content: text } }] }), { status: 200 });
  };
  const s = { geminiKeys: ['g1', 'g2'], mimoKeys: ['m1'] };
  const r = await callModel(s, { prompt: 'x' }, fetcher, () => 1000);
  assert.equal(r.key, 'Gemini key 2');
  assert.deepEqual(seen, ['g1', 'g2']);
  seen.length = 0;
  await callModel(s, { prompt: 'x' }, fetcher, () => 2000);
  assert.deepEqual(seen, ['g2'], 'the rate-limited key rests');
  seen.length = 0;
  await callModel({ geminiKeys: ['g1'], mimoKeys: ['m1'] }, { prompt: 'x' }, fetcher, () => 3000);
  assert.deepEqual(seen, ['m1'], 'MiMo answers when every Gemini key rests');
});

test('AI double-check keeps only the notes it confirms', async () => {
  const { applyVerdicts } = await import('../src/ai.mjs');
  const fs = [{ rule: 'embed.instagram', severity: 'problem', evidence: 'a', note: 'x' }, { rule: 'value.tone', severity: 'problem', evidence: 'b', note: 'y' }];
  assert.deepEqual(applyVerdicts(fs, { notes: [{ i: 0, keep: false }, { i: 1, keep: true, severity: 'check' }] }).map(f => [f.rule, f.severity]), [['value.tone', 'check']]);
});

test('settings: key lists keep, drop and add keys, and older single keys move into the list', async () => {
  const { createSettings, validateSettings } = await import('../src/store.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/em-set-`);
  writeFileSync(`${dir}/settings.json`, JSON.stringify({ geminiKey: 'old1' }));
  const st = createSettings(dir);
  assert.deepEqual(st.get().geminiKeys, ['old1']);
  const { clean, errors } = validateSettings({ geminiKeys: { keep: [0], add: ['new2', 'new3'] } });
  assert.deepEqual(errors, {});
  st.save(clean);
  assert.deepEqual(st.get().geminiKeys, ['old1', 'new2', 'new3']);
  st.save(validateSettings({ geminiKeys: { keep: [2], add: [] } }).clean);
  assert.deepEqual(st.get().geminiKeys, ['new3']);
  assert.deepEqual(st.public().geminiKeys.map(k => k.ends), ['new3'.slice(-4)]);
});

test('finding a post by its headline', async () => {
  const { sameTitle } = await import('../src/wp.mjs');
  assert.ok(sameTitle('A man&#8217;s dog &#8216;saved&#8217; him', "A man's dog 'saved' him"));
  assert.ok(sameTitle('Woman arrives at UAE restaurant for birthday dinner. Once inside, staff ask her to leave because of her outfit', 'Woman arrives at UAE restaurant for birthday dinner. Once inside, staff asks her to leave because of her outfit'));
  assert.ok(!sameTitle('Trump fires Howard Lutnick', 'Trump reportedly wanted to fire Howard Lutnick over his Epstein ties'));
});

test("editor's rulings (2026-11-23): number hyphens fine, 7-day sources, interlink plus source link fine", async () => {
  const dash = t => headlineChecks(t).filter(f => f.rule === 'headline.dashes').map(f => f.severity);
  assert.deepEqual(dash('A 31-year-old and her 2-year-old son'), []);
  assert.deepEqual(dash('A nine-month-old found safe'), []);
  assert.deepEqual(dash('He moved to escape his mother-in-law'), ['check']);
  assert.deepEqual(dash('A shark appears — then chaos'), ['problem']);
  const created = '2026-11-23T12:00:00Z';
  const fresh = s => pitchChecks({ title: 'A man says his neighbor stole his packages', description: 'Posted Nov 20', sources: [s], created, sourceInfo: [{ url: s, postedAt: s.includes('old') ? '2026-11-14T12:00:00Z' : '2026-11-19T12:00:00Z' }] }).some(f => f.rule === 'pitch.fresh');
  assert.equal(fresh('https://news.test/four-days'), false, 'a 4-day-old news source is fine');
  assert.equal(fresh('https://news.test/old'), true, 'a 9-day-old source is not');
  const site = SITES.find(s => s.id === 'wgtc');
  const post = { title: 'A man says his neighbor stole his packages', content: '<p>One sentence here. <a href="https://wegotthiscovered.com/news/a-b/">a man stole packages</a> and <a href="https://source.test/x">Source</a> said so.</p>', image: null, tags: [], categories: ['News'], seoTitle: 'x' };
  assert.ok(!articleChecks(post, { site }).findings.some(f => f.rule === 'links.same-paragraph'));
  const two = { ...post, content: '<p>Two here. <a href="https://wegotthiscovered.com/news/a/">a man stole packages</a> and <a href="https://wegotthiscovered.com/news/b/">a woman found them later</a>.</p>' };
  assert.ok(articleChecks(two, { site }).findings.some(f => f.rule === 'links.same-paragraph' && f.severity === 'problem'));
});
