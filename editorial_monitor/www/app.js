// Editorial Monitor dashboard. No framework: each page is a function that returns HTML from
// the add-on's JSON API, and the detail drawer opens over any page. URLs are relative so
// the page works under Home Assistant's Ingress path.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICONS = {
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  problem: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  check: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  clear: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  wait: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  done: '<path d="M20 6 9 17l-5-5"/>',
  imageOff: '<path d="M2 2l20 20"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><path d="M13.5 13.5 6 21"/><path d="m18 12 3 3"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.05-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  pitch: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 13h4M10 17h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
};
const icon = (name, label) => `<svg class="icon" viewBox="0 0 24 24"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>${ICONS[name]}</svg>`;

const NAV = [
  ['Monitor', [['desk', 'Desk', 'inbox'], ['checks', 'All checks', 'list'], ['writers', 'Writers', 'users']]],
  ['Reference', [['rules', 'Rules', 'book'], ['messages', 'Messages', 'message'], ['activity', 'Activity', 'activity'], ['settings', 'Settings', 'settings']]],
];
const PAGES = NAV.flatMap(([, items]) => items.map(i => i[0]));
const VERDICT = { problem: 'Problem', check: 'To check', clear: 'Clear' };
const KIND = { pitch: 'Pitch', article: 'Article' };
const STATUS = { waiting_sources: 'Waiting for sources', queued: 'Queued', running: 'Checking', waiting_publish: 'Waiting to go live', done: 'Checked', error: 'Couldn\'t check', not_live: 'Never went live', skipped: 'Skipped' };

// ---------- data ----------
async function api(path, opts = {}) {
  if (window.DEMO) return window.DEMO.api(path, opts);
  const res = await fetch(path.replace(/^\//, ''), { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Request failed (${res.status})`), { errors: json.errors });
  return json;
}
const ui = { state: null, filter: { kind: '', site: '' }, list: { q: '', verdict: '', kind: '', site: '' }, rulesGuide: 'quickref', detail: null, ruleData: null };
let RULES = {};

// ---------- formatting ----------
const ago = ms => {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 0) return `in ${dur(-s * 1000)}`;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`; };
const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const when = ms => (ms ? new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const siteOf = id => ui.state?.sites.find(s => s.id === id) || { id, label: String(id || '').toUpperCase() };
const site = id => `<span class="site ${esc(id)}">${esc(siteOf(id).label)}</span>`;
const initials = n => String(n || '?').split(/[\s,]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const who = n => `<span class="who"><span class="avatar" aria-hidden="true">${esc(initials(n))}</span>${esc(n || 'Unknown writer')}</span>`;
const ruleTitle = id => RULES[id]?.title || id;
const sevTag = v => (v ? `<span class="tag ${v}">${VERDICT[v]}</span>` : '');
const counts = fs => { const p = fs.filter(f => f.severity === 'problem').length; return { p, c: fs.length - p }; };
const countText = fs => { const { p, c } = counts(fs); return [p && `${p} problem${p > 1 ? 's' : ''}`, c && `${c} to check`].filter(Boolean).join(', ') || 'No issues'; };
const say = t => { $('#live').textContent = t; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- shell ----------
function route() {
  const [page = 'desk', id] = location.hash.replace(/^#\/?/, '').split('/');
  if (page === 'check') return { page: ui.lastPage || 'desk', id: Number(id) };
  return { page: PAGES.includes(page) ? page : 'desk', id: null };
}
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function renderShell() {
  const cur = route().page, n = ui.state?.needs?.length || 0;
  $('#nav').innerHTML = NAV.map(([label, items]) => `<div class="nav-group"><span class="nav-label">${label}</span>${items.map(([id, l, ic]) => `<a class="nav-item" href="#/${id}"${cur === id ? ' aria-current="page"' : ''}>${icon(ic)}<span>${l}</span>${id === 'desk' && n ? `<span class="count num" aria-label="${n} need you">${n}</span>` : ''}</a>`).join('')}</div>`).join('');
  const s = ui.state;
  const rows = s ? statusRows(s) : [];
  $('#side-foot').innerHTML = `${rows.length ? `<div class="status-card" aria-label="System status">${rows.map(([c, t, w]) => `<div class="status-row"><span class="dot ${c}" aria-hidden="true"></span><span>${esc(t)}</span>${w ? `<span class="when">${esc(w)}</span>` : ''}</div>`).join('')}</div>` : ''}
    <button type="button" class="btn ghost" id="theme">${icon(isDark() ? 'sun' : 'moon')}${isDark() ? 'Light theme' : 'Dark theme'}</button>`;
}
function statusRows(s) {
  const h = s.health, sites = s.sites.filter(x => x.enabled), bad = sites.filter(x => h.board[x.id]?.ok === false);
  return [
    !s.setup.board ? ['off', 'Board not connected'] : bad.length ? ['bad', `Board: ${bad.map(x => x.label).join(', ')} down`] : ['ok', 'Board', ago(h.lastTick)],
    !s.setup.ai ? ['off', 'AI not set up'] : h.ai.ok === false ? ['bad', 'AI unavailable'] : ['ok', h.ai.engine ? h.ai.engine.replace(/ \(.*/, '') : 'AI ready'],
    !s.setup.whatsapp ? ['off', 'WhatsApp not set up'] : !s.setup.sendWhatsApp ? ['off', 'WhatsApp paused'] : h.whatsapp.ok === false ? ['bad', 'WhatsApp failing'] : ['ok', 'WhatsApp'],
  ];
}
try { const t = localStorage.getItem('em-theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* private mode */ }

// Same page again (a filter, the 10-second refresh): swap only the parts marked data-part and
// update the controls in place, so the control in use keeps focus and nothing jumps.
const controlKey = el => [...el.attributes].filter(x => x.name.startsWith('data-') && x.name !== 'data-kbd-item').map(x => `[${x.name}="${CSS.escape(x.value)}"]`).join('');
function patch(main, html, page) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const parts = [...tpl.content.querySelectorAll('[data-part]')];
  if (main.dataset.page !== page || !parts.length || parts.some(p => !main.querySelector(`[data-part="${p.dataset.part}"]`))) { main.innerHTML = html; main.dataset.page = page; return; }
  for (const p of parts) main.querySelector(`[data-part="${p.dataset.part}"]`).replaceWith(p);
  main.querySelectorAll('[role="radio"],[aria-pressed]').forEach(el => {
    const twin = tpl.content.querySelector(controlKey(el) || '#none');
    if (!twin) return;
    for (const k of ['aria-checked', 'aria-pressed']) if (twin.hasAttribute(k)) el.setAttribute(k, twin.getAttribute(k));
    if (el.innerHTML !== twin.innerHTML) el.innerHTML = twin.innerHTML;
  });
  rove(main);
}

async function render() {
  const { page, id } = route();
  if (page !== ui.lastPage) ui.lastPage = page;
  renderShell();
  try {
    const html = await PAGE_RENDER[page]();
    // Re-rendering replaces the page; keep keyboard focus on the same control.
    const a = document.activeElement, sel = a && $('#main').contains(a) ? (a.id ? `#${CSS.escape(a.id)}` : [...a.attributes].filter(x => x.name.startsWith('data-')).map(x => `[${x.name}="${CSS.escape(x.value)}"]`).join('')) : '';
    if (route().page === page) patch($('#main'), html, page);
    if (sel && !$('#main').contains(document.activeElement)) { rove(); $(sel, $('#main'))?.focus(); }
    renderShell();
  } catch (e) {
    $('#main').innerHTML = `<div class="card empty-state"><h3>This page couldn't load</h3><p>${esc(e.message)}. It tries again in a few seconds.</p></div>`;
  }
  if (id) openDetail(id); else closeDetail(false);
}
window.addEventListener('hashchange', render);

// ---------- desk ----------
function issueLine(c) {
  const f = c.findings.find(x => x.severity === 'problem') || c.findings[0];
  if (!f) return '';
  const text = f.evidence && f.evidence.length <= 160 ? f.evidence : f.note || f.evidence;
  return `<span class="row-issue"><b>${esc(ruleTitle(f.rule))}:</b> ${esc(text)}</span>`;
}
function thumb(c) {
  const img = c.info?.image;
  if (c.kind === 'article' && img) return `<img class="thumb" src="${esc(img.preview || img.url)}" alt="" loading="lazy">`;
  if (c.kind === 'article' && c.status === 'done') return `<span class="thumb" title="No featured image">${icon('imageOff')}</span>`;
  return `<span class="thumb">${icon('pitch')}</span>`;
}
const rowHtml = c => `<li><button class="row" type="button" data-open="${c.id}">
  <span class="row-lead"><span class="sev ${c.verdict}">${icon(c.verdict, VERDICT[c.verdict])}</span>${thumb(c)}</span>
  <span class="row-main"><span class="row-title">${esc(c.card.title)}</span>
    <span class="row-meta">${site(c.card.site)}<span>${KIND[c.kind]}</span>${who(c.card.writer)}</span>
    ${issueLine(c)}</span>
  <span class="row-side"><span class="num">${ago(c.finishedAt)}</span>${c.findings.length ? `<span>${counts(c.findings).p ? `<span class="tag problem num" aria-label="${counts(c.findings).p} problems">${counts(c.findings).p}</span> ` : ''}${counts(c.findings).c ? `<span class="tag check num" aria-label="${counts(c.findings).c} to check">${counts(c.findings).c}</span>` : ''}</span>` : ''}</span></button></li>`;

function ring(c, minutes) {
  const total = minutes * 60000, deadline = c.card.created + total, left = deadline - Date.now();
  const r = 11, len = 2 * Math.PI * r;
  const late = left <= 0;
  return `<span class="countdown${late ? ' late' : ''}" data-deadline="${deadline}" data-total="${total}" data-alerted="${c.sourcesAlerted ? 1 : 0}">
    <svg class="ring" viewBox="0 0 28 28" aria-hidden="true"><circle class="track" cx="14" cy="14" r="${r}"/><circle class="prog" cx="14" cy="14" r="${r}" stroke-dasharray="${len.toFixed(2)}" stroke-dashoffset="${(len * Math.max(0, left) / total).toFixed(2)}"/></svg>
    <span class="timer num">${late ? (c.sourcesAlerted ? 'Alerted' : 'Due') : clock(left)}</span></span>`;
}

async function pageDesk() {
  const s = ui.state = await api('/api/state');
  const f = ui.filter;
  const shown = s.needs.filter(c => (!f.kind || c.kind === f.kind) && (!f.site || c.card.site === f.site));
  const n = s.needs.length, all = s.needs.flatMap(c => c.findings), { p, c } = counts(all);
  const perSite = s.sites.map(x => ({ ...x, ...counts(s.needs.filter(k => k.card.site === x.id).flatMap(k => k.findings)) }));
  const max = Math.max(1, ...perSite.map(x => x.p + x.c));
  const missing = [!s.setup.board && 'the board feed token', !s.setup.ai && 'an AI key', !s.setup.whatsapp && 'WhatsApp'].filter(Boolean);

  const hero = `<section class="card hero" aria-label="Summary"><div class="hero-main">
      <div><div class="hero-label">Needs you</div>
        <div class="hero-num${n ? '' : ' zero'}"><strong class="num">${n}</strong><span>${n ? `${n === 1 ? 'story' : 'stories'} from the last 3 days` : 'Everything checked is clear'}</span></div>
        <div class="split"><span class="key"><span class="sq problem" aria-hidden="true"></span><b class="num">${p}</b> problems</span><span class="key"><span class="sq check" aria-hidden="true"></span><b class="num">${c}</b> to check</span></div></div>
      <div class="bars" role="img" aria-label="${esc(`Open issues by site. ${perSite.map(x => `${x.label}: ${x.p} problems, ${x.c} to check`).join('; ')}`)}">
        <div class="bars-title" aria-hidden="true">Open issues by site</div>
        ${perSite.map(x => `<div class="bar-row" aria-hidden="true"><span class="site ${x.id}">${x.label}</span><span class="bar"><i class="problem" style="width:${(x.p / max) * 100}%"></i><i class="check" style="width:${(x.c / max) * 100}%"></i></span><span class="n num">${x.p + x.c}</span></div>`).join('')}
      </div></div>
    <div class="pipeline">
      <div class="pipe"><b class="num">${s.waitingSources.length}</b><span>Waiting for sources</span></div>
      <div class="pipe"><b class="num">${s.running.length}</b><span>Being checked</span></div>
      <div class="pipe"><b class="num">${s.waitingPublish.length}</b><span>Scheduled to go live</span></div>
    </div></section>`;
  const setup = missing.length ? `<div class="callout"><p><strong>Finish setup.</strong> Add ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} to start monitoring.</p><a class="btn primary sm" href="#/settings">Open settings</a></div>` : '';
  const kinds = [['', 'All'], ['pitch', 'Pitches'], ['article', 'Articles']];
  const toolbar = `<div class="toolbar"><div class="toolbar-l"><div class="seg" role="radiogroup" aria-label="Show">${kinds.map(([k, l]) => `<button type="button" role="radio" aria-checked="${f.kind === k}" data-fkind="${k}">${l}</button>`).join('')}</div></div>
    <div class="toolbar-r" role="group" aria-label="Filter by site">${s.sites.map(x => `<button type="button" class="pill" aria-pressed="${f.site === x.id}" data-fsite="${x.id}"><span class="site ${x.id}">${x.label}</span><span class="n num">${s.needs.filter(k => k.card.site === x.id).length}</span></button>`).join('')}</div></div>`;
  const list = shown.length ? `<ul class="card list">${shown.map(rowHtml).join('')}</ul>`
    : `<div class="card empty-state"><span class="badge-ic">${icon('done')}</span><h3>${n ? 'Nothing for this filter' : 'You\'re all caught up'}</h3><p>${n ? 'Try another filter to see the rest.' : 'Pitches are checked as soon as their sources are added, and articles once they go live. Anything that needs you shows up here and on WhatsApp.'}</p></div>`;
  const mini = (rows, right, empty) => (rows.length ? `<ul class="mini">${rows.map(k => `<li><button type="button" class="mini-row" data-open="${k.id}"><span><span class="mini-title">${esc(k.card.title)}</span><span class="mini-meta">${site(k.card.site)}<span>${esc(k.card.writer || 'Unknown')}</span></span></span>${right(k)}</button></li>`).join('')}</ul>` : `<p class="empty">${empty}</p>`);
  const live = `<div class="live">
    <section class="card" aria-labelledby="h-src"><div class="card-head"><h2 id="h-src">Waiting for sources</h2><span class="meta-r">Alert after ${s.sourcesMinutes} min</span></div>
      ${mini(s.waitingSources, k => ring(k, s.sourcesMinutes), 'No pitch is waiting for sources.')}</section>
    <section class="card" aria-labelledby="h-run"><div class="card-head"><h2 id="h-run">Being checked</h2><span class="meta-r num">${s.running.length}</span></div>
      ${mini(s.running, k => `<span class="tag neutral">${KIND[k.kind]}</span>`, 'Nothing in the queue.')}</section>
    <section class="card" aria-labelledby="h-pub"><div class="card-head"><h2 id="h-pub">Scheduled to go live</h2><span class="meta-r num">${s.waitingPublish.length}</span></div>
      ${mini(s.waitingPublish, k => `<span class="mini-meta num">${k.nextTry > Date.now() ? `next look ${ago(k.nextTry)}` : 'looking now'}</span>`, 'No scheduled article is waiting.')}</section>
  </div>`;
  const by = (siteId, kind, verdict) => s.today.filter(r => r.site === siteId && (!kind || r.kind === kind) && (!verdict || r.verdict === verdict)).reduce((a, r) => a + r.n, 0);
  const today = `<section class="card table-card" style="margin-top:var(--s6)" aria-labelledby="h-today"><div class="card-head"><h2 id="h-today">Last 24 hours</h2></div>
    <table class="t num"><caption class="sr-only">Checks in the last 24 hours by site</caption><thead><tr><th scope="col">Site</th><th scope="col">Pitches</th><th scope="col">Articles</th><th scope="col">Problems</th><th scope="col">To check</th><th scope="col">Clear</th></tr></thead>
    <tbody>${s.sites.map(x => `<tr><th scope="row">${site(x.id)}${x.enabled ? '' : ' <span class="muted">(off)</span>'}</th><td>${by(x.id, 'pitch')}</td><td>${by(x.id, 'article')}</td><td>${by(x.id, '', 'problem')}</td><td>${by(x.id, '', 'check')}</td><td>${by(x.id, '', 'clear')}</td></tr>`).join('')}</tbody></table></section>`;
  return `<header class="head"><div><h1>Desk</h1><p>Pitches and published articles that break a rule or need a second look. Mark each one as fine once it's handled.</p></div></header>
    <div data-part="top">${setup}${hero}</div><div class="desk"><section aria-label="Needs you">${toolbar}<div data-part="list">${list}</div></section><div data-part="live">${live}</div></div><div data-part="today">${today}</div>
    <p class="foot">Editorial Monitor ${esc(s.version)}. Running since ${when(s.startedAt)}.</p>`;
}

// ---------- all checks ----------
const checkRowHtml = c => `<tr data-open="${c.id}" tabindex="0"><td>${c.status === 'done' ? sevTag(c.dismissed ? 'clear' : c.verdict) : `<span class="tag neutral">${STATUS[c.status] || c.status}</span>`}</td>
  <td class="title-cell">${esc(c.card.title)}</td><td>${site(c.card.site)}</td><td class="hide-sm">${KIND[c.kind]}</td><td class="hide-sm">${who(c.card.writer)}</td>
  <td class="hide-sm muted">${c.status === 'done' ? esc(countText(c.findings)) : esc(c.error || '')}</td><td class="num muted">${ago(c.finishedAt || c.created)}</td></tr>`;
async function pageChecks() {
  if (!ui.state) ui.state = await api('/api/state');
  const l = ui.list, p = new URLSearchParams(Object.entries(l).filter(([, v]) => v));
  const { checks } = await api(`/api/checks?${p}`);
  const seg = (key, opts, label) => `<div class="seg" role="radiogroup" aria-label="${label}">${opts.map(([v, t]) => `<button type="button" role="radio" aria-checked="${l[key] === v}" data-l${key}="${v}">${t}</button>`).join('')}</div>`;
  return `<header class="head"><div><h1>All checks</h1><p>Every pitch and article the monitor has looked at, newest first.</p></div>
      <div class="head-actions"><div class="search-wrap">${icon('search')}<label class="sr-only" for="q">Search headlines and writers</label><input id="q" class="input" type="search" placeholder="Search headlines or writers" value="${esc(l.q)}"></div></div></header>
    <div class="toolbar"><div class="toolbar-l">${seg('verdict', [['', 'Any'], ['problem', 'Problems'], ['check', 'To check'], ['clear', 'Clear'], ['open', 'In progress']], 'Result')}${seg('kind', [['', 'Both'], ['pitch', 'Pitches'], ['article', 'Articles']], 'Kind')}</div>
      <div class="toolbar-r" role="group" aria-label="Site">${ui.state.sites.map(s => `<button type="button" class="pill" aria-pressed="${l.site === s.id}" data-lsite-toggle="${s.id}"><span class="site ${s.id}">${s.label}</span></button>`).join('')}</div></div>
    <div data-part="checks">${checks.length ? `<div class="card table-card"><table class="t"><caption class="sr-only">Checks</caption><thead><tr><th scope="col">Result</th><th scope="col">Headline</th><th scope="col">Site</th><th scope="col" class="hide-sm">Kind</th><th scope="col" class="hide-sm">Writer</th><th scope="col" class="hide-sm">Issues</th><th scope="col">When</th></tr></thead><tbody>${checks.map(checkRowHtml).join('')}</tbody></table></div>`
      : `<div class="card empty-state"><h3>No checks match</h3><p>Clear the search or pick another filter.</p></div>`}</div>`;
}

// ---------- writers ----------
async function pageWriters() {
  await loadRules();
  if (!ui.state) ui.state = await api('/api/state');
  const { writers } = await api('/api/writers');
  return `<header class="head"><div><h1>Writers</h1><p>The last 30 days. A note on one article is a note for all of them, so each writer's most common issues are worth passing on.</p></div></header>
  ${writers.length ? `<div class="card table-card"><table class="t"><caption class="sr-only">Writers and their most common issues</caption><thead><tr><th scope="col">Writer</th><th scope="col">Checks</th><th scope="col">Problems</th><th scope="col" class="hide-sm">Clear</th><th scope="col">Most common issues</th></tr></thead>
  <tbody>${writers.map(w => `<tr data-writer="${esc(w.writer)}" tabindex="0"><td class="title-cell">${who(w.writer)}<div class="mini-meta">${w.sites.map(site).join('')}</div></td><td class="num">${w.checks}</td><td class="num">${w.problems}</td><td class="num hide-sm">${w.clear}</td>
  <td><div class="btn-row">${w.top.map(([r, n]) => `<span class="tag neutral">${esc(ruleTitle(r))} <span class="num muted">${n}</span></span>`).join('') || '<span class="muted">None</span>'}</div></td></tr>`).join('')}</tbody></table></div>`
    : '<div class="card empty-state"><h3>No checks yet</h3><p>Writers appear here after their first pitch or article is checked.</p></div>'}`;
}

// ---------- rules ----------
async function loadRules() { if (!ui.ruleData) { ui.ruleData = await api('/api/rules'); RULES = Object.fromEntries(ui.ruleData.rules.map(r => [r.id, r])); } return ui.ruleData; }
const shortGuide = t => t.replace(/ guide$/, '').replace('Syndication quick reference', 'Quick reference').replace('Embeds, images and WordPress', 'WordPress').replace('Content and accuracy', 'Content');
async function pageRules() {
  const d = await loadRules();
  const g = d.guides.find(x => x.key === ui.rulesGuide) || d.guides[0];
  const by = { code: ['clear', 'Code'], ai: ['accent', 'AI'], manual: ['neutral', 'Not checkable'] };
  const rules = d.rules.filter(r => r.guide === g.key);
  const total = d.rules.reduce((a, r) => ({ ...a, [r.by]: (a[r.by] || 0) + 1 }), {});
  return `<header class="head"><div><h1>Rules</h1><p>The seven guides exactly as the monitor reads them: ${total.code} rules are checked by code, ${total.ai} judged by AI, and ${total.manual || 0} can't be checked from outside. ${d.status.refreshedAt ? `Downloaded ${ago(Date.parse(d.status.refreshedAt))}.` : 'This is the copy that ships with the add-on.'}</p></div>
    <div class="head-actions"><button type="button" class="btn" id="refresh-rules">${icon('refresh')}Download again</button></div></header>
    <div class="toolbar"><div class="seg" role="radiogroup" aria-label="Guide">${d.guides.map(x => `<button type="button" role="radio" aria-checked="${x.key === g.key}" data-guide="${x.key}">${esc(shortGuide(x.title))}</button>`).join('')}</div></div>
    <div class="rules" data-part="rules"><section class="card" aria-labelledby="h-doc"><div class="card-head"><h2 id="h-doc">${esc(g.title)}</h2><a class="btn ghost sm" href="${esc(g.url)}" target="_blank" rel="noopener">${icon('external')}Google Docs</a></div><div class="doc">${esc(g.text)}</div></section>
    <section class="card" aria-labelledby="h-checks"><div class="card-head"><h2 id="h-checks">What's checked from this guide</h2><span class="meta-r num">${rules.length}</span></div>
      ${rules.map(r => `<div class="rule"><div><strong>${esc(r.title)}</strong><q>${esc(r.quote)}</q></div><span class="tag ${by[r.by][0]}">${by[r.by][1]}</span></div>`).join('') || '<p class="empty">This guide is covered through the others.</p>'}</section></div>`;
}

// ---------- messages / activity ----------
async function pageMessages() {
  if (!ui.state) ui.state = await api('/api/state');
  const { messages } = await api('/api/messages');
  const st = m => (m.status === 'sent' ? '<span class="tag clear">Sent</span>' : m.status === 'failed' ? '<span class="tag problem">Failed</span>' : `<span class="tag neutral">${esc(m.status)}</span>`);
  return `<header class="head"><div><h1>Messages</h1><p>Everything sent to WhatsApp, newest first.</p></div></header>
  ${messages.length ? `<div class="msgs">${messages.map(m => `<article class="card msg"><div class="msg-head">${st(m)}<span class="num">${when(m.at)}</span><span>${esc(m.kind.replace('_', ' '))}</span>${m.site ? site(m.site) : ''}${m.status === 'failed' ? `<button type="button" class="btn sm" data-resend="${m.id}">${icon('send')}Send again</button>` : ''}</div>${m.error ? `<p class="status-line bad">${esc(m.error)}</p>` : ''}<p class="wa">${esc(m.text)}</p></article>`).join('')}</div>`
    : '<div class="card empty-state"><h3>No messages yet</h3><p>Alerts appear here as they are sent. Settings has a button to send a test message.</p></div>'}`;
}
async function pageActivity() {
  const { events } = await api('/api/events');
  return `<header class="head"><div><h1>Activity</h1><p>What the monitor did, and anything that went wrong.</p></div></header>
  <div class="card table-card"><table class="t"><caption class="sr-only">Activity log</caption><thead><tr><th scope="col">When</th><th scope="col">Level</th><th scope="col">What happened</th></tr></thead><tbody>
  ${events.map(e => `<tr><td class="num muted">${when(e.at)}</td><td>${e.level === 'error' ? '<span class="tag problem">Error</span>' : '<span class="tag neutral">Info</span>'}</td><td>${esc(e.text)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Nothing yet.</td></tr>'}</tbody></table></div>`;
}

// ---------- settings ----------
let draft = null;
async function pageSettings() {
  const { settings: s, sites } = await api('/api/settings');
  draft = { switches: {}, sites: {}, keys: { geminiKeys: { keep: s.geminiKeys.map(k => k.i), add: [] }, mimoKeys: { keep: s.mimoKeys.map(k => k.i), add: [] } } };
  ui.settings = s;
  const text = (k, label, hint, type = 'text', ph = '') => `<div class="field"><label for="f-${k}">${label}</label><input class="input" id="f-${k}" data-k="${k}" type="${type}" value="${type === 'password' ? '' : esc(s[k])}" placeholder="${esc(type === 'password' ? (s[k] ? `Saved, ends ${s[k].replace('set, ends ', '')}. Type to replace.` : 'Not set') : ph)}" autocomplete="off" spellcheck="false">${hint ? `<span class="hint">${hint}</span>` : ''}<span class="err" data-err="${k}"></span></div>`;
  const num = (k, label, hint, min, max) => `<div class="field"><label for="f-${k}">${label}</label><input class="input num" id="f-${k}" data-k="${k}" data-num type="number" min="${min}" max="${max}" step="1" value="${esc(s[k])}">${hint ? `<span class="hint">${hint}</span>` : ''}<span class="err" data-err="${k}"></span></div>`;
  const sw = (k, label, hint) => `<div class="switch-row"><span class="text"><span class="label" id="l-${k}">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</span><button type="button" class="switch" role="switch" aria-checked="${Boolean(s[k])}" aria-labelledby="l-${k}" data-sw="${k}"></button></div>`;
  const section = (id, title, sub, body) => `<section class="card section" id="sec-${id}" aria-labelledby="h-${id}"><div class="card-head"><h2 id="h-${id}">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div><div class="fields">${body}</div></section>`;
  const sections = [
    ['board', 'Gamurs board', 'Where the cards come from.', `<div class="grid2">${text('boardUrl', 'Board address', '', 'url', 'https://writer-board.gamurs.group')}${text('boardToken', 'Feed token', 'The PDC Monitor feed token from the board\'s Admin page.', 'password')}</div>`],
    ['ai', 'AI keys', 'Keys are tried in order. A rate-limited key rests for 2 minutes and a refused key for 30 while the next one takes over. MiMo is used when every Gemini key fails.',
      `${keyList('geminiKeys', 'Gemini keys', s.geminiKeys)}<hr class="divider">${keyList('mimoKeys', 'MiMo keys', s.mimoKeys)}<hr class="divider">
       <div class="grid2">${text('geminiModel', 'Gemini model', 'Used for the full review of each pitch and article.')}${text('factModel', 'Headline fact-check model', 'Checks each headline claim against its source. Its findings are always marked To check.')}${text('mimoModel', 'MiMo model', 'Used when every Gemini key fails.')}</div>
       <div class="btn-row"><button type="button" class="btn" id="test-ai">${icon('refresh')}Test every key</button><span class="status-line" id="ai-status" role="status"></span></div>`],
    ['whatsapp', 'WhatsApp', 'Sent through the PDC WhatsApp Bridge.', `<div class="grid2">${text('bridgeToken', 'Bridge token', 'The bridge\'s api_token.', 'password')}${text('whatsappTo', 'Your number', 'The bridge\'s recipient, for example +8801XXXXXXXXX.', 'tel', '+8801XXXXXXXXX')}</div>${text('bridgeUrl', 'Bridge address (optional)', 'Leave empty and the PDC bridge add-on is found automatically.', 'url', 'http://...:8787')}
       ${sw('sendWhatsApp', 'Send WhatsApp messages', 'When off, checks still run and appear here, but nothing is sent.')}
       <div class="btn-row"><button type="button" class="btn" id="test-wa">${icon('send')}Send a test message</button><span class="status-line" id="wa-status" role="status"></span></div>`],
    ['alerts', 'Alerts', 'What reaches your phone.', `${sw('alertProblems', 'Problems', 'Clear rule breaks.')}${sw('alertChecks', 'Things to check', 'Likely issues that need your eye.')}${sw('alertHealth', 'Monitor health', 'When a site\'s board can\'t be read for 10 minutes.')}<div class="grid2">${num('sourcesMinutes', 'No-sources alert after (minutes)', 'Measured from when the card was made.', 1, 120)}</div>`],
    ['sites', 'Sites', 'Which sites are watched and what their primary category should be.', sites.map(x => `<div class="grid2"><div class="switch-row"><span class="text"><span class="label" id="l-site-${x.id}">${esc(x.name)}</span><span class="hint">${site(x.id)} ${plural(x.interlinks, 'interlink')} needed</span></span><button type="button" class="switch" role="switch" aria-checked="${s.sites[x.id]?.enabled !== false}" aria-labelledby="l-site-${x.id}" data-site-sw="${x.id}"></button></div>
      <div class="field"><label for="f-pc-${x.id}">Primary category</label><input class="input" id="f-pc-${x.id}" data-pc="${x.id}" value="${esc(s.sites[x.id]?.primaryCategory ?? '')}"><span class="err" data-err="sites.${x.id}"></span></div></div>`).join('<hr class="divider">')],
    ['checks', 'Checks', 'Fine-tuning for the article checks.', `${sw('checkImage', 'Look at the featured image', 'The AI checks it against the MSN and NewsBreak list and the headline.')}<div class="grid2">${num('charsPerLine', 'Characters per line', 'Used to estimate the five-line paragraph limit.', 40, 200)}${num('backfillMinutes', 'Catch up on start (minutes)', 'Cards made this long before a restart are still checked.', 0, 1440)}</div>`],
    ['rules', 'Rules', 'The guides the checks are based on.', sw('rulesAutoRefresh', 'Download the guides every day', 'Off: the monitor keeps its copy until you download them on the Rules page.')],
  ];
  return `<header class="head"><div><h1>Settings</h1><p>Changes apply as soon as they're saved. Saved keys and tokens are never shown again.</p></div></header>
  <div class="settings"><nav class="settings-index" aria-label="Settings sections">${sections.map(([id, t]) => `<a href="#/settings" data-jump="sec-${id}">${t}</a>`).join('')}</nav>
  <form class="settings-main" id="settings" novalidate>${sections.map(x => section(...x)).join('')}
    <div class="save-bar"><button type="submit" class="btn primary" id="save">${icon('done')}Save changes</button><span class="status-line" id="save-status" role="status"></span></div></form></div>`;
}
function keyList(k, label, keys) {
  return `<div class="field"><span class="label" id="l-${k}">${label}</span><div class="keys" data-keys="${k}" role="group" aria-labelledby="l-${k}">
    ${keys.map(x => `<div class="key-row" data-key-i="${x.i}"><span class="avatar num" aria-hidden="true">${x.i + 1}</span><span class="k">Key ending ${esc(x.ends)}</span>
      <span class="st">${x.at ? `<span class="dot ${x.ok ? 'ok' : 'bad'}" aria-hidden="true"></span>${esc(x.ok ? `Worked ${ago(x.at)}` : `${x.error}, ${ago(x.at)}`)}` : 'Not used yet'}</span>
      <button type="button" class="btn ghost sm" data-key-remove="${k}:${x.i}" aria-label="Remove key ending ${esc(x.ends)}">${icon('trash')}Remove</button></div>`).join('') || '<p class="hint">No keys yet.</p>'}
    <div class="keys" data-new-keys="${k}"></div>
    <div class="key-add"><label class="sr-only" for="add-${k}">New ${label.replace(/s$/, '')}</label><input class="input" id="add-${k}" type="password" placeholder="Paste a key" autocomplete="off" spellcheck="false"><button type="button" class="btn" data-key-add="${k}">${icon('plus')}Add</button></div>
    <span class="err" data-err="${k}"></span></div></div>`;
}

// ---------- detail drawer ----------
async function openDetail(id) {
  const panel = $('#panel'), scrim = $('#scrim');
  if (!panel.hidden && ui.detail?.id === id) return;
  ui.returnFocus = document.activeElement;
  panel.hidden = false; scrim.hidden = false;
  panel.innerHTML = `<div class="drawer-head"><div class="drawer-top"><span class="crumbs">Loading</span><button type="button" class="btn ghost icon-only" data-close aria-label="Close">${icon('x')}</button></div><h2 id="panel-title">Loading the check</h2></div>`;
  requestAnimationFrame(() => { panel.classList.add('open'); scrim.classList.add('open'); });
  try {
    await loadRules();
    if (!ui.state) ui.state = await api('/api/state');
    const c = ui.detail = await api(`/api/check/${id}`);
    panel.innerHTML = detailHtml(c);
    $('[data-close]', panel).focus();
  } catch (e) { panel.innerHTML = `<div class="drawer-head"><div class="drawer-top"><span></span><button type="button" class="btn ghost icon-only" data-close aria-label="Close">${icon('x')}</button></div><h2 id="panel-title">This check couldn't load</h2><p class="muted">${esc(e.message)}</p></div>`; }
}
function closeDetail(updateHash = true) {
  const panel = $('#panel'), scrim = $('#scrim');
  if (panel.hidden) return;
  panel.classList.remove('open'); scrim.classList.remove('open');
  setTimeout(() => { panel.hidden = true; scrim.hidden = true; }, 260);
  ui.detail = null;
  if (updateHash && location.hash.startsWith('#/check/')) history.replaceState(null, '', `#/${ui.lastPage || 'desk'}`);
  ui.returnFocus?.focus?.();
}
function findingHtml(f) {
  const r = RULES[f.rule] || {};
  const guide = ui.ruleData?.guides.find(g => g.key === r.guide);
  return `<article class="finding"><span class="sev ${f.severity}">${icon(f.severity, VERDICT[f.severity])}</span><div>
    <h3>${esc(ruleTitle(f.rule))}</h3>
    ${f.evidence ? `<p class="found">${esc(f.evidence)}</p>` : ''}${f.note ? `<p class="note">${esc(f.note)}</p>` : ''}
    ${r.quote ? `<p class="guide-line"><q>${esc(r.quote)}</q>${guide ? ` <a href="${esc(guide.url)}" target="_blank" rel="noopener">${esc(guide.title)}</a>` : ''}</p>` : ''}
    <div class="by"><span class="tag ${f.by === 'ai' ? 'accent' : 'neutral'}">${f.by === 'ai' ? 'AI, double-checked' : 'Code'}</span></div></div></article>`;
}
function detailHtml(c) {
  const i = c.info || {};
  const problems = c.findings.filter(f => f.severity === 'problem'), checks = c.findings.filter(f => f.severity !== 'problem');
  const actions = `<div class="btn-row">
    ${c.status === 'done' && c.verdict !== 'clear' ? (c.dismissed ? `<button type="button" class="btn" data-undismiss="${c.id}">${icon('undo')}Back to Needs you</button>` : `<button type="button" class="btn primary" data-dismiss="${c.id}">${icon('done')}Mark as fine</button>`) : ''}
    <a class="btn" href="${esc(c.card.url)}" target="_blank" rel="noopener">${icon('external')}Card</a>
    ${i.link ? `<a class="btn" href="${esc(i.link)}" target="_blank" rel="noopener">${icon('external')}Article</a>` : ''}
    ${c.card.editUrl ? `<a class="btn" href="${esc(c.card.editUrl)}" target="_blank" rel="noopener">${icon('external')}Edit</a>` : ''}
    <button type="button" class="btn ghost" data-recheck="${c.id}">${icon('refresh')}Recheck</button>
    ${c.findings.length ? `<button type="button" class="btn ghost" data-copy>${icon('copy')}<span>Copy issues</span></button>` : ''}</div>`;
  const status = c.status === 'done' ? `${sevTag(c.dismissed ? 'clear' : c.verdict)}<span>${esc(countText(c.findings))}, checked ${ago(c.finishedAt)}</span>${c.dismissed ? '<span class="tag neutral">Marked as fine</span>' : ''}`
    : `<span class="tag neutral">${STATUS[c.status] || c.status}</span>${c.error ? `<span>${esc(c.error)}</span>` : ''}`;
  const group = (title, list, sev) => (list.length ? `<section aria-label="${title}"><div class="group-title"><span class="sev ${sev}" aria-hidden="true">${icon(sev)}</span>${title} <span class="muted num">${list.length}</span></div><div class="findings">${list.map(findingHtml).join('')}</div></section>` : '');
  const checkedBy = `${esc(i.engine ? `Code and ${i.engine}${i.factEngine ? `, headline fact check by ${i.factEngine}` : ''}` : 'Code')}${i.aiNote ? `. ${esc(i.aiNote)}` : ''}`;
  const article = c.kind === 'article' && c.status === 'done' ? `<section class="card" aria-labelledby="h-art"><div class="card-head"><h2 id="h-art">Published article</h2>${i.published ? `<span class="meta-r">${when(Date.parse(i.published))}</span>` : ''}</div>
    <div class="article-card"><div>${i.image ? `<img src="${esc(i.image.preview || i.image.url)}" alt="${esc(i.image.title || 'Featured image')}" loading="lazy"><div class="img-caption"><strong>${esc(i.image.title || '(no title)')}</strong><span>${esc(String(i.image.caption || '').replace(/<[^>]+>/g, '').trim() || '(no credit)')}</span><span class="num">${i.image.width || '?'} x ${i.image.height || '?'}</span></div>` : `<div class="no-image">${icon('imageOff')}<span>No featured image</span></div>`}</div>
    <dl class="facts"><dt>SEO title</dt><dd>${esc(i.seoTitle || '')}</dd><dt>Tags</dt><dd>${esc((i.tags || []).map(t => t.name).join(', ') || 'None')}</dd><dt>Categories</dt><dd>${esc((i.categories || []).join(', '))}</dd>
      <dt>Words</dt><dd class="num">${i.stats?.words ?? ''}</dd><dt>Interlinks</dt><dd class="num">${i.stats?.interlinks ?? ''}</dd><dt>Embeds</dt><dd class="num">${i.stats?.embeds ?? ''}</dd><dt>Checked by</dt><dd>${checkedBy}</dd></dl></div></section>` : '';
  const pitch = c.kind === 'pitch' ? `<section class="card" aria-labelledby="h-pitch"><div class="card-head"><h2 id="h-pitch">The pitch</h2><span class="meta-r">${when(c.card.created)}</span></div><div class="card-body"><dl class="facts">
    <dt>Description</dt><dd>${esc(c.card.description ?? 'Not sent by the board yet')}</dd>
    <dt>Sources</dt><dd><ul class="source-list">${(i.sources || c.card.sources.map(u => ({ url: u }))).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>${s.author || s.postedAt ? `<span class="mini-meta">${s.author ? esc(s.author) : ''}${s.postedAt ? ` posted ${when(Date.parse(s.postedAt))}` : ''}</span>` : ''}${s.text ? `<span class="source-text">${esc(s.text)}</span>` : ''}</li>`).join('') || '<li class="muted">None yet</li>'}</ul></dd>
    <dt>Checked by</dt><dd>${checkedBy}</dd></dl></div></section>` : '';
  const pending = c.kind === 'article' && c.status !== 'done' ? `<section class="card"><div class="card-body"><dl class="facts"><dt>Edit link</dt><dd>${esc(c.card.editUrl || 'None')}</dd><dt>Publish link</dt><dd>${esc(c.card.publishUrl || 'None')}</dd></dl></div></section>` : '';
  const msgs = (c.messages || []).map(m => `<article class="card msg"><div class="msg-head">${m.status === 'sent' ? '<span class="tag clear">Sent</span>' : `<span class="tag ${m.status === 'failed' ? 'problem' : 'neutral'}">${esc(m.status)}</span>`}<span class="num">${when(m.at)}</span></div><p class="wa">${esc(m.text)}</p></article>`).join('');
  return `<div class="drawer-head"><div class="drawer-top"><div class="crumbs">${site(c.card.site)}<span class="sep" aria-hidden="true">/</span><span>${KIND[c.kind]}</span><span class="sep" aria-hidden="true">/</span>${who(c.card.writer)}${c.card.list ? `<span class="sep" aria-hidden="true">/</span><span>${esc(c.card.list)}</span>` : ''}</div><button type="button" class="btn ghost icon-only" data-close aria-label="Close">${icon('x')}</button></div>
    <h2 id="panel-title">${esc(i.title || c.card.title)}</h2><div class="drawer-status">${status}</div>${actions}</div>
    <div class="drawer-body">${group('Problems', problems, 'problem')}${group('To check', checks, 'check')}
      ${!c.findings.length && c.status === 'done' ? `<div class="card empty-state"><span class="badge-ic">${icon('done')}</span><h3>No issues found</h3><p>Every rule the monitor can check passed.</p></div>` : ''}
      ${article}${pitch}${pending}${msgs ? `<section aria-labelledby="h-m"><div class="group-title" id="h-m">WhatsApp</div><div class="msgs">${msgs}</div></section>` : ''}</div>`;
}
const issuesText = c => [`${siteOf(c.card.site).label} ${KIND[c.kind]}: "${c.card.title}"`, ...c.findings.map((f, n) => `${n + 1}. ${VERDICT[f.severity]}: ${ruleTitle(f.rule)}${f.evidence ? `\n   Found: ${f.evidence}` : ''}${f.note ? `\n   ${f.note}` : ''}${RULES[f.rule]?.quote ? `\n   Guide: "${RULES[f.rule].quote}"` : ''}`)].join('\n');

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-open],[data-close],[data-fkind],[data-fsite],[data-lverdict],[data-lkind],[data-lsite-toggle],[data-guide],[data-recheck],[data-dismiss],[data-undismiss],[data-copy],[data-sw],[data-site-sw],[data-resend],[data-writer],[data-key-add],[data-key-remove],[data-jump],#refresh-rules,#test-ai,#test-wa,#scrim,#theme');
  if (!t) return;
  const d = t.dataset;
  if (t.id === 'theme') {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('em-theme', document.documentElement.dataset.theme); } catch { /* private mode */ }
    return renderShell();
  }
  if (t.id === 'scrim' || 'close' in d) return closeDetail();
  if (d.open) { location.hash = `#/check/${d.open}`; return; }
  if (d.jump) { e.preventDefault(); document.getElementById(d.jump)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
  if (t.matches('[role="radio"]')) t.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]').forEach(r => r.setAttribute('aria-checked', r === t));
  if ('fkind' in d) { ui.filter.kind = d.fkind; return render(); }
  if ('fsite' in d) { ui.filter.site = ui.filter.site === d.fsite ? '' : d.fsite; return render(); }
  if ('lverdict' in d) { ui.list.verdict = d.lverdict; return render(); }
  if ('lkind' in d) { ui.list.kind = d.lkind; return render(); }
  if (d.lsiteToggle) { ui.list.site = ui.list.site === d.lsiteToggle ? '' : d.lsiteToggle; return render(); }
  if (d.writer) { ui.list = { q: d.writer, verdict: '', kind: '', site: '' }; location.hash = '#/checks'; return; }
  if (d.guide) { ui.rulesGuide = d.guide; return render(); }
  if (d.sw) { const on = t.getAttribute('aria-checked') !== 'true'; t.setAttribute('aria-checked', on); draft.switches[d.sw] = on; return; }
  if (d.siteSw) { const on = t.getAttribute('aria-checked') !== 'true'; t.setAttribute('aria-checked', on); draft.sites[d.siteSw] = { ...(draft.sites[d.siteSw] || {}), enabled: on }; return; }
  if (d.keyRemove) {
    const [k, i] = d.keyRemove.split(':'), row = t.closest('.key-row'), keep = draft.keys[k].keep, n = Number(i);
    const removing = keep.includes(n);
    draft.keys[k].keep = removing ? keep.filter(x => x !== n) : [...keep, n].sort((a, b) => a - b);
    row.classList.toggle('removed', removing);
    t.innerHTML = removing ? `${icon('undo')}Undo` : `${icon('trash')}Remove`;
    say(removing ? 'The key will be removed when you save' : 'Key kept');
    return;
  }
  if (d.keyAdd) {
    const k = d.keyAdd, input = $(`#add-${k}`), v = input.value.trim();
    if (!v) { input.focus(); return; }
    draft.keys[k].add.push(v); input.value = '';
    $(`[data-new-keys="${k}"]`).insertAdjacentHTML('beforeend', `<div class="key-row"><span class="avatar" aria-hidden="true">${icon('plus')}</span><span class="k">New key ending ${esc(v.slice(-4))}</span><span class="st">Saved when you press Save</span></div>`);
    say('Key added. Press Save changes to keep it.'); return;
  }
  const busy = async (fn, done) => { t.setAttribute('aria-busy', 'true'); t.disabled = true; try { await fn(); if (done) say(done); } catch (err) { say(err.message); alertIn(t, err.message); } finally { t.removeAttribute('aria-busy'); t.disabled = false; } };
  if (d.recheck) return busy(async () => { await api(`/api/check/${d.recheck}/recheck`, { method: 'POST' }); ui.detail = null; await openDetail(Number(d.recheck)); }, 'Recheck started');
  if (d.dismiss || d.undismiss) return busy(async () => { const id = d.dismiss || d.undismiss; await api(`/api/check/${id}/${d.dismiss ? 'dismiss' : 'undismiss'}`, { method: 'POST' }); ui.detail = null; await openDetail(Number(id)); render(); }, d.dismiss ? 'Marked as fine' : 'Back in Needs you');
  if ('copy' in d) return busy(async () => { await navigator.clipboard.writeText(issuesText(ui.detail)); t.querySelector('span').textContent = 'Copied'; }, 'Issues copied');
  if (d.resend) return busy(async () => { await api(`/api/messages/${d.resend}/resend`, { method: 'POST' }); render(); }, 'Sent again');
  if (t.id === 'refresh-rules') return busy(async () => { const r = await api('/api/rules/refresh', { method: 'POST' }); ui.ruleData = null; await render(); say(r.changed.length ? `Updated: ${r.changed.join(', ')}` : r.failed.length ? `Couldn't download: ${r.failed.join('; ')}` : 'The guides haven\'t changed'); });
  if (t.id === 'test-ai') return busy(async () => {
    const st = $('#ai-status'); st.className = 'status-line'; st.textContent = 'Testing each key...';
    const r = await api('/api/test/ai', { method: 'POST' });
    st.className = `status-line ${r.results.every(x => x.ok) ? 'good' : 'bad'}`;
    st.textContent = r.results.map(x => `${x.key}: ${x.ok ? 'working' : x.error}`).join('. ');
  });
  if (t.id === 'test-wa') return busy(async () => { const st = $('#wa-status'); st.className = 'status-line'; st.textContent = 'Sending...'; await api('/api/test/whatsapp', { method: 'POST' }); st.className = 'status-line good'; st.textContent = 'Sent. Check your WhatsApp.'; });
});
function alertIn(t, msg) { const s = t.parentElement?.querySelector('.status-line'); if (s) { s.textContent = msg; s.className = 'status-line bad'; } }
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#panel').hidden) closeDetail();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-open],tr[data-writer]')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Enter' && e.target.matches('[id^="add-"]')) { e.preventDefault(); $(`[data-key-add="${e.target.id.slice(4)}"]`)?.click(); }
  if (e.key === 'Tab' && !$('#panel').hidden) { // keep focus inside the open drawer
    const f = [...$('#panel').querySelectorAll('a[href],button:not([disabled]),input')]; if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});
let qTimer;
document.addEventListener('input', e => {
  if (e.target.id === 'q') { clearTimeout(qTimer); qTimer = setTimeout(async () => { ui.list.q = e.target.value; await render(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 300); }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'settings') return;
  e.preventDefault();
  const form = e.target, out = { ...draft.switches };
  form.querySelectorAll('[data-k]').forEach(i => { if (i.type === 'password' && !i.value) return; out[i.dataset.k] = 'num' in i.dataset ? Number(i.value) : i.value; });
  for (const k of ['geminiKeys', 'mimoKeys']) {
    const pending = $(`#add-${k}`).value.trim(); // a pasted key counts even if Add wasn't pressed
    const kk = { keep: draft.keys[k].keep, add: [...draft.keys[k].add, ...(pending ? [pending] : [])] };
    if (kk.add.length || kk.keep.length !== ui.settings[k].length) out[k] = kk;
  }
  const sites = {}; form.querySelectorAll('[data-pc]').forEach(i => { sites[i.dataset.pc] = { primaryCategory: i.value, ...(draft.sites[i.dataset.pc] || {}) }; });
  out.sites = sites;
  const btn = $('#save'), st = $('#save-status');
  form.querySelectorAll('.err').forEach(x => { x.textContent = ''; }); form.querySelectorAll('[aria-invalid]').forEach(x => x.removeAttribute('aria-invalid'));
  btn.setAttribute('aria-busy', 'true'); btn.disabled = true; st.className = 'status-line'; st.textContent = 'Saving...';
  try { await api('/api/settings', { method: 'POST', body: out }); ui.state = null; await render(); const s2 = $('#save-status'); s2.className = 'status-line good'; s2.textContent = 'Saved.'; say('Settings saved'); }
  catch (err) {
    st.textContent = err.message; st.className = 'status-line bad';
    for (const [k, m] of Object.entries(err.errors || {})) { const x = form.querySelector(`[data-err="${k}"]`); if (x) x.textContent = m; form.querySelector(`[data-k="${k}"]`)?.setAttribute('aria-invalid', 'true'); }
  } finally { btn.removeAttribute('aria-busy'); btn.disabled = false; }
});

// Radio groups (segmented controls): one tab stop, arrows move and select, like native radios.
function rove(root = document) {
  root.querySelectorAll('[role="radiogroup"]').forEach(g => {
    const items = [...g.querySelectorAll('[role="radio"]')];
    const on = items.find(b => b.getAttribute('aria-checked') === 'true') || items[0];
    items.forEach(b => b.setAttribute('tabindex', b === on ? '0' : '-1'));
  });
}
document.addEventListener('keydown', e => {
  const b = e.target.closest?.('[role="radio"]');
  if (!b || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...b.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')], i = items.indexOf(b);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  e.preventDefault();
  items[next].focus();
  items[next].click();
});
new MutationObserver(() => rove()).observe(document.body, { childList: true, subtree: true });

const PAGE_RENDER = { desk: pageDesk, checks: pageChecks, writers: pageWriters, rules: pageRules, messages: pageMessages, activity: pageActivity, settings: pageSettings };
// Live: the desk refreshes every 10 s, the countdown rings every second.
setInterval(() => { if (route().page === 'desk' && !document.hidden) render(); }, 10000);
setInterval(() => {
  document.querySelectorAll('.countdown[data-deadline]').forEach(el => {
    const left = Number(el.dataset.deadline) - Date.now(), total = Number(el.dataset.total);
    const prog = el.querySelector('.prog'), len = Number(prog.getAttribute('stroke-dasharray'));
    prog.setAttribute('stroke-dashoffset', (len * Math.max(0, left) / total).toFixed(2));
    if (left > 0) el.querySelector('.timer').textContent = clock(left);
    else if (!el.classList.contains('late')) { el.classList.add('late'); el.querySelector('.timer').textContent = el.dataset.alerted === '1' ? 'Alerted' : 'Due'; }
  });
}, 1000);
loadRules().catch(() => {}).finally(render);
