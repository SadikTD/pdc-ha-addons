// The AI reviewer: Gemini 3.5 Flash-Lite first, MiMo V2.6 Flash if Gemini fails. The model
// gets the guides word for word and may only report rules from the catalog, each with
// evidence quoted from the material. A finding whose evidence isn't in the material is
// dropped, so the model can't invent problems.
import { aiRules, RULES } from './catalog.mjs';
import { GUIDES } from './rules.mjs';
import { norm, clip } from './text.mjs';

export const DEFAULT_MODELS = { gemini: 'gemini-3.5-flash-lite', mimo: 'mimo-v2.6-flash' };

// All keys of a provider, in order: settings.geminiKeys / mimoKeys (lists) plus the older
// single geminiKey / mimoKey.
export const keysOf = (settings, provider) => [...new Set([...(settings[`${provider}Keys`] || []), settings[`${provider}Key`]].map(k => String(k || '').trim()).filter(Boolean))];

// A key that hit its rate limit (429) rests for 2 minutes; one that was refused (400/401/403,
// a wrong or disabled key) for 30. The next key is used meanwhile. Shown in Settings.
const resting = new Map(); // key -> { until, reason }
export const keyStatus = new Map(); // key -> { ok, at, error }
const REST = { 429: 2 * 60000, 400: 30 * 60000, 401: 30 * 60000, 403: 30 * 60000 };

export async function callModel(settings, { prompt, image }, fetcher = fetch, clock = Date.now, retryDelay = 2000) {
  const gModel = settings.geminiModel || DEFAULT_MODELS.gemini, mModel = settings.mimoModel || DEFAULT_MODELS.mimo;
  const attempts = [
    ...keysOf(settings, 'gemini').map((key, i) => ({
      name: 'Gemini', label: `Gemini key ${i + 1}`, key, model: gModel, timeout: 60000,
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(gModel)}:generateContent`, headers: { 'x-goog-api-key': key },
      body: { contents: [{ parts: [{ text: prompt }, ...(image ? [{ inline_data: { mime_type: image.mime, data: image.base64 } }] : [])] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 6000, responseMimeType: 'application/json' } },
      extract: j => j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''), sawImage: Boolean(image),
    })),
    ...keysOf(settings, 'mimo').map((key, i) => ({
      name: 'MiMo', label: `MiMo key ${i + 1}`, key, model: mModel, timeout: 90000,
      url: 'https://api.xiaomimimo.com/v1/chat/completions', headers: { 'api-key': key },
      body: { model: mModel, messages: [{ role: 'user', content: prompt }], temperature: 0.1,
        max_completion_tokens: 6000, response_format: { type: 'json_object' }, thinking: { type: 'disabled' } },
      extract: j => j.choices?.[0]?.message?.content, sawImage: false,
    })),
  ];
  const failures = [];
  // Resting keys go last rather than being skipped, so a single key is still tried.
  const order = [...attempts.filter(a => !(resting.get(a.key)?.until > clock())), ...attempts.filter(a => resting.get(a.key)?.until > clock())];
  for (const a of order) {
    try {
      const send = () => fetcher(a.url, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(a.timeout),
        headers: { 'Content-Type': 'application/json', ...a.headers }, body: JSON.stringify(a.body) });
      let res = await send();
      // 500/503 is the provider being busy for a moment (seen on Gemini 2026-11-23): retry twice.
      for (let n = 1; n <= 2 && (res.status === 500 || res.status === 503); n++) { await new Promise(r => setTimeout(r, retryDelay * n)); res = await send(); }
      if (!res.ok) {
        const why = res.status === 429 ? 'rate limited' : [400, 401, 403].includes(res.status) ? 'key refused' : `HTTP ${res.status}`;
        if (REST[res.status]) resting.set(a.key, { until: clock() + REST[res.status], reason: why });
        keyStatus.set(a.key, { ok: false, at: clock(), error: `${why} (HTTP ${res.status})` });
        failures.push(`${a.label}: ${why}`);
        continue;
      }
      const parsed = parseJson(a.extract(await res.json()));
      if (parsed) {
        resting.delete(a.key);
        keyStatus.set(a.key, { ok: true, at: clock(), error: null });
        return { engine: `${a.name} (${a.model})`, key: a.label, sawImage: a.sawImage, result: parsed, failures };
      }
      failures.push(`${a.label}: unreadable answer`);
    } catch (e) {
      keyStatus.set(a.key, { ok: false, at: clock(), error: e?.name === 'TimeoutError' ? 'timed out' : 'network error' });
      failures.push(`${a.label}: ${e?.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
    }
  }
  const err = new Error(`AI unavailable (${failures.join('; ') || 'no AI keys set'})`);
  err.failures = failures;
  throw err;
}
const parseJson = t => { try { return JSON.parse(String(t || '').replace(/^```(json)?\s*|\s*```$/g, '')); } catch { return null; } };

const guideBlock = (rules, keys) => keys.map(k => `=== ${GUIDES.find(g => g.key === k).title} ===\n${rules.text[k]}`).join('\n\n');
// headline.source-only has its own fact-check step (factCheck below), so the big review leaves it out.
const ruleList = stage => aiRules(stage).filter(r => r.id !== 'headline.source-only').map(r => `- ${r.id}: ${r.title} (guide line: "${r.quote}")`).join('\n');

// Headline against source, claim by claim, as its own small task (settings.factModel). It
// leans towards "supported": a phrase the source puts in quote marks while reporting what a
// person said or posted is that person's words, even without "she said" next to it. Reading it
// as the outlet's own words was a wrong call on a real pitch (Melania Trump's "visual
// portraits", which she did post), 2026-11-23. Findings are only ever "check", never "problem".
export const DEFAULT_FACT_MODEL = 'gemini-3.6-flash';
export function factPrompt(title, sources) {
  return `Fact-check a news headline against its source. Split the headline into its separate claims (who did what, numbers, quotes, who said something, cause and effect). For each claim, find the sentence in the source that supports it.
Rules:
- Words the source puts in quotation marks while reporting what someone said, posted or announced count as that person's words, even if "she said" isn't right next to them. Only mark a quote unsupported if the source says a different person said it, or the words aren't in the source at all.
- A claim is supported if the source says the same thing in other words. Don't mark something unsupported because of wording, emphasis or small details the headline leaves out.
- Mark unsupported only what the source plainly contradicts or doesn't contain: a different number ("more than 12,000" vs "12,000"), a different person, an event the source doesn't describe, or something the source only alleges stated as proven fact.
- If you aren't sure, mark it supported.

Headline: ${title}

${sources.map(s => `Source (${s.author || s.url}):\n${s.text}`).join('\n\n')}

Answer with JSON only: {"claims":[{"claim":"<words copied from the headline>","supported":true|false,"source":"<the supporting sentence copied from the source, or empty>","why":"<one short sentence>"}]}`;
}
const words = t => norm(t).split(' ').filter(w => w.length > 2);
export async function factCheck(settings, title, sources, fetcher = fetch) {
  // Only against real article text: a Reddit title, a hashtag-only caption or a paywall stub
  // doesn't hold the story, and claims "missing" from it were false alarms in the live test
  // (2026-11-23). Videos' spoken words aren't readable at all.
  const usable = sources.filter(s => String(s.text || '').trim().length >= 600);
  if (!usable.length) return { findings: [], note: 'The source text couldn\'t be read in full (a video, a blocked site or a paywall), so the headline wasn\'t fact-checked' };
  const prompt = factPrompt(title, usable), model = settings.factModel || DEFAULT_FACT_MODEL;
  // No fallback to a weaker model: Flash-Lite flagged claims against sources it couldn't fully
  // see. The free tier of Gemini 3.6 Flash allows 20 requests a day per key project (2026-11-23).
  const r = await callModel({ ...settings, geminiModel: model }, { prompt }, fetcher);
  const fallback = '';
  const head = new Set(words(title));
  const findings = (Array.isArray(r.result?.claims) ? r.result.claims : [])
    .filter(c => c && c.supported === false && words(c.claim).filter(w => head.has(w)).length >= Math.min(3, words(c.claim).length))
    .map(c => ({ rule: 'headline.source-only', severity: 'check', evidence: clip(c.claim, 300), note: clip(c.why || 'The source doesn\'t show this.', 300), by: 'ai' }));
  return { findings: findings.slice(0, 4), engine: r.engine, note: fallback || undefined };
}
const SHAPE = `Answer with JSON only: {"findings":[{"rule":"<rule id from the list>","severity":"problem"|"check","evidence":"<exact words copied from the material>","note":"<one short sentence: what is wrong and what the guide wants>"}]}
"problem" = clearly breaks the rule. "check" = likely breaks it, an editor should look. Report nothing you are unsure is a real issue; an empty list is a good answer.
Evidence must be copied exactly from the material (the pitch, the article, the source text or an embed), except for image rules, where you describe what you see.`;

export function pitchPrompt(rules, p) {
  return `You are a senior editor checking a writer's pitch for a syndicated news site (${p.site}). Judge it ONLY against the guides below. Do not apply any rule that isn't in them, and do not report duplicates (another tool does that).

${guideBlock(rules, ['quickref', 'stories', 'headlines', 'value'])}

Rules you may report (use these ids only):
${ruleList('pitch')}

Already checked elsewhere, don't repeat: sentence case, length, dashes, quote marks, colons, bad words, missing sources, missing description, post date, freshness, and whether each headline claim is in the source (a separate fact check does that).

=== The pitch ===
Headline: ${p.title}
Description: ${p.description || '(none)'}
Sources:
${p.sourceInfo.map(s => `- ${s.url} (${s.provider}${s.author ? `, by ${s.author}` : ''}${s.postedAt ? `, posted ${s.postedAt}` : ''})${s.text ? `\n  Source text: ${s.text}` : ''}`).join('\n') || '(none)'}
Pitched at: ${p.created}

${SHAPE}`;
}

export function articlePrompt(rules, a) {
  const body = a.blocks.map((b, i) => `[${i + 1} ${b.type}${b.provider ? ` ${b.provider}` : ''}] ${b.type === 'embed' ? b.url || '' : b.htmlish}`).join('\n');
  return `You are a senior editor checking a published article on a syndicated news site (${a.site}). Judge it ONLY against the guides below. Do not apply any rule that isn't in them.

${guideBlock(rules, GUIDES.map(g => g.key))}

Rules you may report (use these ids only):
${ruleList('article')}

Already checked by code, don't repeat: article shape, word count, sentence counts, paragraph length, And/But/However openers, H2 case and period, dates, units, digits, @handles, curse words, interlink count and anchor length, repeated links, embed presence, image size, credit format, SEO title format, tags present, categories.

=== The article ===
Headline: ${a.title}
SEO title: ${a.seoTitle || '(empty)'}
Featured image title: ${a.image?.title || '(none)'}
Featured image credit: ${a.image?.caption || '(none)'}${a.imageAttached ? '\n(The featured image is attached: check it against the image rules.)' : ''}
Tags: ${a.tags.join(', ') || '(none)'}
Categories: ${a.categories.join(', ') || '(none)'}
Pitch sources: ${a.cardSources.join(' ') || '(none)'}

Body, block by block (links shown as [link text](url)):
${body}

=== Where each interlink goes ===
${(a.targets || []).map(t => `- ${t.url}: "${t.title}" ${t.summary}`).join('\n') || '(not known)'}

=== Source and embed text ===
${a.sources.map(s => `- ${s.url}${s.author ? ` (by ${s.author})` : ''}: ${s.text || '(not readable)'}`).join('\n') || '(none)'}

${SHAPE}`;
}

// Keeps findings that use a known rule for this stage and quote real material.
export function vetFindings(result, stage, material) {
  const allowed = new Set(aiRules(stage).map(r => r.id));
  const hay = norm(material);
  const list = Array.isArray(result?.findings) ? result.findings : [];
  return list.filter(x => x && allowed.has(x.rule)).map(x => ({
    rule: x.rule, severity: x.severity === 'problem' ? 'problem' : 'check', evidence: clip(String(x.evidence || ''), 400), note: clip(String(x.note || ''), 300), by: 'ai',
  })).filter(x => x.note && (x.rule.startsWith('image.') ? true : x.evidence && hay.includes(norm(x.evidence).slice(0, 120))))
    .filter((x, i, all) => all.findIndex(y => y.rule === x.rule && norm(y.evidence) === norm(x.evidence)) === i).slice(0, 15);
}

// Second opinion: each proposed finding goes back with the exact guide line, and only the
// ones that plainly break that line as written survive. Measured on 2026-11-23: the first
// pass called a diver's Instagram a "celebrity" embed and a metal-detecting story a crime.
export function verifyPrompt(findings, material) {
  return `You are double-checking another editor's notes on an article. Be strict: a note stays only if the quoted words clearly break the guide line exactly as it is written. Do not stretch a rule to cover something it doesn't say (for example, a rule about celebrities doesn't cover ordinary people, and a rule about crime stories doesn't cover non-crime stories). When unsure, drop it.

${findings.map((f, i) => `Note ${i}: rule "${RULES[f.rule]?.title}". Guide line: "${RULES[f.rule]?.quote}"
Quoted from the article: "${f.evidence}"
The editor said: ${f.note}`).join('\n\n')}

=== The article and sources, for context ===
${clip(material, 24000)}

Answer with JSON only: {"notes":[{"i":<note number>,"keep":true|false,"severity":"problem"|"check","why":"<one short sentence>"}]}
"problem" only when the guide line is broken beyond doubt; otherwise "check".`;
}
export function applyVerdicts(findings, result) {
  const notes = Array.isArray(result?.notes) ? result.notes : [];
  return findings.flatMap((f, i) => {
    const n = notes.find(x => Number(x?.i) === i);
    if (!n || n.keep !== true) return [];
    return [{ ...f, severity: n.severity === 'problem' ? 'problem' : 'check' }];
  });
}

export const ruleOf = id => RULES[id];
