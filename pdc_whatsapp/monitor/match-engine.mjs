// Duplicate-matching engine for the Trello monitor: Trello card normalization,
// URL normalization (exact match), keyword extraction + overlap shortlist, and
// the 4-verdict AI prompt/parser. Server-side port of the browser checker's
// pipeline, kept in step with index.html. Shared by worker.js and the PDC
// WhatsApp Bridge add-on (copied there as monitor/match-engine.mjs).

const SCHED = {
  CANDIDATE_CAP: 15,   // max shortlisted candidates sent to the AI per card (ranked by rare shared words)
};

const SCHED_STOPWORDS = new Set([
  'a','an','the','and','or','but','so','if','then','when','while','of','in','on','at',
  'to','for','from','with','by','as','is','are','was','were','be','been','being','have',
  'has','had','do','does','did','will','would','could','should','may','might','must',
  'can','this','that','these','those','it','its','they','them','their','there','here',
  'he','she','his','her','we','our','us','you','your','i','me','my','not','no','yes',
  'just','only','also','all','any','some','one','two','more','most','new','up','down',
  'out','over','into','about','after','before','because','how','why','what','who','which',
  'where','reveals','says','said','get','gets','got','make','makes','made','than','too',
  'very','much','many','now','still','yet','even','ever','off','onto','upon','per','via'
]);

// ============================================================================
// DATA LOADERS — server-side equivalents of the browser loaders. They hit the
// upstream APIs directly (the worker already holds the credentials) rather than
// going through the proxy routes.
// ============================================================================

// ---- TRELLO ----------------------------------------------------------------
function schedTrelloIdToDate(id) {
  if (!id || typeof id !== 'string' || id.length < 8) return null;
  const ts = parseInt(id.slice(0, 8), 16);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000);
}

// Also normalizes AotF sheet rows and OS Asana tasks (pitch-sources.mjs),
// which arrive in the same card shape plus _site and _created (ISO date).
function schedNormalizeTrello(card, memberMap) {
  const title = String(card.name || '').trim();
  if (!title || title.length < 3) return null;
  const created = card._created ? new Date(card._created) : schedTrelloIdToDate(card.id);
  const links = schedExtractLinks(card.desc);
  const sourceUrl = links[0] || '';
  let writer = '';
  if (Array.isArray(card.idMembers) && card.idMembers.length > 0) {
    const names = card.idMembers.map(id => memberMap[id]).filter(Boolean);
    if (names.length > 0) writer = names.join(' · ');
  }
  return {
    date: created,
    dateStr: created ? schedFmtDate(created) : '',
    dateLabel: card._createdLabel || '', // sheet rows only know the day
    site: card._site || 'WGTC',
    writer,
    sourceUrl,
    title,
    status: String(card._listName || '').trim(),
    editLink: card.shortUrl || '',
    normalizedUrl: schedNormalizeUrl(sourceUrl),
    normalizedUrl2: '',
    keywords: schedExtractKeywords(title),
    // Arrays, not Sets: findings (with their candidates) are stored as JSON.
    linkKeys: [...new Set(links.map(schedLinkKey).filter(Boolean))],
    handles: [...new Set(links.map(schedCreatorHandle).filter(Boolean))],
  };
}

// ---- Links. Same as the website (index.html): every link in a pitch counts,
// and a social post becomes "platform:post id", so the same TikTok,
// Instagram, X, Threads, YouTube or Reddit post matches however it was copied.
function schedExtractLinks(text) {
  const t = String(text || '');
  const found = t.match(/https?:\/\/[^\s"'<>)\]]+/g);
  if (found) return [...new Set(found)];
  const bare = t.trim();
  return /^[\w.-]+\.[a-z]{2,}\/\S+$/i.test(bare) ? [bare] : [];
}
function schedParseLink(url) {
  try {
    const raw = String(url || '').trim();
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    return { u, host: u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, ''), p: u.pathname.split('/').filter(Boolean) };
  } catch { return null; }
}
export const SOCIAL_KEY = /^(tiktok|tiktok-short|instagram|threads|x|youtube|reddit):/;
function schedLinkKey(url) {
  const l = schedParseLink(url);
  if (!l) return schedNormalizeUrl(url);
  const { u, host, p } = l;
  const after = (word, rx = /./) => { const i = p.indexOf(word); return i >= 0 && rx.test(p[i + 1] || '') ? p[i + 1] : ''; };
  let id;
  if (host === 'tiktok.com') {
    if ((id = after('video', /^\d+$/) || after('photo', /^\d+$/))) return 'tiktok:' + id;
    if (p[0] === 't' && p[1]) return 'tiktok-short:' + p[1];
  }
  if ((host === 'vm.tiktok.com' || host === 'vt.tiktok.com') && p[0]) return 'tiktok-short:' + p[0];
  if (host === 'instagram.com' && (id = after('p') || after('reel') || after('reels') || after('tv'))) return 'instagram:' + id;
  if (/^threads\.(net|com)$/.test(host) && (id = after('post'))) return 'threads:' + id;
  if (/^(x|twitter|fxtwitter|vxtwitter|fixupx)\.com$/.test(host) && (id = after('status', /^\d+$/))) return 'x:' + id;
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (p[0] === 'watch' && u.searchParams.get('v')) return 'youtube:' + u.searchParams.get('v');
    if (/^(shorts|live|embed)$/.test(p[0] || '') && p[1]) return 'youtube:' + p[1];
  }
  if (host === 'youtu.be' && p[0]) return 'youtube:' + p[0];
  if (/(^|\.)reddit\.com$/.test(host) && (id = after('comments'))) return 'reddit:' + id.toLowerCase();
  if (host === 'redd.it' && p[0]) return 'reddit:' + p[0].toLowerCase();
  return schedNormalizeUrl(url);
}
// The creator behind a TikTok or Instagram link ("tiktok:@amy").
function schedCreatorHandle(url) {
  const l = schedParseLink(url);
  if (!l) return '';
  const { host, p } = l;
  if (host === 'tiktok.com' && /^@[\w.]+$/.test(p[0] || '')) return 'tiktok:' + p[0].toLowerCase();
  if (host === 'instagram.com') {
    const name = p[0] === 'stories' ? p[1] : p[0];
    if (name && !/^(p|reel|reels|tv|stories|explore|accounts)$/.test(name) && /^[\w.]+$/.test(name)) return 'instagram:@' + name.toLowerCase();
  }
  return '';
}
// "Same TikTok video" for a shared link key.
export function linkReason(key) {
  const what = { tiktok: 'TikTok video', 'tiktok-short': 'TikTok link', instagram: 'Instagram post', threads: 'Threads post', x: 'X/Twitter post', youtube: 'YouTube video', reddit: 'Reddit post' }[String(key).split(':')[0]];
  return what ? `Same ${what}` : 'Same source link';
}

// ============================================================================
// SHARED HELPERS — direct ports of the browser's pure functions.
// ============================================================================
// One shared formatter: toLocaleDateString builds a new one per call, which
// cost ~25 ms of CPU per monitor check (300 cards) on a 10 ms CPU budget.
const SCHED_DATE_FORMAT = new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
function schedFmtDate(d) {
  try {
    return SCHED_DATE_FORMAT.format(new Date(d));
  } catch { return ''; }
}

function schedNormalizeUrl(url) {
  if (!url) return '';
  try {
    let u = String(url).trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const parsed = new URL(u);
    let host = parsed.host.toLowerCase().replace(/^www\./, '');
    let path = parsed.pathname.replace(/\/+$/, '');
    // Mirrors normalizeUrl in index.html: a bare homepage or a YouTube /watch
    // path without its ?v= id can't prove two pitches share a source.
    if (!path) return '';
    if (/^(m\.)?youtube\.com$/.test(host) && path === '/watch') {
      const v = parsed.searchParams.get('v');
      return v ? 'youtube.com/watch?v=' + v : '';
    }
    return host + path;
  } catch {
    return String(url).trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '')
      .replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

function schedExtractKeywords(title) {
  const out = { all: new Set(), proper: new Set() };
  if (!title) return out;
  const text = String(title);
  const tokens = text.split(/(\s+|[\-\—\–\/\.,:;!?()"'\[\]])/).filter(Boolean);
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.proper.add(run.join(' ').toLowerCase());
    run = [];
  };
  for (const tok of tokens) {
    const w = tok.trim();
    if (!w) continue;
    if (/^[A-Z][a-zA-Z]+$|^[A-Z]+$/.test(w) && w.length > 1 && !SCHED_STOPWORDS.has(w.toLowerCase())) {
      run.push(w);
    } else if (w.match(/^(of|and|the|for|in|on)$/i) && run.length > 0) {
      run.push(w);
    } else {
      flushRun();
    }
  }
  flushRun();
  const words = text.toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean);
  for (const w of words) {
    if (w.length < 3) continue;
    if (SCHED_STOPWORDS.has(w)) continue;
    out.all.add(w);
  }
  const nums = text.match(/\$?\d[\d,\.]*/g) || [];
  for (const n of nums) if (n.length > 1) out.all.add(n.toLowerCase());
  return out;
}

function schedKeywordOverlap(a, b) {
  let proper = 0, words = 0;
  for (const p of a.proper) {
    for (const q of b.proper) {
      if (p === q) { proper++; break; }
      if (p.length > 4 && q.length > 4 && (p.includes(q) || q.includes(p))) { proper++; break; }
    }
  }
  for (const w of a.all) if (b.all.has(w)) words++;
  return { proper, words, score: proper * 4 + words };
}

// Same as the website: shared words count by how rare they are across the
// pitches compared against ("window seat" says more than "woman"), at least
// two meaningful ones; a light stem matches "upgraded"/"upgrade". A pitch about
// the same TikTok/Instagram creator always gets in, first.
const schedStem = w => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(ing|ed|es|s)$/, '') : w);
const schedStems = kw => new Set([...(kw?.all || [])].map(schedStem));
function schedStage2(inputKeywords, rows, { handles = [] } = {}) {
  const df = new Map(), rowStems = rows.map(r => schedStems(r.keywords));
  for (const s of rowStems) for (const w of s) df.set(w, (df.get(w) || 0) + 1);
  const weight = w => Math.log((rows.length + 1) / ((df.get(w) || 0) + 1)), min = Math.log(rows.length + 1);
  const stems = schedStems(inputKeywords), scored = [];
  rows.forEach((r, i) => {
    let score = 0;
    for (const w of stems) if (rowStems[i].has(w)) score += weight(w);
    const creator = handles.length > 0 && (r.handles || []).some(h => handles.includes(h));
    if (score >= min || creator) scored.push({ row: r, score: score + (creator ? 100 : 0) });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SCHED.CANDIDATE_CAP).map(s => s.row);
}

function schedTryParseJSON(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = t.indexOf('{'), last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);
  try { return JSON.parse(t); } catch { return null; }
}

// ----------------------------------------------------------------------------
// VERDICT RUBRIC — kept byte-for-byte aligned with the browser's VERDICT_RUBRIC
// so the Trello monitor and the browser checker reach the same conclusions.
// ----------------------------------------------------------------------------
const SCHED_VERDICT_RUBRIC = [
  'VERDICTS (DEFAULT to "different" whenever you are uncertain):',
  '',
  '- "duplicate" = SAME specific news event AND same angle/hook. The two pitches lead with the same news, frame it the same way, and a reader who saw the first would learn nothing new from the second. Wording can differ.',
  '- "same_story" = SAME specific news event, but DIFFERENT angle, hook, or lede. Both pitches could legitimately run because each gives the reader new information or framing the other does not.',
  '- "near_miss" = Overlapping SUBJECT (same person, team, scandal) but the SPECIFIC news event is not the same.',
  '- "different" = No meaningful overlap. This is the correct answer whenever the specific event AND subject are not shared. Default here when uncertain.',
  '',
  'STRICTNESS RULES:',
  '1. Sharing a SUBJECT alone (same celebrity, politician, team) is not enough for any verdict above "different".',
  '2. Sharing a THEME alone is not enough.',
  '3. Two items on the same day about the same person are still "different" if they describe SEPARATE events.',
  '4. When in doubt between "duplicate" and "same_story", choose "same_story".',
  '5. When in doubt between "same_story" and "near_miss", choose "near_miss".',
];
const SCHED_VERDICT_SCHEMA_LINE =
  '{"results":[{"id":<integer>,"verdict":"duplicate"|"same_story"|"near_miss"|"different","confidence":<0-100>,"reason":"<one short sentence naming the specific overlap or the specific difference>"}]}';

function schedBuildAuditPrompt(targetRow, candidates) {
  const list = candidates.map((c, i) =>
    `[${i + 1}] site=${c.site || '?'} writer=${c.writer || '?'} date=${c.dateStr || '?'} status=${c.status || 'pending'} — "${(c.title || '').replace(/"/g, '\\"')}"`
  ).join('\n');
  return [
    'You are a duplicate detector for a busy news pitch desk. Compare the pitch under review against each earlier pitch. For each one, judge whether and how it overlaps. Be strict but distinguish levels of overlap.',
    '',
    ...SCHED_VERDICT_RUBRIC,
    '',
    'Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:',
    SCHED_VERDICT_SCHEMA_LINE,
    '',
    'Include exactly one entry per candidate using the bracketed id.',
    '',
    `PITCH UNDER REVIEW: site=${targetRow.site || '?'} writer=${targetRow.writer || '?'} date=${targetRow.dateStr || '?'} — "${targetRow.title.replace(/"/g, '\\"')}"`,
    '',
    'EARLIER PITCHES:',
    list,
  ].join('\n');
}

export const monitorEngine = {
  normalize: schedNormalizeTrello, shortlist: schedStage2, parse: schedTryParseJSON,
  prompt: schedBuildAuditPrompt,
};
