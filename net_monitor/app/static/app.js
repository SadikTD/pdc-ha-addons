/* Net Monitor dashboard. All times are shown in the viewer's local time zone. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  };
  const root = $("root");
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- formatting
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const hFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const dFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const dShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const time = (ts) => tFmt.format(ts * 1000);
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  const when = (ts) => {
    const now = Date.now() / 1000;
    if (sameDay(ts, now)) return `Today ${time(ts)}`;
    if (sameDay(ts, now - 86400)) return `Yesterday ${time(ts)}`;
    return `${dFmt.format(ts * 1000)}, ${time(ts)}`;
  };
  const dur = (s, precise) => {
    s = Math.max(0, Math.round(s));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return precise ? `${h}h ${m}m ${sec}s` : `${h}h ${m}m`;
    if (m) return precise || (m < 10 && sec) ? `${m}m ${sec}s` : `${m}m`;
    return `${sec}s`;
  };
  const mbps = (v) => (v == null ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const ms = (v) => (v == null ? "—" : v.toFixed(v < 10 ? 1 : 0));
  const pct = (v, d = 0) => (v == null ? "—" : `${v.toFixed(d)}%`);
  const relative = (ts) => {
    const diff = ts - Date.now() / 1000, a = Math.abs(diff);
    const txt = a < 60 ? "less than a minute" : dur(a);
    return diff >= 0 ? `in ${txt}` : `${txt} ago`;
  };
  const toLocalInput = (ts) => {
    const d = new Date(ts * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const fromLocalInput = (v) => new Date(v).getTime() / 1000;
  const TRIGGER = { scheduled: "Hourly", manual: "Manual", after_outage: "After outage" };
  const SKIP = { failed: ["down", "Failed"], skipped_busy: ["warn", "Skipped — line busy"], skipped_paused: ["", "Skipped — paused"] };

  // -------------------------------------------------------------------- theme
  // Follow Home Assistant's own light/dark setting (Ingress runs same-origin),
  // falling back to the OS preference when opened outside HA.
  const osDark = matchMedia("(prefers-color-scheme: dark)");
  function detectDark() {
    try {
      const ha = window.parent !== window && window.parent.document.querySelector("home-assistant");
      if (ha && ha.hass && ha.hass.themes && typeof ha.hass.themes.darkMode === "boolean") return ha.hass.themes.darkMode;
    } catch (e) { /* not embedded in HA */ }
    return osDark.matches;
  }
  function applyTheme(force) {
    const theme = detectDark() ? "dark" : "light";
    if (!force && document.documentElement.dataset.theme === theme) return;
    document.documentElement.dataset.theme = theme;
    if (data.loaded) renderCharts();
  }

  // ----------------------------------------------------------------- animation
  function countUp(el, to, format) {
    if (to == null || Number.isNaN(to)) { el.textContent = format(null); el.dataset.v = ""; return; }
    const from = el.dataset.v === undefined || el.dataset.v === "" ? 0 : Number(el.dataset.v);
    el.dataset.v = to;
    if (reduceMotion || from === to) { el.textContent = format(to); return; }
    const t0 = performance.now(), D = 700;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - k, 3);
      el.textContent = format(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ tooltip
  const tip = $("tip");
  function showTip(ev, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 12, y = ev.clientY + 12;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 12;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 12;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // -------------------------------------------------------------------- state
  let range = { preset: 86400, lo: 0, hi: 0 };
  let lastPreset = 86400;
  const data = { status: null, tests: [], checks: [], events: [], report: null, timeline: [], heat: null, ips: [], loaded: false };
  let showAllTests = false;
  const charts = {};
  let lastTestSeen = null, wasRunning = false, statusTimer = null;

  function computeRange() {
    if (range.preset !== "custom") {
      range.hi = Date.now() / 1000;
      range.lo = range.hi - range.preset;
    }
  }

  // --------------------------------------------------------------------- load
  async function loadStatus() {
    const s = await api("api/status");
    data.status = s;
    renderHero();
    const newest = s.last_test ? s.last_test.id : null;
    if ((wasRunning && !s.test_running) || (lastTestSeen !== null && newest !== lastTestSeen)) loadAll();
    wasRunning = s.test_running;
    lastTestSeen = newest;
    scheduleStatus(s.test_running ? 1000 : 10000);
  }
  function scheduleStatus(ms) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => loadStatus().catch(() => scheduleStatus(10000)), ms);
  }

  async function loadAll() {
    computeRange();
    const q = `from=${range.lo}&to=${range.hi}`;
    const buckets = innerWidth < 560 ? 45 : 90;
    const [status, tests, checks, events, report, tl, heat, ips] = await Promise.all([
      api("api/status"), api(`api/speedtests?${q}`), api(`api/checks?${q}`), api(`api/events?${q}`),
      api(`api/report?${q}`), api(`api/timeline?${q}&buckets=${buckets}`), api("api/heatmap?days=30"), api("api/iplog"),
    ]);
    Object.assign(data, { status, tests, checks, events, report, timeline: tl, heat, ips, loaded: true });
    lastTestSeen = status.last_test ? status.last_test.id : null;
    root.classList.remove("skeleton");
    renderHero();
    renderRangeLabel();
    renderStrip();
    renderReport();
    renderCharts();
    renderHeatmap();
    renderIps();
    renderOutages();
    renderTests();
    $("export-tests").href = `api/export/speedtests.csv?${q}`;
    $("export-outages").href = `api/export/outages.csv?${q}`;
    loadAlerts().catch((e) => console.error(e));
    loadMonths().catch((e) => console.error(e));
  }

  // --------------------------------------------------------------------- hero
  function renderHero() {
    const s = data.status;
    if (!s) return;
    const card = $("conn-card");
    card.classList.toggle("up", s.online === true);
    card.classList.toggle("down", s.online === false && !s.planned_outage);
    card.classList.toggle("planned", s.online === false && !!s.planned_outage);
    $("conn-state").classList.remove("loading");
    $("conn-state").textContent = s.online === true ? "Online"
      : s.online === false ? (s.planned_outage ? "Router restarting" : "Internet down") : "Checking…";
    tickSince();
    countUp($("q-latency"), s.online ? s.latency_ms : null, (v) => (v == null ? "—" : `${ms(v)} ms`));
    countUp($("q-jitter"), s.online ? s.jitter_ms : null, (v) => (v == null ? "—" : `${ms(v)} ms`));
    countUp($("q-loss"), s.online ? s.loss_pct : null, (v) => (v == null ? "—" : `${v.toFixed(0)}%`));
    drawSpark();

    const lt = s.last_test;
    countUp($("sp-down"), lt ? lt.download_mbps : null, mbps);
    countUp($("sp-up"), lt ? lt.upload_mbps : null, mbps);
    const dp = lt ? (100 * lt.download_mbps) / s.plan_down : null, up = lt ? (100 * lt.upload_mbps) / s.plan_up : null;
    $("sp-down-bar").style.width = `${Math.min(100, dp || 0)}%`;
    $("sp-up-bar").style.width = `${Math.min(100, up || 0)}%`;
    $("sp-down-pct").textContent = lt ? `${dp.toFixed(0)}% of ${s.plan_down} Mbps plan` : "No test yet";
    $("sp-up-pct").textContent = lt ? `${up.toFixed(0)}% of ${s.plan_up} Mbps plan` : "";

    const paused = s.paused_until === -1 || s.paused_until > s.now;
    let next;
    if (paused) next = s.paused_until === -1 ? "Scheduled tests paused" : `Paused until ${when(s.paused_until)}`;
    else if (s.next_test_ts) next = `Next ${time(s.next_test_ts)} (${relative(s.next_test_ts)})`;
    else next = "";
    const note = s.scheduler_note ? ` · ${s.scheduler_note}` : "";
    $("speed-foot").innerHTML = lt
      ? `${esc(when(lt.ts))} · ${ms(lt.ping_ms)} ms ping · ${esc(lt.server_name || "")} · ${esc(next)}${esc(note)}`
      : esc(next + note);
    $("pause-label").textContent = paused ? "Paused" : "Pause";
    $("menu-resume").hidden = !paused;

    const run = $("btn-run");
    run.disabled = s.test_running;
    run.querySelector("span").textContent = s.test_running ? "Testing…" : "Run speedtest";
    renderLive();
  }

  function tickSince() {
    const s = data.status;
    if (!s) return;
    const now = Date.now() / 1000;
    let text = "";
    if (s.online === true && s.online_since) text = `Online for ${dur(now - s.online_since, true)}`;
    else if (s.online === false && s.outage_start && s.planned_outage) text = `Scheduled restart since ${time(s.outage_start)} · ${dur(now - s.outage_start, true)}`;
    else if (s.online === false && s.outage_start) text = `Down since ${when(s.outage_start)} · ${dur(now - s.outage_start, true)}`;
    if (s.last_check_ts) text += `${text ? " · " : ""}checked ${relative(s.last_check_ts)}`;
    $("conn-since").textContent = text || " ";
  }

  function renderLive() {
    const s = data.status;
    const live = $("live");
    live.hidden = !s.test_running;
    if (!s.test_running) return;
    const order = ["ping", "download", "upload"];
    const idx = order.indexOf(s.test_phase);
    const labels = { connecting: "Connecting to server…", ping: "Measuring latency…", download: "Testing download…", upload: "Testing upload…" };
    $("live-phase").textContent = labels[s.test_phase] || "Starting…";
    $("live-value").textContent = s.test_live_mbps == null ? "" : s.test_phase === "ping" ? `${ms(s.test_live_mbps)} ms` : `${mbps(s.test_live_mbps)} Mbit/s`;
    live.querySelectorAll("[data-step]").forEach((el) => {
      const i = order.indexOf(el.dataset.step);
      el.className = i < idx ? "done" : i === idx ? "active" : "";
    });
    const overall = idx < 0 ? 0.02 : (idx + Math.min(1, s.test_progress || 0)) / 3;
    $("live-bar").style.width = `${(overall * 100).toFixed(1)}%`;
  }

  function drawSpark() {
    const c = $("spark"), s = data.status;
    const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    const pts = (s.sparkline || []).filter((p) => p.up && p.latency_ms != null);
    if (pts.length < 2) return;
    const t0 = s.sparkline[0].ts, t1 = s.sparkline[s.sparkline.length - 1].ts || t0 + 1;
    const vals = pts.map((p) => p.latency_ms);
    const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.1 || 1;
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * (w - 4) + 2, Y = (v) => h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 14);
    const color = css("--series-lat");
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "40");
    grad.addColorStop(1, color + "00");
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.ts), Y(p.latency_ms)) : ctx.moveTo(X(p.ts), Y(p.latency_ms))));
    ctx.lineTo(X(pts[pts.length - 1].ts), h);
    ctx.lineTo(X(pts[0].ts), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.ts), Y(p.latency_ms)) : ctx.moveTo(X(p.ts), Y(p.latency_ms))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();
    // failures as small red ticks along the bottom
    ctx.fillStyle = css("--critical");
    (s.sparkline || []).filter((p) => !p.up).forEach((p) => ctx.fillRect(X(p.ts) - 1, h - 3, 2, 3));
  }

  // -------------------------------------------------------------- range label
  function renderRangeLabel() {
    $("range-label").textContent = `${fullFmt.format(range.lo * 1000)} → ${range.preset === "custom" ? fullFmt.format(range.hi * 1000) : "now"}`;
  }

  // ------------------------------------------------------------- uptime strip
  function renderStrip() {
    const tl = data.timeline;
    const r = data.report;
    $("uptime-headline").textContent = r.uptime_pct == null ? "—" : pct(r.uptime_pct, r.uptime_pct >= 99.95 || r.uptime_pct < 10 ? 1 : 2);
    const strip = $("strip");
    strip.innerHTML = tl.map((b, i) => {
      let cls = "";
      if (b.uptime_pct != null) cls = b.downtime_s <= 0 ? "good" : b.uptime_pct >= 95 ? "warn" : "bad";
      return `<span class="${cls}" data-i="${i}"></span>`;
    }).join("");
    if (tl.length) {
      const span = range.hi - range.lo;
      const f = (t) => (span <= 2 * 86400 ? time(t) : dShort.format(t * 1000));
      $("strip-start").textContent = f(tl[0].from);
      $("strip-end").textContent = range.preset === "custom" ? f(tl[tl.length - 1].to) : "Now";
    }
  }
  $("strip").addEventListener("mousemove", (ev) => {
    const i = ev.target.dataset && ev.target.dataset.i;
    if (i === undefined) return hideTip();
    const b = data.timeline[Number(i)];
    const span = b.to - b.from;
    const head = span >= 86400 * 0.99 ? dFmt.format(b.from * 1000) : `${when(b.from)} – ${time(b.to)}`;
    const body = b.uptime_pct == null
      ? "<span>Not monitored</span>"
      : `<span>${pct(b.uptime_pct, 2)} uptime</span>${b.downtime_s ? `<span>${dur(b.downtime_s)} down · ${b.outages} outage${b.outages === 1 ? "" : "s"}</span>` : ""}` +
        (b.planned_s > 30 ? `<span>${dur(b.planned_s)} scheduled router restart</span>` : "") +
        (b.offline_s > 30 ? `<span>${dur(b.offline_s)} not monitored</span>` : "");
    showTip(ev, `<b>${esc(head)}</b>${body}`);
  });
  $("strip").addEventListener("mouseleave", hideTip);

  // ---------------------------------------------------------------- report
  function renderReport() {
    const r = data.report;
    const g = $("grade");
    g.className = `grade${r.grade ? ` g-${r.grade}` : ""}`;
    $("grade-letter").textContent = r.grade || "–";
    $("grade-caption").textContent = r.grade
      ? `Speed ${r.avg_down_pct.toFixed(0)}% of plan · ${pct(r.uptime_pct, 1)} uptime`
      : "Needs speedtests and uptime data";
    const c = r.test_counts || {};
    const skipped = (c.skipped_busy || 0) + (c.skipped_paused || 0);
    $("report-sub").textContent = `${r.tests} speedtest${r.tests === 1 ? "" : "s"}${c.failed ? ` · ${c.failed} failed` : ""}${skipped ? ` · ${skipped} skipped` : ""}${r.data_mb ? ` · ${(r.data_mb / 1000).toFixed(1)} GB used` : ""}`;
    const tile = (label, value, sub) =>
      `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || "&nbsp;"}</div></div>`;
    const lo = r.longest_outage;
    $("report-tiles").innerHTML = [
      tile("Avg download", r.avg_down == null ? "—" : `${mbps(r.avg_down)}<small>Mbit/s</small>`, r.avg_down == null ? "" : `${r.avg_down_pct.toFixed(0)}% of plan · ${mbps(r.min_down)}–${mbps(r.max_down)}`),
      tile("Avg upload", r.avg_up == null ? "—" : `${mbps(r.avg_up)}<small>Mbit/s</small>`, r.avg_up == null ? "" : `${r.avg_up_pct.toFixed(0)}% of plan`),
      tile("Avg ping", r.avg_ping == null ? "—" : `${ms(r.avg_ping)}<small>ms</small>`, "to Singapore"),
      tile("Below half of plan", r.below_50_pct == null ? "—" : pct(r.below_50_pct), r.below_80_pct == null ? "" : `${pct(r.below_80_pct)} below 80%`),
      tile("Outages", String(r.outages), (r.downtime_s ? `${dur(r.downtime_s)} down in total` : "no downtime") +
        (r.planned_restarts ? ` · ${r.planned_restarts} scheduled restart${r.planned_restarts === 1 ? "" : "s"} excluded` : "")),
      tile("Longest outage", lo ? dur(lo.duration_s) : "—", lo ? when(lo.start) : ""),
      tile("Slowest hour", r.slowest_hour ? esc(r.slowest_hour.label) : "—", r.slowest_hour ? `avg ${mbps(r.slowest_hour.avg_down)} Mbit/s` : "needs more data"),
      tile("Fastest hour", r.fastest_hour ? esc(r.fastest_hour.label) : "—", r.fastest_hour ? `avg ${mbps(r.fastest_hour.avg_down)} Mbit/s` : ""),
    ].join("");
  }

  // ------------------------------------------------------------------- charts
  const bandsPlugin = {
    id: "bands",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      ctx.save();
      for (const e of data.events) {
        const x0 = Math.max(a.left, x.getPixelForValue(e.start * 1000));
        const x1 = Math.min(a.right, x.getPixelForValue((e.end ?? Date.now() / 1000) * 1000));
        if (x1 <= a.left || x0 >= a.right) continue;
        ctx.fillStyle = e.kind === "internet_down" ? css("--band-down") : e.kind === "planned_restart" ? css("--band-planned") : css("--band-offline");
        ctx.fillRect(x0, a.top, Math.max(2, x1 - x0), a.bottom - a.top);
      }
      ctx.restore();
    },
  };
  const crosshairPlugin = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const act = chart.tooltip && chart.tooltip.getActiveElements();
      if (!act || !act.length) return;
      const { ctx, chartArea: a } = chart;
      ctx.save();
      ctx.strokeStyle = css("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(act[0].element.x, a.top);
      ctx.lineTo(act[0].element.x, a.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
  const planPlugin = {
    id: "plan",
    beforeDatasetsDraw(chart) {
      const plan = data.status && data.status.plan_down;
      const { ctx, chartArea: a, scales: { y } } = chart;
      if (!plan || plan > y.max) return;
      const py = y.getPixelForValue(plan);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = css("--text-muted");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.left, py);
      ctx.lineTo(a.right, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--text-muted");
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(`Plan ${plan}`, a.right - 4, py - 4);
      ctx.restore();
    },
  };

  function xAxis() {
    const span = range.hi - range.lo;
    return {
      type: "linear", min: range.lo * 1000, max: range.hi * 1000,
      grid: { color: css("--grid"), drawTicks: false },
      border: { color: css("--axis") },
      ticks: {
        color: css("--text-muted"), maxRotation: 0, autoSkipPadding: 28, padding: 6,
        callback: (v) => (span <= 36 * 3600 ? (span <= 6 * 3600 ? tFmt.format(v) : hFmt.format(v)) : dShort.format(v)),
      },
    };
  }
  function baseOptions() {
    return {
      responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 500 }, normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: xAxis(),
        y: { beginAtZero: true, grid: { color: css("--grid"), drawTicks: false }, border: { display: false },
          ticks: { color: css("--text-muted"), padding: 6, maxTicksLimit: 5 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"),
          footerColor: css("--text-muted"), borderColor: css("--border"), borderWidth: 1, padding: 10, cornerRadius: 10,
          usePointStyle: true, boxPadding: 4,
          callbacks: { title: (items) => fullFmt.format(items[0].parsed.x) },
        },
      },
    };
  }
  function withBreaks(points) {
    const breaks = data.events.map((e) => ({ x: ((e.start + (e.end ?? Date.now() / 1000)) / 2) * 1000, y: null }));
    return [...points, ...breaks].sort((a, b) => a.x - b.x);
  }
  function legend(el, items) {
    el.innerHTML = items.map(([label, color, kind]) =>
      `<span><i class="${kind || ""}" style="${kind === "dash" ? "" : `background:${color}`}"></i>${label}</span>`).join("");
  }
  function mount(key, canvas, cfg) {
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart(canvas, cfg);
  }

  function renderCharts() {
    renderSpeedChart();
    renderQualityCharts();
    renderHeatmap();
    if (data.status) drawSpark();
  }

  function renderSpeedChart() {
    const ok = data.tests.filter((t) => t.status === "ok");
    $("speed-empty").hidden = ok.length > 0;
    const radius = ok.length > 200 ? 0 : 3;
    const byX = new Map(ok.map((t) => [t.ts * 1000, t]));
    const plan = data.status.plan_down;
    const ds = (label, key, color) => ({
      label, data: withBreaks(ok.map((t) => ({ x: t.ts * 1000, y: t[key] }))),
      borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: radius, pointHoverRadius: 5,
      pointBorderColor: css("--surface-1"), pointBorderWidth: radius ? 1.5 : 0, tension: 0.25, spanGaps: false,
    });
    const opts = baseOptions();
    opts.scales.y.suggestedMax = plan * 1.1;
    opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${mbps(item.parsed.y)} Mbit/s`;
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const t = byX.get(items[0].parsed.x);
      return t ? [`${((100 * t.download_mbps) / plan).toFixed(0)}% of plan · ping ${ms(t.ping_ms)} ms`, `${t.server_name || ""} · ${TRIGGER[t.trigger] || t.trigger}`] : [];
    };
    mount("speed", $("speed-chart"), {
      type: "line",
      data: { datasets: [ds("Download", "download_mbps", css("--series-1")), ds("Upload", "upload_mbps", css("--series-2"))] },
      options: opts, plugins: [bandsPlugin, planPlugin, crosshairPlugin],
    });
    legend($("speed-legend"), [["Download", css("--series-1")], ["Upload", css("--series-2")], ["Plan", "", "dash"],
      ["Internet down", css("--band-down"), "band"], ["Scheduled restart", css("--band-planned"), "band"], ["Not monitored", css("--band-offline"), "band"]]);
  }

  function renderQualityCharts() {
    const lat = data.checks.map((c) => ({ x: c.ts * 1000, y: c.up ? c.latency_ms : null }));
    const jit = data.checks.map((c) => ({ x: c.ts * 1000, y: c.up ? c.jitter_ms : null }));
    const opts = baseOptions();
    opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${ms(item.parsed.y)} ms`;
    const line = (label, pts, color) => ({ label, data: pts, borderColor: color, backgroundColor: color, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, tension: 0.2, spanGaps: false });
    mount("latency", $("latency-chart"), {
      type: "line",
      data: { datasets: [line("Latency", lat, css("--series-lat")), line("Jitter", jit, css("--series-jit"))] },
      options: opts, plugins: [bandsPlugin, crosshairPlugin],
    });
    const loss = data.checks.map((c) => ({ x: c.ts * 1000, y: c.up ? c.loss_pct || 0 : null }));
    const lopts = baseOptions();
    lopts.scales.y.suggestedMax = 10;
    lopts.scales.y.ticks.maxTicksLimit = 2;
    lopts.scales.y.ticks.callback = (v) => `${v}%`;
    lopts.scales.x.ticks.display = false;
    lopts.plugins.tooltip.callbacks.label = (item) => ` Packet loss: ${item.parsed.y.toFixed(0)}%`;
    mount("loss", $("loss-chart"), {
      type: "bar",
      data: { datasets: [{ label: "Packet loss", data: loss, backgroundColor: css("--critical"), borderRadius: 2, barPercentage: 1, categoryPercentage: 1, minBarLength: 0 }] },
      options: lopts, plugins: [bandsPlugin],
    });
    legend($("quality-legend"), [["Latency", css("--series-lat")], ["Jitter", css("--series-jit")], ["Packet loss", css("--critical"), "band"]]);
  }

  // Drag-to-zoom on the speed chart; double-click returns to the last preset.
  (() => {
    const wrap = $("speed-wrap"), box = $("zoom-box");
    let startX = null;
    const localX = (ev) => ev.clientX - wrap.getBoundingClientRect().left;
    wrap.addEventListener("mousedown", (ev) => {
      const a = charts.speed && charts.speed.chartArea;
      const x = localX(ev);
      if (!a || x < a.left || x > a.right) return;
      startX = x;
      box.style.left = `${x}px`;
      box.style.width = "0px";
      box.hidden = false;
    });
    addEventListener("mousemove", (ev) => {
      if (startX === null) return;
      const a = charts.speed.chartArea;
      const x = Math.max(a.left, Math.min(a.right, localX(ev)));
      box.style.left = `${Math.min(x, startX)}px`;
      box.style.width = `${Math.abs(x - startX)}px`;
    });
    addEventListener("mouseup", (ev) => {
      if (startX === null) return;
      const a = charts.speed.chartArea, sx = charts.speed.scales.x;
      const x = Math.max(a.left, Math.min(a.right, localX(ev)));
      box.hidden = true;
      if (Math.abs(x - startX) > 8) {
        const lo = sx.getValueForPixel(Math.min(x, startX)) / 1000, hi = sx.getValueForPixel(Math.max(x, startX)) / 1000;
        if (range.preset !== "custom") lastPreset = range.preset;
        Object.assign(range, { preset: "custom", lo, hi });
        selectChip("custom", false);
        loadAll();
      }
      startX = null;
    });
    wrap.addEventListener("dblclick", () => {
      if (range.preset !== "custom") return;
      range.preset = lastPreset;
      selectChip(lastPreset);
      loadAll();
    });
  })();

  // ------------------------------------------------------------------ heatmap
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const HEAT_STEPS = [25, 50, 70, 85, 95];
  function heatClass(p) {
    let i = 0;
    while (i < HEAT_STEPS.length && p >= HEAT_STEPS[i]) i++;
    return i;
  }
  function renderHeatmap() {
    const h = data.heat;
    if (!h) return;
    const cells = new Map(h.cells.map((c) => [`${c.wday}-${c.hour}`, c]));
    let html = "<span></span>";
    for (let hr = 0; hr < 24; hr++) html += `<span class="cl">${hr % 6 === 0 ? hFmt.format(new Date(2000, 0, 1, hr)).replace(/\s/g, "") : ""}</span>`;
    DAYS.forEach((d, w) => {
      html += `<span class="rl">${d}</span>`;
      for (let hr = 0; hr < 24; hr++) {
        const c = cells.get(`${w}-${hr}`);
        html += c
          ? `<span class="cell" data-k="${w}-${hr}" style="background:var(--heat-${heatClass(c.pct)})"></span>`
          : `<span class="cell" data-k="${w}-${hr}"></span>`;
      }
    });
    const el = $("heatmap");
    el.innerHTML = html;
    el.onmousemove = (ev) => {
      const k = ev.target.dataset && ev.target.dataset.k;
      if (!k) return hideTip();
      const [w, hr] = k.split("-").map(Number);
      const c = cells.get(k);
      const label = `${DAYS[w]} ${hFmt.format(new Date(2000, 0, 1, hr))}`;
      showTip(ev, c ? `<b>${label}</b><span>avg ${mbps(c.avg_down)} Mbit/s · ${c.pct.toFixed(0)}% of plan</span><span>${c.n} test${c.n === 1 ? "" : "s"}</span>` : `<b>${label}</b><span>No tests yet</span>`);
    };
    el.onmouseleave = hideTip;
    const labels = ["<25%", "25–50%", "50–70%", "70–85%", "85–95%", "≥95%"];
    $("heat-legend").innerHTML = `<span>Slower</span>${labels.map((l, i) => `<i title="${l} of plan" style="background:var(--heat-${i})"></i>`).join("")}<span>Faster (of plan)</span>`;
  }

  // ------------------------------------------------------------------- tables
  function pbar(v, plan) {
    const p = (100 * v) / plan;
    const cls = p < 50 ? "low" : p < 80 ? "mid" : "";
    return `<span class="pbar"><i><b class="${cls}" style="width:${Math.min(100, p).toFixed(0)}%"></b></i>${p.toFixed(0)}%</span>`;
  }
  function recoveryText(e) {
    if (e.kind !== "internet_down") return '<span class="muted">—</span>';
    if (e.ongoing) return '<span class="muted">still down</span>';
    if (e.rec_status === "ok") return `${mbps(e.rec_download)} ↓ / ${mbps(e.rec_upload)} ↑ Mbit/s · ${ms(e.rec_ping)} ms`;
    if (e.rec_status === "failed") return '<span class="muted">test failed</span>';
    return '<span class="muted">too short to test</span>';
  }
  function renderOutages() {
    const rows = data.events;
    $("outage-rows").innerHTML = rows.length ? rows.map((e) => `<tr>
      <td>${when(e.start)}</td><td>${e.ongoing ? "<strong>ongoing</strong>" : when(e.end)}</td>
      <td class="num">${dur(e.duration_s)}</td>
      <td>${e.kind === "internet_down" ? '<span class="tag down">Internet down</span>' : e.kind === "planned_restart" ? '<span class="tag planned">Scheduled router restart</span>' : '<span class="tag">Not monitored (Pi off)</span>'}</td>
      <td>${recoveryText(e)}</td></tr>`).join("")
      : '<tr><td colspan="5" class="muted">No outages in this range.</td></tr>';
  }
  function renderTests() {
    const plan = data.status.plan_down;
    const rows = [...data.tests].reverse();
    const shown = showAllTests ? rows : rows.slice(0, 25);
    $("btn-more-tests").hidden = showAllTests || rows.length <= 25;
    $("btn-more-tests").textContent = `Show all ${rows.length}`;
    $("test-rows").innerHTML = shown.length ? shown.map((t) => {
      if (t.status !== "ok") {
        const [cls, label] = SKIP[t.status] || ["", t.status];
        const why = t.status === "skipped_busy" && t.error ? `${label}: ${t.error}` : label + (t.busy_mbps ? ` (${mbps(t.busy_mbps)} Mbit/s in use)` : "");
        return `<tr><td>${when(t.ts)}</td><td colspan="7"><span class="tag ${cls}">${esc(why)}</span>${t.error && t.status !== "skipped_busy" ? ` <span class="muted" title="${esc(t.error)}">${esc(t.error.slice(0, 70))}</span>` : ""}</td><td>${TRIGGER[t.trigger] || esc(t.trigger)}</td><td></td></tr>`;
      }
      return `<tr><td>${when(t.ts)}</td>
        <td class="num"><strong>${mbps(t.download_mbps)}</strong></td><td>${pbar(t.download_mbps, plan)}</td>
        <td class="num">${mbps(t.upload_mbps)}</td><td class="num">${ms(t.ping_ms)} ms</td><td class="num">${ms(t.jitter_ms)} ms</td>
        <td class="num">${t.packet_loss == null ? "—" : `${t.packet_loss.toFixed(1)}%`}</td>
        <td>${esc(t.server_name)}</td><td>${TRIGGER[t.trigger] || esc(t.trigger)}</td>
        <td>${t.result_url ? `<a class="link" href="${esc(t.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ""}</td></tr>`;
    }).join("") : '<tr><td colspan="10" class="muted">No speedtests in this range.</td></tr>';
  }
  function renderIps() {
    $("ip-rows").innerHTML = data.ips.length
      ? data.ips.map((r, i) => `<tr><td>${when(r.ts)}${i === 0 ? ' <span class="tag ok">current</span>' : ""}</td><td>${esc(r.ip)}</td><td>${esc(r.isp)}</td></tr>`).join("")
      : '<tr><td colspan="3" class="muted">Recorded after the next speedtest.</td></tr>';
  }

  // ------------------------------------------------------------------- lookup
  async function lookup(ts) {
    const r = await api(`api/at?ts=${ts}`);
    const lines = [`<div><strong>${fullFmt.format(ts * 1000)}</strong></div>`];
    if (r.event && r.event.kind === "internet_down") {
      lines.push(`<div><span class="tag down">Internet was down</span> from ${when(r.event.start)} to ${r.event.ongoing ? "now" : when(r.event.end)} (${dur(r.event.duration_s)})</div>`);
    } else if (r.event && r.event.kind === "planned_restart") {
      lines.push(`<div><span class="tag planned">Scheduled router restart</span> from ${when(r.event.start)} to ${when(r.event.end)} (${dur(r.event.duration_s)}) — not counted as downtime</div>`);
    } else if (r.event) {
      lines.push(`<div><span class="tag">Not monitored</span> — the monitor was off from ${when(r.event.start)} to ${when(r.event.end)}</div>`);
    } else if (r.check) {
      lines.push(r.check.up
        ? `<div><span class="tag ok">Online</span> · latency ${ms(r.check.latency_ms)} ms${r.check.jitter_ms != null ? ` · jitter ${ms(r.check.jitter_ms)} ms` : ""}${r.check.loss_pct ? ` · ${r.check.loss_pct.toFixed(0)}% loss` : ""}</div>`
        : '<div><span class="tag down">No response</span></div>');
    } else {
      lines.push('<div class="muted">No connectivity data at that time.</div>');
    }
    const t = (x, label) => x
      ? `<div>${label}: <strong>${mbps(x.download_mbps)} ↓ / ${mbps(x.upload_mbps)} ↑ Mbit/s</strong>, ${ms(x.ping_ms)} ms — ${when(x.ts)} (${dur(Math.abs(x.ts - ts))} ${x.ts <= ts ? "before" : "after"})</div>`
      : `<div class="muted">${label}: none</div>`;
    lines.push(t(r.before, "Speedtest before"), t(r.after, "Speedtest after"));
    $("lookup-result").innerHTML = lines.join("");
  }

  // ------------------------------------------------------------------- wiring
  function selectChip(value, hideCustom = true) {
    for (const c of document.querySelectorAll(".chip")) c.setAttribute("aria-checked", String(c.dataset.range === String(value)));
    $("custom-range").hidden = hideCustom ? value !== "custom" : true;
  }
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
    const v = c.dataset.range;
    selectChip(v);
    if (v === "custom") {
      $("custom-from").value = toLocalInput(range.lo);
      $("custom-to").value = toLocalInput(range.hi);
      return;
    }
    range.preset = Number(v);
    lastPreset = range.preset;
    showAllTests = false;
    loadAll();
  }));
  $("btn-apply-range").addEventListener("click", () => {
    const lo = fromLocalInput($("custom-from").value), hi = fromLocalInput($("custom-to").value);
    if (!(lo < hi)) return;
    Object.assign(range, { preset: "custom", lo, hi });
    loadAll();
  });
  $("btn-run").addEventListener("click", async () => {
    $("btn-run").disabled = true;
    await fetch("api/speedtest/run", { method: "POST" });
    wasRunning = true;
    loadStatus();
  });
  const menu = $("pause-menu"), menuList = menu.querySelector(".menu-list");
  $("btn-pause").addEventListener("click", (ev) => {
    ev.stopPropagation();
    menuList.hidden = !menuList.hidden;
    $("btn-pause").setAttribute("aria-expanded", String(!menuList.hidden));
  });
  addEventListener("click", () => { menuList.hidden = true; });
  menuList.querySelectorAll("[data-min]").forEach((b) => b.addEventListener("click", async () => {
    await api("api/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: Number(b.dataset.min) }) });
    loadStatus();
  }));
  // ------------------------------------------------------------------- alerts
  // WhatsApp markup (*bold*, _italic_) on already-escaped text.
  const waFormat = (t) => esc(t)
    .replace(/(^|[\s(])\*([^*\n]+)\*/gm, "$1<strong>$2</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_/gm, "$1<em>$2</em>");

  async function loadAlerts() {
    const a = await api("api/alerts");
    const off = (t) => `<span class="off">${esc(t)}</span>`;
    $("alexa-facts").innerHTML = [
      ["Echo devices", a.alexa_entities.length ? esc(a.alexa_entities.join(", ")) : off("not set (alexa_entities)")],
      ["Volume", `${a.alexa_volume}% while speaking, then restored`],
      ["When it drops", `“${esc(a.down_message)}”`],
      ["When it's back", `“${esc(a.up_message)}”`],
      ["Quiet hours", a.alexa_quiet_hours.length ? esc(a.alexa_quiet_hours.join(", ")) : off("none")],
      ["Offline fallback", a.offline_tts_service ? esc(a.offline_tts_service) : off("not set (offline_tts_service)")],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    document.querySelectorAll("[data-device='alexa']").forEach((b) => { b.disabled = !a.alexa_entities.length; });
    $("btn-phone-test").disabled = !a.offline_tts_service;
    $("btn-wa-test").disabled = !a.whatsapp_configured;
    $("wa-note").textContent = (a.whatsapp_configured ? "Sent when the internet comes back. " : "Set whatsapp_to and whatsapp_api_token to enable. ")
      + (a.preview_is_real ? "Preview of your latest outage:" : "Sample preview (no outages recorded yet):");
    $("wa-preview").innerHTML = waFormat(a.preview);
  }

  document.querySelectorAll("[data-announce]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      const r = await api("api/test/announce", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: b.dataset.announce, device: b.dataset.device }) });
      $("announce-result").textContent = `Sent: “${r.text}”`;
    } catch (e) {
      $("announce-result").textContent = "Couldn't send the test announcement.";
    }
    setTimeout(() => { b.disabled = false; }, 4000);
  }));
  $("btn-wa-test").addEventListener("click", async () => {
    $("btn-wa-test").disabled = true;
    $("wa-result").textContent = "Sending…";
    try {
      await api("api/test/whatsapp", { method: "POST" });
      $("wa-result").textContent = "Test report sent to WhatsApp.";
    } catch (e) {
      $("wa-result").textContent = "Not sent. Check the add-on log (is the WhatsApp bridge connected?).";
    }
    $("btn-wa-test").disabled = false;
  });

  let selMonth = null;
  async function showMonth(key) {
    selMonth = key;
    document.querySelectorAll("#month-rows tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.month === key));
    const tr = document.querySelector(`#month-rows tr[data-month="${key}"]`);
    $("btn-month-send").textContent = `Send ${tr ? tr.dataset.label : key} report`;
    const r = await api(`api/monthly_report?month=${key}`);
    $("month-preview").innerHTML = waFormat(r.text);
  }
  async function loadMonths() {
    const months = await api("api/months");
    const pct = (v, d = 0) => (v == null ? "—" : `${v.toFixed(d)}%`);
    $("month-rows").innerHTML = months.map((m) => {
      const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
      const partial = m.monitored_days < m.days - 1 ? ` <span class="muted small">(${Math.round(m.monitored_days)} of ${Math.round(m.days)} days)</span>` : "";
      return `<tr data-month="${key}" data-label="${esc(m.label)}"><td>${esc(m.label)}${partial}</td><td><strong>${m.grade || "—"}</strong></td>
        <td class="num">${pct(m.avg_down_pct)}</td><td class="num">${pct(m.uptime_pct, 2)}</td>
        <td class="num">${m.outages}</td><td class="num">${m.downtime_s ? dur(m.downtime_s) : "—"}</td></tr>`;
    }).join("") || `<tr><td colspan="6" class="muted">No data yet</td></tr>`;
    document.querySelectorAll("#month-rows tr[data-month]").forEach((tr) => tr.addEventListener("click", () => showMonth(tr.dataset.month)));
    const a = await api("api/alerts");
    $("btn-month-send").disabled = !a.whatsapp_configured || !months.length;
    if (months.length) await showMonth(selMonth || `${months[0].year}-${String(months[0].month).padStart(2, "0")}`);
  }
  $("btn-month-send").addEventListener("click", async () => {
    $("btn-month-send").disabled = true;
    $("month-result").textContent = "Sending…";
    try {
      await api("api/test/monthly", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month: selMonth }) });
      $("month-result").textContent = `${selMonth} report sent to WhatsApp.`;
    } catch (e) {
      $("month-result").textContent = "Not sent. Check the add-on log (is the WhatsApp bridge connected?).";
    }
    $("btn-month-send").disabled = false;
  });

  $("btn-more-tests").addEventListener("click", () => { showAllTests = true; renderTests(); });
  $("lookup-form").addEventListener("submit", (e) => { e.preventDefault(); lookup(fromLocalInput($("lookup-at").value)); });
  osDark.addEventListener("change", () => applyTheme());
  addEventListener("focus", () => applyTheme());
  setInterval(() => applyTheme(), 5000);
  let resizeT;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => data.loaded && (drawSpark(), renderStrip()), 200); });

  root.classList.add("skeleton");
  $("conn-state").classList.add("loading");
  applyTheme(true);
  $("lookup-at").value = toLocalInput(Date.now() / 1000 - 86400);
  selectChip(86400);
  loadAll().then(() => scheduleStatus(10000)).catch((e) => { console.error(e); scheduleStatus(10000); });
  setInterval(tickSince, 1000);
  setInterval(() => { if (range.preset !== "custom") loadAll().catch(() => {}); }, 300000);
})();
