// The monitor: every 30 s it reads each site's cards from the Gamurs board and moves each
// card through two checks.
//   Pitch:   waiting for sources -> (no sources after N minutes: WhatsApp) -> checked once
//            sources are on the card. Rechecked by itself if the writer edits the card
//            within two hours (up to three times).
//   Article: once the card has an edit or publish link, its post is looked up every five
//            minutes until it goes live (scheduled posts aren't public before), then checked.
// A check that finds problems or things to check sends one WhatsApp message; the same
// findings never send twice.
import { createHash } from 'node:crypto';
import { SITES, withSettings } from './sites.mjs';
import { pitchChecks, articleChecks } from './checks.mjs';
import { fetchPost, linkTargets } from './wp.mjs';
import { readSource, readEmbeds } from './sources.mjs';
import { callModel, pitchPrompt, articlePrompt, vetFindings, verifyPrompt, applyVerdicts, keysOf, factCheck } from './ai.mjs';
import { checkMessage, noSourcesMessage } from './alerts.mjs';
import { logEvent } from './store.mjs';
import { articleBlocks, decode, clip, stripTags, links, hostOf } from './text.mjs';
import { UA } from './wp.mjs';
import { webFetch } from './web.mjs';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const PITCH_COLS = ['pitched', 'writing'], PITCH_STAGES = ['pitch', 'progress'];
const ARTICLE_POLL = 5 * MIN, ARTICLE_GIVE_UP = 5 * DAY;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// Paragraph HTML as text the AI can read: links as [text](url), italics as _text_.
const htmlish = html => decode(String(html || '')
  .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, h, t) => (stripTags(t) ? `[${stripTags(t)}](${decode(h)})` : ''))
  .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_').replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

export function createMonitor({ db, settings, rules, bridge, fetcher = fetch, web = webFetch, clock = Date.now }) {
  const startedAt = clock();
  const health = { board: {}, ai: { ok: null, at: null, error: null, engine: null }, wp: {}, lastTick: null, ticking: false, whatsapp: { ok: null, at: null, error: null } };
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const log = (level, text) => logEvent(db, level, text);

  async function readBoard(site) {
    const s = settings.get();
    const url = new URL(`${s.boardUrl}/api/feed/pitches`);
    url.searchParams.set('site', site.board);
    url.searchParams.set('days', '7');
    const res = await fetcher(url, { headers: { Authorization: `Bearer ${s.boardToken}`, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (res.status === 401) throw new Error('The board rejected the feed token (401)');
    if (!res.ok) throw new Error(`Board answered ${res.status}`);
    const j = await res.json();
    if (!Array.isArray(j?.pitches)) throw new Error('Board sent an unexpected answer');
    return j.pitches;
  }

  function upsertCard(site, p, now) {
    const key = `${site.id}:${p.id}`;
    const row = {
      key, site: site.id, card_id: String(p.id), title: clip(p.title, 500), writer: clip(p.writer, 200), col: p.col, col_label: p.colLabel || p.col,
      stage: p.stage || null, created: Date.parse(p.created) || now, url: p.url || '', description: 'description' in p ? clip(p.description, 5000) : null,
      sources: JSON.stringify((p.sources || []).filter(u => /^https?:\/\//.test(u)).slice(0, 10)), edit_url: p.editUrl || '', publish_url: p.publishUrl || '',
    };
    run(`INSERT INTO cards (key, site, card_id, title, writer, col, col_label, stage, created, url, description, sources, edit_url, publish_url, first_seen, last_seen)
         VALUES ($key, $site, $card_id, $title, $writer, $col, $col_label, $stage, $created, $url, $description, $sources, $edit_url, $publish_url, $now, $now)
         ON CONFLICT (key) DO UPDATE SET title = excluded.title, writer = excluded.writer, col = excluded.col, col_label = excluded.col_label, stage = excluded.stage,
           url = excluded.url, description = excluded.description, sources = excluded.sources, edit_url = excluded.edit_url, publish_url = excluded.publish_url, last_seen = $now`,
      { ...Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])), $now: now });
    return { ...row, sources: parse(row.sources, []), scheduled: Date.parse(p.scheduled || '') || null };
  }

  const pitchInput = c => hash([c.title, c.description, c.sources]);

  function syncSite(site, pitches, now) {
    const s = settings.get();
    for (const p of pitches) {
      const card = upsertCard(site, p, now);
      const fresh = card.created >= startedAt - s.backfillMinutes * MIN && now - card.created < DAY;
      const inPitch = PITCH_COLS.includes(card.col) || PITCH_STAGES.includes(card.stage);
      const pitch = one('SELECT * FROM checks WHERE card_key = ? AND kind = ?', card.key, 'pitch');
      if (!pitch && fresh && inPitch) {
        run(`INSERT INTO checks (card_key, kind, status, created, input_hash) VALUES (?, 'pitch', ?, ?, ?)`, card.key, card.sources.length ? 'queued' : 'waiting_sources', now, pitchInput(card));
      } else if (pitch) {
        if (pitch.status === 'waiting_sources') {
          if (card.sources.length) run(`UPDATE checks SET status = 'queued', input_hash = ? WHERE id = ?`, pitchInput(card), pitch.id);
          else if (!pitch.sources_alerted && now - card.created >= s.sourcesMinutes * MIN) {
            run('UPDATE checks SET sources_alerted = ? WHERE id = ?', now, pitch.id);
            notify('no_sources', card.key, noSourcesMessage(card, s.sourcesMinutes), `nosrc:${card.key}`);
          }
        } else if (pitch.status === 'done' && pitch.input_hash !== pitchInput(card) && now - card.created < 2 * HOUR && pitch.rechecks < 3 && card.sources.length) {
          run(`UPDATE checks SET status = 'queued', input_hash = ?, rechecks = rechecks + 1, next_try = 0 WHERE id = ?`, pitchInput(card), pitch.id);
        }
      }
      const published = ['scheduled', 'submitted', 'check_daily', 'archive'].includes(card.col) || ['publish', 'archive'].includes(card.stage);
      if ((card.edit_url || card.publish_url || published) && now - card.created < 14 * DAY) {
        const art = one('SELECT id, status FROM checks WHERE card_key = ? AND kind = ?', card.key, 'article');
        if (!art && card.created >= startedAt - Math.max(s.backfillMinutes * MIN, 3 * DAY)) {
          run(`INSERT INTO checks (card_key, kind, status, created, next_try) VALUES (?, 'article', 'waiting_publish', ?, ?)`, card.key, now, card.scheduled && card.scheduled > now ? card.scheduled : 0);
        } else if (art && art.status === 'waiting_publish' && card.scheduled && card.scheduled > now) {
          run('UPDATE checks SET next_try = MAX(next_try, ?) WHERE id = ?', card.scheduled, art.id);
        }
      }
    }
  }

  async function notify(kind, cardKey, text, idem) {
    const s = settings.get();
    if (!s.sendWhatsApp) { run(`INSERT OR IGNORE INTO messages (at, kind, card_key, text, status, idem) VALUES (?, ?, ?, ?, 'not sent (WhatsApp off)', ?)`, clock(), kind, cardKey, text, idem); return; }
    if (one('SELECT 1 FROM messages WHERE idem = ? AND status = ?', idem, 'sent')) return;
    run(`INSERT INTO messages (at, kind, card_key, text, status, idem) VALUES (?, ?, ?, ?, 'sending', ?)
         ON CONFLICT (idem) DO UPDATE SET at = excluded.at, text = excluded.text, status = 'sending', error = NULL`, clock(), kind, cardKey, text, idem);
    try {
      await bridge.send(text, idem);
      run(`UPDATE messages SET status = 'sent', error = NULL WHERE idem = ?`, idem);
      Object.assign(health.whatsapp, { ok: true, at: clock(), error: null });
    } catch (e) {
      run(`UPDATE messages SET status = 'failed', error = ? WHERE idem = ?`, clip(e.message, 300), idem);
      Object.assign(health.whatsapp, { ok: false, at: clock(), error: e.message });
      log('error', `WhatsApp: ${e.message}`);
    }
  }

  function alertFor(check, card, findings, extra) {
    const s = settings.get();
    const wanted = findings.filter(f => (f.severity === 'problem' ? s.alertProblems : s.alertChecks));
    if (!wanted.length) return;
    const key = `${check.kind}:${card.key}:${hash(wanted.map(f => [f.rule, f.severity, f.evidence]).sort())}`;
    if (check.alerted_key === key) return;
    run('UPDATE checks SET alerted_key = ? WHERE id = ?', key, check.id);
    return notify(check.kind, card.key, checkMessage(card, check, wanted, extra), key);
  }

  const verdictOf = fs => (fs.some(f => f.severity === 'problem') ? 'problem' : fs.length ? 'check' : 'clear');
  const cardOf = key => { const c = one('SELECT * FROM cards WHERE key = ?', key); return c && { ...c, sources: parse(c.sources, []) }; };

  async function ai(stage, prompt, material, image) {
    const s = settings.get();
    if (!keysOf(s, 'gemini').length && !keysOf(s, 'mimo').length) return { findings: [], engine: null, note: 'AI keys not set, so only code checks ran' };
    try {
      const r = await callModel(s, { prompt, image }, fetcher);
      Object.assign(health.ai, { ok: true, at: clock(), error: r.failures.length ? r.failures.join('; ') : null, engine: r.engine });
      let findings = vetFindings(r.result, stage, material);
      if (findings.length) {
        try { findings = applyVerdicts(findings, (await callModel(s, { prompt: verifyPrompt(findings, material) }, fetcher)).result); }
        catch { findings = findings.map(f => ({ ...f, severity: 'check' })); } // couldn't double-check: an editor looks
      }
      return { findings, engine: r.engine, sawImage: r.sawImage };
    } catch (e) {
      // The code checks still count: they're sent, and the dashboard says the AI didn't run.
      Object.assign(health.ai, { ok: false, at: clock(), error: e.message });
      log('error', e.message);
      return { findings: [], engine: null, note: `${e.message}, so only code checks ran` };
    }
  }

  // The headline fact check; if it can't run, the rest of the check still counts.
  async function fact(title, sources) {
    const s = settings.get();
    if (!keysOf(s, 'gemini').length && !keysOf(s, 'mimo').length) return { findings: [] };
    try { return await factCheck(s, title, sources, fetcher); }
    catch (e) { return { findings: [], note: `Headline fact check didn't run (${clip(e.message, 120)})` }; }
  }

  async function runPitch(check) {
    const card = cardOf(check.card_key);
    const site = withSettings(SITES.find(x => x.id === card.site), settings.get());
    const sourceInfo = [];
    for (const u of card.sources.slice(0, 5)) sourceInfo.push(await readSource(u, web));
    const input = { site: site.name, title: card.title, description: card.description, descriptionKnown: card.description !== null, sources: card.sources, created: new Date(card.created).toISOString(), sourceInfo };
    const code = pitchChecks(input);
    const material = [card.title, card.description, ...card.sources, ...sourceInfo.map(x => `${x.author} ${x.text}`)].join('\n');
    const a = await ai('pitch', pitchPrompt(rules, input), material);
    const fc = await fact(card.title, sourceInfo);
    const findings = [...code, ...a.findings, ...fc.findings];
    const info = { engine: a.engine, factEngine: fc.engine || null, aiNote: [a.note, fc.note].filter(Boolean).join('. ') || null, sources: sourceInfo };
    finish(check, findings, info);
    await alertFor(one('SELECT * FROM checks WHERE id = ?', check.id), card, findings);
  }

  async function loadImage(url) {
    try {
      const res = await web(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) return null;
      return { mime: (res.headers.get('content-type') || 'image/jpeg').split(';')[0], base64: buf.toString('base64') };
    } catch { return null; }
  }

  async function runArticle(check) {
    const card = cardOf(check.card_key);
    const s = settings.get();
    const site = withSettings(SITES.find(x => x.id === card.site), s);
    let got;
    try { got = await fetchPost(site, { editUrl: card.edit_url, publishUrl: card.publish_url, title: card.title, since: card.created }, web); health.wp[site.id] = { ok: true, at: clock() }; }
    catch (e) { health.wp[site.id] = { ok: false, at: clock(), error: e.message }; throw e; }
    if (!got.live) {
      const tooOld = clock() - check.created > ARTICLE_GIVE_UP;
      run(`UPDATE checks SET status = ?, next_try = ?, error = ?, attempts = attempts + 1 WHERE id = ?`, tooOld ? 'not_live' : 'waiting_publish', clock() + ARTICLE_POLL, got.reason, check.id);
      return;
    }
    const post = got.post;
    // Live before the monitor started: already handled by whoever was watching then (a Recheck still checks it).
    if (!check.rechecks && Date.parse(post.date) < startedAt - s.backfillMinutes * MIN) {
      run(`UPDATE checks SET status = 'skipped', error = 'Published before the monitor started', finished_at = ? WHERE id = ?`, clock(), check.id);
      return;
    }
    // Only news is checked: reviews and opinion pieces don't follow the syndication guides. An
    // article counts as news when it has the site's news category (News; Curveball on OS,
    // which files every story there).
    const newsCategory = site.primaryCategory || 'News';
    if (!post.categories.some(c => c.toLowerCase() === newsCategory.toLowerCase())) {
      run(`UPDATE checks SET status = 'skipped', error = ?, finished_at = ? WHERE id = ?`, `Not news (no ${newsCategory} category)`, clock(), check.id);
      return;
    }
    const blocks = articleBlocks(post.content);
    const embedTexts = await readEmbeds(blocks.filter(b => b.type === 'embed'), web);
    const own = h => hostOf(h) === hostOf(site.wp) && !/\/(tag|category|author)\//.test(h);
    const targets = await linkTargets(site, blocks.filter(b => b.type === 'p').flatMap(b => links(b.html)).map(l => l.href).filter(own), web);
    const sourceTexts = [];
    for (const u of card.sources.slice(0, 3)) if (!embedTexts.some(e => e.url === u)) sourceTexts.push(await readSource(u, web));
    const { findings: code, stats } = articleChecks(post, { site, cardSources: card.sources, embedTexts, charsPerLine: s.charsPerLine });
    const image = s.checkImage && post.image ? await loadImage(post.image.preview || post.image.url) : null;
    const material = [post.title, post.seoTitle, post.image?.title, stripTags(post.image?.caption), post.tags.map(t => t.name).join(', '), post.categories.join(', '),
      ...blocks.map(b => htmlish(b.html)), ...blocks.map(b => b.text), ...embedTexts.map(e => e.text), ...sourceTexts.map(x => x.text), ...targets.map(t => `Interlink ${t.url} goes to: ${t.title}. ${t.summary}`)].join('\n');
    const a = await ai('article', articlePrompt(rules, {
      site: site.name, title: post.title, seoTitle: post.seoTitle, image: post.image && { title: post.image.title, caption: stripTags(post.image.caption) }, imageAttached: Boolean(image),
      tags: post.tags.map(t => t.name), categories: post.categories, cardSources: card.sources,
      blocks: blocks.map(b => ({ type: b.type, provider: b.provider, url: b.url, htmlish: htmlish(b.html) })),
      sources: [...embedTexts, ...sourceTexts], targets,
    }), material, image);
    const fc = await fact(post.title, [...embedTexts, ...sourceTexts]);
    const findings = [...code, ...a.findings, ...fc.findings];
    const info = {
      engine: a.engine, factEngine: fc.engine || null,
      aiNote: [a.note || (image && !a.sawImage ? 'The fallback model can\'t see images, so the image wasn\'t looked at' : null), fc.note].filter(Boolean).join('. ') || null,
      link: post.link, title: post.title, seoTitle: post.seoTitle, published: post.date, image: post.image, tags: post.tags, categories: post.categories, stats, embeds: embedTexts,
    };
    finish(check, findings, info);
    await alertFor(one('SELECT * FROM checks WHERE id = ?', check.id), card, findings, { link: post.link });
  }

  function finish(check, findings, info) {
    run(`UPDATE checks SET status = 'done', verdict = ?, findings = ?, info = ?, error = NULL, finished_at = ?, attempts = attempts + 1 WHERE id = ?`,
      verdictOf(findings), JSON.stringify(findings), JSON.stringify(info), clock(), check.id);
  }

  async function work(check) {
    run(`UPDATE checks SET status = 'running', started_at = ? WHERE id = ?`, clock(), check.id);
    try {
      if (check.kind === 'pitch') await runPitch(check); else await runArticle(check);
    } catch (e) {
      const back = check.kind === 'article' ? 'waiting_publish' : 'queued';
      const attempts = check.attempts + 1;
      run(`UPDATE checks SET status = ?, error = ?, attempts = ?, next_try = ? WHERE id = ?`, attempts >= 6 ? 'error' : back, clip(e.message, 400), attempts, clock() + Math.min(30 * MIN, MIN * 2 ** attempts), check.id);
      log('error', `${check.kind} check of ${check.card_key} failed: ${e.message}`);
    }
  }

  // A restart cuts off whatever was running; it goes back in the queue straight away.
  run(`UPDATE checks SET status = CASE kind WHEN 'article' THEN 'waiting_publish' ELSE 'queued' END WHERE status = 'running'`);
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true; health.ticking = true;
    try {
      const s = settings.get();
      const now = clock();
      if (s.boardUrl && s.boardToken) {
        for (const site of SITES.filter(x => s.sites[x.id]?.enabled !== false)) {
          try {
            syncSite(site, await readBoard(site), now);
            if (health.board[site.id]?.ok === false) log('info', `${site.label}: board readable again`);
            health.board[site.id] = { ok: true, at: now, since: null };
          } catch (e) {
            const was = health.board[site.id];
            const since = was?.ok === false ? was.since : now;
            health.board[site.id] = { ok: false, at: now, error: e.message, since };
            if (was?.ok !== false) log('error', `${site.label}: ${e.message}`);
            if (s.alertHealth && now - since >= 10 * MIN && !was?.told) {
              health.board[site.id].told = true;
              notify('health', null, `*Editorial Monitor can't read the board*\n${site.label}: ${e.message}\nSince ${new Date(since).toISOString().slice(11, 16)} UTC.`, `health:board:${site.id}:${since}`);
            } else if (was?.told) health.board[site.id].told = true;
          }
        }
      }
      run(`UPDATE checks SET status = 'queued' WHERE status = 'running' AND started_at < ?`, now - 10 * MIN);
      // Pitches first, newest first (the freshest story matters most), four at a time: one check
      // spends most of its minute waiting on source pages and the AI.
      const due = q(`SELECT * FROM checks WHERE status IN ('queued', 'waiting_publish') AND next_try <= ? ORDER BY kind = 'pitch' DESC, created DESC LIMIT 40`, now);
      const pool = Array.from({ length: Math.min(4, due.length) }, async () => { for (let c; (c = due.shift());) await work(c); });
      await Promise.all(pool);
      if (s.rulesAutoRefresh && (!rules.status().refreshedAt || now - Date.parse(rules.status().refreshedAt) > DAY)) {
        const r = await rules.refresh(fetcher);
        if (r.changed.length) log('info', `Rules updated: ${r.changed.join(', ')}`);
      }
      health.lastTick = clock();
    } finally { busy = false; health.ticking = false; }
  }

  function recheck(id) {
    const c = one('SELECT * FROM checks WHERE id = ?', id);
    if (!c) return false;
    run(`UPDATE checks SET status = ?, next_try = 0, attempts = 0, dismissed = 0, alerted_key = NULL, rechecks = rechecks + 1 WHERE id = ?`, c.kind === 'article' ? 'waiting_publish' : 'queued', id);
    setTimeout(tick, 50);
    return true;
  }

  return { tick, recheck, health, startedAt, notify };
}
