// PDC Monitor dashboard. Plain ES modules, no build step; served through
// Home Assistant Ingress, so every request path is relative.

// ------------------------------------------------------------------ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = n => Number(n || 0).toLocaleString();
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const ms = s => (s ? s * 1000 : null); // Worker times are seconds

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path.replace(/^\//, ''), {
    method, cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

function ago(t, now = Date.now()) {
  if (!t) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function dur(msv) {
  const s = Math.round(msv / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const shortDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const when = t => (t ? dateFmt.format(new Date(t)) : '—');
const timeTag = t => (t ? `<time datetime="${new Date(t).toISOString()}" title="${esc(when(t))}" data-ago="${t}">${ago(t)}</time>` : '—');
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ------------------------------------------------------------------ domain
const VERDICTS = {
  duplicate: { label: 'Duplicate', sev: 3 },
  same_story: { label: 'Similar story', sev: 2 },
  near_miss: { label: 'Possible overlap', sev: 1 },
  clear: { label: 'Clear', sev: 0 },
  waiting: { label: 'Waiting for AI', sev: -1 },
  baseline: { label: 'Baseline', sev: -2 },
};
const FLAGS = ['duplicate', 'same_story', 'near_miss'];
function outcome(j) {
  if (j.check === 'baseline') return 'baseline';
  if (j.check !== 'checked') return 'waiting';
  if (!j.findings.length) return 'clear';
  return j.findings.reduce((a, f) => (VERDICTS[f.verdict]?.sev > VERDICTS[a]?.sev ? f.verdict : a), j.findings[0].verdict);
}
const best = j => j.findings.slice().sort((a, b) => VERDICTS[b.verdict].sev - VERDICTS[a.verdict].sev || b.confidence - a.confidence)[0];
const vIcon = o => `<svg class="vi"><use href="#v-${o}"/></svg>`;
const chip = o => `<span class="chip v-${o}"><svg><use href="#v-${o}"/></svg>${VERDICTS[o].label}</span>`;
const SEND = {
  none: { label: 'No alert needed', tick: 'none' },
  skipped: { label: 'Below your alert rules', tick: 'none' },
  dry_run: { label: 'Dry run: not sent', tick: 'none' },
  pending: { label: 'Queued to send', tick: 'wait' },
  sending: { label: 'Sending now', tick: 'wait' },
  accepted: { label: 'Sent to WhatsApp', tick: 'ok' },
  failed: { label: 'Failed to send', tick: 'bad' },
  uncertain: { label: 'Not confirmed; check WhatsApp', tick: 'warn' },
};
const TICK_SVG = {
  ok: '<svg viewBox="0 0 24 24"><path d="m2 13 4 4 8-9"/><path d="m10 16 1 1 8-9"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17v.1"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
  none: '<svg viewBox="0 0 24 24"><path d="M8 12h8" opacity=".6"/></svg>',
};
const ticks = send => { const t = SEND[send]?.tick || 'none'; return `<span class="ticks ${t === 'ok' ? 'ok' : t === 'warn' ? 'warn' : t === 'bad' ? 'bad' : ''}" title="${esc(SEND[send]?.label || send)}">${TICK_SVG[t]}</span>`; };
const methodLabel = m => !m ? '—' : m.method === 'exact' ? 'Exact title / link match' : m.method === 'keywords' ? 'No similar keywords' : `AI${m.engine ? ` · ${m.engine}` : ''}`;
function source(key) {
  if (key.startsWith('trello:')) return { id: 'pitch', label: 'Pitch alert', c: 'var(--critical)' };
  if (key.startsWith('health:')) return { id: 'health', label: 'Monitor health', c: 'var(--warning)' };
  if (key.startsWith('netmon-')) return { id: 'netmon', label: 'Net Monitor', c: 'var(--accent-2)' };
  if (key.startsWith('ui-test-')) return { id: 'test', label: 'Test', c: 'var(--accent)' };
  return { id: 'other', label: 'Other', c: 'var(--muted)' };
}

// ------------------------------------------------------------------ state
const prefs = Object.assign({ theme: 'auto', refresh: 10, motion: true }, JSON.parse(localStorage.getItem('pdc-prefs') || '{}'));
const S = {
  page: 'overview', status: null, monitor: null, monitorError: null, messages: [], events: [],
  clockOffset: 0, filter: 'all', q: '', shown: 60, dailyDays: 14, scanHours: 24, msgFilter: 'all', msgShown: 120,
  lists: null, listsError: null, draft: null, bridgeDraft: null, fieldErrors: {}, restarting: false, openJob: null,
  firstPaint: { overview: true },
};
const serverNow = () => Date.now() + S.clockOffset;
const jobs = () => S.monitor?.jobs || [];
const ledgerKey = j => `trello:${S.monitor?.board}:${j.id}`;
const ledgerByKey = () => new Map(S.messages.map(m => [m.key, m]));

// ------------------------------------------------------------------ theme
function applyTheme() {
  let theme = prefs.theme;
  if (theme === 'auto') {
    let dark = matchMedia('(prefers-color-scheme: dark)').matches;
    try { const hass = parent.document.querySelector('home-assistant')?.hass; if (hass?.themes) dark = Boolean(hass.themes.darkMode); } catch { /* not in HA */ }
    theme = dark ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('reduce-motion', !prefs.motion);
}
const savePrefs = () => { localStorage.setItem('pdc-prefs', JSON.stringify(prefs)); applyTheme(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Shared SVG gradients.
document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent-2)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent-2)" stop-opacity="0"/></linearGradient>
  <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient>
</defs></svg>`);

// ------------------------------------------------------------------ tooltip
const tip = $('#tip');
function showTip(html, ev) {
  tip.innerHTML = html; tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => tip.classList.remove('on');

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="dot ${kind === 'ok' ? 'live' : kind === 'bad' ? 'bad' : kind === 'warn' ? 'warn' : 'info'}"></span>${esc(text)}`;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 6000 : 3500);
}

// Numbers count up from their previous value.
function countTo(el, to, suffix = '') {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (!prefs.motion || from === to) { el.innerHTML = fmtN(to) + suffix; return; }
  const t0 = performance.now(), d = 900;
  const step = t => {
    const k = Math.min(1, (t - t0) / d), e = 1 - (1 - k) ** 3;
    el.innerHTML = fmtN(Math.round(from + (to - from) * e)) + suffix;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ charts
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// Stacked columns. series: [{id, label, color}], cols: [{label, tipTitle, values:{id:n}}]
function columns(el, { series, cols, labelEvery = 1 }) {
  const W = Math.max(280, el.clientWidth), H = el.clientHeight || 230, L = 34, B = 24, T = 8;
  const max = niceMax(Math.max(1, ...cols.map(c => series.reduce((a, s) => a + (c.values[s.id] || 0), 0))));
  const cw = (W - L) / cols.length, bw = Math.max(2, Math.min(18, cw * 0.56));
  const y = v => T + (H - B - T) * (1 - v / max);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line class="${i ? 'gridline' : 'baseline'}" x1="${L}" x2="${W}" y1="${yy}" y2="${yy}"/><text class="tick" x="${L - 8}" y="${yy + 4}" text-anchor="end">${fmtN(v)}</text>`;
  }
  cols.forEach((c, i) => {
    const x = L + cw * i + (cw - bw) / 2;
    let acc = 0;
    const stack = series.filter(s => c.values[s.id] > 0);
    stack.forEach((s, k) => {
      const v = c.values[s.id], y1 = y(acc + v), y0 = y(acc), gap = k ? 2 : 0;
      const h = Math.max(1, y0 - y1 - gap);
      g += `<rect class="bar" style="animation-delay:${Math.min(i * 18, 500)}ms" x="${x}" y="${y1}" width="${bw}" height="${h}" rx="${Math.min(4, bw / 2)}" fill="${s.color}"/>`;
      acc += v;
    });
    if (i % labelEvery === 0) g += `<text class="tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(c.label)}</text>`;
    g += `<rect class="hover-col" data-i="${i}" x="${L + cw * i}" y="${T}" width="${cw}" height="${H - B - T}" rx="6"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${g}</svg>`;
  el.onmousemove = ev => {
    const i = ev.target.dataset?.i;
    if (i === undefined) return hideTip();
    const c = cols[i], total = series.reduce((a, s) => a + (c.values[s.id] || 0), 0);
    showTip(`<b>${esc(c.tipTitle || c.label)}</b>${series.map(s => `<div class="row"><span>${s.icon || `<i class="sw" style="display:inline-block;width:9px;height:9px;border-radius:3px;background:${s.color}"></i>`}${esc(s.label)}</span><em>${fmtN(c.values[s.id] || 0)}</em></div>`).join('')}
      ${series.length > 1 ? `<div class="row" style="margin-top:4px;border-top:1px solid var(--hair);padding-top:4px"><span>Total</span><em>${fmtN(total)}</em></div>` : ''}${c.extra || ''}`, ev);
  };
  el.onmouseleave = hideTip;
}

function sparkline(values) {
  const W = 110, H = 34, max = Math.max(1, ...values), n = values.length;
  const pts = values.map((v, i) => [(i / (n - 1)) * W, H - 3 - (v / max) * (H - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path class="area" d="${d}L${W},${H}L0,${H}Z"/><path d="${d}"/><circle cx="${last[0]}" cy="${last[1]}" r="3.5"/></svg>`;
}

const LEG = FLAGS.concat('clear');
const verdictSeries = () => ['clear', 'near_miss', 'same_story', 'duplicate'].map(id => ({
  id, label: VERDICTS[id].label, color: `var(--${{ clear: 'good', near_miss: 'warning', same_story: 'serious', duplicate: 'critical' }[id]})`,
  icon: `<svg class="v-${id}" style="fill:currentColor"><use href="#v-${id}"/></svg>`,
}));
const legendHtml = series => series.map(s => `<span>${s.icon || `<i class="sw" style="background:${s.color}"></i>`}${esc(s.label)}</span>`).join('');

function dailyBuckets(days, pick) {
  const today = startOfDay(serverNow()), out = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); out.push({ t: d.getTime(), values: {} }); }
  const idx = new Map(out.map((b, i) => [dayKey(b.t), i]));
  for (const j of jobs()) {
    const r = pick(j); if (!r) continue;
    const i = idx.get(dayKey(r.t)); if (i === undefined) continue;
    out[i].values[r.id] = (out[i].values[r.id] || 0) + 1;
  }
  return out;
}

// ------------------------------------------------------------------ top chrome
function renderChrome() {
  const st = S.status, m = S.monitor, now = serverNow();
  const pills = [];
  if (st) {
    const b = st.bridge;
    pills.push(b.connected && b.accountOk ? `<span class="pill"><span class="dot live"></span>WhatsApp connected</span>`
      : b.pairingCode ? `<span class="pill"><span class="dot warn"></span>Waiting for pairing</span>`
      : b.connected ? `<span class="pill"><span class="dot bad"></span>Wrong WhatsApp account</span>`
      : `<span class="pill"><span class="dot bad"></span>WhatsApp offline</span>`);
  }
  if (m) {
    const s = m.settings.values, lastOk = ms(m.state?.last_ok);
    const stale = !lastOk || now - lastOk > 5 * 60000;
    pills.push(!s.enabled ? `<span class="pill"><span class="dot"></span>Monitor paused</span>`
      : stale ? `<span class="pill"><span class="dot bad"></span>Scans stalled</span>`
      : `<span class="pill"><span class="dot live"></span>Scanning · <span data-ago="${lastOk}">${ago(lastOk, now)}</span></span>`);
    pills.push(!s.sending ? `<span class="pill"><span class="dot warn"></span>Dry run</span>`
      : m.quietNow ? `<span class="pill"><span class="dot info"></span>Quiet hours</span>`
      : `<span class="pill"><span class="dot live"></span>Alerts live</span>`);
  } else if (S.monitorError) pills.push(`<span class="pill"><span class="dot bad"></span>Worker unreachable</span>`);
  $('#pills').innerHTML = pills.join('');

  const banners = [];
  if (st?.bridge.pairingCode) banners.push(`<div class="banner" style="--c:var(--warning)"><svg viewBox="0 0 16 16"><use href="#v-near_miss"/></svg><div><b>Link WhatsApp:</b> enter code <b class="num">${esc(st.bridge.pairingCode)}</b> on ${esc(st.bridge.sender)} under Linked devices › Link with phone number.</div><a class="btn" href="#settings">Details</a></div>`);
  if (S.monitorError) banners.push(`<div class="banner" style="--c:var(--critical)"><svg viewBox="0 0 16 16"><use href="#v-duplicate"/></svg><div>${esc(S.monitorError)}</div><a class="btn" href="#settings">Open settings</a></div>`);
  if (S.restarting) banners.push(`<div class="banner" style="--c:var(--info)"><svg viewBox="0 0 16 16"><use href="#v-waiting"/></svg><div>Restarting the add-on to apply your settings…</div></div>`);
  $('#banner').innerHTML = banners.join('');

  const recent = jobs().filter(j => FLAGS.includes(outcome(j)) && ms(j.checkedAt) > now - 86400000).length;
  const badge = $('#nav-flagged');
  badge.hidden = !recent; badge.textContent = recent; badge.title = `${recent} flagged in the last 24 hours`;
  $('#rail-foot').innerHTML = st ? `Add-on v${esc(st.version)}<br>Updated <span data-ago="${Date.now()}">just now</span>` : '';
}

// ------------------------------------------------------------------ overview
const TILE_ICONS = {
  checked: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
  flagged: '<svg viewBox="0 0 24 24"><path d="M4 21V4"/><path d="M4 4h12l-2 4 2 4H4"/></svg>',
  sent: '<svg viewBox="0 0 24 24"><path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4 18-7Z"/></svg>',
  msgs: '<svg viewBox="0 0 24 24"><path d="M20.5 11.6a8.4 8.4 0 0 1-12.4 7.4L3.5 20.5 5 16.1A8.4 8.4 0 1 1 20.5 11.6Z"/></svg>',
};
function renderTiles() {
  const m = S.monitor, st = S.status, el = $('#tiles');
  const count = (pred) => (m?.counts || []).filter(pred).reduce((a, c) => a + c.count, 0);
  const checked = count(c => c.check_status === 'checked');
  const waiting = count(c => c.check_status === 'pending');
  const flagged = count(c => c.check_status === 'checked' && c.send_status !== 'none');
  const sent = count(c => c.send_status === 'accepted');
  const problems = count(c => c.send_status === 'failed' || c.send_status === 'uncertain');
  const mix = { duplicate: 0, same_story: 0, near_miss: 0 };
  jobs().forEach(j => { const o = outcome(j); if (o in mix) mix[o]++; });
  const d14 = f => dailyBuckets(14, j => f(j) ? { t: ms(j.checkedAt), id: 'x' } : null).map(b => b.values.x || 0);
  const lastAlert = jobs().filter(j => j.send === 'accepted').map(j => ms(j.checkedAt)).sort((a, b) => b - a)[0];
  const tiles = [
    { id: 'checked', label: 'Pitches checked', value: checked, note: waiting ? `${waiting} waiting for a verdict` : `${pct(checked - flagged, checked)}% came back clear`, spark: d14(j => j.check === 'checked') },
    { id: 'flagged', label: 'Overlaps caught', value: flagged, note: `${mix.duplicate} duplicate · ${mix.same_story} similar · ${mix.near_miss} possible`, spark: d14(j => FLAGS.includes(outcome(j))) },
    { id: 'sent', label: 'Alerts sent', value: sent, note: problems ? `${problems} not delivered` : lastAlert ? `Last one ${ago(lastAlert)}` : 'None yet', spark: d14(j => j.send === 'accepted') },
    { id: 'msgs', label: 'WhatsApp, last 24h', value: st?.messages.sent24h || 0, note: `${fmtN(st?.messages.sent || 0)} sent through this bridge`, accent: true },
  ];
  if (!el.children.length) {
    el.innerHTML = tiles.map((t, i) => `<div class="card tile rise${t.accent ? ' accent' : ''}" style="animation-delay:${i * 70}ms" data-tile="${t.id}">
      <div class="label"><i>${TILE_ICONS[t.id]}</i>${t.label}</div><div class="value num">0</div><div class="foot"><span class="note"></span><span class="sp"></span></div></div>`).join('');
  }
  for (const t of tiles) {
    const card = el.querySelector(`[data-tile="${t.id}"]`);
    countTo(card.querySelector('.value'), t.value);
    card.querySelector('.note').textContent = t.note;
    card.querySelector('.sp').innerHTML = t.spark ? sparkline(t.spark) : '';
  }
}

function renderDaily() {
  const days = S.dailyDays, series = verdictSeries();
  const buckets = dailyBuckets(days, j => j.check === 'checked' ? { t: ms(j.checkedAt), id: outcome(j) } : null);
  $('#daily-legend').innerHTML = legendHtml(series.slice().reverse());
  columns($('#chart-daily'), {
    series, labelEvery: days <= 14 ? 2 : days <= 30 ? 5 : 15,
    cols: buckets.map(b => ({ label: shortDay.format(b.t), tipTitle: dayFmt.format(b.t), values: b.values })),
  });
}

function renderPulse() {
  const el = $('#card-pulse'), m = S.monitor;
  if (!m) { el.innerHTML = `<div class="card-head"><h2>Live monitor</h2></div><div class="skel" style="height:168px;width:168px;border-radius:50%;margin:0 auto 18px"></div><div class="skel" style="height:90px"></div>`; return; }
  const lastScan = m.scans[m.scans.length - 1];
  const day = m.scans.filter(s => ms(s.hour) > serverNow() - 86400000);
  const fails = day.reduce((a, s) => a + s.failures, 0), scans = day.reduce((a, s) => a + s.scans, 0);
  const waiting = jobs().filter(j => j.check === 'pending').length;
  if (!el.querySelector('.ring')) {
    el.innerHTML = `<div class="card-head"><h2>Live monitor</h2><span class="muted small">every minute</span></div>
      <div class="ring-wrap"><svg class="ring" viewBox="0 0 168 168"><circle class="track" cx="84" cy="84" r="74"/><circle class="prog" cx="84" cy="84" r="74" stroke-dasharray="465" stroke-dashoffset="465"/></svg>
      <div class="ring-label"><b id="ring-v">—</b><small id="ring-s">since last scan</small></div></div>
      <dl class="kv" id="pulse-kv"></dl>`;
  }
  $('#pulse-kv').innerHTML = `
    <dt>Last scan</dt><dd>${m.state?.last_ok ? esc(when(ms(m.state.last_ok))) : 'never'}</dd>
    <dt>Cards on the board</dt><dd>${lastScan ? fmtN(lastScan.cards) : '—'}</dd>
    <dt>Scan time</dt><dd>${lastScan?.last_ms ? `${(lastScan.last_ms / 1000).toFixed(1)}s` : '—'}</dd>
    <dt>Scans, 24h</dt><dd>${fmtN(scans)}${fails ? ` · <span style="color:var(--critical-ink)">${fails} failed</span>` : ''}</dd>
    <dt>Waiting for AI</dt><dd>${waiting}</dd>
    ${m.state?.last_error ? `<dt>Last error</dt><dd style="color:var(--critical-ink)" title="${esc(m.state.last_error)}">${esc(m.state.last_error)}</dd>` : ''}`;
  tickPulse();
}
function tickPulse() {
  const m = S.monitor, v = $('#ring-v'); if (!m || !v) return;
  const last = ms(m.state?.last_ok), now = serverNow();
  const since = last ? now - last : null;
  const prog = $('#card-pulse .prog'), wrap = $('#card-pulse .ring-wrap');
  if (!m.settings.values.enabled) { v.textContent = 'Paused'; $('#ring-s').textContent = 'monitoring is off'; prog.style.strokeDashoffset = 465; return; }
  v.textContent = since == null ? '—' : since < 3600000 ? `${Math.floor(since / 1000)}s` : ago(last, now).replace(' ago', '');
  $('#ring-s').textContent = since != null && since > 5 * 60000 ? 'since last good scan' : 'since last scan';
  const k = since == null ? 0 : Math.min(1, (since % 60000) / 60000);
  prog.style.strokeDashoffset = String(465 * (1 - (since > 5 * 60000 ? 1 : k)));
  prog.style.stroke = since > 5 * 60000 ? 'var(--critical)' : '';
  wrap.classList.toggle('scanning', since != null && since % 60000 > 55000);
}

function renderFeed() {
  const list = jobs().filter(j => j.check !== 'baseline').slice(0, 8);
  $('#feed').innerHTML = list.length ? list.map((j, i) => {
    const o = outcome(j), b = j.findings.length ? best(j) : null;
    return `<div class="feed-item rise v-${o}" style="animation-delay:${i * 40}ms" data-job="${j.id}" tabindex="0" role="button">
      <span class="ic">${vIcon(o)}</span>
      <div style="min-width:0"><div class="t">${esc(j.name)}</div><div class="s">${esc(VERDICTS[o].label)}${b ? ` · ${b.confidence}% vs “${esc(b.title)}”` : ` · ${esc(j.writer)} · ${esc(j.list)}`}</div></div>
      ${timeTag(ms(j.checkedAt || j.firstSeen))}</div>`;
  }).join('') : `<div class="empty">No pitches checked yet.</div>`;
}

function renderMix() {
  const counts = { duplicate: 0, same_story: 0, near_miss: 0, clear: 0 };
  jobs().forEach(j => { const o = outcome(j); if (o in counts) counts[o]++; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  $('#mix-total').textContent = `${fmtN(total)} checked`;
  const order = ['duplicate', 'same_story', 'near_miss', 'clear'];
  $('#mix').innerHTML = `<div class="mix-bar">${order.filter(o => counts[o]).map(o => `<i class="v-${o}" style="flex-grow:${counts[o]}" title="${VERDICTS[o].label}: ${counts[o]}"></i>`).join('')}</div>
    <div class="mix-rows">${order.map(o => `<div class="mix-row v-${o}"><span>${vIcon(o)}<span style="color:var(--ink-2)">${VERDICTS[o].label}</span></span><b>${fmtN(counts[o])}</b><em>${pct(counts[o], total)}%</em></div>`).join('')}</div>`;
}

function renderHealth() {
  const st = S.status, m = S.monitor, now = serverNow(), rows = [];
  const row = (state, label, detail) => rows.push(`<li><span class="dot ${state}"></span><span>${label}</span><span>${detail}</span></li>`);
  if (st) {
    const b = st.bridge;
    if (b.connected && b.accountOk) row('live', 'WhatsApp link', `${esc(b.user?.number || b.sender)} · up ${dur(Date.now() - b.connectedSince)}`);
    else if (b.pairingCode) row('warn', 'WhatsApp link', 'Waiting for pairing code');
    else row('bad', 'WhatsApp link', b.offlineSince ? `Offline ${dur(Date.now() - b.offlineSince)}` : 'Offline');
  }
  if (S.monitorError) row('bad', 'Pitch-checker Worker', esc(S.monitorError.length > 40 ? 'Unreachable' : S.monitorError));
  if (m) {
    row('live', 'Pitch-checker Worker', 'Reachable');
    const last = ms(m.state?.last_ok);
    if (!m.settings.values.enabled) row('', 'Trello scans', 'Paused');
    else if (!last || now - last > 5 * 60000) row('bad', 'Trello scans', esc(m.state?.last_error || `Last ${ago(last, now)}`));
    else row('live', 'Trello scans', `Last ${ago(last, now)}`);
    const waiting = jobs().filter(j => j.check === 'pending');
    const stuck = waiting.filter(j => now - ms(j.firstSeen) > 3600000).length;
    const ai = [m.ai.mimo && 'MiMo', m.ai.gemini && 'Gemini'].filter(Boolean).join(' + ') || 'No keys';
    row(stuck ? 'bad' : !(m.ai.mimo || m.ai.gemini) ? 'bad' : waiting.length ? 'warn' : 'live', 'AI verdicts', stuck ? `${stuck} stuck over an hour` : `${ai}${waiting.length ? ` · ${waiting.length} waiting` : ''}`);
    const bad = jobs().filter(j => j.send === 'failed' || j.send === 'uncertain').length;
    const queued = jobs().filter(j => j.send === 'pending').length;
    row(bad ? 'warn' : !m.settings.values.sending ? 'warn' : 'live', 'Alert delivery',
      !m.settings.values.sending ? 'Dry run (sending off)' : `${m.quietNow ? 'Quiet hours · ' : ''}${queued ? `${queued} queued · ` : ''}${bad ? `${bad} not delivered` : 'All delivered'}`);
  }
  $('#health').innerHTML = rows.join('') || '<li><span class="skel" style="grid-column:1/-1;height:18px"></span></li>';
}

function renderScans24() {
  const m = S.monitor; if (!m) return;
  const cols = hourCols(24);
  const total = cols.reduce((a, c) => a + (c.values.ok || 0) + (c.values.fail || 0), 0);
  const fails = cols.reduce((a, c) => a + (c.values.fail || 0), 0);
  $('#scan-sum').textContent = `${fmtN(total)} scans${fails ? ` · ${fails} failed` : ''}`;
  columns($('#chart-scans'), { series: scanSeries(), cols, labelEvery: 6 });
}
const scanSeries = () => [{ id: 'ok', label: 'Successful scans', color: 'var(--accent-2)' }, { id: 'fail', label: 'Failed scans', color: 'var(--critical)' }];
function hourCols(hours) {
  const byHour = new Map((S.monitor?.scans || []).map(s => [s.hour, s]));
  const now = Math.floor(serverNow() / 1000), top = Math.floor(now / 3600) * 3600, cols = [];
  const group = hours > 72 ? 6 : hours > 24 ? 2 : 1;
  for (let h = top - (hours - 1) * 3600; h <= top; h += 3600 * group) {
    const v = { ok: 0, fail: 0 }, x = { checks: 0, flagged: 0, sent: 0 };
    for (let k = 0; k < group; k++) {
      const s = byHour.get(h + k * 3600); if (!s) continue;
      v.ok += s.scans - s.failures; v.fail += s.failures; x.checks += s.checks; x.flagged += s.flagged; x.sent += s.sent;
    }
    const t = h * 1000;
    cols.push({
      label: group > 1 && hours > 72 ? shortDay.format(t) : hourFmt.format(t), tipTitle: `${dayFmt.format(t)}, ${hourFmt.format(t)}${group > 1 ? ` – ${hourFmt.format(t + group * 3600000)}` : ''}`, values: v,
      extra: `<div class="row"><span>Pitches checked</span><em>${x.checks}</em></div><div class="row"><span>Flagged</span><em>${x.flagged}</em></div><div class="row"><span>Alerts sent</span><em>${x.sent}</em></div>`,
    });
  }
  return cols;
}

function renderHeatmap() {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const j of jobs()) {
    if (!j.created) continue;
    const d = new Date(j.created * 1000), r = (d.getDay() + 6) % 7, c = d.getHours();
    max = Math.max(max, ++grid[r][c]);
  }
  const steps = ['--seq-5', '--seq-4', '--seq-3', '--seq-2', '--seq-1'];
  const color = v => (v ? `var(${steps[Math.min(4, Math.floor((v / max) * 5 - 1e-9))]})` : 'var(--seq-0)');
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let h = '<div class="heat"><span></span>' + Array.from({ length: 24 }, (_, i) => `<span class="hh">${i % 6 === 0 ? i : ''}</span>`).join('');
  grid.forEach((row, r) => {
    h += `<span class="hl">${days[r]}</span>` + row.map((v, c) => `<i style="background:${color(v)};animation-delay:${(r * 24 + c) * 3}ms" data-r="${r}" data-c="${c}" data-v="${v}"></i>`).join('');
  });
  h += `</div><div class="heat-scale">Fewer ${['var(--seq-0)', ...steps.map(s => `var(${s})`)].map(c => `<i style="background:${c}"></i>`).join('')} More</div>`;
  const el = $('#heatmap');
  el.innerHTML = h;
  el.onmousemove = ev => {
    const t = ev.target; if (t.dataset?.v === undefined) return hideTip();
    const hr = Number(t.dataset.c), fmt = x => hourFmt.format(new Date(2026, 0, 1, x));
    showTip(`<b>${days[t.dataset.r]}, ${fmt(hr)} – ${fmt((hr + 1) % 24)}</b><div class="row"><span>Pitches created</span><em>${t.dataset.v}</em></div>`, ev);
  };
  el.onmouseleave = hideTip;
}

function renderOverview() {
  renderTiles(); renderPulse(); renderHealth();
  if (!S.monitor) {
    for (const id of ['#chart-daily', '#chart-scans']) $(id).innerHTML = '<div class="skel" style="height:100%"></div>';
    $('#feed').innerHTML = Array.from({ length: 5 }, () => '<div class="skel" style="height:42px;margin:6px 0"></div>').join('');
    return;
  }
  renderDaily(); renderFeed(); renderMix(); renderScans24(); renderHeatmap();
}

// ------------------------------------------------------------------ pitches
const FILTERS = [
  ['all', 'All', () => true],
  ['flagged', 'Flagged', j => FLAGS.includes(outcome(j))],
  ['duplicate', 'Duplicate', j => outcome(j) === 'duplicate'],
  ['same_story', 'Similar story', j => outcome(j) === 'same_story'],
  ['near_miss', 'Possible overlap', j => outcome(j) === 'near_miss'],
  ['clear', 'Clear', j => outcome(j) === 'clear'],
  ['waiting', 'Waiting', j => outcome(j) === 'waiting'],
  ['problems', 'Problems', j => j.send === 'failed' || j.send === 'uncertain' || Boolean(j.error)],
];
function renderPitches() {
  const all = jobs().filter(j => j.check !== 'baseline');
  $('#filters').innerHTML = FILTERS.map(([id, label, f]) => {
    const n = all.filter(f).length;
    return (id === 'problems' || id === 'waiting') && !n ? '' : `<button data-f="${id}" class="${S.filter === id ? 'on' : ''}">${id in VERDICTS ? `<svg class="vi v-${id}"><use href="#v-${id}"/></svg>` : ''}${label}<span class="n">${n}</span></button>`;
  }).join('');
  const f = FILTERS.find(x => x[0] === S.filter)?.[2] || (() => true);
  const q = S.q.trim().toLowerCase();
  const rows = all.filter(f).filter(j => !q || [j.name, j.writer, j.list, ...j.findings.map(x => x.title)].join(' ').toLowerCase().includes(q));
  const el = $('#pitch-list');
  if (!S.monitor) { el.innerHTML = Array.from({ length: 8 }, () => '<div class="row"><span class="skel" style="grid-column:1/-1;height:34px"></span></div>').join(''); return; }
  if (!rows.length) { el.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg><div>No pitches match.</div></div>`; $('#more').hidden = true; return; }
  el.innerHTML = `<div class="row head"><span></span><span>Pitch</span><span class="c-match">Closest match</span><span class="c-list">How it was checked</span><span class="when">Checked</span><span></span></div>` +
    rows.slice(0, S.shown).map((j, i) => {
      const o = outcome(j), b = j.findings.length ? best(j) : null;
      return `<div class="row v-${o}" data-job="${j.id}" tabindex="0" role="button" style="animation:rise .4s var(--ease) both;animation-delay:${Math.min(i, 20) * 20}ms">
        <span class="ic" title="${VERDICTS[o].label}">${vIcon(o)}</span>
        <div class="main"><b>${esc(j.name)}</b><small>${esc(VERDICTS[o].label)} · ${esc(j.writer)} · ${esc(j.list)}</small></div>
        <div class="cell c-match">${b ? `${esc(b.title)}<small>${b.confidence}% · ${esc(VERDICTS[b.verdict].label)}${j.findings.length > 1 ? ` · +${j.findings.length - 1} more` : ''}</small>` : '<span class="muted">—</span>'}</div>
        <div class="cell c-list">${esc(methodLabel(j.meta))}<small>${j.meta?.compared ? `vs ${fmtN(j.meta.compared)} cards` : o === 'waiting' ? `${j.attempts} attempt${j.attempts === 1 ? '' : 's'}` : ''}</small></div>
        <div class="when">${timeTag(ms(j.checkedAt || j.firstSeen))}<small>${esc(when(ms(j.checkedAt || j.firstSeen)))}</small></div>
        ${ticks(j.send)}</div>`;
    }).join('');
  $('#more').hidden = rows.length <= S.shown;
  $('#more').textContent = `Show more (${rows.length - S.shown} left)`;
}

// ------------------------------------------------------------------ drawer
function confRing(v) {
  const c = 2 * Math.PI * 24;
  return `<div class="conf"><svg viewBox="0 0 56 56"><circle class="t" cx="28" cy="28" r="24"/><circle class="p" cx="28" cy="28" r="24" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-to="${c * (1 - v / 100)}"/></svg><b>${v}%</b></div>`;
}
function formatWa(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<b>$2</b>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])~([^~\n]+)~/g, '$1<s>$2</s>');
}
function bubble(m, { collapse = true } = {}) {
  const src = source(m.key), lines = String(m.text || '').split('\n');
  const long = collapse && lines.length > 14;
  const body = m.text ? formatWa(long ? lines.slice(0, 12).join('\n') : m.text) : '<i class="muted">Message text was not recorded (sent before v2.0)</i>';
  const tick = m.state === 'sent' ? `<span class="ok">${TICK_SVG.ok}</span>` : m.state === 'unknown' ? TICK_SVG.warn : TICK_SVG.wait;
  return `<div class="bubble${m.state === 'unknown' ? ' fail' : ''}" data-key="${esc(m.key)}"><div class="src" style="color:${src.c}">${esc(src.label)}</div>${body}${long ? `\n<button class="more-t" data-expand="${esc(m.key)}">Read more</button>` : ''}
    <div class="meta" title="${esc(m.state === 'sent' ? 'Delivered to WhatsApp' : m.state === 'unknown' ? `Not confirmed${m.error ? `: ${m.error}` : ''}` : 'Sending')}">${new Date(m.sentAt || m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${tick}</div></div>`;
}

function openJob(id) {
  const j = jobs().find(x => x.id === id); if (!j) return;
  S.openJob = id;
  const o = outcome(j), b = j.findings.length ? best(j) : null, msg = ledgerByKey().get(ledgerKey(j));
  const pcard = (tag, p) => `<div class="pcard"><div class="tag">${tag}</div><p>${esc(p.title || p.name)}</p><dl>
    <dt>Writer</dt><dd>${esc(p.writer)}</dd><dt>List</dt><dd>${esc(p.list || '—')}</dd><dt>Created</dt><dd>${esc(when(ms(p.created)))}</dd></dl>
    ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Open in Trello <svg><use href="#i-ext"/></svg></a>` : ''}</div>`;
  const steps = [
    { c: 'var(--muted)', t: 'Card created', d: when(ms(j.created)) },
    { c: 'var(--info)', t: 'Seen by the monitor', d: `${when(ms(j.firstSeen))} · in ${j.list}` },
    j.check === 'checked' ? { c: `var(--${{ duplicate: 'critical', same_story: 'serious', near_miss: 'warning', clear: 'good' }[o]})`, t: `Checked: ${VERDICTS[o].label}`, d: `${when(ms(j.checkedAt))} · ${methodLabel(j.meta)}` }
      : { c: 'var(--info)', t: 'Waiting for an AI verdict', d: `${j.attempts} attempt${j.attempts === 1 ? '' : 's'}${j.nextCheck ? ` · next try ${when(ms(j.nextCheck))}` : ''}` },
    ...(j.send !== 'none' ? [{ c: SEND[j.send]?.tick === 'ok' ? 'var(--good)' : SEND[j.send]?.tick === 'bad' ? 'var(--critical)' : 'var(--warning)', t: SEND[j.send]?.label || j.send, d: msg?.sentAt ? when(msg.sentAt) : j.send === 'pending' && S.monitor.quietNow ? 'Waiting for quiet hours to end' : j.error || '' }] : []),
  ];
  const meta = j.meta || {};
  $('#drawer-body').innerHTML = `
    <div class="d-head">${chip(o)}<h2 id="drawer-title">${esc(j.name)}</h2>
      <div class="d-meta"><span>${esc(j.writer)}</span><span>${esc(j.list)}</span><span>${esc(when(ms(j.created)))}</span></div></div>
    ${b ? `<div class="d-section"><h3>Closest match</h3><div class="compare">${pcard('New pitch', j)}${pcard('Existing pitch', b)}</div></div>
      <div class="d-section"><h3>${j.findings.length === 1 ? 'Finding' : `${j.findings.length} findings`}</h3>
      ${j.findings.map(f => `<div class="finding v-${f.verdict}">${confRing(f.confidence)}<div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(f.verdict)}<a class="link" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.title)}</a></div><p>${esc(f.reason || '')}</p></div></div>`).join('')}</div>`
      : o === 'clear' ? `<div class="d-section"><div class="finding v-clear"><div class="conf" style="display:grid;place-items:center"><svg class="vi" style="width:30px;height:30px"><use href="#v-clear"/></svg></div><div><b>No duplicates found</b><p>${meta.method === 'keywords' ? 'No other pitch in the reference window shared enough keywords to need an AI comparison.' : `Compared with ${fmtN(meta.compared || 0)} cards${meta.shortlisted ? `; the AI reviewed the ${meta.shortlisted} closest` : ''} and found nothing that overlaps.`}</p></div></div></div>` : ''}
    <div class="d-section"><h3>Timeline</h3><ol class="steps">${steps.map(s => `<li style="--c:${s.c}">${esc(s.t)}<small>${esc(s.d)}</small></li>`).join('')}</ol></div>
    ${msg ? `<div class="d-section"><h3>WhatsApp message</h3><div class="chat" style="padding:16px">${bubble(msg, { collapse: false })}</div></div>` : ''}
    <div class="d-section"><h3>Check details</h3><dl class="kv">
      <dt>Method</dt><dd>${esc(methodLabel(j.meta))}</dd>
      <dt>Compared against</dt><dd>${meta.compared != null ? `${fmtN(meta.compared)} cards` : '—'}</dd>
      <dt>Sent to AI</dt><dd>${meta.shortlisted != null ? `${meta.shortlisted} closest` : '—'}</dd>
      <dt>Took</dt><dd>${meta.ms != null ? `${(meta.ms / 1000).toFixed(1)}s` : '—'}</dd>
      <dt>Alert</dt><dd>${esc(SEND[j.send]?.label || j.send)}</dd>
      ${j.sid ? `<dt>WhatsApp ID</dt><dd class="num">${esc(j.sid)}</dd>` : ''}
      ${j.error ? `<dt>Last error</dt><dd style="color:var(--critical-ink)" title="${esc(j.error)}">${esc(j.error)}</dd>` : ''}
      ${j.source ? `<dt>Source link</dt><dd><a class="link" href="${esc(j.source)}" target="_blank" rel="noopener">${esc(j.source)}</a></dd>` : ''}</dl></div>
    <div class="actions">
      ${j.url ? `<a class="btn primary" href="${esc(j.url)}" target="_blank" rel="noopener"><svg><use href="#i-ext"/></svg>Open in Trello</a>` : ''}
      <button class="btn" data-act="recheck" data-id="${j.id}"><svg><use href="#i-refresh"/></svg>Check again</button>
      ${j.findings.length ? `<button class="btn" data-act="resend" data-id="${j.id}"><svg><use href="#i-send"/></svg>${j.send === 'accepted' ? 'Send alert again' : 'Send alert'}</button>` : ''}
    </div>`;
  const d = $('#drawer'); d.classList.add('on'); d.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => requestAnimationFrame(() => $$('.conf .p', d).forEach(c => { c.style.strokeDashoffset = c.dataset.to; })));
  $('.drawer-x').focus();
}
function closeDrawer() { const d = $('#drawer'); d.classList.remove('on'); d.setAttribute('aria-hidden', 'true'); S.openJob = null; }

async function jobAction(btn) {
  const { act, id } = btn.dataset;
  const j = jobs().find(x => x.id === id);
  if (act === 'resend' && !confirm(j?.send === 'accepted' ? 'This alert was already sent. Send it to WhatsApp again?' : 'Send this alert to WhatsApp?')) return;
  btn.classList.add('busy');
  try {
    const r = await api(`api/jobs/${id}/${act}`, { method: 'POST' });
    toast(act === 'recheck' ? 'Queued: the monitor checks it again within a minute' : r.sending ? 'Queued: the alert goes out within a minute' : 'Queued, but sending is off (dry run)', 'ok');
    await loadMonitor(true); if (S.openJob) openJob(S.openJob);
  } catch (e) { toast(e.message, 'bad'); } finally { btn.classList.remove('busy'); }
}

// ------------------------------------------------------------------ messages
const MSG_FILTERS = [['all', 'All'], ['pitch', 'Pitch alerts'], ['health', 'Monitor health'], ['netmon', 'Net Monitor'], ['test', 'Tests']];
function renderMessages() {
  const counts = {}; S.messages.forEach(m => { const s = source(m.key).id; counts[s] = (counts[s] || 0) + 1; });
  $('#msg-filters').innerHTML = MSG_FILTERS.filter(([id]) => id === 'all' || counts[id]).map(([id, l]) => `<button data-mf="${id}" class="${S.msgFilter === id ? 'on' : ''}">${l}<span class="n">${id === 'all' ? S.messages.length : counts[id]}</span></button>`).join('');
  const list = S.messages.filter(m => S.msgFilter === 'all' || source(m.key).id === S.msgFilter).slice(0, S.msgShown).reverse();
  const el = $('#chat');
  if (!list.length) { el.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><use href="#i-chat"/></svg><div>No messages yet. Messages sent from now on appear here.</div></div>`; return; }
  const atBottom = el.dataset.ready && innerHeight + scrollY >= document.body.scrollHeight - 80;
  let h = '', day = '';
  const total = S.messages.filter(m => S.msgFilter === 'all' || source(m.key).id === S.msgFilter).length;
  if (total > S.msgShown) h += `<button class="btn ghost" style="align-self:center" id="earlier">Show earlier messages</button>`;
  for (const m of list) {
    const k = dayKey(m.sentAt || m.at);
    if (k !== day) { day = k; h += `<div class="day-sep">${esc(dayFmt.format(m.sentAt || m.at))}</div>`; }
    h += bubble(m);
  }
  el.innerHTML = h;
  if (!el.dataset.ready || atBottom) { el.dataset.ready = '1'; requestAnimationFrame(() => scrollTo({ top: document.body.scrollHeight, behavior: el.dataset.ready ? 'smooth' : 'auto' })); }
}

// ------------------------------------------------------------------ activity
const EVENT_STYLE = {
  started: ['var(--accent)', 'Add-on started', '<path d="M5 3l14 9-14 9V3Z"/>'],
  connected: ['var(--good)', 'WhatsApp connected', '<path d="m5 12 5 5 9-10"/>'],
  disconnected: ['var(--warning)', 'WhatsApp disconnected', '<path d="M6 6l12 12M18 6 6 18"/>'],
  pairing: ['var(--info)', 'Pairing code issued', '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>'],
  logged_out: ['var(--critical)', 'Unlinked by WhatsApp', '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l-5-5 5-5M5 12h11"/>'],
  wrong_account: ['var(--critical)', 'Wrong account linked', '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'],
  forbidden: ['var(--critical)', 'WhatsApp refused the connection', '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>'],
  relink: ['var(--info)', 'Relink requested', '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'],
  settings: ['var(--accent)', 'Settings changed', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'],
  test: ['var(--accent)', 'Test message sent', '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4 18-7Z"/>'],
  recheck: ['var(--info)', 'Recheck requested', '<path d="M20 11a8 8 0 0 0-14.6-4.5L3 9"/><path d="M3 4v5h5"/>'],
  resend: ['var(--info)', 'Resend requested', '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4 18-7Z"/>'],
  rejected: ['var(--critical)', 'Request rejected', '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17v.1"/>'],
  send_failed: ['var(--critical)', 'Send not confirmed', '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17v.1"/>'],
  error: ['var(--critical)', 'Error', '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.1"/>'],
};
function renderActivity() {
  const series = scanSeries();
  $('#scan-legend').innerHTML = legendHtml(series);
  if (S.monitor) columns($('#chart-scan-history'), { series, cols: hourCols(S.scanHours), labelEvery: S.scanHours === 24 ? 3 : S.scanHours === 72 ? 6 : 8 });
  $('#event-count').textContent = `${S.events.length} events`;
  $('#events').innerHTML = S.events.slice(0, 300).map((e, i) => {
    const [c, title, path] = EVENT_STYLE[e.type] || ['var(--muted)', e.type, '<circle cx="12" cy="12" r="4"/>'];
    return `<li style="--c:${c};animation-delay:${Math.min(i, 15) * 25}ms"><span class="ev"><svg viewBox="0 0 24 24">${path}</svg></span><div><b>${esc(title)}</b><small>${esc(e.detail)}</small></div>${timeTag(e.at)}</li>`;
  }).join('') || '<li><div class="empty" style="grid-column:1/-1">No events yet.</div></li>';
}

// ------------------------------------------------------------------ settings
const toggle = (name, on, label = name) => `<span class="toggle"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} aria-label="${esc(label)}"><span></span></span>`;
const err = k => (S.fieldErrors[k] ? `<div class="err">${esc(S.fieldErrors[k])}</div>` : '');
function monitorDraftFrom(m, lists) {
  const v = m.settings.values;
  return {
    enabled: v.enabled, sending: v.sending, alert_verdicts: [...v.alert_verdicts], min_confidence: v.min_confidence,
    quiet_hours: v.quiet_hours, health_alerts: v.health_alerts, reference_days: v.reference_days,
    list_ids: lists ? lists.lists.filter(l => l.watched).map(l => l.id) : null,
  };
}
function bridgeDraftFrom(s) {
  return { recipient_number: s.recipient_number, sender_number: s.sender_number, ha_notifications: s.ha_notifications, offline_notify_minutes: s.offline_notify_minutes, worker_url: s.worker_url };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function monitorChanges() {
  if (!S.draft || !S.monitor) return {};
  const base = monitorDraftFrom(S.monitor, S.lists), out = {};
  for (const k of Object.keys(S.draft)) if (S.draft[k] !== null && !same(S.draft[k], base[k])) out[k] = S.draft[k];
  return out;
}
function bridgeChanges() {
  if (!S.bridgeDraft || !S.status) return {};
  const base = bridgeDraftFrom(S.status.settings), out = {};
  for (const k of Object.keys(S.bridgeDraft)) if (!same(S.bridgeDraft[k], base[k])) out[k] = S.bridgeDraft[k];
  return out;
}

function renderSettings(force = false) {
  const el = $('#settings');
  // Don't rebuild the form under the user's cursor while they edit.
  if (!force && el.dataset.built && (Object.keys(monitorChanges()).length || Object.keys(bridgeChanges()).length || el.contains(document.activeElement))) { renderConnection(); return; }
  const st = S.status, m = S.monitor;
  // Only rebuild when the saved settings themselves changed, not on every poll.
  const sig = JSON.stringify([m?.settings, S.lists, S.listsError, st?.settings, S.monitorError, prefs, S.fieldErrors]);
  if (!force && el.dataset.built && el.dataset.sig === sig) { renderConnection(); return; }
  el.dataset.sig = sig;
  if (st) S.bridgeDraft = bridgeDraftFrom(st.settings);
  if (m) S.draft = monitorDraftFrom(m, S.lists);
  const d = S.draft, bd = S.bridgeDraft;
  const quietOn = Boolean(d?.quiet_hours), [qFrom, qTo] = (d?.quiet_hours || '23:00-07:00').split('-');
  el.innerHTML = `
    <div class="card s-card rise" id="s-conn"></div>

    <div class="card s-card rise" style="animation-delay:60ms">
      <div class="s-head"><span class="ico"><svg><use href="#i-layers"/></svg></span><div><h2>Pitch monitor</h2><p>Runs in the pitch-checker Worker. Changes apply on its next minute tick.</p></div></div>
      ${!m ? `<div class="field col"><div class="muted">${esc(S.monitorError || 'Loading…')}</div></div>` : `
      <div class="field"><div class="fl">Monitoring<small>Scan the Trello board every minute and check new pitches</small></div>${toggle('enabled', d.enabled, 'Monitoring')}</div>
      <div class="field"><div class="fl">Send WhatsApp alerts<small>When off, findings are recorded as a dry run and nothing is sent</small></div>${toggle('sending', d.sending, 'Send WhatsApp alerts')}</div>
      <div class="field col"><div class="fl">Watched lists<small>A pitch is checked the first time it appears in one of these lists</small></div>
        <div class="chips" id="lists">${S.lists ? S.lists.lists.map(l => `<label class="chk"><input type="checkbox" name="list" value="${l.id}" ${d.list_ids?.includes(l.id) ? 'checked' : ''}><span><i class="mark"></i>${esc(l.name)}</span></label>`).join('') : `<span class="muted">${esc(S.listsError || 'Loading lists from Trello…')}</span>`}</div>${err('list_ids')}</div>
      <div class="field col"><div class="fl">Alert me for<small>Other findings are still shown here but don't send a message</small></div>
        <div class="chips">${FLAGS.map(v => `<label class="chk"><input type="checkbox" name="verdict" value="${v}" ${d.alert_verdicts.includes(v) ? 'checked' : ''}><span class="v-${v}"><svg style="fill:currentColor;stroke:none"><use href="#v-${v}"/></svg><span style="color:var(--ink)">${VERDICTS[v].label}</span></span></label>`).join('')}</div>${err('alert_verdicts')}</div>
      <div class="field"><div class="fl">Minimum confidence<small>Only alert when the AI is at least this sure</small></div>
        <div class="range"><input type="range" name="min_confidence" min="0" max="100" step="5" value="${d.min_confidence}"><output>${d.min_confidence}%</output></div></div>
      <div class="field"><div class="fl">Quiet hours<small>Hold alerts overnight and send them when the window ends (Bangladesh time)</small></div>
        <div class="pair">${toggle('quiet_on', quietOn, 'Quiet hours')}<input class="input time" type="time" name="q_from" value="${qFrom}" ${quietOn ? '' : 'disabled'} aria-label="From"><span class="muted">to</span><input class="input time" type="time" name="q_to" value="${qTo}" ${quietOn ? '' : 'disabled'} aria-label="To"></div>${err('quiet_hours')}</div>
      <div class="field"><div class="fl">Health alerts<small>WhatsApp you if scans stall, the AI fails, or an alert isn't delivered</small></div>${toggle('health_alerts', d.health_alerts, 'Health alerts')}</div>
      <div class="field"><div class="fl">Reference window<small>How far back to look for earlier pitches on the board</small></div>
        <div class="range"><input type="range" name="reference_days" min="1" max="14" step="1" value="${d.reference_days}"><output>${d.reference_days} d</output></div></div>`}
    </div>

    <div class="card s-card rise" style="animation-delay:120ms">
      <div class="s-head"><span class="ico"><svg><use href="#i-chat"/></svg></span><div><h2>WhatsApp bridge</h2><p>This add-on's options. Saving restarts the add-on (about 10 seconds).</p></div></div>
      ${!bd ? '<div class="field col"><div class="muted">Loading…</div></div>' : `
      <div class="field"><label for="f-rcpt">Send alerts to<small class="help" style="display:block;margin:2px 0 0;font-weight:400">Updates the Worker too</small></label><input class="input" id="f-rcpt" name="recipient_number" value="${esc(bd.recipient_number)}" inputmode="tel" autocomplete="off">${err('recipient_number')}</div>
      <div class="field"><label for="f-sender">Sender number<small class="help" style="display:block;margin:2px 0 0;font-weight:400">Changing it needs a new pairing</small></label><input class="input" id="f-sender" name="sender_number" value="${esc(bd.sender_number)}" inputmode="tel" autocomplete="off">${err('sender_number')}</div>
      <div class="field"><div class="fl">Home Assistant notifications<small>Warn in Home Assistant when WhatsApp is unlinked or offline</small></div>${toggle('ha_notifications', bd.ha_notifications, 'Home Assistant notifications')}</div>
      <div class="field"><label for="f-off">Offline warning after<small class="help" style="display:block;margin:2px 0 0;font-weight:400">Minutes disconnected before warning</small></label><input class="input" id="f-off" type="number" min="1" max="1440" name="offline_notify_minutes" value="${bd.offline_notify_minutes}">${err('offline_notify_minutes')}</div>
      <div class="field col"><label for="f-worker">Pitch-checker Worker address</label><input class="input wide" id="f-worker" name="worker_url" value="${esc(bd.worker_url)}" placeholder="https://name.account.workers.dev" autocomplete="off">
        <div class="help">Where this dashboard reads pitch checks from. It signs in with the add-on's api_token.</div>${err('worker_url')}</div>`}
    </div>

    <div class="card s-card rise" style="animation-delay:180ms">
      <div class="s-head"><span class="ico"><svg><use href="#i-grid"/></svg></span><div><h2>Dashboard</h2><p>Saved in this browser only.</p></div></div>
      <div class="field"><div class="fl">Theme</div><div class="seg" data-pref="theme">${[['auto', 'Match Home Assistant'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => `<button data-v="${v}" class="${prefs.theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="field"><div class="fl">Refresh every</div><div class="seg" data-pref="refresh">${[5, 10, 30, 60].map(v => `<button data-v="${v}" class="${prefs.refresh === v ? 'on' : ''}">${v}s</button>`).join('')}</div></div>
      <div class="field"><div class="fl">Animations</div>${toggle('pref_motion', prefs.motion, 'Animations')}</div>
    </div>
    <div class="savebar" id="savebar"><span id="save-text">Unsaved changes</span><button class="btn ghost" id="discard">Discard</button><button class="btn primary" id="save">Save changes</button></div>`;
  el.dataset.built = '1';
  renderConnection(); updateSavebar();
}

function renderConnection() {
  const el = $('#s-conn'), st = S.status; if (!el) return;
  if (!st) { el.innerHTML = '<div class="s-head"><div class="skel" style="height:60px;width:100%"></div></div>'; return; }
  const b = st.bridge, ok = b.connected && b.accountOk;
  const code = b.pairingCode ? [...b.pairingCode].map((c, i) => `<span style="animation-delay:${i * 60}ms">${esc(c)}</span>`).join('') : '';
  const sig = `${ok}|${b.pairingCode}|${b.connected}|${b.user?.number}`;
  if (el.dataset.sig === sig) { const up = $('#conn-up'); if (up) up.textContent = ok ? `Connected for ${dur(Date.now() - b.connectedSince)}` : b.offlineSince ? `Offline for ${dur(Date.now() - b.offlineSince)}` : 'Offline'; return; }
  el.dataset.sig = sig;
  el.innerHTML = `
    <div class="s-head"><span class="ico"><svg><use href="#i-link"/></svg></span><div><h2>WhatsApp connection</h2><p>The linked device that sends every alert.</p></div></div>
    <div class="conn"><div class="avatar${ok ? '' : ' off'}">${esc((b.user?.name || 'WA').slice(0, 2).toUpperCase())}</div>
      <div class="who"><b>${ok ? esc(b.user?.name || 'Linked') : b.pairingCode ? 'Waiting for pairing' : b.connected ? 'Wrong account linked' : 'Not connected'}</b>
        <small>${esc(b.user?.number || b.sender)} · <span id="conn-up">${ok ? `Connected for ${dur(Date.now() - b.connectedSince)}` : b.offlineSince ? `Offline for ${dur(Date.now() - b.offlineSince)}` : 'Offline'}</span>${b.reconnects ? ` · ${b.reconnects} reconnect${b.reconnects === 1 ? '' : 's'}` : ''}</small></div>
      <button class="btn" id="btn-test" ${ok ? '' : 'disabled'}><svg><use href="#i-send"/></svg>Send test</button>
      <button class="btn danger" id="btn-relink"><svg><use href="#i-refresh"/></svg>${b.paired ? 'Relink device' : 'New pairing code'}</button></div>
    ${b.pairingCode ? `<div class="pairing"><div class="muted small">Pairing code for ${esc(b.sender)}</div><div class="code">${code}</div>
      <ol><li>On that phone open WhatsApp › Settings › Linked devices › Link a device</li><li>Tap “Link with phone number instead”</li><li>Enter the code above. It refreshes automatically if it expires.</li></ol></div>` : ''}`;
}

function updateSavebar() {
  const n = Object.keys(monitorChanges()).length + Object.keys(bridgeChanges()).length;
  const bar = $('#savebar'); if (!bar) return;
  bar.classList.toggle('on', n > 0);
  $('#save-text').textContent = `${n} unsaved change${n === 1 ? '' : 's'}${Object.keys(bridgeChanges()).length ? ' · add-on restarts' : ''}`;
}

function onSettingsInput(e) {
  const t = e.target, d = S.draft, bd = S.bridgeDraft;
  if (t.name === 'pref_motion') { prefs.motion = t.checked; savePrefs(); return; }
  if (d) {
    if (['enabled', 'sending', 'health_alerts'].includes(t.name)) d[t.name] = t.checked;
    if (t.name === 'list') d.list_ids = $$('input[name=list]:checked').map(x => x.value);
    if (t.name === 'verdict') d.alert_verdicts = $$('input[name=verdict]:checked').map(x => x.value);
    if (t.name === 'min_confidence') { d.min_confidence = Number(t.value); t.nextElementSibling.textContent = `${t.value}%`; }
    if (t.name === 'reference_days') { d.reference_days = Number(t.value); t.nextElementSibling.textContent = `${t.value} d`; }
    if (['quiet_on', 'q_from', 'q_to'].includes(t.name)) {
      const on = $('input[name=quiet_on]').checked;
      $$('input[name=q_from],input[name=q_to]').forEach(x => { x.disabled = !on; });
      d.quiet_hours = on ? `${$('input[name=q_from]').value}-${$('input[name=q_to]').value}` : '';
    }
  }
  if (bd && t.name in bd) bd[t.name] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value.trim();
  updateSavebar();
}

async function saveSettings() {
  const mc = monitorChanges(), bc = bridgeChanges(), btn = $('#save');
  if (mc.alert_verdicts && !mc.alert_verdicts.length) { S.fieldErrors = { alert_verdicts: 'Pick at least one' }; renderSettings(true); return; }
  if (mc.list_ids && !mc.list_ids.length) { S.fieldErrors = { list_ids: 'Pick at least one list' }; renderSettings(true); return; }
  btn.classList.add('busy'); S.fieldErrors = {};
  try {
    if (Object.keys(mc).length) {
      try { await api('api/monitor/settings', { method: 'POST', body: { settings: mc } }); }
      catch (e) { if (e.data?.errors) { S.fieldErrors = Object.fromEntries(Object.entries(e.data.errors).map(([k, v]) => [k, v])); } throw e; }
      await loadMonitor(true);
      if (mc.list_ids) await loadLists();
      toast('Monitor settings saved', 'ok');
    }
    if (Object.keys(bc).length) {
      try { await api('api/settings', { method: 'POST', body: { changes: bc } }); }
      catch (e) { if (e.data?.errors) S.fieldErrors = { ...S.fieldErrors, ...e.data.errors }; throw e; }
      S.restarting = Date.now(); toast('Saved. Restarting the add-on…', 'ok'); renderChrome();
    }
    renderSettings(true);
  } catch (e) {
    toast(Object.keys(S.fieldErrors).length ? 'Please fix the highlighted settings' : e.message, 'bad');
    renderSettings(true);
    // keep the user's edits visible
    Object.assign(S.draft || {}, mc); Object.assign(S.bridgeDraft || {}, bc);
    for (const [k, v] of Object.entries({ ...mc, ...bc })) { const i = $(`#settings [name="${k}"]`); if (i && typeof v !== 'object') { if (i.type === 'checkbox') i.checked = v; else i.value = v; } }
    updateSavebar();
  } finally { btn?.classList.remove('busy'); }
}

// ------------------------------------------------------------------ data loading
async function loadStatus() {
  try {
    const st = await api('api/status');
    if (S.restarting && st.version) { if (Date.now() - S.restarting > 4000) { S.restarting = false; toast('Add-on restarted with the new settings', 'ok'); renderSettings(true); } }
    S.status = st;
  } catch { if (!S.restarting) S.status = S.status && { ...S.status }; }
  renderChrome();
  if (S.page === 'overview') { renderTiles(); renderHealth(); }
  if (S.page === 'settings') renderSettings();
}
async function loadMonitor(fresh = false) {
  try {
    const m = await api(`api/monitor${fresh ? `?t=${Date.now()}` : ''}`);
    S.clockOffset = m.now * 1000 - Date.now(); S.monitor = m; S.monitorError = null;
  } catch (e) { S.monitorError = e.message; }
  renderPage();
}
async function loadMessages() {
  const t = m => m.sentAt || m.created || m.at;
  try { S.messages = (await api('api/messages')).messages.sort((a, b) => t(b) - t(a)); } catch { /* keep last */ }
  if (S.page === 'messages') renderMessages();
}
async function loadEvents() {
  try { S.events = (await api('api/events')).events; } catch { /* keep last */ }
  if (S.page === 'activity') renderActivity();
}
async function loadLists() {
  try { S.lists = await api('api/lists'); S.listsError = S.lists.error; } catch (e) { S.listsError = e.message; }
  if (S.page === 'settings') renderSettings(true);
}

function renderPage() {
  renderChrome();
  if (S.page === 'overview') renderOverview();
  if (S.page === 'pitches') renderPitches();
  if (S.page === 'messages') renderMessages();
  if (S.page === 'activity') renderActivity();
  if (S.page === 'settings') renderSettings();
}

// ------------------------------------------------------------------ routing
function go() {
  const page = (location.hash.slice(1) || 'overview').split('/')[0];
  if (!$(`#page-${page}`)) { location.hash = 'overview'; return; }
  S.page = page;
  $$('.page').forEach(p => p.classList.toggle('on', p.id === `page-${page}`));
  $$('[data-page]').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  const sec = $(`#page-${page}`);
  $('#page-title').textContent = sec.dataset.title; $('#page-sub').textContent = sec.dataset.sub;
  document.title = `${sec.dataset.title} · PDC Monitor`;
  if (page === 'settings') { $('#settings').dataset.built = ''; if (!S.lists) loadLists(); }
  if (page === 'activity') loadEvents();
  if (page === 'messages') { $('#chat').dataset.ready = ''; loadMessages(); }
  scrollTo({ top: 0 });
  renderPage();
}
addEventListener('hashchange', go);

// ------------------------------------------------------------------ events
document.addEventListener('click', async e => {
  const t = e.target.closest('button, [data-job], [data-close]'); if (!t) return;
  if (t.dataset.job) return openJob(t.dataset.job);
  if (t.hasAttribute('data-close')) return closeDrawer();
  if (t.dataset.act) return jobAction(t);
  if (t.dataset.days) { S.dailyDays = Number(t.dataset.days); $$('#daily-range button').forEach(b => b.classList.toggle('on', b === t)); return renderDaily(); }
  if (t.dataset.hours) { S.scanHours = Number(t.dataset.hours); $$('#scan-range button').forEach(b => b.classList.toggle('on', b === t)); return renderActivity(); }
  if (t.dataset.f) { S.filter = t.dataset.f; S.shown = 60; return renderPitches(); }
  if (t.dataset.mf) { S.msgFilter = t.dataset.mf; S.msgShown = 120; $('#chat').dataset.ready = ''; return renderMessages(); }
  if (t.id === 'earlier') { S.msgShown += 120; const y = document.body.scrollHeight - scrollY; renderMessages(); scrollTo({ top: document.body.scrollHeight - y }); return; }
  if (t.dataset.expand) { const m = S.messages.find(x => x.key === t.dataset.expand); if (m) t.closest('.bubble').outerHTML = bubble(m, { collapse: false }); return; }
  if (t.id === 'more') { S.shown += 60; return renderPitches(); }
  if (t.closest('[data-pref]')) {
    const k = t.closest('[data-pref]').dataset.pref; prefs[k] = k === 'refresh' ? Number(t.dataset.v) : t.dataset.v; savePrefs();
    $$(`[data-pref="${k}"] button`).forEach(b => b.classList.toggle('on', b === t)); schedule(); return;
  }
  if (t.id === 'btn-test' || t.id === 'btn-test-2') {
    t.classList.add('busy');
    try { await api('api/test', { method: 'POST', body: {} }); toast('Test message sent. Check WhatsApp', 'ok'); loadMessages(); }
    catch (err) { toast(err.message, 'bad'); } finally { t.classList.remove('busy'); }
    return;
  }
  if (t.id === 'btn-relink') {
    if (!confirm('Unlink this bridge from WhatsApp and get a new pairing code?\n\nAlerts pause until you enter the new code on the sender phone.')) return;
    t.classList.add('busy');
    try { await api('api/relink', { method: 'POST' }); toast('Unlinked. A new pairing code appears in a few seconds', 'ok'); setTimeout(loadStatus, 3000); }
    catch (err) { toast(err.message, 'bad'); } finally { t.classList.remove('busy'); }
    return;
  }
  if (t.id === 'save') return saveSettings();
  if (t.id === 'discard') { S.fieldErrors = {}; renderSettings(true); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.job) { e.preventDefault(); openJob(e.target.dataset.job); }
  if (e.key === '/' && S.page === 'pitches' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
});
$('#q').addEventListener('input', e => { S.q = e.target.value; S.shown = 60; renderPitches(); });
$('#settings').addEventListener('input', onSettingsInput);
$('#settings').addEventListener('change', onSettingsInput);
let resizeT; addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderPage, 150); });

// Relative times and the pulse ring tick every second without refetching.
setInterval(() => {
  $$('[data-ago]').forEach(el => { el.textContent = ago(Number(el.dataset.ago), el.closest('#pills, .card') ? serverNow() : Date.now()); });
  tickPulse();
}, 1000);

let timers = [];
function schedule() {
  timers.forEach(clearInterval);
  const r = prefs.refresh * 1000;
  timers = [
    setInterval(() => !document.hidden && loadStatus(), r),
    setInterval(() => !document.hidden && loadMonitor(), Math.max(15000, r)),
    setInterval(() => !document.hidden && loadMessages(), Math.max(20000, r)),
    setInterval(() => !document.hidden && S.page === 'activity' && loadEvents(), Math.max(20000, r)),
  ];
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadStatus(); loadMonitor(); } });

applyTheme();
go();
loadStatus(); loadMonitor(); loadMessages();
schedule();
