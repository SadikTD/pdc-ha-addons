/* Valorant history: when each server is good to play, so you can plan your games. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = async (path) => {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  };
  const root = document.querySelector(".valo");
  const vcss = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const REGIONS = [["mumbai", "Mumbai"], ["singapore", "Singapore"], ["hongkong", "Hong Kong"], ["manila", "Manila"], ["tokyo", "Tokyo"], ["sydney", "Sydney"]];
  const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hourFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const hour = (h) => hourFmt.format(new Date(2000, 0, 1, h));
  const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const ms = (v) => (v == null ? "—" : Math.round(v));
  const level = (ready) => (ready == null ? "" : ready >= 80 ? "good" : ready >= 50 ? "warn" : "bad");
  const dur = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.round((s % 3600) / 60);
    return d >= 2 ? `${d} days` : d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };

  const params = new URLSearchParams(location.search);
  const state = { region: params.get("region") || localStorage.getItem("valoHistRegion"), days: Number(localStorage.getItem("valoHistDays")) || 7, data: null };
  const charts = {};

  function tabs(main) {
    if (!REGIONS.some(([k]) => k === state.region)) state.region = main;
    $("vh-tabs").innerHTML = REGIONS.map(([k, n]) =>
      `<button class="valo-tab" role="tab" aria-selected="${k === state.region}" data-key="${k}">${k === main ? '<i class="main-mark" title="Main server"></i>' : ""}${n}</button>`).join("");
    document.querySelectorAll("#vh-range [data-days]").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.days) === state.days)));
  }

  async function load() {
    const live = state.main ? null : await api("api/valorant").catch(() => null);
    if (live) state.main = live.main;
    tabs(state.main || "mumbai");
    state.data = await api(`api/valorant/history?region=${state.region}&days=${state.days}`);
    render();
  }

  function render() {
    const d = state.data, limit = d.max_ping_ms;
    if (!d.minutes) {
      $("vh-body").innerHTML = `<div class="vb"><div><div class="vb-server">${esc(d.region_name)}</div><p class="vb-verdict">No history yet</p></div>
        <p class="vb-why">Every minute the add-on saves how each server was doing. The first hours appear here soon; the week view fills in over the next 7 days.</p></div>`;
      return;
    }
    const b = d.best, w = d.worst, span = (x) => `${hour(x.start_hour)} to ${hour(x.end_hour)}`;
    const lv = b ? level(b.ready_pct) : level(d.ready_pct);
    const thin = d.minutes < 3 * 24 * 60;
    $("vh-body").innerHTML = `
      <section class="vb lv-${lv || "warn"} vh-hero">
        <div>
          <div class="vb-server">Best time to play ${esc(d.region_name)}</div>
          <p class="vb-verdict">${b ? span(b) : "Still learning"}</p>
        </div>
        <p class="vb-why">${b ? `Ready ${Math.round(b.ready_pct)}% of the time in those hours.` : "Each hour of the day needs about 30 minutes of readings first."}
          ${w && b && w.start_hour !== b.start_hour ? ` Worst is ${span(w)}, ready only ${Math.round(w.ready_pct)}%.` : ""}
          ${thin ? " Based on less than 3 days so far, so it will sharpen." : ""}</p>
      </section>
      <dl class="valo-stats">
        <div><dt>Ready to queue</dt><dd>${Math.round(d.ready_pct)}<small>% of the time</small></dd></div>
        <div><dt>Typical ping</dt><dd>${ms(d.median_ms)}<small>ms</small></dd><span class="sub">Your limit is ${limit} ms</span></div>
        <div><dt>Rough patches</dt><dd>${d.stretches.length}<small>${d.stretches.length === 15 ? "+" : ""}</small></dd><span class="sub">10 minutes or longer</span></div>
        <div><dt>Measured</dt><dd>${dur(d.minutes * 60)}</dd><span class="sub">Since ${dShort.format(d.since * 1000)}</span></div>
      </dl>

      <div class="valo-sec"><h2>Week at a glance</h2><span>How often it was ready, by day and hour</span></div>
      <div class="vh-heat" id="vh-heat" role="img" aria-label="Share of time ${esc(d.region_name)} was ready to play, by weekday and hour"></div>
      <div class="vh-legend"><span><i class="lv-good"></i>Ready 80%+</span><span><i class="lv-warn"></i>50 to 80%</span><span><i class="lv-bad"></i>Under 50%</span><span><i></i>No data</span></div>

      <div class="vh-grid">
        <div>
          <div class="valo-sec"><h2>By hour of day</h2><span>Ready share</span></div>
          <div class="valo-chart"><canvas id="vh-hours" aria-label="Share of time ready, by hour of day"></canvas></div>
        </div>
        <div>
          <div class="valo-sec"><h2>Ping over time</h2><span>Dashed line: your ${limit} ms limit</span></div>
          <div class="valo-chart"><canvas id="vh-series" aria-label="Typical ping over time"></canvas></div>
        </div>
      </div>

      <div class="valo-sec"><h2>Servers compared</h2><span>Last ${d.days} days</span></div>
      <div class="valo-routes">${d.compare.map((c) => `<a class="vrt vh-cmp lv-${level(c.ready_pct)}" href="?region=${c.region}" data-key="${c.region}">
        <span><b>${esc(c.name)}</b><span class="ip">${ms(c.avg_ms)} ms average</span></span>
        <span class="vrt-bar"><i style="width:${c.ready_pct.toFixed(1)}%"></i></span>
        <span class="vrt-val">${Math.round(c.ready_pct)}<small>%</small></span></a>`).join("")}</div>

      <div class="valo-sec"><h2>Rough patches</h2><span>When ${esc(d.region_name)} wasn't worth queuing for 10+ minutes</span></div>
      ${d.stretches.length ? `<div class="vh-table"><table>
        <thead><tr><th>When</th><th class="num">Lasted</th><th class="num">Typical ping</th><th class="num">Worst</th></tr></thead>
        <tbody>${d.stretches.map((s) => `<tr><td>${dayTime.format(s.start * 1000)} to ${timeFmt.format(s.end * 1000)}</td>
          <td class="num">${dur(s.end - s.start)}</td><td class="num">${ms(s.median_ms)} ms</td><td class="num">${ms(s.peak_ms)} ms</td></tr>`).join("")}</tbody>
      </table></div>` : `<p class="valo-note">None in this period. Clean.</p>`}`;
    renderHeat(d);
    renderHours(d);
    renderSeries(d);
  }

  function renderHeat(d) {
    const cells = new Map(d.heat.map((c) => [`${c.wday}-${c.hour}`, c]));
    const now = new Date(), nowKey = `${(now.getDay() + 6) % 7}-${now.getHours()}`;
    let html = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="vh-hx">${h % 3 === 0 ? hour(h) : ""}</span>`).join("")}`;
    DAYS.forEach((day, w) => {
      html += `<span class="vh-dy">${day}</span>`;
      for (let h = 0; h < 24; h++) {
        const c = cells.get(`${w}-${h}`);
        const tip = c ? `${day} ${hour(h)}: ready ${Math.round(c.ready_pct)}%, typical ping ${ms(c.median_ms)} ms` : `${day} ${hour(h)}: no data yet`;
        html += `<span class="vh-c ${c ? `lv-${level(c.ready_pct)}` : ""}${`${w}-${h}` === nowKey ? " now" : ""}" data-tip="${esc(tip)}"></span>`;
      }
    });
    $("vh-heat").innerHTML = html;
  }

  function chartBase() {
    const grid = vcss("--v-line"), dim = vcss("--v-dim");
    return {
      responsive: true, maintainAspectRatio: false, animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 500 },
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: { grid: { color: grid, drawTicks: false }, border: { color: grid }, ticks: { color: dim, maxRotation: 0, autoSkipPadding: 20, padding: 6 } },
        y: { beginAtZero: true, grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: dim, padding: 6, maxTicksLimit: 5 } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: vcss("--v-panel-hi"), titleColor: vcss("--v-bone"), bodyColor: dim, borderColor: grid, borderWidth: 1, padding: 10, cornerRadius: 0 },
      },
    };
  }
  function mount(key, canvas, cfg) {
    if (charts[key]) charts[key].destroy();
    charts[key] = new Chart(canvas, cfg);
  }

  function renderHours(d) {
    const byHour = new Map(d.hours.map((h) => [h.hour, h]));
    const rows = Array.from({ length: 24 }, (_, h) => byHour.get(h) || { hour: h, ready_pct: null, median_ms: null, n: 0 });
    // Same emphasis as the heatmap: bad hours bright, good ones quiet.
    const color = (r) => { const l = level(r.ready_pct); return l ? vcss(`--v-${l}`) + { good: "66", warn: "9e", bad: "e6" }[l] : vcss("--v-line"); };
    const opts = chartBase();
    opts.scales.y.max = 100;
    opts.scales.y.ticks.callback = (v) => `${v}%`;
    opts.plugins.tooltip.callbacks = {
      title: (items) => hour(rows[items[0].dataIndex].hour),
      label: (item) => { const r = rows[item.dataIndex]; return r.n ? ` Ready ${Math.round(r.ready_pct)}%, typical ${ms(r.median_ms)} ms` : " No data yet"; },
    };
    mount("hours", $("vh-hours"), { type: "bar", options: opts, data: {
      labels: rows.map((r) => (r.hour % 3 === 0 ? hour(r.hour) : "")),
      datasets: [{ data: rows.map((r) => r.ready_pct ?? 0), backgroundColor: rows.map(color), borderRadius: 0, barPercentage: 0.82, categoryPercentage: 1 }],
    } });
  }

  function renderSeries(d) {
    const opts = chartBase(), lo = Date.now() - d.days * 86400e3, hi = Date.now();
    Object.assign(opts.scales.x, { type: "linear", min: lo, max: hi });
    opts.scales.x.ticks.callback = (v) => dShort.format(v);
    opts.scales.y.suggestedMax = d.max_ping_ms * 1.5;
    opts.plugins.tooltip.callbacks = {
      title: (items) => dayTime.format(items[0].parsed.x),
      label: (item) => (item.datasetIndex ? ` Your limit: ${d.max_ping_ms} ms` : ` Typical ping ${ms(item.parsed.y)} ms, ready ${Math.round(d.series[item.dataIndex].ready_pct)}%`),
    };
    const c = $("vh-series"), grad = c.getContext("2d").createLinearGradient(0, 0, 0, 170);
    grad.addColorStop(0, "rgba(255,70,85,0.26)"); grad.addColorStop(1, "rgba(255,70,85,0)");
    mount("series", c, { type: "line", options: opts, data: { datasets: [
      { data: d.series.map((p) => ({ x: p.ts * 1000, y: p.median_ms })), borderColor: vcss("--v-bone"), backgroundColor: grad, fill: true,
        borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 4, tension: 0.2 },
      { data: [{ x: lo, y: d.max_ping_ms }, { x: hi, y: d.max_ping_ms }], borderColor: vcss("--v-red"), borderWidth: 1.2, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0 },
    ] } });
  }

  // Heatmap tooltip, for mouse and keyboard-less touch alike.
  const tip = $("vh-tip");
  document.addEventListener("pointermove", (e) => {
    const c = e.target.closest && e.target.closest("[data-tip]");
    if (!c) { tip.hidden = true; return; }
    tip.textContent = c.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(innerWidth - r.width - 8, e.clientX + 12)}px`;
    tip.style.top = `${Math.max(8, e.clientY - r.height - 12)}px`;
  });

  const pick = (key) => {
    state.region = key;
    localStorage.setItem("valoHistRegion", key);
    history.replaceState(null, "", `?region=${key}`);
    load().catch(fail);
  };
  $("vh-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-key]"); if (b) pick(b.dataset.key); });
  $("vh-body").addEventListener("click", (e) => {
    const a = e.target.closest(".vh-cmp");
    if (!a) return;
    e.preventDefault();
    pick(a.dataset.key);
    scrollTo({ top: 0, behavior: "smooth" });
  });
  $("vh-range").addEventListener("click", (e) => {
    const b = e.target.closest("[data-days]");
    if (!b) return;
    state.days = Number(b.dataset.days);
    localStorage.setItem("valoHistDays", state.days);
    load().catch(fail);
  });
  const fail = (e) => {
    console.error(e);
    $("vh-body").innerHTML = `<p class="valo-empty">Couldn't load the history. Check that the Net Monitor add-on is running, then reload this page.</p>`;
  };
  load().catch(fail);
  setInterval(() => { if (!document.hidden) load().catch(() => {}); }, 300000);
})();
