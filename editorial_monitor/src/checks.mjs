// Rule checks that code can measure exactly. Each finding is
// { rule, severity: 'problem' | 'check', evidence, note }; `rule` is a key of catalog RULES.
// 'problem' breaks a rule for sure; 'check' is likely wrong but needs a human eye.
import { articleBlocks, links, unquoted, sentences, caseStyle, curseWords, drugWords, saWords, badCensoring, findDates, hasPostDate,
  METRIC_RE, MONEY_NOT_USD, smallDigits, handles, hostOf, words, norm, clip, stripTags, SOCIAL, providerOf } from './text.mjs';

const f = (rule, severity, evidence, note = '') => ({ rule, severity, evidence: clip(String(evidence ?? ''), 400), note, by: 'code' });

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|a';
const NUMBER_COMPOUND = new RegExp(`^\\$?(\\d[\\d.,]*|(${NUMBER_WORDS})(-(${NUMBER_WORDS}))?)(-[a-z]+)+(’s|'s)?$`, 'i');

export function headlineChecks(title, { max = 150 } = {}) {
  const t = String(title || '').trim();
  const out = [];
  if (!t) return out;
  const style = caseStyle(t);
  if (style === 'title') out.push(f('headline.case', 'problem', t, 'Looks like title case.'));
  else if (style === 'maybe') out.push(f('headline.case', 'check', t, 'Most words are capitalized; fine only if they are all names.'));
  if (t.length >= max) out.push(f('headline.length', 'problem', t, `${t.length} characters.`));
  // Dashes (– —) break the rule. Hyphens in number words ("2-year-old", "31-year-old",
  // "nine-month-old", "5-foot") are allowed (the editor's ruling, 2026-11-23); any other
  // hyphenated word is left for a human to judge.
  const dashes = t.match(/\S*[–—]\S*/g) || [];
  const hyphens = (t.match(/[^\s–—]*\w-\w[^\s–—]*/g) || []).map(w => w.replace(/^[‘'"“(]+|[’'"”),.:;!?]+$/g, ''))
    .filter(w => !NUMBER_COMPOUND.test(w));
  if (dashes.length) out.push(f('headline.dashes', 'problem', dashes.join(', '), 'Dashes get cut off in partner feeds.'));
  if (hyphens.length) out.push(f('headline.dashes', 'check', hyphens.join(', '), 'Hyphenated words other than ages and numbers ("2-year-old" is fine).'));
  if (/["“”]/.test(t)) out.push(f('headline.quotes', 'problem', t, 'Uses double quotes.'));
  if (/:(?!\s*[‘'“"])/.test(t.replace(/\d:\d/g, ''))) out.push(f('headline.colon', 'check', t, 'Has a colon; fine only if it does not join two headlines.'));
  const curses = curseWords(t), drugs = drugWords(t), stars = /\*/.test(t) ? [t.match(/\S*\*\S*/)[0]] : [];
  if (curses.length || drugs.length || stars.length) out.push(f('headline.bad-words', 'problem', [...curses, ...drugs, ...stars].join(', ')));
  const sa = saWords(t).filter(w => !/^sexual/.test(w));
  if (sa.length) out.push(f('headline.sa', 'problem', sa.join(', '), 'Write SA instead.'));
  return out;
}

// TikTok and X post times are inside their IDs; others come from the source fetch.
export function postedFromUrl(url) {
  const u = String(url || '');
  const tt = /tiktok\.com\/.*\/(?:video|photo)\/(\d{15,22})/.exec(u);
  if (tt) return Number(BigInt(tt[1]) >> 32n) * 1000;
  const x = /(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d{15,22})/.exec(u);
  if (x) return Number((BigInt(x[1]) >> 22n) + 1288834974657n);
  return null;
}

const DAY = 86400000, SOURCE_MAX_AGE = 7 * DAY;
export function pitchChecks({ title, description, sources = [], created, sourceInfo = [], descriptionKnown = true }) {
  const out = headlineChecks(title);
  if (!sources.length) out.push(f('pitch.sources', 'problem', 'No source links on the card.'));
  if (descriptionKnown && !String(description || '').trim()) out.push(f('pitch.description', 'check', 'The card has no description.'));
  const social = sources.filter(s => SOCIAL.has(providerOf(s)));
  if (descriptionKnown && social.some(s => ['tiktok', 'x', 'reddit', 'youtube'].includes(providerOf(s))) && !hasPostDate(description)) {
    out.push(f('pitch.post-date', 'problem', 'No original post date written on the card.', `Source: ${social[0]}`));
  }
  const at = Date.parse(created) || Date.now();
  for (const s of sources) {
    const info = sourceInfo.find(i => i.url === s) || {};
    const posted = info.postedAt ? Date.parse(info.postedAt) : postedFromUrl(s);
    if (!posted) continue;
    // Every source may be up to 7 days old (the editor's ruling, 2026-11-23: the guide's 24 hours
    // for news flagged too many pitches).
    const age = at - posted;
    if (age > SOURCE_MAX_AGE) out.push(f('pitch.fresh', 'problem', `${s}`, `Posted ${ageText(age)} before the pitch; sources can be up to 7 days old.`));
  }
  return out;
}
export const ageText = ms => (ms >= 2 * DAY ? `${Math.round(ms / DAY)} days` : `${Math.round(ms / 3600000)} hours`);

// The published article. `post` is normalized by wp.mjs.
export function articleChecks(post, { site, cardSources = [], embedTexts = [], charsPerLine = 100 }) {
  const out = headlineChecks(post.title);
  const blocks = articleBlocks(post.content);
  const paras = blocks.filter(b => b.type === 'p');
  const ownHost = hostOf(site.wp);

  // Shape: p p p h2 p embed. An article without an embed is fine (some writers don't add
  // one), so then the shape ends at the paragraph under the H2.
  const hasEmbed = blocks.some(b => b.type === 'embed' || b.type === 'bare-link');
  const want = hasEmbed ? ['p', 'p', 'p', 'h2', 'p', 'embed'] : ['p', 'p', 'p', 'h2', 'p'];
  const got = blocks.slice(0, want.length).map(b => (b.type === 'bare-link' ? 'embed' : b.type));
  const firstBad = want.findIndex((w, i) => got[i] !== w);
  if (firstBad >= 0) {
    const names = { p: 'a paragraph', h2: 'the H2', embed: 'the embed', image: 'an image', list: 'a list', quote: 'a quote', other: 'another block', h3: 'an H3' };
    out.push(f('format.shape', 'problem', `Block ${firstBad + 1} is ${names[got[firstBad]] || 'missing'}; it should be ${names[want[firstBad]]}.`, `Order found: ${got.map(g => names[g] || g).join(', ')}.`));
  }

  const body = blocks.filter(b => /^(p|h\d|list|quote)$/.test(b.type)).map(b => b.text).join(' ');
  const count = words(body).length;
  if (count < 400) out.push(f('format.words', 'problem', `${count} words.`));

  paras.forEach((p, i) => {
    const s = sentences(p.text);
    const last = i === paras.length - 1;
    if (s.length < 2 && !last) out.push(f('format.two-sentences', 'problem', p.text));
    if (p.text.length > charsPerLine * 5) out.push(f('format.five-lines', 'check', clip(p.text, 220), `${p.text.length} characters, about ${Math.ceil(p.text.length / charsPerLine)} lines.`));
    const opener = sentences(unquoted(p.text)).find(x => /^(And|But|Moreover)\b/.test(x));
    if (opener) out.push(f('format.openers', 'problem', opener));
    if (/^However\b/.test(p.text)) out.push(f('format.however', 'problem', s[0] || p.text));
  });

  const h2s = blocks.filter(b => b.type === 'h2');
  for (const h of h2s) {
    if (/\.\s*$/.test(h.text)) out.push(f('format.h2', 'problem', h.text, 'Ends with a period.'));
    const style = caseStyle(h.text);
    if (style === 'title') out.push(f('format.h2', 'problem', h.text, 'Looks like title case.'));
    else if (style === 'maybe') out.push(f('format.h2', 'check', h.text, 'Most words are capitalized.'));
  }

  const own = unquoted(body);
  const dates = findDates(own);
  if (dates.length) out.push(f('format.dates', 'check', dates.join(', '), 'Fine only if the story needs the date.'));
  const metric = [...own.matchAll(METRIC_RE), ...own.matchAll(MONEY_NOT_USD)].map(m => m[0]);
  if (metric.length) out.push(f('format.units', 'check', [...new Set(metric)].join(', ')));
  const small = smallDigits(unquoted(paras.map(p => p.text).join(' ')));
  if (small.length) out.push(f('format.numbers', 'check', small.slice(0, 4).map(s => `…${s}…`).join(' | ')));
  const hs = Object.entries(handles(paras.map(p => p.text).join(' '))).filter(([, n]) => n > 1);
  if (hs.length) out.push(f('format.handles', 'problem', hs.map(([h, n]) => `@${h} (${n} times)`).join(', ')));
  const curses = curseWords(body, { mild: false }), badStars = badCensoring(body);
  if (curses.length) out.push(f('format.curses', 'problem', curses.join(', '), 'Written out in full.'));
  if (badStars.length) out.push(f('format.curses', 'check', badStars.join(', '), 'Use the first letter and stars (f***) or all stars (****).'));
  const apparently = own.match(/[^.]*\bapparently\b[^.]*\.?/i);
  if (apparently) out.push(f('value.apparently', 'check', apparently[0].trim()));

  // Links
  const internal = [], seen = new Map();
  paras.forEach((p, i) => {
    const ls = links(p.html).filter(l => /^https?:/.test(l.href));
    // "Never put two links in the same paragraph" means two interlinks; an interlink next to an
    // outside source link is fine (the editor's ruling, 2026-11-23).
    const ownLinks = ls.filter(l => hostOf(l.href) === ownHost && !/\/(tag|category|author)\//.test(l.href)).length;
    if (ownLinks > 1) out.push(f('links.same-paragraph', 'problem', p.text, `${ownLinks} interlinks in paragraph ${i + 1}.`));
    for (const l of ls) {
      const own = hostOf(l.href) === ownHost && !/\/(tag|category|author)\//.test(l.href);
      if (/^(click here|here|read more|this|this story|this article)$/i.test(l.text.trim())) out.push(f('links.click-here', 'problem', l.text));
      if (!own) continue;
      internal.push({ ...l, para: i });
      const key = l.href.replace(/[#?].*$/, '').replace(/\/$/, '');
      if (seen.has(key)) out.push(f('links.repeat', 'problem', l.href)); else seen.set(key, l);
      const n = words(l.text).length;
      if (n < 3 || n > 7) out.push(f('links.anchor-length', 'problem', `"${l.text}"`, `${n} word${n === 1 ? '' : 's'}.`));
      else if (n > 5) out.push(f('links.anchor-length', 'check', `"${l.text}"`, `${n} words; 3 to 5 is the target.`));
    }
  });
  const need = site.interlinks;
  if (seen.size < need) out.push(f('links.count', 'problem', `${seen.size} interlink${seen.size === 1 ? '' : 's'}.`, `${site.label} needs ${need}.`));

  // Source named and linked in the first three paragraphs; only the name is linked.
  const early = paras.slice(0, 3).flatMap(p => links(p.html)).filter(l => /^https?:/.test(l.href) && hostOf(l.href) !== ownHost);
  if (!early.length) out.push(f('source.linked', 'problem', 'No outside source link in the first three paragraphs.'));
  for (const l of early) if (words(l.text).length > 4) out.push(f('format.source-link-text', 'check', `"${l.text}"`, 'Only the source\'s name should be the link.'));

  // Embeds
  const embeds = blocks.filter(b => b.type === 'embed');
  const bare = blocks.filter(b => b.type === 'bare-link');
  for (const b of bare) out.push(f('embed.rendered', 'problem', b.url, b.provider === 'facebook' ? 'A plain Facebook link; use the Custom HTML embed code.' : 'Shows as a plain link, not an embed.'));
  for (const e of embedTexts) {
    const bad = curseWords(e.text, { mild: false });
    if (bad.length) out.push(f('embed.curses', 'problem', `${e.url}: ${bad.join(', ')}`, 'Use a censored screenshot instead.'));
  }

  // Featured image
  const img = post.image;
  if (!img) out.push(f('image.present', 'problem', 'The article has no featured image.'));
  else {
    if (img.width && img.height && (img.width !== 1280 || img.height !== 720)) out.push(f('image.size', 'problem', `${img.width} x ${img.height}`));
    if (!/(^|\/)Gamurs-Imager-/i.test(img.file || img.url || '')) out.push(f('image.imager', 'check', (img.file || img.url || '').split('/').pop(), 'File name isn\'t an Imager download (Gamurs-Imager-...).'));
    const title = String(img.title || '').trim();
    if (!title || words(title).length < 3 || /^(Gamurs-Imager|IMG|DSC|screenshot|image)[\w-]*$/i.test(title.replace(/\s/g, '-'))) out.push(f('image.title', 'problem', title || '(empty)', 'Describe what is happening in the picture.'));
    else if (findDates(title).length || /\b(19|20)\d{2}\b/.test(title)) out.push(f('image.title', 'problem', title, 'Has a date.'));
    const cap = stripTags(img.caption);
    if (!/^Image by\s+\S/i.test(cap)) out.push(f('image.credit', 'problem', cap || '(empty)', 'Should start with "Image by".'));
    else if (!/,\s*\S/.test(cap.replace(/^Image by\s+/i, ''))) out.push(f('image.credit', 'check', cap, 'Format is "Image by ___, license".'));
    if (/instagram/i.test(cap + ' ' + title)) out.push(f('image.instagram', 'problem', cap || title));
  }

  // SEO
  const seo = String(post.seoTitle || '').trim();
  const siteName = site.name.toLowerCase();
  // An empty SEO title shows as Yoast's default: the headline, a separator and the site name.
  const yoastDefault = seo.toLowerCase().endsWith(site.name.toLowerCase()) && /\s[|–—-]\s*[^|–—-]+$/.test(seo);
  if (!seo || norm(seo) === norm(post.title) || yoastDefault) out.push(f('seo.title', 'problem', seo || '(empty)', 'This is Yoast\'s default (the headline and site name), so the SEO title wasn\'t filled in.'));
  else {
    const bits = [];
    if (seo.includes('|')) bits.push('a pipe');
    if (/:/.test(seo)) bits.push('a colon');
    if (seo.toLowerCase().includes(siteName)) bits.push('the site name');
    if (bits.length) out.push(f('seo.format', 'problem', seo, `Has ${bits.join(' and ')}.`));
    if (caseStyle(seo) === 'title') out.push(f('seo.case', 'problem', seo));
    if ((seo.match(/\?/g) || []).length > 1) out.push(f('seo.question', 'problem', seo, 'Two questions in one.'));
  }
  if (post.metaDescription && metaLooksTyped(post)) out.push(f('seo.meta', 'check', post.metaDescription, 'Doesn\'t match the excerpt or the first paragraph, so it looks typed into the meta description box.'));

  // Tags and categories
  if (!post.tags.length) out.push(f('tags.present', 'problem', 'No tags.'));
  const fresh = post.tags.filter(t => t.count === 1);
  if (fresh.length) out.push(f('tags.existing', 'check', fresh.map(t => t.name).join(', '), 'Used by this article only, so probably created for it.'));
  const want1 = site.primaryCategory;
  if (want1 && !post.categories.some(c => c.toLowerCase() === want1.toLowerCase())) out.push(f('category.primary', 'problem', post.categories.join(', ') || '(none)', `${want1} isn't one of the categories.`));
  else if (want1 && post.primaryCategory && post.primaryCategory.toLowerCase() !== want1.toLowerCase()) out.push(f('category.primary', 'check', post.primaryCategory, `The link shows ${post.primaryCategory} as the primary category, not ${want1}.`));
  if (site.topicCategory && post.categories.length < 2) out.push(f('category.topic', 'check', post.categories.join(', ') || '(none)', 'No topic as the second category.'));

  return { findings: out, stats: { words: count, paragraphs: paras.length, h2: h2s.length, interlinks: seen.size, embeds: embeds.length } };
}

export function mediaId(u) {
  const s = String(u || '');
  return (/tiktok\.com\/(?:.*\/video\/|player\/v1\/|embed\/v2\/)(\d{15,22})/.exec(s) || /(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/.exec(s)
    || /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(s) || [])[1] || null;
}

// Yoast fills an empty meta description from the excerpt or the start of the article,
// so one that matches neither was typed in by hand.
export function metaLooksTyped(post) {
  const d = norm(post.metaDescription).slice(0, 60);
  if (!d) return false;
  const ex = norm(stripTags(post.excerpt)), first = norm(stripTags(post.content)).slice(0, 2000);
  return !(ex.startsWith(d) || first.includes(d) || (ex && d.startsWith(ex.slice(0, 40))));
}
