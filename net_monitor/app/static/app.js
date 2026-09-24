/* Net Monitor dashboard. All times are shown in the viewer's local time zone. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const api = async (path, opts) => {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  };
  const css = (name) => getComputedStyle(document.querySelector(".viz-root")).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- formatting
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
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
  const dur = (s) => {
    s = Math.round(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return m < 10 && sec ? `${m}m ${sec}s` : `${m}m`;
    return `${sec}s`;
  };
  const mbps = (v) => (v == null ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const ms = (v) => (v == null ? "—" : v.toFixed(v < 10 ? 1 : 0));
  const relative = (ts) => {
    const diff = ts - Date.now() / 1000;
    const a = Math.abs(diff);
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
  const STATUS = {
    ok: ["ok", ""], failed: ["down", "Failed"],
    skipped_busy: ["warn", "Skipped — line busy"], skipped_paused: ["", "Skipped — paused"],
  };

  // --------------------------------------------------------------------- state
  let range = { preset: 86400, lo: 0, hi: 0 };
  let data = { status: null, tests: [], checks: [], events: [], summary: null };
  let showAllTests = false;
  let charts = {};
  let lastTestSeen = null;
  let wasRunning = false;

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
    renderStatus();
    const newest = s.last_test && s.last_test.id;
    if ((wasRunning && !s.test_running) || (lastTestSeen !== null && newest !== lastTestSeen)) {
      loadAll();
    }
    wasRunning = s.test_running;
    lastTestSeen = newest ?? null;
  }

  async function loadAll() {
    computeRange();
    const q = `from=${range.lo}&to=${range.hi}`;
    const [status, tests, checks, events, summary] = await Promise.all([
      api("api/status"), api(`api/speedtests?${q}`), api(`api/checks?${q}`), api(`api/events?${q}`), api(`api/summary?${q}`),
    ]);
    Object.assign(data, { status, tests, checks, events, summary });
    lastTestSeen = status.last_test ? status.last_test.id : null;
    renderStatus();
    renderSummary();
    renderSpeedChart();
    renderLatencyChart();
    renderOutages();
    renderTests();
    $("export-tests").href = `api/export/speedtests.csv?${q}`;
    $("export-outages").href = `api/export/outages.csv?${q}`;
  }

  // ------------------------------------------------------------------- status
  function renderStatus() {
    const s = data.status;
    const pill = $("status-pill");
    pill.className = "status-pill " + (s.online === true ? "up" : s.online === false ? "down" : "");
    $("status-label").textContent = s.online === true ? "Online" : s.online === false ? "Internet down" : "Checking…";
    const detail = [];
    if (s.online === false && s.outage_start) detail.push(`since ${when(s.outage_start)} (${dur(s.now - s.outage_start)})`);
    if (s.online && s.latency_ms != null) detail.push(`${ms(s.latency_ms)} ms latency`);
    if (s.last_check_ts) detail.push(`checked ${relative(s.last_check_ts)}`);
    $("status-detail").textContent = detail.join(" · ");

    const run = $("btn-run");
    run.disabled = s.test_running;
    run.textContent = s.test_running ? "Speedtest running…" : "Run speedtest now";

    const paused = s.paused_until === -1 || s.paused_until > s.now;
    $("pause-select").hidden = paused;
    $("btn-resume").hidden = !paused;

    const lt = s.last_test;
    let next;
    if (paused) next = s.paused_until === -1 ? "Paused until you resume" : `Paused until ${when(s.paused_until)}`;
    else if (s.test_running) next = "Running now…";
    else if (s.next_test_ts) next = `${when(s.next_test_ts)} (${relative(s.next_test_ts)})`;
    else next = "—";
    const tile = (label, value, sub, swatch) =>
      `<div class="tile"><div class="label">${swatch ? `<span class="swatch" style="background:${swatch}"></span>` : ""}${label}</div>` +
      `<div class="value">${value}</div><div class="sub">${sub}</div></div>`;
    $("now-cards").innerHTML = [
      tile("Last download", lt ? `${mbps(lt.download_mbps)} <small>Mbit/s</small>` : "—", lt ? when(lt.ts) : "No test yet", css("--series-1")),
      tile("Last upload", lt ? `${mbps(lt.upload_mbps)} <small>Mbit/s</small>` : "—", lt ? esc(lt.server_name || "") : "", css("--series-2")),
      tile("Last ping", lt ? `${ms(lt.ping_ms)} <small>ms</small>` : "—", lt ? `jitter ${ms(lt.jitter_ms)} ms` : ""),
      tile("Next speedtest", `<span style="font-size:16px">${next}</span>`, esc(s.scheduler_note ||
        (s.router_upnp === false ? "Busy-line check unavailable (router UPnP)" : "Waits if the line is busy"))),
    ].join("");

    $("foot").textContent =
      `Checks every ${s.options.check_interval_seconds}s to ${s.options.check_targets.join(", ")} · ` +
      `speedtest every ${s.options.speedtest_interval_minutes} min · servers ${s.options.server_ids.join(", ")}`;
  }

  // ------------------------------------------------------------------ summary
  function renderSummary() {
    const s = data.summary, sp = s.speed || {}, c = s.test_counts || {};
    const tile = (label, value, sub) =>
      `<div class="tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub || ""}</div></div>`;
    const skipped = (c.skipped_busy || 0) + (c.skipped_paused || 0);
    $("summary-tiles").innerHTML = [
      tile("Uptime", s.uptime_pct == null ? "—" : `${s.uptime_pct.toFixed(s.uptime_pct >= 99.95 || s.uptime_pct < 10 ? 1 : 2)}%`,
        s.monitor_offline_s > 60 ? `${dur(s.monitor_offline_s)} not monitored` : "of monitored time"),
      tile("Outages", String(s.outages), s.downtime_s ? `${dur(s.downtime_s)} down in total` : "no downtime"),
      tile("Avg download", sp.n ? `${mbps(sp.avg_down)} <small>Mbit/s</small>` : "—", sp.n ? `${mbps(sp.min_down)} – ${mbps(sp.max_down)}` : ""),
      tile("Avg upload", sp.n ? `${mbps(sp.avg_up)} <small>Mbit/s</small>` : "—", sp.n ? `${mbps(sp.min_up)} – ${mbps(sp.max_up)}` : ""),
      tile("Avg ping", sp.n ? `${ms(sp.avg_ping)} <small>ms</small>` : "—", "to Singapore server"),
      tile("Speedtests", String(sp.n || 0), [c.failed ? `${c.failed} failed` : "", skipped ? `${skipped} skipped` : "",
        sp.data_mb ? `${(sp.data_mb / 1000).toFixed(1)} GB used` : ""].filter(Boolean).join(" · ")),
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
        ctx.fillStyle = e.kind === "internet_down" ? css("--band-down") : css("--band-offline");
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

  function xAxis() {
    const span = range.hi - range.lo;
    return {
      type: "linear", min: range.lo * 1000, max: range.hi * 1000,
      grid: { color: css("--grid"), drawTicks: false },
      border: { color: css("--axis") },
      ticks: {
        color: css("--text-muted"), maxRotation: 0, autoSkipPadding: 24, padding: 6,
        callback: (v) => (span <= 2 * 86400 ? tFmt.format(v) : dShort.format(v)),
      },
    };
  }
  function yAxis(title) {
    return {
      beginAtZero: true,
      grid: { color: css("--grid"), drawTicks: false },
      border: { display: false },
      ticks: { color: css("--text-muted"), padding: 6, maxTicksLimit: 6 },
      title: { display: false, text: title },
    };
  }
  function baseOptions(yTitle) {
    return {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: { x: xAxis(), y: yAxis(yTitle) },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"),
          footerColor: css("--text-muted"), borderColor: css("--border"), borderWidth: 1, padding: 10,
          usePointStyle: true, boxPadding: 4,
          callbacks: { title: (items) => fullFmt.format(items[0].parsed.x) },
        },
      },
    };
  }

  function withBreaks(points) {
    // Insert nulls inside outages so lines don't bridge across them.
    const breaks = data.events.map((e) => ({ x: ((e.start + (e.end ?? Date.now() / 1000)) / 2) * 1000, y: null }));
    return [...points, ...breaks].sort((a, b) => a.x - b.x);
  }

  function legend(el, items) {
    el.innerHTML = items.map(([label, color, band]) =>
      `<span><i class="${band ? "band" : ""}" style="background:${color}"></i>${label}</span>`).join("");
  }

  function renderSpeedChart() {
    const ok = data.tests.filter((t) => t.status === "ok");
    $("speed-empty").hidden = ok.length > 0;
    const radius = ok.length > 200 ? 0 : 3;
    const byX = new Map(ok.map((t) => [t.ts * 1000, t]));
    const ds = (label, key, color) => ({
      label, data: withBreaks(ok.map((t) => ({ x: t.ts * 1000, y: t[key] }))),
      borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: radius, pointHoverRadius: 5,
      pointBorderColor: css("--surface-1"), pointBorderWidth: radius ? 1.5 : 0, tension: 0, spanGaps: false,
    });
    const opts = baseOptions("Mbit/s");
    opts.plugins.tooltip.callbacks.label = (item) => ` ${item.dataset.label}: ${mbps(item.parsed.y)} Mbit/s`;
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const t = byX.get(items[0].parsed.x);
      return t ? [`Ping ${ms(t.ping_ms)} ms · jitter ${ms(t.jitter_ms)} ms`, `${t.server_name || ""} · ${TRIGGER[t.trigger] || t.trigger}`] : [];
    };
    const cfg = {
      type: "line",
      data: { datasets: [ds("Download", "download_mbps", css("--series-1")), ds("Upload", "upload_mbps", css("--series-2"))] },
      options: opts, plugins: [bandsPlugin, crosshairPlugin],
    };
    if (charts.speed) charts.speed.destroy();
    charts.speed = new Chart($("speed-chart"), cfg);
    legend($("speed-legend"), [["Download", css("--series-1")], ["Upload", css("--series-2")],
      ["Internet down", css("--band-down"), true], ["Not monitored", css("--band-offline"), true]]);
  }

  function renderLatencyChart() {
    const pts = data.checks.map((c) => ({ x: c.ts * 1000, y: c.up ? c.latency_ms : null }));
    const opts = baseOptions("ms");
    opts.plugins.tooltip.callbacks.label = (item) => ` Latency: ${ms(item.parsed.y)} ms`;
    const cfg = {
      type: "line",
      data: { datasets: [{ label: "Latency", data: pts, borderColor: css("--series-lat"), backgroundColor: css("--series-lat"),
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: false }] },
      options: opts, plugins: [bandsPlugin, crosshairPlugin],
    };
    if (charts.latency) charts.latency.destroy();
    charts.latency = new Chart($("latency-chart"), cfg);
    legend($("latency-legend"), [["Latency (lowest of the check targets)", css("--series-lat")], ["Internet down", css("--band-down"), true]]);
  }

  // ------------------------------------------------------------------- tables
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
      <td>${when(e.start)}</td>
      <td>${e.ongoing ? "<strong>ongoing</strong>" : when(e.end)}</td>
      <td class="num">${dur(e.duration_s)}</td>
      <td>${e.kind === "internet_down" ? '<span class="tag down">Internet down</span>' : '<span class="tag">Monitor offline (Pi off / no data)</span>'}</td>
      <td>${recoveryText(e)}</td></tr>`).join("")
      : '<tr><td colspan="5" class="muted">No outages in this range 🎉</td></tr>';
  }

  function renderTests() {
    const rows = [...data.tests].reverse();
    const shown = showAllTests ? rows : rows.slice(0, 50);
    $("btn-more-tests").hidden = showAllTests || rows.length <= 50;
    $("btn-more-tests").textContent = `Show all ${rows.length}`;
    $("test-rows").innerHTML = shown.length ? shown.map((t) => {
      const [cls, label] = STATUS[t.status] || ["", t.status];
      if (t.status !== "ok") {
        const why = label + (t.busy_mbps ? ` (${mbps(t.busy_mbps)} Mbit/s in use)` : "");
        return `<tr><td>${when(t.ts)}</td><td colspan="6"><span class="tag ${cls}">${esc(why)}</span>
          ${t.error ? `<span class="muted" title="${esc(t.error)}"> ${esc(t.error.slice(0, 80))}</span>` : ""}</td>
          <td>${TRIGGER[t.trigger] || esc(t.trigger)}</td><td></td></tr>`;
      }
      return `<tr><td>${when(t.ts)}</td>
        <td class="num">${mbps(t.download_mbps)}</td><td class="num">${mbps(t.upload_mbps)}</td>
        <td class="num">${ms(t.ping_ms)} ms</td><td class="num">${ms(t.jitter_ms)} ms</td>
        <td class="num">${t.packet_loss == null ? "—" : t.packet_loss.toFixed(1) + "%"}</td>
        <td>${esc(t.server_name)}${t.server_location ? ` <span class="muted">${esc(t.server_location)}</span>` : ""}</td>
        <td>${TRIGGER[t.trigger] || esc(t.trigger)}</td>
        <td>${t.result_url ? `<a class="link" href="${esc(t.result_url)}" target="_blank" rel="noopener">result ↗</a>` : ""}</td></tr>`;
    }).join("") : '<tr><td colspan="9" class="muted">No speedtests in this range.</td></tr>';
  }

  // ------------------------------------------------------------------- lookup
  async function lookup(ts) {
    const r = await api(`api/at?ts=${ts}`);
    const lines = [`<div><strong>${fullFmt.format(ts * 1000)}</strong></div>`];
    if (r.event && r.event.kind === "internet_down") {
      lines.push(`<div><span class="tag down">Internet was down</span> from ${when(r.event.start)} to ${r.event.ongoing ? "now" : when(r.event.end)} (${dur(r.event.duration_s)})</div>`);
    } else if (r.event) {
      lines.push(`<div><span class="tag">Not monitored</span> — the monitor was off from ${when(r.event.start)} to ${when(r.event.end)}</div>`);
    } else if (r.check) {
      lines.push(`<div>${r.check.up ? `<span class="tag ok">Online</span> · latency ${ms(r.check.latency_ms)} ms` : '<span class="tag down">No response</span>'}</div>`);
    } else {
      lines.push('<div class="muted">No connectivity data at that time.</div>');
    }
    const t = (x, label) => x
      ? `<div>${label}: <strong>${mbps(x.download_mbps)} ↓ / ${mbps(x.upload_mbps)} ↑ Mbit/s</strong>, ${ms(x.ping_ms)} ms — at ${when(x.ts)} (${dur(Math.abs(x.ts - ts))} ${x.ts <= ts ? "before" : "after"})</div>`
      : `<div class="muted">${label}: none</div>`;
    lines.push(t(r.before, "Speedtest before"), t(r.after, "Speedtest after"));
    $("lookup-result").innerHTML = lines.join("");
  }

  // ------------------------------------------------------------------- wiring
  function selectChip(value) {
    for (const c of document.querySelectorAll(".chip")) c.setAttribute("aria-checked", String(c.dataset.range === String(value)));
    $("custom-range").hidden = value !== "custom";
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
    loadStatus();
  });
  $("pause-select").addEventListener("change", async (e) => {
    if (!e.target.value) return;
    await api("api/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: Number(e.target.value) }) });
    e.target.value = "";
    loadStatus();
  });
  $("btn-resume").addEventListener("click", async () => {
    await api("api/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: 0 }) });
    loadStatus();
  });
  $("btn-more-tests").addEventListener("click", () => { showAllTests = true; renderTests(); });
  $("lookup-form").addEventListener("submit", (e) => { e.preventDefault(); lookup(fromLocalInput($("lookup-at").value)); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderSpeedChart(); renderLatencyChart(); renderStatus(); });

  // Default the lookup box to "yesterday, this time".
  $("lookup-at").value = toLocalInput(Date.now() / 1000 - 86400);
  selectChip(86400);
  loadAll();
  setInterval(() => loadStatus().catch(() => {}), 15000);
  setInterval(() => { if (range.preset !== "custom") loadAll().catch(() => {}); }, 300000);
})();
