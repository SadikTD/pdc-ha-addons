// HTML and text helpers for WordPress article content. No dependencies: the
// block editor writes regular, flat HTML (p, h2, figure, ul...), so a small
// depth-counting scanner is enough to split it into top-level blocks.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export const decode = s => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
export const stripTags = html => decode(String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/[\s ]+/g, ' ').trim();
export const words = s => (String(s).match(/[A-Za-z0-9À-ɏ'’*@#$%.-]+/g) || []).filter(w => /[A-Za-z0-9]/.test(w));
export const norm = s => String(s ?? '').toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9'"]+/g, ' ').trim();

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);

// Top-level elements of a block of HTML, each { tag, cls, html, inner }.
export function topLevelBlocks(html) {
  const out = [];
  const s = String(html || '');
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let depth = 0, start = -1, tag = null, attrs = '', innerStart = 0, m;
  while ((m = re.exec(s))) {
    const [, close, name0, a, selfClose] = m;
    const name = name0.toLowerCase();
    if (depth === 0) {
      if (close) continue;
      if (VOID.has(name) || selfClose) { out.push({ tag: name, cls: attrOf(a, 'class'), attrs: a, html: m[0], inner: '' }); continue; }
      tag = name; attrs = a; start = m.index; innerStart = re.lastIndex; depth = 1;
      continue;
    }
    if (name !== tag || VOID.has(name) || selfClose) continue;
    if (close) depth--; else depth++;
    if (depth === 0) out.push({ tag, cls: attrOf(attrs, 'class'), attrs, html: s.slice(start, re.lastIndex), inner: s.slice(innerStart, m.index) });
  }
  return out;
}
export const attrOf = (attrs, name) => (new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs || '') || [])[2] ?? (new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs || '') || [])[1] ?? '';

export function links(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  // An empty <a></a> (an editor leftover next to the real link) isn't a link anyone sees.
  while ((m = re.exec(String(html || '')))) { const text = stripTags(m[2]); if (text || /<img/i.test(m[2])) out.push({ href: decode(attrOf(m[1], 'href')), text }); }
  return out;
}

const PROVIDERS = [
  ['tiktok', /tiktok\.com/i], ['x', /(twitter\.com|x\.com)\//i], ['youtube', /(youtube\.com|youtu\.be)/i], ['instagram', /instagram\.com/i],
  ['facebook', /facebook\.com/i], ['reddit', /reddit\.com/i], ['threads', /threads\.(net|com)/i], ['bluesky', /bsky\.app/i], ['truthsocial', /truthsocial\.com/i],
];
export const providerOf = url => (PROVIDERS.find(([, re]) => re.test(url || '')) || ['web'])[0];
export const SOCIAL = new Set(['tiktok', 'x', 'youtube', 'instagram', 'facebook', 'reddit', 'threads', 'bluesky', 'truthsocial']);

// The URL an embed shows: the block's own URL, a blockquote's cite, or an iframe.
function embedUrl(b) {
  const wrapper = /class="wp-block-embed__wrapper"[^>]*>\s*(https?:\/\/[^\s<]+)/i.exec(b.html);
  if (wrapper) return decode(wrapper[1]);
  const cite = /\bcite="([^"]+)"/i.exec(b.html) || /data-instgrm-permalink="([^"]+)"/i.exec(b.html) || /data-href="([^"]+)"/i.exec(b.html);
  if (cite) return decode(cite[1]);
  const a = links(b.html).map(l => l.href).filter(h => /\/status\/|\/video\/|\/p\/|\/reel\/|watch\?v=|\/comments\//.test(h)).pop();
  if (a) return a;
  const iframe = /<iframe[^>]+src="([^"]+)"/i.exec(b.html);
  return iframe ? decode(iframe[1]) : '';
}

// Classifies the article into blocks: p, h2, h3..., embed, image, list, quote, other.
// A paragraph holding only a bare URL is an embed that didn't render.
export function articleBlocks(html) {
  return topLevelBlocks(html).map(b => {
    const text = stripTags(b.inner || b.html);
    if (/^h[1-6]$/.test(b.tag)) return { type: b.tag, text, html: b.html };
    const isEmbed = /wp-block-embed|twitter-tweet|tiktok-embed|instagram-media|fb-post|reddit-embed|bluesky-embed/i.test(b.cls + ' ' + b.html.slice(0, 400))
      || (b.tag === 'iframe') || (/^(figure|div)$/.test(b.tag) && /<iframe/i.test(b.html));
    if (isEmbed) { const url = embedUrl(b); return { type: 'embed', provider: providerOf(url || b.html), url, text, html: b.html }; }
    if (b.tag === 'figure' && /wp-block-image|<img/i.test(b.html)) return { type: 'image', text, html: b.html };
    if (b.tag === 'p') {
      if (/^https?:\/\/\S+$/.test(text)) return { type: 'bare-link', provider: providerOf(text), url: text, text, html: b.html };
      return text ? { type: 'p', text, html: b.html } : { type: 'empty', text, html: b.html };
    }
    if (b.tag === 'ul' || b.tag === 'ol') return { type: 'list', text, html: b.html };
    if (b.tag === 'blockquote') return { type: 'quote', text, html: b.html };
    return { type: text ? 'other' : 'empty', text, html: b.html };
  }).filter(b => b.type !== 'empty');
}

// Sentences of a paragraph. ponytail: abbreviation list heuristic, not NLP; good enough to count
// "one sentence" paragraphs and sentence openers, and every finding quotes the paragraph.
const ABBR = /\b(Mr|Mrs|Ms|Dr|Jr|Sr|St|Mt|Ft|Gen|Gov|Sen|Rep|Rev|Prof|Lt|Col|Sgt|Capt|Cmdr|Det|Ofc|No|Vol|vs|etc|Inc|Ltd|Co|Corp|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|U\.S|U\.K|a\.m|p\.m|e\.g|i\.e|[A-Z])\.$/;
export function sentences(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let cur = '';
  const parts = t.split(/(?<=[.!?…]['"’”)\]]*)\s+(?=['"‘“(\[]*[A-Z0-9@#$])/);
  for (const p of parts) {
    cur = cur ? `${cur} ${p}` : p;
    if (ABBR.test(cur.replace(/['"’”)\]]+$/, ''))) continue;
    out.push(cur); cur = '';
  }
  if (cur) out.push(cur);
  return out;
}

const SMALL = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'to', 'of', 'in', 'on', 'at', 'by', 'up', 'as', 'is', 'it', 'with', 'from', 'into', 'over', 'after', 'about', 'than', 'that', 'this', 'his', 'her', 'their', 'its', 'was', 'are', 'be', 'has', 'had', 'have', 'who', 'what', 'when', 'why', 'how']);
// 'title' when function words are capitalized mid-sentence (a sure sign), 'maybe' when
// nearly every longer word is capitalized (could be a run of names), else 'ok'.
export function caseStyle(text) {
  const ws = String(text || '').replace(/['‘’"“”]/g, ' ').split(/\s+/).filter(w => /^[A-Za-z]/.test(w));
  if (ws.length < 3) return 'ok';
  const rest = ws.slice(1).filter((w, i) => !/[.:?!]$/.test(ws[i]));
  const smallCaps = rest.filter(w => SMALL.has(w.toLowerCase()) && /^[A-Z][a-z]/.test(w)).length;
  if (smallCaps >= 2 || (smallCaps === 1 && rest.filter(w => SMALL.has(w.toLowerCase())).length === 1 && rest.length >= 4 && capRatio(rest) > 0.7)) return 'title';
  const long = rest.filter(w => w.length >= 4 && !SMALL.has(w.toLowerCase()));
  if (long.length >= 4 && capRatio(long) === 1) return 'maybe';
  return 'ok';
}
const capRatio = ws => ws.filter(w => /^[A-Z]/.test(w)).length / (ws.length || 1);

// Words the guides ban or want censored. Matched as whole words, case-insensitive.
export const CURSES = ['fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'motherfucker', 'motherfucking', 'shit', 'shitty', 'bullshit', 'shits', 'bitch', 'bitches', 'bastard', 'asshole', 'assholes', 'dick', 'dickhead', 'cunt', 'cunts', 'pussy', 'cock', 'damn', 'goddamn', 'piss', 'pissed', 'slut', 'whore', 'twat', 'wanker', 'prick', 'crap', 'hell', 'ass', 'dumbass', 'jackass', 'retard', 'retarded', 'nigger', 'nigga', 'faggot', 'fag'];
export const DRUGS = ['cocaine', 'heroin', 'meth', 'methamphetamine', 'fentanyl', 'marijuana', 'weed', 'cannabis', 'crack', 'ecstasy', 'mdma', 'lsd', 'ketamine', 'opioids', 'opioid', 'oxycodone', 'xanax', 'molly', 'shrooms', 'psilocybin', 'pcp', 'narcotics'];
export const SA_WORDS = ['rape', 'raped', 'rapes', 'rapist', 'raping', 'molestation', 'molested', 'molest', 'molesting', 'molester', 'sexual assault', 'sexually assaulted'];
// Words that are also names (Dick Cheney, Moby-Dick, Hell's Kitchen) only count in lower case.
const NAMEISH = new Set(['dick', 'cock', 'prick', 'hell', 'crap', 'piss', 'molly', 'crack', 'weed', 'ass']);
const findWords = (text, list) => {
  const t = String(text || '');
  return [...new Set(list.filter(w => new RegExp(`(^|[^A-Za-z*-])${w.replace(/ /g, '\\s+')}(?![A-Za-z*])`, NAMEISH.has(w) ? '' : 'i').test(t)))];
};
// Text with quoted speech taken out, for style rules that apply to the writer's own words.
export const unquoted = text => String(text || '').replace(/“[^”]*”|"[^"]*"|‘[^’]{3,}’(?=[\s.,;:!?)]|$)/g, ' ');
// Curse words that are written out in full. "hell", "ass", "crap", "damn" etc. are words a
// nine-year-old couldn't say, so they count in headlines, but in body copy only the strong ones do.
const MILD = new Set(['damn', 'hell', 'crap', 'piss', 'pissed', 'ass']);
export const curseWords = (text, { mild = true } = {}) => findWords(text, mild ? CURSES : CURSES.filter(w => !MILD.has(w)));
export const drugWords = text => findWords(text, DRUGS);
export const saWords = text => findWords(text, SA_WORDS);
// Censoring the guide doesn't allow: "f-word", "fck", "f—", "sh*t" (letters after the stars).
export function badCensoring(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/\b(f-word|s-word|b-word|fck|fcking|fcuk|sht|btch)(?![a-z])|\b[a-z][–—]+[a-z]{0,2}\b/gi)) out.push(m[0]);
  for (const m of t.matchAll(/(?<![\w*])([a-z]{2,}\*+[a-z]*|[a-z]\*+[a-z]+\*+[a-z]*|[a-z]\*+(?:[a-z]{1,2})(?![a-z*]))(?![\w*])/gi)) {
    // Only when the letters before the stars start a curse word: "Thunderbolts*" is a film title.
    const stem = m[0].split('*')[0].toLowerCase();
    if (!CURSES.some(w => w.startsWith(stem))) continue;
    if (!/^[a-z]\*+$/i.test(m[0]) && !/^[a-z]\*{2,}(ing|ed|er|s|in)$/i.test(m[0])) out.push(m[0]);
  }
  return [...new Set(out)];
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Aug\\.?|Sept?\\.?|Oct\\.?|Nov\\.?|Dec\\.?';
export const DATE_RE = new RegExp(`\\b(?:(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:\\s+\\d{4})?|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?|\\d{4}-\\d{2}-\\d{2})\\b`, 'g');
export const findDates = text => [...new Set(String(text || '').match(DATE_RE) || [])];
// A date written on a pitch card ("posted Nov 22", "11/22", "22 November", "yesterday", "2 days ago").
const DATE_ONE = new RegExp(DATE_RE.source);
export const hasPostDate = text => DATE_ONE.test(String(text || '')) || /\b(today|yesterday|\d+\s*(h|hr|hrs|hours?|d|days?)\s+ago|posted\s+(on\s+)?\w+day)\b/i.test(String(text || ''));

export const METRIC_RE = /\b\d[\d,.]*\s?(km|kilomet(?:er|re)s?|kg|kilograms?|grams?|cm|centimet(?:er|re)s?|millimet(?:er|re)s?|mm|met(?:er|re)s?|lit(?:er|re)s?|°C|degrees Celsius|Celsius|km\/h|kph)\b/gi;
export const MONEY_NOT_USD = /(£|€|¥|₹)\s?\d|\b\d[\d,.]*\s?(euros?|pounds sterling|rupees|yen)\b/gi;

// A number from one to nine written as a digit, where the guide wants it spelled out.
// Skips money, percentages, times, ages ("5-year-old"), scores, ranks ("No. 1"), dates and decimals.
export function smallDigits(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/(?<![\d$£€.,:/#-])\b([1-9])\b(?![\d.,:/%-]|\s?(%|percent|a\.m|p\.m|am\b|pm\b|st\b|nd\b|rd\b|th\b))/g)) {
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    if (/(No\.|number|Section|Chapter|Season|Episode|Week|Game|Route|Highway|Article|Level|Amendment|Title|Grade|Category|Class|Phase|Stage|Day|Act|Part|Vol\.|COVID-|Gen|iPhone|PS|Xbox|Windows)\s?$/i.test(before)) continue;
    if (new RegExp(`(${MONTHS})\\s?$`, 'i').test(before)) continue;
    out.push(t.slice(Math.max(0, m.index - 25), m.index + 26).trim());
  }
  return out;
}

export const handles = text => {
  const counts = {};
  for (const m of String(text || '').matchAll(/(?<![\w@])@([A-Za-z0-9_.]{2,30})/g)) { const k = m[1].replace(/\.$/, '').toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
  return counts;
};

export const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
export const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
