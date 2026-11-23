// Editorial Monitor: Home Assistant add-on entry point. Serves the sidebar dashboard
// (Ingress) and its JSON API, and runs the monitor every 30 seconds.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, logEvent, createSettings, validateSettings, SECRET } from './src/store.mjs';
import { createRules, GUIDES, docUrl } from './src/rules.mjs';
import { createMonitor } from './src/monitor.mjs';
import { createBridge } from './src/alerts.mjs';
import { RULES } from './src/catalog.mjs';
import { SITES } from './src/sites.mjs';
import { callModel, keysOf, keyStatus } from './src/ai.mjs';

const DATA = process.env.DATA_DIR || '/data';
const PORT = Number(process.env.PORT || 8099);
const ALLOW_ALL = process.env.ALLOW_ALL === '1'; // local preview only
const ALLOWED = new Set(['172.30.32.2', '127.0.0.1', '::1']);
const WWW = fileURLToPath(new URL('./www/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

await mkdir(DATA, { recursive: true });
const db = openDb(DATA);
const settings = createSettings(DATA);
const rules = createRules(DATA);
const supervisor = process.env.SUPERVISOR_TOKEN ? async path => {
  const res = await fetch(`http://supervisor${path}`, { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` }, signal: AbortSignal.timeout(10000) });
  return res.ok ? (await res.json()).data : null;
} : null;
const bridge = createBridge({ settings, supervisor });
const monitor = createMonitor({ db, settings, rules, bridge });

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

const checkRow = r => r && ({
  id: r.id, kind: r.kind, status: r.status, verdict: r.verdict, dismissed: Boolean(r.dismissed), error: r.error,
  created: r.created, finishedAt: r.finished_at, nextTry: r.next_try, sourcesAlerted: r.sources_alerted,
  findings: parse(r.findings, []), info: parse(r.info, {}),
  card: { key: r.card_key, site: r.site, title: r.title, writer: r.writer, list: r.col_label, url: r.url, created: r.c_created, editUrl: r.edit_url, publishUrl: r.publish_url,
    description: r.description, sources: parse(r.sources, []) },
});
const JOIN = `SELECT k.*, c.site, c.title, c.writer, c.col_label, c.url, c.created AS c_created, c.edit_url, c.publish_url, c.description, c.sources FROM checks k JOIN cards c ON c.key = k.card_key`;

function state() {
  const now = Date.now(), dayAgo = now - 86400000;
  const needs = q(`${JOIN} WHERE k.status = 'done' AND k.verdict IN ('problem', 'check') AND k.dismissed = 0 AND k.finished_at > ? ORDER BY k.verdict = 'problem' DESC, k.finished_at DESC LIMIT 60`, now - 3 * 86400000).map(checkRow);
  const waitingSources = q(`${JOIN} WHERE k.status = 'waiting_sources' ORDER BY c.created`).map(checkRow);
  const waitingPublish = q(`${JOIN} WHERE k.status = 'waiting_publish' ORDER BY k.next_try LIMIT 40`).map(checkRow);
  const running = q(`${JOIN} WHERE k.status IN ('running', 'queued') ORDER BY k.created`).map(checkRow);
  const today = q(`SELECT c.site, k.kind, k.verdict, COUNT(*) AS n FROM checks k JOIN cards c ON c.key = k.card_key WHERE k.status = 'done' AND k.finished_at > ? GROUP BY 1, 2, 3`, dayAgo);
  const recentClear = q(`${JOIN} WHERE k.status = 'done' AND (k.verdict = 'clear' OR k.dismissed = 1) ORDER BY k.finished_at DESC LIMIT 8`).map(checkRow);
  const s = settings.get();
  return {
    version: VERSION, now, startedAt: monitor.startedAt, health: monitor.health, sourcesMinutes: s.sourcesMinutes,
    setup: { board: Boolean(s.boardUrl && s.boardToken), ai: keysOf(s, 'gemini').length + keysOf(s, 'mimo').length > 0, whatsapp: Boolean(s.bridgeToken && s.whatsappTo), sendWhatsApp: s.sendWhatsApp },
    sites: SITES.map(x => ({ id: x.id, label: x.label, name: x.name, enabled: s.sites[x.id]?.enabled !== false })),
    needs, waitingSources, waitingPublish, running, today, recentClear,
  };
}

function list(url) {
  const where = [`k.status NOT IN ('waiting_sources')`], args = [];
  const p = url.searchParams;
  if (p.get('site')) { where.push('c.site = ?'); args.push(p.get('site')); }
  if (p.get('kind')) { where.push('k.kind = ?'); args.push(p.get('kind')); }
  if (p.get('verdict')) { if (p.get('verdict') === 'open') where.push(`k.status NOT IN ('done', 'skipped', 'not_live', 'error')`); else { where.push('k.verdict = ?'); args.push(p.get('verdict')); } }
  if (p.get('writer')) { where.push('c.writer = ?'); args.push(p.get('writer')); }
  if (p.get('rule')) { where.push(`k.findings LIKE ?`); args.push(`%"rule":"${p.get('rule').replace(/[%_"]/g, '')}"%`); }
  if (p.get('q')) { where.push('(c.title LIKE ? OR c.writer LIKE ?)'); args.push(`%${p.get('q')}%`, `%${p.get('q')}%`); }
  const limit = Math.min(500, Number(p.get('limit')) || 200);
  return q(`${JOIN} WHERE ${where.join(' AND ')} ORDER BY COALESCE(k.finished_at, k.created) DESC LIMIT ${limit}`, ...args).map(checkRow);
}

function writers() {
  const rows = q(`${JOIN} WHERE k.status = 'done' AND k.finished_at > ?`, Date.now() - 30 * 86400000);
  const by = {};
  for (const r of rows) {
    const w = by[r.writer || 'Unknown'] ||= { writer: r.writer || 'Unknown', checks: 0, problems: 0, clear: 0, rules: {}, sites: new Set() };
    w.checks++; w.sites.add(r.site);
    if (r.verdict === 'problem') w.problems++;
    if (r.verdict === 'clear') w.clear++;
    for (const f of parse(r.findings, [])) w.rules[f.rule] = (w.rules[f.rule] || 0) + 1;
  }
  return Object.values(by).map(w => ({ ...w, sites: [...w.sites], top: Object.entries(w.rules).sort((a, b) => b[1] - a[1]).slice(0, 5) })).sort((a, b) => b.problems - a.problems || b.checks - a.checks);
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

async function api(req, url) {
  const m = url.pathname.match(/^\/api\/check\/(\d+)(?:\/(\w+))?$/);
  if (req.method === 'GET' && url.pathname === '/api/state') return state();
  if (req.method === 'GET' && url.pathname === '/api/checks') return { checks: list(url) };
  if (req.method === 'GET' && url.pathname === '/api/writers') return { writers: writers() };
  if (m && req.method === 'GET' && !m[2]) { const r = checkRow(one(`${JOIN} WHERE k.id = ?`, Number(m[1]))); if (!r) throw Object.assign(new Error('Not found'), { status: 404 }); r.messages = q('SELECT id, at, kind, text, status, error FROM messages WHERE card_key = ? ORDER BY at DESC', r.card.key); return r; }
  if (m && req.method === 'POST') {
    const id = Number(m[1]);
    if (m[2] === 'recheck') return { ok: monitor.recheck(id) };
    if (m[2] === 'dismiss' || m[2] === 'undismiss') { db.prepare('UPDATE checks SET dismissed = ? WHERE id = ?').run(m[2] === 'dismiss' ? 1 : 0, id); return { ok: true }; }
  }
  if (req.method === 'GET' && url.pathname === '/api/messages') return { messages: q('SELECT m.*, c.title, c.site FROM messages m LEFT JOIN cards c ON c.key = m.card_key ORDER BY m.at DESC LIMIT 200') };
  if (req.method === 'POST' && url.pathname.startsWith('/api/messages/') && url.pathname.endsWith('/resend')) {
    const msg = one('SELECT * FROM messages WHERE id = ?', Number(url.pathname.split('/')[3]));
    if (!msg) throw Object.assign(new Error('Not found'), { status: 404 });
    db.prepare(`UPDATE messages SET status = 'retry' WHERE id = ?`).run(msg.id);
    await monitor.notify(msg.kind, msg.card_key, msg.text, msg.idem);
    return one('SELECT id, status, error FROM messages WHERE id = ?', msg.id);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') return { events: q('SELECT * FROM events ORDER BY id DESC LIMIT 300') };
  if (req.method === 'GET' && url.pathname === '/api/rules') {
    return { status: rules.status(), guides: GUIDES.map(g => ({ ...g, url: docUrl(g.key), text: rules.text[g.key] })), rules: Object.entries(RULES).map(([id, r]) => ({ id, ...r })) };
  }
  if (req.method === 'POST' && url.pathname === '/api/rules/refresh') return rules.refresh();
  if (req.method === 'GET' && url.pathname === '/api/settings') return { settings: settings.public(keyStatus), sites: SITES };
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const { clean, errors } = validateSettings(await body(req));
    if (Object.keys(errors).length) throw Object.assign(new Error('Some settings are not valid'), { status: 400, errors });
    for (const k of SECRET) if (clean[k] === undefined) delete clean[k];
    settings.save(clean);
    if ('bridgeUrl' in clean) bridge.reset();
    logEvent(db, 'info', `Settings changed: ${Object.keys(clean).join(', ')}`);
    setTimeout(monitor.tick, 100);
    return { settings: settings.public(keyStatus) };
  }
  if (req.method === 'POST' && url.pathname === '/api/test/whatsapp') {
    await bridge.send('*Editorial Monitor*\nTest message: WhatsApp alerts are working.', `test:${Date.now()}`);
    return { ok: true };
  }
  if (req.method === 'POST' && url.pathname === '/api/test/ai') {
    // Each key on its own, so a bad one shows up even when another works.
    const s = settings.get(), results = [];
    for (const p of ['gemini', 'mimo']) for (const [i, key] of keysOf(s, p).entries()) {
      try { const r = await callModel({ ...s, geminiKeys: p === 'gemini' ? [key] : [], mimoKeys: p === 'mimo' ? [key] : [], geminiKey: '', mimoKey: '' }, { prompt: 'Answer with JSON only: {"ok":true}' }); results.push({ key: `${p === 'gemini' ? 'Gemini' : 'MiMo'} key ${i + 1}`, ok: true, engine: r.engine }); }
      catch (e) { results.push({ key: `${p === 'gemini' ? 'Gemini' : 'MiMo'} key ${i + 1}`, ok: false, error: (e.failures || [e.message]).join('; ') }); }
    }
    if (!results.length) throw Object.assign(new Error('Add a Gemini or MiMo key first'), { status: 400 });
    return { ok: results.some(r => r.ok), results };
  }
  throw Object.assign(new Error('Not found'), { status: 404 });
}

const server = createServer(async (req, res) => {
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!ALLOW_ALL && !ALLOWED.has(remote)) { res.writeHead(403).end('Forbidden'); return; }
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/api/')) {
      const out = await api(req, url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(out));
      return;
    }
    const path = normalize(join(WWW, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!path.startsWith(WWW)) { res.writeHead(403).end(); return; }
    const data = await readFile(path).catch(() => null);
    if (!data) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  } catch (e) {
    res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message, errors: e.errors }));
  }
});
server.listen(PORT, () => logEvent(db, 'info', `Editorial Monitor ${VERSION} started`));

const loop = () => monitor.tick().catch(e => logEvent(db, 'error', `Tick failed: ${e.message}`)).finally(() => setTimeout(loop, 30000));
setTimeout(loop, 2000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
