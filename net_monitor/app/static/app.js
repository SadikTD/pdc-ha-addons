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
  const TRIGGER = { scheduled: "Scheduled", manual: "You ran it", after_outage: "After an outage" };
  const SKIP = { failed: ["down", "Failed"], skipped_busy: ["warn", "Skipped, line in use"], skipped_paused: ["", "Skipped, tests paused"] };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const listText = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

  // ------------------------------------------------------------------ quality
  // Plain-language grading of response time (latency), steadiness (jitter) and
  // lost data (packet loss) to Singapore, where ~50 ms is normal from Bangladesh.
  const QUALITY_SINCE = 1791738254;  // 11 Oct 2026 11:04 PM (+06), when v1.4.1 went live
  const LEVEL = ["Smooth", "Sluggish", "Poor"];
  const LEVEL_CLS = ["good", "warn", "bad"];
  const RATE_WORD = ["Good", "Fair", "Poor"];
  const step3 = (v, a, b) => (v == null ? 0 : v < a ? 0 : v < b ? 1 : 2);
  const rateLat = (v) => step3(v, 100, 200);
  const rateJit = (v) => step3(v, 20, 50);
  const rateLoss = (v) => step3(v, 2, 10);
  function rate(lat, jit, loss) {
    const why = [];
    if (rateLat(lat)) why.push(`slow (${ms(lat)} ms)`);
    if (rateJit(jit)) why.push(`jumpy (±${ms(jit)} ms)`);
    if (rateLoss(loss)) why.push(`losing data (${loss.toFixed(0)}%)`);
    return { level: Math.max(rateLat(lat), rateJit(jit), rateLoss(loss)), why };
  }
  // What each activity needs: [good if all under, okay if all under] for latency, jitter, loss.
  const USES = [
    { name: "Browsing", need: [[300, 100, 5], [600, 200, 15]] },
    { name: "Video streaming", need: [[400, 150, 5], [800, 300, 15]], minMbps: [25, 8] },
    { name: "Video calls", need: [[150, 30, 3], [300, 60, 10]] },
    { name: "Online games", need: [[80, 15, 1], [150, 30, 3]] },
  ];
  const USE_WORD = ["Works well", "May stutter", "Likely to struggle", "Not working"];
  function useLevel(u, r, mbpsNow) {
    const fits = ([l, j, p]) => (r.latency_ms ?? 0) < l && (r.jitter_ms ?? 0) < j && (r.loss_pct ?? 0) < p;
    let lvl = fits(u.need[0]) ? 0 : fits(u.need[1]) ? 1 : 2;
    if (u.minMbps && mbpsNow != null) lvl = Math.max(lvl, mbpsNow >= u.minMbps[0] ? 0 : mbpsNow >= u.minMbps[1] ? 1 : 2);
    return lvl;
  }
  const DOWN_WHY = (reason) => !reason ? "None of the test servers abroad are answering."
    : /DNS/.test(reason) ? "Websites can't be found: your router's DNS isn't answering, even though the line may be up."
    : /only [01] of/.test(reason) ? "The test servers abroad aren't answering, so the international link is cut."
    : "Too few test servers abroad are answering to call the line usable.";

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
    renderQuality();
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
    renderVerdict();
    drawSpark();

    const lt = s.last_test;
    countUp($("sp-down"), lt ? lt.download_mbps : null, mbps);
    countUp($("sp-up"), lt ? lt.upload_mbps : null, mbps);
    const dp = lt ? (100 * lt.download_mbps) / s.plan_down : null, up = lt ? (100 * lt.upload_mbps) / s.plan_up : null;
    $("sp-down-bar").style.width = `${Math.min(100, dp || 0)}%`;
    $("sp-up-bar").style.width = `${Math.min(100, up || 0)}%`;
    $("sp-down-pct").textContent = lt ? `${dp.toFixed(0)}% of ${s.plan_down} Mbps plan` : "No test yet";
    $("sp-up-pct").textContent = lt ? `${up.toFixed(0)}% of ${s.plan_up} Mbps plan` : "";
    const note = $("speed-note");
    if (!lt) {
      note.className = "speed-note";
      note.textContent = "No speedtest yet. Run one to see how your line compares with your plan.";
    } else {
      const lv = dp >= 90 ? 0 : dp >= 60 ? 1 : 2;
      note.className = `speed-note lv-${LEVEL_CLS[lv]}`;
      note.innerHTML = ["<strong>Full speed.</strong> You're getting what you pay for.",
        `<strong>A bit under your plan.</strong> Download reached ${dp.toFixed(0)}% of it.`,
        `<strong>Well below your plan.</strong> Download reached only ${dp.toFixed(0)}% of it.`][lv]
        + (up < 50 ? ` Upload was unusually low in this test (${mbps(lt.upload_mbps)} Mbit/s), which usually means the line was busy or congested.` : "");
    }

    const paused = s.paused_until === -1 || s.paused_until > s.now;
    let next;
    if (paused) next = s.paused_until === -1 ? "Paused until you resume" : `Paused until ${when(s.paused_until)}`;
    else if (s.next_test_ts) next = `${time(s.next_test_ts)}, ${relative(s.next_test_ts)}`;
    else next = "—";
    const foot = [];
    if (lt) {
      foot.push(["Last test", `${when(lt.ts)}, ${ms(lt.ping_ms)} ms ping`]);
      const place = [...new Set(String(lt.server_location || "").split(", ").filter(Boolean))].join(", ");
      foot.push(["Server", [lt.server_name, place].filter(Boolean).join(", ")]);
    }
    foot.push(["Next test", next]);
    if (s.scheduler_note && !paused) foot.push(["Note", s.scheduler_note]);
    $("speed-foot").innerHTML = foot.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    $("pause-label").textContent = paused ? "Tests paused" : "Pause tests";
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
    else if (s.online === false && s.outage_start) text = `Down since ${when(s.outage_start)}, ${dur(now - s.outage_start, true)} so far`;
    if (s.last_check_ts) text += `${text ? ". " : ""}Checked ${relative(s.last_check_ts)}.`;
    $("conn-since").textContent = text || " ";
  }

  function renderVerdict() {
    const s = data.status, r = s.recent || {};
    let title = "", text = "", lvl = 0, uses = null;
    if (s.online === false && s.planned_outage) {
      title = "Scheduled router restart";
      text = "Your router restarts at this time every day. It isn't counted as an outage.";
      uses = USES.map((u) => [u.name, 3]);
    } else if (s.online === false) {
      title = "Nothing gets through";
      text = DOWN_WHY(s.down_reason);
      lvl = 2;
      uses = USES.map((u) => [u.name, 3]);
    } else if (s.online === true && r.latency_ms != null) {
      const q = rate(r.latency_ms, r.jitter_ms, r.loss_pct);
      lvl = q.level;
      if (r.fails) lvl = Math.max(lvl, 1);
      title = ["Smooth", "A bit sluggish", "Struggling"][lvl];
      text = lvl === 0
        ? `Replies come back in ${ms(r.latency_ms)} ms, steadily and with nothing lost. Fine for everything, games included.`
        : `${cap(listText([...q.why, ...(r.fails ? [`${r.fails} short drop${r.fails === 1 ? "" : "s"}`] : [])]))} in the last 10 minutes. `
          + (lvl === 1 ? "Games and video calls may lag." : "Expect lag, buffering and dropped calls.");
      const dl = s.last_test ? s.last_test.download_mbps : null;
      uses = USES.map((u) => [u.name, Math.max(useLevel(u, r, dl), r.fails && u.name !== "Browsing" ? 1 : 0)]);
    }
    $("verdict").className = `verdict lv-${LEVEL_CLS[lvl]}`;
    $("verdict").hidden = !title;
    $("verdict-title").textContent = title;
    $("verdict-text").textContent = text;
    $("uses").innerHTML = (uses || []).map(([name, l]) =>
      `<li class="use u-${l === 3 ? "off" : LEVEL_CLS[l]}"><span class="use-name">${name}</span><span class="use-word">${USE_WORD[l]}</span></li>`).join("");
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
    const last = pts[pts.length - 1];
    $("spark-now").textContent = last && s.online ? `${ms(last.latency_ms)} ms now` : "";
    if (pts.length < 2) return;
    const t0 = s.sparkline[0].ts, t1 = s.sparkline[s.sparkline.length - 1].ts || t0 + 1;
    // Scale to the typical values so one spike doesn't flatten the rest; spikes are clipped at the top.
    const vals = pts.map((p) => p.latency_ms).sort((a, b) => a - b);
    const lo = 0, hi = Math.max(100, vals[Math.floor(vals.length * 0.9)] * 1.4);
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * (w - 4) + 2, Y = (v) => Math.max(2, h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 8));
    // The "feels instant" line at 100 ms.
    ctx.strokeStyle = css("--grid");
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, Y(100)); ctx.lineTo(w, Y(100)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css("--text-muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("100 ms", 2, Y(100) - 3);
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
    $("range-label").textContent = range.preset === "custom"
      ? `Showing ${fullFmt.format(range.lo * 1000)} to ${fullFmt.format(range.hi * 1000)}`
      : `Showing since ${fullFmt.format(range.lo * 1000)}`;
  }

  // ------------------------------------------------------------- uptime strip
  function renderStrip() {
    const tl = data.timeline;
    const r = data.report;
    $("uptime-headline").textContent = r.uptime_pct == null ? "—" : pct(r.uptime_pct, r.uptime_pct >= 99.95 || r.uptime_pct < 10 ? 1 : 2);
    $("uptime-sub").textContent = r.uptime_pct == null ? "Not enough data yet."
      : r.outages ? `${r.outages} outage${r.outages === 1 ? "" : "s"}, ${dur(r.downtime_s)} down in total.${r.planned_restarts ? ` ${r.planned_restarts} scheduled router restart${r.planned_restarts === 1 ? "" : "s"} not counted.` : ""}`
      : "No outages in this range.";
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
      ? `${r.avg_down_pct.toFixed(0)}% of plan speed, ${pct(r.uptime_pct, 1)} uptime`
      : "Needs speedtests and uptime data";
    $("grade-how").textContent = "Graded on speed (60%) and uptime (40%).";
    const c = r.test_counts || {};
    const skipped = (c.skipped_busy || 0) + (c.skipped_paused || 0);
    $("report-sub").textContent = `Based on ${r.tests} speedtest${r.tests === 1 ? "" : "s"}${c.failed ? `, ${c.failed} failed` : ""}${skipped ? `, ${skipped} skipped` : ""}${r.data_mb ? `. Tests used ${(r.data_mb / 1000).toFixed(1)} GB.` : ""}`;
    const tile = (label, value, sub) =>
      `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || "&nbsp;"}</div></div>`;
    const lo = r.longest_outage;
    $("report-tiles").innerHTML = [
      tile("Avg download", r.avg_down == null ? "—" : `${mbps(r.avg_down)}<small>Mbit/s</small>`, r.avg_down == null ? "" : `${r.avg_down_pct.toFixed(0)}% of plan, ranging ${mbps(r.min_down)} to ${mbps(r.max_down)}`),
      tile("Avg upload", r.avg_up == null ? "—" : `${mbps(r.avg_up)}<small>Mbit/s</small>`, r.avg_up == null ? "" : `${r.avg_up_pct.toFixed(0)}% of plan`),
      tile("Avg ping", r.avg_ping == null ? "—" : `${ms(r.avg_ping)}<small>ms</small>`, "to Singapore"),
      tile("Tests at full speed", r.below_80_pct == null ? "—" : pct(100 - r.below_80_pct), r.below_50_pct == null ? "" : `got at least 80% of your plan.${r.below_50_pct ? ` ${pct(r.below_50_pct)} got under half.` : ""}`),
      tile("Outages", String(r.outages), (r.downtime_s ? `${dur(r.downtime_s)} down in total.` : "No downtime.") +
        (r.planned_restarts ? ` ${r.planned_restarts} router restart${r.planned_restarts === 1 ? "" : "s"} not counted.` : "")),
      tile("Longest outage", lo ? dur(lo.duration_s) : "None", lo ? when(lo.start) : ""),
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

  // ----------------------------------------------------------------- valorant
  async function loadValorant() {
    data.valo = await api("api/valorant");
    renderValorant();
  }

  function renderValorant() {
    const v = data.valo;
    if (!v) return;
    const l = v.latest, w = (l && l.window) || {};
    $("valo-region").textContent = v.region_name;
    $("valo-headline").textContent = w.ping_ms != null ? `${ms(w.ping_ms)} ms` : "—";
    let lvl = 1, title = "Measuring…", text = "The first reading takes about a minute.";
    if (l && l.playable) {
      lvl = 0;
      title = "Good to play";
      text = `The match route answers in ${ms(w.ping_ms)} ms with ${pct(w.loss_pct, 1)} packet loss over the last 3 minutes.`;
    } else if (l) {
      lvl = 2;
      title = "Hold off on ranked";
      text = `${cap(listText(l.why))} over the last 3 minutes.`;
      if (l.best_other_ms != null && w.ping_ms != null && l.best_other_ms < w.ping_ms - 20)
        text += ` Other routes to ${v.region_name} are at ${ms(l.best_other_ms)} ms, so it's the route to Riot's match server that's slow, not your whole connection.`;
    }
    $("valo-verdict").className = `verdict lv-${LEVEL_CLS[lvl]}`;
    $("valo-title").textContent = title;
    $("valo-text").textContent = text;
    $("valo-tiles").innerHTML = [
      ["Ping (network RTT)", ms(w.ping_ms), "ms", "Round trip, as the game shows it"],
      ["Network delay", w.ping_ms == null ? "—" : ms(w.ping_ms / 2), "ms", "One way, about half the ping"],
      ["Jitter", w.jitter_ms == null ? "—" : `±${ms(w.jitter_ms)}`, "ms", "How much the ping jumps"],
      ["Packet loss", w.loss_pct == null ? "—" : w.loss_pct.toFixed(1), "%", "Pings that never came back"],
    ].map(([label, val, unit, sub]) =>
      `<div class="tile"><div class="label">${label}</div><div class="value">${val}<small>${unit}</small></div><div class="sub">${sub}</div></div>`).join("");
    $("valo-rows").innerHTML = (l ? l.edges : []).map((e) => `<tr>
      <td>${e.match ? "<strong>Match route</strong>" : "Other route"} <span class="muted">${esc(e.edge)}</span></td>
      <td class="num${e.ping_ms == null || e.ping_ms > v.max_ping_ms ? " is-bad" : ""}">${e.ping_ms == null ? "No reply" : `${ms(e.ping_ms)} ms`}</td>
      <td class="num">${e.jitter_ms == null ? "—" : `±${ms(e.jitter_ms)} ms`}</td>
      <td class="num${e.loss_pct >= 3 ? " is-bad" : ""}">${pct(e.loss_pct)}</td></tr>`).join("");
    renderValorantChart();
  }

  function renderValorantChart() {
    const v = data.valo;
    if (!v) return;
    const now = Date.now(), lo = now - 86400e3;
    const pts = (key) => v.history.map((r) => ({ x: r.ts * 1000, y: r[key] }));
    const ds = (label, key, color) => ({ label, data: pts(key), borderColor: color, backgroundColor: color, borderWidth: 2,
      pointRadius: 0, pointHoverRadius: 4, cubicInterpolationMode: "monotone", spanGaps: false });
    const opts = baseOptions();
    Object.assign(opts.scales.x, { min: lo, max: now });
    opts.scales.x.ticks.callback = (x) => hFmt.format(x);
    opts.scales.y.suggestedMax = v.max_ping_ms * 1.5;
    opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${ms(item.parsed.y)} ms`;
    const limit = { label: "Your limit", data: [{ x: lo, y: v.max_ping_ms }, { x: now, y: v.max_ping_ms }], borderColor: css("--critical"),
      borderWidth: 1, borderDash: [4, 4], pointRadius: 0, pointHoverRadius: 0 };
    mount("valo", $("valo-chart"), { type: "line", options: opts, data: { datasets: [
      ds("Match route", "match_ms", css("--series-1")), ds("Best other route", "best_ms", css("--series-lat")), limit] } });
    legend($("valo-legend"), [["Match route", css("--series-1")], ["Best other route", css("--series-lat")], [`Limit ${v.max_ping_ms} ms`, "", "dash"]]);
  }

  function renderCharts() {
    renderValorantChart();
    renderSpeedChart();
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
      pointBorderColor: css("--surface-1"), pointBorderWidth: radius ? 1.5 : 0, cubicInterpolationMode: "monotone", spanGaps: false,
    });
    const opts = baseOptions();
    opts.scales.y.suggestedMax = plan * 1.1;
    opts.scales.y.title = { display: true, text: "Mbit/s", color: css("--text-muted"), font: { size: 11 } };
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

  // Connection quality: a strip of how the line felt, three plain stats, and the rough patches.
  let qBuckets = [];
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  function renderQuality() {
    const rows = data.checks;
    // Before v1.4.1 quality was measured against a Dhaka server, which says nothing about abroad.
    const up = rows.filter((c) => c.up && c.latency_ms != null && c.ts >= QUALITY_SINCE);
    const levelOf = (c) => rate(c.latency_ms, c.jitter_ms, c.loss_pct || 0);
    up.forEach((c) => { c.q = levelOf(c); });

    // Strip: same buckets as the uptime strip.
    const n = data.timeline.length || 60;
    const step = (range.hi - range.lo) / n;
    qBuckets = Array.from({ length: n }, (_, i) => ({ from: range.lo + i * step, to: range.lo + (i + 1) * step, rows: [] }));
    rows.forEach((c) => { const b = qBuckets[Math.floor((c.ts - range.lo) / step)]; if (b) b.rows.push(c); });
    qBuckets.forEach((b) => {
      const u = b.rows.filter((c) => c.q);
      b.downs = b.rows.length - b.rows.filter((c) => c.up).length;
      b.lat = avg(u.map((c) => c.latency_ms));
      b.jit = avg(u.map((c) => c.jitter_ms).filter((v) => v != null));
      b.loss = avg(u.map((c) => c.loss_pct || 0));
      b.cls = !b.rows.length ? "" : b.downs > b.rows.length / 2 ? "down" : !u.length ? "" : LEVEL_CLS[rate(b.lat, b.jit, b.loss).level];
    });
    $("qstrip").innerHTML = qBuckets.map((b, i) => `<span class="${b.cls}" data-i="${i}"></span>`).join("");
    $("qstrip-start").textContent = $("strip-start").textContent;
    $("qstrip-end").textContent = $("strip-end").textContent;

    const smooth = up.length ? (100 * up.filter((c) => c.q.level === 0).length) / up.length : null;
    $("quality-headline").textContent = smooth == null ? "—" : `Smooth ${smooth >= 99.5 && smooth < 100 ? "99.5" : smooth.toFixed(0)}% of the time`;

    // Three plain stats for the range.
    const lat = median(up.map((c) => c.latency_ms)), jit = median(up.map((c) => c.jitter_ms).filter((v) => v != null));
    const loss = avg(up.map((c) => c.loss_pct || 0));
    const worst = up.reduce((w, c) => (!w || c.latency_ms > w.latency_ms ? c : w), null);
    const stat = (name, value, r, about, extra) => `<div class="qstat">
        <div class="qstat-top"><span class="qstat-name">${name}</span><span class="pill ${LEVEL_CLS[r]}">${RATE_WORD[r]}</span></div>
        <div class="qstat-value">${value}</div>
        <p class="qstat-about">${about}${extra ? ` ${extra}` : ""}</p></div>`;
    $("qstats").innerHTML = !up.length ? '<p class="muted">No quality readings in this range. Tracking started on 11 Oct, 11:04 PM.</p>' : [
      stat("Response time", `${ms(lat)}<small>ms typical</small>`, rateLat(lat),
        "How long data takes to reach Singapore and come back. Under 100 ms feels instant.",
        worst && worst.latency_ms > 2 * lat ? `Slowest: ${ms(worst.latency_ms)} ms at ${when(worst.ts)}.` : ""),
      stat("Steadiness", jit == null ? "—" : `±${ms(jit)}<small>ms</small>`, rateJit(jit),
        "How much the response time jumps around. Big jumps cause lag spikes in games and calls."),
      stat("Lost data", `${loss < 0.1 ? "0" : loss.toFixed(1)}<small>%</small>`, rateLoss(loss),
        "Share of test connections that got no answer. Above 2% you'll notice stutters."),
    ].join("");

    // Rough patches: runs of sluggish/poor checks, worst first.
    const gapOk = Math.max(90, 3 * (rows.length > 1 ? (rows[rows.length - 1].ts - rows[0].ts) / rows.length : 30));
    const patches = [];
    let cur = null;
    for (const c of up) {
      if (c.q.level && cur && c.ts - cur.end <= gapOk) { cur.end = c.ts; cur.items.push(c); continue; }
      if (cur) { patches.push(cur); cur = null; }
      if (c.q.level) cur = { start: c.ts, end: c.ts, items: [c] };
    }
    if (cur) patches.push(cur);
    patches.forEach((p) => {
      p.level = Math.max(...p.items.map((c) => c.q.level));
      p.lat = avg(p.items.map((c) => c.latency_ms));
      p.jit = avg(p.items.map((c) => c.jitter_ms).filter((v) => v != null));
      p.loss = avg(p.items.map((c) => c.loss_pct || 0));
      p.secs = Math.max(30, p.end - p.start);
      p.score = p.secs * (p.level === 2 ? 3 : 1);
    });
    const top = patches.filter((p) => p.secs >= 60).sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => b.start - a.start);
    $("rough").innerHTML = !up.length ? "" : top.length
      ? `<h3>Rough patches</h3><ul>${top.map((p) => `<li>
          <span class="pill ${LEVEL_CLS[p.level]}">${LEVEL[p.level]}</span>
          <span class="rough-when">${when(p.start)}${sameDay(p.start, p.end) ? `–${time(p.end)}` : ` to ${when(p.end)}`}</span>
          <span class="rough-why">${cap(listText(rate(p.lat, p.jit, p.loss).why) || "unsteady")} for about ${dur(p.secs)}</span></li>`).join("")}</ul>`
      : '<p class="rough-none">No rough patches in this range. The line was steady whenever it was up.</p>';
    if (range.lo < QUALITY_SINCE) $("rough").insertAdjacentHTML("beforeend", '<p class="muted small">Quality tracking started on 11 Oct, 11:04 PM, so earlier times show as no data.</p>');
  }
  $("qstrip").addEventListener("mousemove", (ev) => {
    const i = ev.target.dataset && ev.target.dataset.i;
    if (i === undefined) return hideTip();
    const b = qBuckets[Number(i)];
    const head = b.to - b.from >= 86400 * 0.99 ? dFmt.format(b.from * 1000) : `${when(b.from)} – ${time(b.to)}`;
    let body;
    if (!b.cls) body = b.to <= QUALITY_SINCE ? "<span>Not measured yet. Quality tracking started on 11 Oct, 11:04 PM.</span>" : "<span>No data</span>";
    else if (b.cls === "down") body = "<span>Internet down for most of this time</span>";
    else {
      const q = rate(b.lat, b.jit, b.loss);
      body = `<span>${LEVEL[q.level]}${q.why.length ? `: ${esc(listText(q.why))}` : ""}</span>`
        + `<span>Response ${ms(b.lat)} ms, steadiness ±${ms(b.jit)} ms, ${(b.loss || 0).toFixed(1)}% lost</span>`;
    }
    showTip(ev, `<b>${esc(head)}</b>${body}`);
  });
  $("qstrip").addEventListener("mouseleave", hideTip);

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
    const labels = ["under 25%", "25–50%", "50–70%", "70–85%", "85–95%", "95% or more"];
    $("heat-legend").innerHTML = `<span>Under 25% of plan</span>${labels.map((l, i) => `<i title="${l} of plan" style="background:var(--heat-${i})"></i>`).join("")}<span>95% or more</span>`;
    const byHour = {};
    h.cells.forEach((c) => { (byHour[c.hour] = byHour[c.hour] || []).push(c.avg_down); });
    const hrs = Object.entries(byHour).map(([hr, v]) => ({ hr: Number(hr), avg: v.reduce((a, b) => a + b, 0) / v.length }));
    if (hrs.length > 3) {
      const best = hrs.reduce((a, b) => (b.avg > a.avg ? b : a)), worst = hrs.reduce((a, b) => (b.avg < a.avg ? b : a));
      const hl = (x) => hFmt.format(new Date(2000, 0, 1, x));
      $("heat-summary").innerHTML = best.avg - worst.avg < 0.1 * h.plan_down
        ? `Speed hardly changes through the day: between <strong>${mbps(worst.avg)}</strong> and <strong>${mbps(best.avg)}</strong> Mbit/s.`
        : `Fastest around <strong>${hl(best.hr)}</strong> (${mbps(best.avg)} Mbit/s), slowest around <strong>${hl(worst.hr)}</strong> (${mbps(worst.avg)} Mbit/s).`;
    } else $("heat-summary").textContent = "Needs a few days of speedtests.";
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
    return `<span class="muted">${e.duration_s < 120 ? "too short to test" : "not tested"}</span>`;
  }
  function renderOutages() {
    const rows = data.events;
    $("outage-rows").innerHTML = rows.length ? rows.map((e) => `<tr>
      <td>${when(e.start)}</td><td>${e.ongoing ? "<strong>ongoing</strong>" : when(e.end)}</td>
      <td class="num">${dur(e.duration_s)}</td>
      <td>${e.kind === "internet_down" ? '<span class="tag down">Internet down</span>' : e.kind === "planned_restart" ? '<span class="tag planned">Scheduled router restart</span>' : '<span class="tag">Monitor was off</span>'}</td>
      <td>${recoveryText(e)}</td></tr>`).join("")
      : '<tr><td colspan="5" class="muted">No outages in this range.</td></tr>';
  }
  // " is-warn" / " is-bad" when a value crosses a threshold (low=true: smaller is worse).
  const flag = (v, warn, bad, low) => v == null ? "" : low ? (v < bad ? " is-bad" : v < warn ? " is-warn" : "") : (v >= bad ? " is-bad" : v >= warn ? " is-warn" : "");
  function failText(err) {
    if (!err) return "";
    if (/Latency test failed/i.test(err)) return "No test server could be reached. The international link was probably down.";
    if (/timed out/i.test(err)) return "The test took too long and was stopped.";
    if (/No such file|not found|cannot find/i.test(err)) return "The speedtest program isn't available.";
    return err.length > 80 ? `${err.slice(0, 80)}…` : err;
  }
  function renderTests() {
    const plan = data.status.plan_down;
    const rows = [...data.tests].reverse();
    const shown = showAllTests ? rows : rows.slice(0, 10);
    $("btn-more-tests").hidden = showAllTests || rows.length <= 10;
    $("btn-more-tests").textContent = `Show all ${rows.length}`;
    $("test-rows").innerHTML = shown.length ? shown.map((t) => {
      if (t.status !== "ok") {
        const [cls, label] = SKIP[t.status] || ["", t.status];
        const why = t.status === "skipped_busy" && t.error ? `${label}: ${t.error}` : label;
        return `<tr><td>${when(t.ts)}</td><td colspan="7"><span class="tag ${cls}" title="${esc(t.error || "")}">${esc(why)}</span>${t.status === "failed" ? ` <span class="muted">${esc(failText(t.error))}</span>` : ""}</td><td>${TRIGGER[t.trigger] || esc(t.trigger)}</td><td></td></tr>`;
      }
      return `<tr><td>${when(t.ts)}</td>
        <td class="num"><strong>${mbps(t.download_mbps)}</strong></td><td>${pbar(t.download_mbps, plan)}</td>
        <td class="num${flag(t.upload_mbps / data.status.plan_up, 0.5, 0.2, true)}">${mbps(t.upload_mbps)}</td>
        <td class="num${flag(t.ping_ms, 100, 200)}">${ms(t.ping_ms)} ms</td><td class="num${flag(t.jitter_ms, 20, 50)}">${ms(t.jitter_ms)} ms</td>
        <td class="num${flag(t.packet_loss, 2, 10)}">${t.packet_loss == null ? "—" : `${t.packet_loss.toFixed(1)}%`}</td>
        <td>${esc(t.server_name)}</td><td>${TRIGGER[t.trigger] || esc(t.trigger)}</td>
        <td>${t.result_url ? `<a class="link" href="${esc(t.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ""}</td></tr>`;
    }).join("") : '<tr><td colspan="10" class="muted">No speedtests in this range.</td></tr>';
  }
  let showAllIps = false;
  function renderIps() {
    const ips = data.ips, unique = new Set(ips.map((r) => r.ip)).size;
    $("ip-sub").textContent = ips.length > 1 ? `${unique} different address${unique === 1 ? "" : "es"} across the last ${ips.length} changes` : "";
    $("btn-more-ips").hidden = showAllIps || ips.length <= 6;
    $("btn-more-ips").textContent = `Show all ${ips.length}`;
    $("ip-rows").innerHTML = ips.length
      ? (showAllIps ? ips : ips.slice(0, 6)).map((r, i) => `<tr><td>${when(r.ts)}${i === 0 ? ' <span class="tag ok">current</span>' : ""}</td><td>${esc(r.ip)}</td><td>${esc(r.isp)}</td></tr>`).join("")
      : '<tr><td colspan="3" class="muted">Recorded after the next speedtest.</td></tr>';
  }

  // ------------------------------------------------------------------- lookup
  async function lookup(ts) {
    $("lookup-result").innerHTML = '<p class="muted small">Looking…</p>';
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
    const off = (t, sec) => `<span class="off">${esc(t)}</span>${sec ? ` <button type="button" class="linkbtn" data-open-settings="${sec}">Set up</button>` : ""}`;
    const names = a.alexa_entities.map((e) => (a.alexa_names && a.alexa_names[e]) || e);
    $("alexa-facts").innerHTML = [
      ["Speaks on", names.length ? esc(listText(names)) : off("No Echo picked", "alexa")],
      ["Volume", `${a.alexa_volume}% while speaking, then put back`],
      ["When it drops", `“${esc(a.down_message)}”`],
      ["When it's back", `“${esc(a.up_message)}”`],
      ["Quiet hours", a.alexa_quiet_hours.length ? esc(listText(a.alexa_quiet_hours.map((w) => w.replace("-", " to ")))) : off("None")],
      ["If Alexa can't speak", a.offline_tts_service ? `Your phone says it (${esc(a.offline_tts_service.replace(/^notify\.(mobile_app_)?/, ""))})` : off("Nothing is said", "alexa")],
    ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    document.querySelectorAll("[data-device='alexa']").forEach((b) => { b.disabled = !a.alexa_entities.length; });
    $("btn-phone-test").disabled = !a.offline_tts_service;
    $("btn-wa-test").disabled = !a.whatsapp_configured;
    $("wa-note").innerHTML = (a.whatsapp_configured ? "Sent when the internet comes back. "
      : 'Off. Add your number and the bridge token to turn it on. <button type="button" class="linkbtn" data-open-settings="whatsapp">Set up</button> ')
      + (a.preview_is_real ? "This is the report for your latest outage." : "Sample report, as no outages are recorded yet.");
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

  // ----------------------------------------------------------------- settings
  const hourLabel = (h) => hFmt.format(new Date(2000, 0, 1, h));
  const HOURS = Array.from({ length: 24 }, (_, h) => [h, hourLabel(h)]);
  const WEEKDAY_OPTS = [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]];
  const SETTINGS_UI = [
    { id: "plan", title: "Your internet plan", note: "What you pay for. Grades, reports and slow-speed alerts compare against this.", fields: [
      { key: "plan_download_mbps", label: "Download speed", type: "number", unit: "Mbps", step: "any" },
      { key: "plan_upload_mbps", label: "Upload speed", type: "number", unit: "Mbps", step: "any" },
      { key: "plan_price", label: "Monthly bill", type: "number", step: "any", unitKey: "plan_currency",
        help: "Adds a value-for-money line to the monthly report. 0 leaves it out." },
      { key: "plan_currency", label: "Currency symbol", type: "text", short: true },
    ] },
    { id: "alexa", title: "Alexa announcements", note: "Alexa speaks through Amazon's servers, so it can only warn you when Amazon is still reachable.", fields: [
      { key: "alexa_entities", label: "Echo devices", type: "players", help: "None ticked = no announcements." },
      { key: "alexa_volume", label: "Announcement volume", type: "range", help: "Set just for the announcement, then put back." },
      { key: "alexa_down_message", label: "When the internet drops", type: "text" },
      { key: "alexa_up_message", label: "When it's back", type: "text", help: "{duration} is replaced with e.g. “27 minutes”." },
      { key: "alexa_quiet_hours", label: "Quiet hours", type: "windows", help: "No announcements during these times." },
      { key: "offline_tts_service", label: "Phone fallback", type: "notify",
        help: "Phone that speaks the warning when Alexa can't. Leave empty to never use the phone." },
    ] },
    { id: "whatsapp", title: "WhatsApp", note: "Sent through the PDC WhatsApp Bridge add-on.", fields: [
      { key: "whatsapp_to", label: "Your number", type: "text", placeholder: "+8801XXXXXXXXX", help: "Must be the bridge's recipient number." },
      { key: "whatsapp_api_token", label: "Bridge API token", type: "password", help: "The bridge's api_token." },
      { key: "monthly_report_enabled", label: "Monthly ISP report", type: "bool", help: "Last month's report card, on the 1st." },
      { key: "monthly_report_hour", label: "Send it at", type: "hour" },
      { key: "whatsapp_bridge_url", label: "Bridge address", type: "text", placeholder: "Found automatically",
        help: "Only if the bridge isn't found, e.g. http://172.30.33.6:8787" },
    ] },
    { id: "alerts", title: "Phone notifications", note: "Home Assistant app notifications.", fields: [
      { key: "notify_service", label: "Notify service", type: "notify", help: "Empty = no phone notifications." },
      { key: "notify_min_outage_minutes", label: "Ignore outages shorter than", type: "number", unit: "min",
        help: "Also applies to the WhatsApp outage report." },
      { key: "slow_alert_percent", label: "Slow-speed alert below", type: "number", unit: "% of plan", help: "0 turns slow-speed alerts off." },
      { key: "slow_alert_consecutive_tests", label: "…for this many tests in a row", type: "number" },
      { key: "weekly_report_enabled", label: "Weekly report", type: "bool" },
      { key: "weekly_report_day", label: "Weekly report day", type: "select", options: WEEKDAY_OPTS },
      { key: "weekly_report_hour", label: "Weekly report time", type: "hour" },
    ] },
    { id: "valorant", title: "Valorant", note: "Checked every minute through the route your matches use.", fields: [
      { key: "valorant_region", label: "Server", type: "select", options: [["mumbai", "Mumbai"], ["singapore", "Singapore"],
        ["hongkong", "Hong Kong"], ["manila", "Manila"], ["tokyo", "Tokyo"], ["sydney", "Sydney"]] },
      { key: "valorant_max_ping_ms", label: "Don't queue above", type: "number", unit: "ms ping" },
      { key: "valorant_alerts", label: "Phone alerts", type: "bool", help: "When it turns good or bad to play. Uses the notify service under Phone notifications." },
    ] },
    { id: "speedtest", title: "Speedtests", fields: [
      { key: "speedtest_interval_minutes", label: "Run every", type: "number", unit: "min", help: "Aligned to midnight: 60 = on the hour. Restarts the add-on." },
      { key: "server_ids", label: "Ookla server IDs", type: "ints", help: "Tried in order, comma-separated." },
      { key: "recovery_speedtest_min_outage_minutes", label: "Test after outages of at least", type: "number", unit: "min" },
      { key: "busy_threshold_mbps", label: "Line is busy above (download)", type: "number", unit: "Mbps", step: "any", help: "0 = ignore." },
      { key: "busy_upload_mbps", label: "…or upload above", type: "number", unit: "Mbps", step: "any", help: "Catches gaming and calls. 0 = ignore." },
      { key: "busy_packets_per_second", label: "…or outgoing packets above", type: "number", unit: "per second", help: "0 = ignore." },
      { key: "busy_retry_minutes", label: "Retry a busy line after", type: "number", unit: "min" },
      { key: "maintenance_windows", label: "Scheduled router restarts", type: "windows",
        help: "Outages in these windows aren't counted, announced or reported." },
    ] },
    { id: "monitoring", title: "Monitoring", note: "Advanced.", fields: [
      { key: "check_interval_seconds", label: "Check every", type: "number", unit: "seconds", help: "Restarts the add-on." },
      { key: "check_targets", label: "Check targets", type: "lines", help: "One host:port per line, all abroad. Online when at least 2 answer; in-country answers (under 10 ms) are ignored." },
      { key: "dns_check_server", label: "DNS check server", type: "text", help: "auto = the router. Online also needs it to resolve names. Empty = off." },
      { key: "quality_samples", label: "Handshakes per check", type: "number", help: "For jitter and packet loss." },
      { key: "retention_days", label: "Keep history for", type: "number", unit: "days" },
    ] },
  ];
  const FIELDS = SETTINGS_UI.flatMap((s) => s.fields);
  let settingsData = null, settingsOriginal = {};

  function fieldControl(f, v) {
    const id = `set-${f.key}`, val = esc(v ?? "");
    const opts = (list, cur) => list.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");
    switch (f.type) {
      case "number": {
        const unit = f.unitKey ? esc(settingsData.values[f.unitKey]) : esc(f.unit || "");
        return `<div class="with-unit"><input type="number" id="${id}" value="${val}" step="${f.step || 1}">${unit ? `<span class="unit">${unit}</span>` : ""}</div>`;
      }
      case "text": return `<input type="text" id="${id}" value="${val}" placeholder="${esc(f.placeholder || "")}"${f.short ? ' style="max-width:120px"' : ""}>`;
      case "password": return `<input type="password" id="${id}" value="" autocomplete="off" placeholder="${settingsData.secrets_set[f.key] ? "Saved. Type a new one to replace it" : "Not set"}">`;
      case "bool": return `<label class="switch"><input type="checkbox" id="${id}"${v ? " checked" : ""}><span></span></label>`;
      case "select": return `<select id="${id}">${opts(f.options, v)}</select>`;
      case "hour": return `<select id="${id}">${opts(HOURS, v)}</select>`;
      case "range": return `<div class="range"><input type="range" id="${id}" min="0" max="100" step="5" value="${val}"><output for="${id}">${val}%</output></div>`;
      case "players": return `<div class="checks" id="${id}">${settingsData.media_players.map((p) =>
        `<label><input type="checkbox" value="${esc(p.id)}"${(v || []).includes(p.id) ? " checked" : ""}> ${esc(p.name)} <span class="muted small">${esc(p.id)}</span></label>`).join("") || '<span class="muted">No media players found</span>'}</div>`;
      case "notify": return `<input type="text" id="${id}" value="${val}" list="notify-list" placeholder="notify.mobile_app_…">`;
      case "ints": return `<input type="text" id="${id}" value="${esc((v || []).join(", "))}">`;
      case "lines": return `<textarea id="${id}" spellcheck="false">${esc((v || []).join("\n"))}</textarea>`;
      case "windows": return `<div class="windows" id="${id}">${(v || []).map(winRow).join("")}<button type="button" class="btn ghost add">+ Add a time window</button></div>`;
    }
    return "";
  }
  function winRow(spec) {
    const [a, b] = String(spec || "00:00-07:00").split("-").map((t) => t.trim().padStart(5, "0"));
    return `<div class="win"><input type="time" value="${esc(a)}"> to <input type="time" value="${esc(b)}"><button type="button" class="btn ghost" aria-label="Remove">Remove</button></div>`;
  }
  function fieldValue(f) {
    const el = $(`set-${f.key}`);
    switch (f.type) {
      case "number": return el.value === "" ? "" : Number(el.value);
      case "bool": return el.checked;
      case "hour": case "range": return Number(el.value);
      case "players": return [...el.querySelectorAll("input:checked")].map((c) => c.value);
      case "ints": return el.value.split(/[\s,]+/).filter(Boolean).map(Number);
      case "lines": return el.value.split("\n").map((s) => s.trim()).filter(Boolean);
      case "windows": return [...el.querySelectorAll(".win")].map((w) => {
        const [a, b] = w.querySelectorAll("input");
        return a.value && b.value ? `${a.value}-${b.value}` : "";
      }).filter(Boolean);
      default: return el.value.trim();
    }
  }
  function settingsChanges() {
    const out = {};
    FIELDS.forEach((f) => {
      const v = fieldValue(f);
      if (f.type === "password" ? v !== "" : JSON.stringify(v) !== JSON.stringify(settingsOriginal[f.key])) out[f.key] = v;
    });
    return out;
  }
  function settingsDirty() {
    const n = Object.keys(settingsChanges()).length;
    $("settings-save").disabled = !n;
    const st = $("settings-status");
    if (!st.classList.contains("bad")) { st.className = "small"; st.textContent = n ? `${n} unsaved change${n > 1 ? "s" : ""}` : ""; }
  }
  function settingsStatus(text, cls) {
    const st = $("settings-status");
    st.className = `small ${cls || ""}`;
    st.textContent = text;
  }

  async function openSettings(section) {
    const dlg = $("settings");
    settingsStatus("");
    $("settings-body").innerHTML = '<p class="muted">Loading…</p>';
    dlg.showModal();
    try {
      settingsData = await api("api/settings");
    } catch (e) {
      $("settings-body").innerHTML = '<p class="muted">Couldn\'t load the settings.</p>';
      return;
    }
    settingsOriginal = JSON.parse(JSON.stringify(settingsData.values));
    $("settings-nav").innerHTML = SETTINGS_UI.map((s) => `<a href="#sec-${s.id}">${esc(s.title)}</a>`).join("");
    $("settings-body").innerHTML = `<datalist id="notify-list">${settingsData.notify_services.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>`
      + SETTINGS_UI.map((s) => `<fieldset id="sec-${s.id}"><legend>${esc(s.title)}</legend>${s.note ? `<p class="small muted section-note">${esc(s.note)}</p>` : ""}
        ${s.fields.map((f) => `<div class="field" data-key="${f.key}">
          ${["players", "windows", "bool"].includes(f.type) ? `<span class="label">${esc(f.label)}</span>` : `<label for="set-${f.key}">${esc(f.label)}</label>`}
          <div>${fieldControl(f, settingsData.values[f.key])}</div>
          ${f.help ? `<p class="help">${esc(f.help)}</p>` : ""}<p class="err" hidden></p></div>`).join("")}</fieldset>`).join("");
    settingsDirty();
    if (section) document.getElementById(`sec-${section}`).scrollIntoView({ block: "start" });
  }
  function closeSettings() {
    if (Object.keys(settingsChanges()).length && !confirm("Discard unsaved changes?")) return;
    $("settings").close();
  }

  $("btn-settings").addEventListener("click", () => openSettings());
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-settings]");
    if (b) openSettings(b.dataset.openSettings);
  });
  $("settings-close").addEventListener("click", closeSettings);
  $("settings-cancel").addEventListener("click", closeSettings);
  $("settings").addEventListener("cancel", (e) => { e.preventDefault(); closeSettings(); });
  $("settings-nav").addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    document.querySelector(a.getAttribute("href")).scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });
  $("settings-body").addEventListener("input", (e) => {
    if (e.target.type === "range") e.target.nextElementSibling.textContent = `${e.target.value}%`;
    if (e.target.id === "set-plan_currency") document.querySelector('[data-key="plan_price"] .unit').textContent = e.target.value;
    const field = e.target.closest(".field");
    if (field) { field.classList.remove("invalid"); field.querySelector(".err").hidden = true; }
    $("settings-status").classList.remove("bad");
    settingsDirty();
  });
  $("settings-body").addEventListener("change", settingsDirty);
  $("settings-body").addEventListener("click", (e) => {
    const b = e.target.closest(".windows button");
    if (!b) return;
    if (b.classList.contains("add")) b.insertAdjacentHTML("beforebegin", winRow());
    else b.closest(".win").remove();
    settingsDirty();
  });
  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const changes = settingsChanges();
    if (!Object.keys(changes).length) return;
    $("settings-save").disabled = true;
    settingsStatus("Saving…");
    const r = await fetch("api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changes) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      Object.entries(body.errors || {}).forEach(([k, msg]) => {
        const field = document.querySelector(`.field[data-key="${k}"]`);
        if (!field) return;
        field.classList.add("invalid");
        const err = field.querySelector(".err");
        err.textContent = `This ${msg}.`.replace("This “", "“");
        err.hidden = false;
      });
      const first = document.querySelector(".field.invalid");
      if (first) first.scrollIntoView({ block: "center" });
      settingsStatus(body.error || "Some settings need fixing.", "bad");
      $("settings-save").disabled = false;
      return;
    }
    if (body.restart) {
      settingsStatus("Saved. Restarting the add-on…", "good");
      await new Promise((res) => setTimeout(res, 6000));
      for (let i = 0; i < 40; i++) {
        try { await api("api/status"); break; } catch (err) { await new Promise((res) => setTimeout(res, 1500)); }
      }
      location.reload();
      return;
    }
    Object.assign(settingsOriginal, changes);
    if ("whatsapp_api_token" in changes) {
      settingsData.secrets_set.whatsapp_api_token = true;
      $("set-whatsapp_api_token").value = "";
      $("set-whatsapp_api_token").placeholder = "Saved. Type a new one to replace it";
    }
    settingsDirty();
    settingsStatus("Saved. Changes are live.", "good");
    loadAll().catch(() => {});
  });

  let selMonth = null;
  async function showMonth(key) {
    selMonth = key;
    document.querySelectorAll("#month-rows tr").forEach((tr) => tr.classList.toggle("sel", tr.dataset.month === key));
    const tr = document.querySelector(`#month-rows tr[data-month="${key}"]`);
    $("btn-month-send").textContent = `Send the ${tr ? tr.dataset.label : key} report`;
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
  document.querySelectorAll(".unfold").forEach((b) => b.addEventListener("click", () => {
    const chat = b.previousElementSibling;
    b.textContent = chat.classList.toggle("folded") ? "Show the whole message" : "Fold it up";
  }));
  $("btn-more-ips").addEventListener("click", () => { showAllIps = true; renderIps(); });
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
  loadValorant().catch((e) => console.error(e));
  setInterval(() => loadValorant().catch(() => {}), 60000);
  setInterval(tickSince, 1000);
  setInterval(() => { if (range.preset !== "custom") loadAll().catch(() => {}); }, 300000);
})();
