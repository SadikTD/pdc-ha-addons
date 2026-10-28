/* Electricity Monitor dashboard. Times are shown in the viewer's local time zone. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const api = async (path) => {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  };
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return { ok: r.ok, body: await r.json().catch(() => ({})) };
  };
  const root = $("root");
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NOW = () => Date.now() / 1000;

  // ---------------------------------------------------------------- formatting
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const hFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const dFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const dShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const mFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const mShort = new Intl.DateTimeFormat(undefined, { month: "short" });
  const time = (ts) => tFmt.format(ts * 1000);
  const hourLabel = (h) => hFmt.format(new Date(2026, 0, 1, h));
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  const when = (ts) => {
    if (!ts) return "-";
    if (sameDay(ts, NOW())) return `Today ${time(ts)}`;
    if (sameDay(ts, NOW() - 86400)) return `Yesterday ${time(ts)}`;
    return `${dFmt.format(ts * 1000)}, ${time(ts)}`;
  };
  const dur = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return m < 10 && sec ? `${m}m ${sec}s` : `${m}m`;
    return `${sec}s`;
  };
  const n = (v, d = 0) => (v == null || Number.isNaN(v) ? "-" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  let CUR = "৳";
  const money = (v, d = 0) => (v == null ? "-" : `${CUR}${n(v, d)}`);
  const toLocalInput = (ts) => {
    const d = new Date(ts * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const fromLocalInput = (v) => new Date(v).getTime() / 1000;
  const startOfDay = (ts) => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  const pctChange = (a, b) => (b > 0 ? (100 * (a - b)) / b : null);
  const deltaHtml = (a, b, label) => {
    const p = pctChange(a, b);
    if (p == null) return "";
    const r = Math.round(p);
    if (r === 0) return `Same as ${esc(label.replace(/^vs /, ""))}`;
    const cls = r > 3 ? "delta-up" : r < -3 ? "delta-down" : "";
    return `<span class="${cls}">${r > 0 ? "+" : ""}${r}%</span> ${esc(label)}`;
  };

  // -------------------------------------------------------------------- theme
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
    if (loaded[tab]) loaders[tab]();
  }

  function countUp(el, to, format) {
    if (to == null || Number.isNaN(to)) { el.textContent = format(null); el.dataset.v = ""; return; }
    const from = el.dataset.v === undefined || el.dataset.v === "" ? 0 : Number(el.dataset.v);
    el.dataset.v = to;
    if (reduceMotion || from === to) { el.textContent = format(to); return; }
    const t0 = performance.now(), D = 600;
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
  root.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t) showTip(e, t.dataset.tip); else if (!tip.hidden) hideTip();
  });
  root.addEventListener("mouseleave", hideTip);

  // ------------------------------------------------------------------- charts
  const charts = {};
  function chart(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), config);
  }
  function axisTime(span) {
    return (v) => (span > 2 * 86400 ? dShort.format(v * 1000) : time(v));
  }
  function opts({ span, yTitle, stacked, legend, yMin, yMax, xType = "linear", tickX }) {
    const grid = css("--grid"), tick = css("--text-muted");
    return {
      responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 500 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: !!legend, labels: { color: css("--text-secondary"), boxWidth: 12, boxHeight: 3 } },
        tooltip: {
          backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"),
          borderColor: css("--axis"), borderWidth: 1, cornerRadius: 0,
          callbacks: xType === "linear" ? { title: (items) => items.length ? when(items[0].parsed.x) : "" } : {},
        },
      },
      scales: {
        x: {
          type: xType, stacked, grid: { color: grid, drawTicks: false }, border: { color: css("--axis") },
          ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, callback: tickX || (xType === "linear" ? axisTime(span) : function (v) { return this.getLabelForValue(v); }) },
        },
        y: {
          stacked, grid: { color: grid, drawTicks: false }, border: { display: false }, min: yMin, max: yMax,
          ticks: { color: tick, maxTicksLimit: 6 }, title: yTitle ? { display: true, text: yTitle, color: tick } : undefined,
        },
      },
    };
  }
  const line = (label, data, color, extra) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2, ...extra });

  // ------------------------------------------------------------------- tabs
  const loaders = {}, loaded = {};
  let tab = "live";
  function setTab(t) {
    if (!loaders[t]) t = "live";
    tab = t;
    document.querySelectorAll("#tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    document.querySelectorAll(".page").forEach((p) => { p.hidden = p.id !== `page-${t}`; });
    if (location.hash !== `#${t}`) history.replaceState(null, "", `#${t}`);
    hideTip();
    loaders[t]().catch((e) => console.error(e));
  }
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b) setTab(b.dataset.tab); });
  $("tabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const tabs = [...document.querySelectorAll("#tabs [role=tab]")];
    const i = tabs.findIndex((b) => b.dataset.tab === tab) + (e.key === "ArrowRight" ? 1 : -1);
    const b = tabs[(i + tabs.length) % tabs.length];
    b.focus();
    setTab(b.dataset.tab);
  });
  root.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) setTab(g.dataset.goto); });

  function chips(id, onPick) {
    $(id).addEventListener("click", (e) => {
      const c = e.target.closest(".chip");
      if (!c) return;
      $(id).querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-checked", String(x === c)));
      onPick(c.dataset);
    });
  }

  // ---------------------------------------------------------------- confirm
  function confirmBox(title, text, okLabel) {
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    $("confirm-ok").textContent = okLabel || "Yes";
    const dlg = $("confirm");
    dlg.returnValue = "";
    dlg.showModal();
    return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok"), { once: true }));
  }
  async function control(action, extra) {
    const labels = {
      on: ["Turn the breaker on?", "The whole house gets power again. If it tripped on a fault, make sure the cause is fixed first.", "Turn on"],
      off: ["Turn the breaker off?", "This cuts the power to the whole house.", "Turn off"],
      clear_flag: ["Clear the trip flag?", "Resets the breaker's fault flag.", "Clear"],
    };
    if (labels[action] && !(await confirmBox(...labels[action]))) return false;
    const r = await post("api/control", { action, ...extra });
    if (!r.ok) alert(r.body.error || "Home Assistant didn't accept that.");
    setTimeout(refreshAll, 1500);
    return r.ok;
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-control]"); if (b) control(b.dataset.control); });

  // ============================================================== LIVE
  let status = null, oddsCache = null, oddsAt = 0;
  const STATE_TEXT = {
    on: ["Power on", "Everything is normal."],
    outage: ["Power cut", "The breaker went silent and isn't metering: load shedding or a supply fault."],
    offline: ["Breaker offline", ""],
    trip: ["Breaker tripped", ""],
    off: ["Breaker off", ""],
    unknown: ["Not connected", "Can't reach Home Assistant right now. Events are caught up when it's back."],
  };

  function stateLines(s) {
    const st = s.state;
    const ev = s.off_event;
    let title = "", text = STATE_TEXT[st][1], level = st === "on" ? "" : "lv-bad";
    if (st === "on") {
      title = s.last_outage && s.last_outage.end ? `Last power cut ${when(s.last_outage.end)}` : "No power cuts recorded yet";
      const p = s.prediction;
      if (p && p.next) text = `Next likely cut around ${hourLabel(p.next.hour)} (${Math.round(p.next.chance * 100)}% of recent days).`;
    } else if (st === "outage") {
      title = "Load shedding";
      const p = s.prediction;
      text += s.last_outage && s.last_outage.data && s.last_outage.data.v_before ? ` Voltage just before: ${n(s.last_outage.data.v_before)} V.` : "";
      if (p && p.now) text += ` Cuts at this hour happened on ${Math.round(p.now * 100)}% of recent days.`;
    } else if (st === "offline") {
      title = "Waiting to see if it's a power cut";
      text = `The breaker stopped answering. If it's still silent after ${dur(s.min_outage_s)}, it counts as a power cut; if it comes back still metering, it was only Wi-Fi.`;
      level = "lv-warn";
    } else if (st === "trip" || st === "off") {
      title = ev ? ev.cause_text || "Switched off" : "Switched off";
      text = ev ? ev.detail || "" : "";
      if (ev && ev.cause === "stayed_off") text += s.auto_restore ? " It will be switched back on automatically once the voltage is steady." : "";
      level = st === "trip" ? "lv-bad" : "lv-warn";
    }
    return { title, text, level };
  }

  function renderLive() {
    const s = status;
    CUR = s.currency || CUR;
    const st = s.state;
    $("state-card").className = `card state-card reveal st-${st}`;
    $("state-word").textContent = st === "trip" && s.off_event && s.off_event.cause === "stayed_off" ? "Breaker off" : STATE_TEXT[st][0];
    tickSince();
    const L = stateLines(s);
    $("state-verdict").className = `verdict ${L.level}`;
    $("state-title").textContent = L.title;
    $("state-text").textContent = L.text;
    $("state-actions").innerHTML = (st === "trip" || st === "off")
      ? `<button class="btn primary" data-control="on"><span>Turn the breaker on</span></button>
         <button class="btn ghost" data-goto="protection"><span>Why did it switch off?</span></button>` : "";
    const badge = document.querySelector('#tabs [data-tab="live"]');
    badge.innerHTML = `Live${["trip", "outage", "off"].includes(st) ? '<i class="badge" aria-label="needs attention"></i>' : ""}`;

    const r = s.readings || {};
    const online = s.avail && s.ha_connected;
    countUp($("m-power"), online ? r.power : null, (v) => n(v));
    const rate = (s.bill && s.bill.rate) || 0;
    $("m-power-note").textContent = online && r.power != null ? `About ${money(r.power / 1000 * rate * 1.05, 1)} an hour at this load` : st === "outage" ? "No power from the grid" : "";
    $("m-voltage").textContent = online && r.voltage != null ? `${n(r.voltage, 1)} V` : "-";
    voltageBar(online ? r.voltage : null, r.low_v, r.over_v);
    const cell = (id, v, cls) => { const el = $(id); el.textContent = v; el.parentElement.className = `mcell ${cls || ""}`; };
    cell("m-current", online && r.current != null ? `${n(r.current, 2)} A` : "-", r.over_a && r.current >= r.over_a * 0.85 ? "warn" : "");
    cell("m-pf", online && r.pf != null ? `${n(r.pf)}%` : "-", r.pf != null && r.pf < 80 ? "warn" : "");
    cell("m-hz", online && r.hz != null ? `${n(r.hz, 1)} Hz` : "-", r.hz != null && Math.abs(r.hz - 50) > 0.5 ? "warn" : "");
    cell("m-temp", r.temp != null ? `${n(r.temp)} °C` : "-", r.over_t && r.temp >= r.over_t - 5 ? "bad" : r.over_t && r.temp >= r.over_t - 10 ? "warn" : "");
    cell("m-energy", r.energy != null ? `${n(r.energy, 1)} kWh` : "-");
    cell("m-base", s.base_w != null ? `${n(s.base_w)} W` : "-");

    const c = s.compare, t = s.today, b = s.bill, p = s.prepaid;
    const tiles = [
      { label: "Used today", value: `${n(c.today, 1)}<small>kWh</small>`, sub: deltaHtml(c.today, c.yesterday_same, "vs this time yesterday") },
      { label: "Cost today", value: money(c.today * avgRate(b)), sub: `Yesterday ${money(c.yesterday * avgRate(b))}` },
      { label: "Power cuts today", value: `${t.outages}`, sub: t.outages ? `${dur(t.outage_s)} without power` : "None so far", cls: t.outages ? "bad" : "good" },
      { label: "This month", value: `${n(b.units)}<small>kWh</small>`, sub: `${money(b.bill.total)} so far, about ${money(b.projected && b.projected.total)} by month end` },
      { label: "Price per unit now", value: money(b.rate, 2), sub: b.next_limit ? `${n(b.next_limit - b.units)} units until ${money(b.next_rate, 2)}` : "Top slab", cls: b.next_limit && b.next_limit - b.units < 20 && b.next_rate > b.rate ? "warn" : "" },
      p.configured
        ? { label: "Prepaid balance", value: money(p.balance), sub: p.balance <= 0 ? "Probably used up. Check the meter" : p.days_left != null ? `About ${n(p.days_left, 1)} days left` : "", cls: p.balance <= p.low_alert ? "bad" : p.days_left != null && p.days_left <= 5 ? "warn" : "good", goto: "prepaid" }
        : { label: "Prepaid balance", value: "Not set", sub: "Enter the meter's balance to track it", goto: "prepaid" },
    ];
    $("today-tiles").innerHTML = tiles.map((x) => `<div class="tile ${x.cls || ""}"${x.goto ? ` data-goto="${x.goto}" role="button" tabindex="0"` : ""}>
      <div class="label">${esc(x.label)}</div><div class="value">${x.value}</div><div class="sub">${x.sub || "&nbsp;"}</div></div>`).join("");

    renderForecast();
    renderEvents($("recent"), s.recent, "No power cuts, trips or drops in the last 3 days.");
    renderSpark();
    $("foot").textContent = `Updated ${time(s.now)}${s.ha_connected ? "" : " - Home Assistant not connected"}`;
  }
  const avgRate = (b) => (b && b.units > 0 ? (b.bill.energy / b.units) * 1.05 : (b ? b.rate * 1.05 : 0));

  function tickSince() {
    if (!status) return;
    const s = status;
    const since = s.since;
    let txt = "&nbsp;";
    if (s.state === "on" && since) txt = `for ${dur(NOW() - since)}, since ${when(since)}`;
    else if (["outage", "offline", "trip", "off"].includes(s.state) && since) txt = `for ${dur(NOW() - since)}, since ${when(since)}`;
    else if (s.state === "unknown" && since) txt = `last seen ${when(since)}`;
    $("state-since").innerHTML = txt;
  }
  setInterval(tickSince, 1000);

  function voltageBar(v, lo, hi) {
    const MIN = 150, MAX = 290, pos = (x) => `${(100 * (Math.min(MAX, Math.max(MIN, x)) - MIN)) / (MAX - MIN)}%`;
    lo = lo || 180; hi = hi || 270;
    $("vbar").style.gridTemplateColumns = `${lo - MIN}fr ${hi - lo}fr ${MAX - hi}fr`;
    $("vb-lo").style.left = pos(lo);
    $("vb-hi").style.left = pos(hi);
    $("vb-lo-l").textContent = `cut ${n(lo)} V`;
    $("vb-hi-l").textContent = `cut ${n(hi)} V`;
    $("vb-mark").hidden = v == null;
    if (v != null) $("vb-mark").style.left = pos(v);
  }

  async function renderForecast() {
    if (!oddsCache || NOW() - oddsAt > 600) {
      oddsCache = await api("api/heatmap?days=28");
      oddsAt = NOW();
    }
    const p = status.prediction, odds = oddsCache.odds, hour = new Date().getHours();
    if (!p) {
      $("forecast").innerHTML = '<p class="muted">The forecast needs a few days of data.</p>';
      return;
    }
    const next = p.next;
    $("forecast").innerHTML = `
      <div class="forecast-big">
        <div><div class="k">This hour</div><div class="v">${Math.round(p.now * 100)}%</div></div>
        <div><div class="k">Next likely cut</div><div class="v">${next ? `${hourLabel(next.hour)}` : "None expected"}</div></div>
        ${next ? `<div><div class="k">Chance then</div><div class="v">${Math.round(next.chance * 100)}%</div></div>` : ""}
      </div>
      <div class="oddsbar" aria-label="Chance of a power cut in each hour of the day">${odds.map((o, h) =>
        `<i class="${h === hour ? "now" : o >= 0.3 ? "hot" : ""}" style="height:${Math.max(4, o * 100)}%" data-tip="<b>${esc(hourLabel(h))}</b><span>${Math.round(o * 100)}% of the last ${p.days} days had a cut</span>"></i>`).join("")}</div>
      <div class="odds-axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
      <p class="small muted hint">From the last ${p.days} days of power cuts. Bars show how often each hour had one.</p>`;
  }

  function eventLabel(e) {
    if (e.kind === "outage") return ["Power cut", e.confidence === "estimated" ? e.detail : e.data && e.data.v_before ? `Voltage before: ${n(e.data.v_before)} V` : "", "outage"];
    if (e.kind === "wifi") return ["Breaker offline", e.cause === "wifi" ? "Wi-Fi drop: it kept metering, so the power was on" : "Short drop (Wi-Fi or router)", "wifi"];
    if (e.kind === "gap") return ["Monitor offline", e.detail || "Home Assistant was offline", "gap"];
    if (e.kind === "fault") return ["Breaker fault", e.detail || "", "fault"];
    if (e.kind === "voltage") return [e.cause === "high" ? "High voltage" : "Low voltage", e.data && e.data.extreme ? `${e.cause === "high" ? "Peak" : "Lowest"} ${n(e.data.extreme)} V` : "", e.cause];
    if (e.kind === "off") {
      const self = ["ha_user", "automation", "addon"].includes(e.cause);
      return [self ? "Breaker switched off" : e.cause === "stayed_off" ? "Stayed off after power returned" : "Breaker tripped",
        `${e.cause_text || ""}${e.detail ? `. ${e.detail}` : ""}${e.data && e.data.restored_by ? `. Back on by ${e.data.restored_by}` : ""}`, self ? "off" : "trip"];
    }
    return [e.kind, e.detail || "", e.kind];
  }
  function renderEvents(el, rows, empty) {
    el.innerHTML = rows && rows.length ? rows.map((e) => {
      const [title, sub, cls] = eventLabel(e);
      return `<li class="k-${cls}"><span class="ev-when">${esc(when(e.start))}</span>
        <span class="ev-what"><b>${esc(title)}</b><span>${esc(sub)}</span></span>
        <span class="ev-len">${e.end ? dur(e.duration_s) : "ongoing"}</span></li>`;
    }).join("") : `<li class="empty-li">${esc(empty)}</li>`;
  }

  function renderSpark() {
    const pts = (status.spark || []).filter((p) => p.w != null);
    $("spark-now").textContent = pts.length ? `${n(pts[pts.length - 1].w)} W` : "";
    chart("spark", {
      type: "line",
      data: { datasets: [line("Power", pts.map((p) => ({ x: p.ts, y: p.w })), css("--accent"), { fill: true, backgroundColor: `color-mix(in srgb, ${css("--accent")} 14%, transparent)`, borderWidth: 1.5 })] },
      options: { ...opts({ span: 3600 }), animation: false, scales: { x: { type: "linear", display: false }, y: { display: false, beginAtZero: true } }, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    });
  }

  async function loadStrip() {
    const now = NOW();
    const rows = await api(`api/timeline?from=${now - 86400}&to=${now}&buckets=96`);
    const word = { on: "Power on", outage: "Power cut", off: "Breaker off", wifi: "Breaker offline", gap: "Monitor offline", none: "No data", future: "" };
    $("strip24").innerHTML = rows.map((r) => `<span class="${r.state}" data-tip="<b>${esc(word[r.state])}</b><span>${esc(time(r.lo))} - ${esc(time(r.hi))}</span>"></span>`).join("");
    $("strip24-axis").innerHTML = [0, 6, 12, 18, 24].map((h) => `<span>${esc(time(now - 86400 + h * 3600))}</span>`).join("");
    const cuts = rows.filter((r) => r.state === "outage").length;
    $("strip-note").textContent = cuts ? `${dur(cuts * 900)} of power cuts (15-minute blocks)` : "";
  }

  loaders.live = async () => {
    status = await api("api/status");
    renderLive();
    loaded.live = true;
    loadStrip();
  };

  // ============================================================== POWER CUTS
  let outDays = 7, outLimit = 50, calCache = null;
  chips("out-range", (d) => { outDays = Number(d.days); outLimit = 50; loaders.outages(); });
  $("show-wifi").addEventListener("change", () => loaders.outages());
  $("out-more").addEventListener("click", () => { outLimit += 100; loaders.outages(); });

  loaders.outages = async () => {
    const now = NOW(), lo = outDays === 1 ? startOfDay(now) : now - outDays * 86400;
    const kinds = $("show-wifi").checked ? "outage,wifi,gap" : "outage";
    const [sum, evs, nets, heat, odds] = await Promise.all([
      api(`api/summary?from=${lo}&to=${now}`), api(`api/events?from=${lo}&to=${now}&kinds=${kinds}`),
      api(`api/events?from=${lo}&to=${now}&kinds=internet`), api(`api/heatmap?days=${Math.max(7, outDays)}`), api("api/heatmap?days=28"),
    ]);
    if (!calCache || NOW() - calCache.at > 600) calCache = { at: NOW(), rows: await api("api/calendar?days=365") };
    $("out-csv").href = `api/export/events.csv?from=${lo}&to=${now}`;
    const tiles = [
      ["Power cuts", n(sum.outages), sum.outages ? `${n(sum.outages / Math.max(1, (now - lo) / 86400), 1)} a day` : "None", sum.outages ? "bad" : "good"],
      ["Without power", dur(sum.outage_s), `${n(100 - sum.power_pct, 1)}% of the time`],
      ["Longest", sum.outages ? dur(sum.longest_s) : "-", ""],
      ["Average cut", sum.outages ? dur(sum.average_s) : "-", ""],
      ["Breaker trips", n(sum.trips), sum.trips ? Object.entries(sum.trip_causes).map(([k, v]) => `${k.replace(/_/g, " ")} x${v}`).join(", ") : "None", sum.trips ? "bad" : "good"],
      ["Internet down too", `${n(sum.outages_with_internet_down)} of ${n(sum.outages)}`, "Cuts where Net Monitor saw the internet drop"],
      ["Wi-Fi drops", n(sum.wifi), "Breaker offline, power on"],
    ];
    $("out-tiles").innerHTML = tiles.map(([l, v, s, c]) => `<div class="tile ${c || ""}"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="sub">${esc(s || " ")}</div></div>`).join("");

    renderHeat(heat);
    chart("odds-chart", {
      type: "bar",
      data: { labels: odds.odds.map((_, h) => hourLabel(h)), datasets: [{ label: "Chance", data: odds.odds.map((o) => Math.round(o * 100)), backgroundColor: odds.odds.map((o) => (o >= 0.3 ? css("--critical") : `color-mix(in srgb, ${css("--critical")} 35%, transparent)`)), borderRadius: 0 }] },
      options: { ...opts({ xType: "category", yMin: 0, yMax: 100 }), plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y}% of days` } } } },
    });
    renderCalendar(calCache.rows);

    const netOverlap = (e) => nets.some((x) => x.start < (e.end || now) && (x.end || now) > e.start);
    const rows = evs.slice(0, outLimit);
    $("out-rows").innerHTML = rows.length ? rows.map((e) => {
      const [title, sub] = eventLabel(e);
      return `<tr><td>${esc(when(e.start))}</td><td>${e.end ? esc(sameDay(e.start, e.end) ? time(e.end) : when(e.end)) : '<span class="tag down">ongoing</span>'}</td>
        <td class="num">${dur(e.duration_s)}</td><td class="wrap"><b>${esc(title)}</b>${sub ? `<br><span class="muted small">${esc(sub)}</span>` : ""}</td>
        <td>${e.kind === "outage" ? (netOverlap(e) ? '<span class="tag down">Down too</span>' : '<span class="tag ok">Stayed up</span>') : ""}</td></tr>`;
    }).join("") : '<tr><td colspan="5" class="muted">No power cuts in this range.</td></tr>';
    $("out-more").hidden = evs.length <= outLimit;
    $("lookup-at").value = $("lookup-at").value || toLocalInput(now - 3600);
    loaded.outages = true;
  };

  function renderHeat(h) {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const max = Math.max(1, ...h.grid.flat());
    let html = '<span></span>' + Array.from({ length: 24 }, (_, i) => `<span class="cl">${i % 6 === 0 ? esc(hourLabel(i)) : ""}</span>`).join("");
    h.grid.forEach((row, d) => {
      html += `<span class="rl">${days[d]}</span>` + row.map((m, hr) => {
        const p = m ? 15 + 85 * (m / max) : 0;
        const style = m ? ` style="background:color-mix(in srgb, var(--critical) ${p.toFixed(0)}%, var(--surface-2))"` : "";
        return `<span class="cell"${style} data-tip="<b>${days[d]} ${esc(hourLabel(hr))}</b><span>${m ? `${Math.round(m)} min without power` : "No cuts"}</span>"></span>`;
      }).join("");
    });
    $("heatmap").innerHTML = html;
    $("heat-note").textContent = `${h.outages} cuts, ${h.days} days`;
    $("heat-legend").innerHTML = '<span>Fewer minutes</span>' + [15, 40, 65, 100].map((p) => `<i style="background:color-mix(in srgb, var(--critical) ${p}%, var(--surface-2))"></i>`).join("") + "<span>More</span>";
    const byHour = Array.from({ length: 24 }, (_, i) => h.grid.reduce((a, r) => a + r[i], 0));
    const top = byHour.map((m, i) => [m, i]).filter(([m]) => m > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i).sort((a, b) => a - b);
    $("heat-summary").innerHTML = top.length ? `Most of the time without power falls around <strong>${top.map((i) => esc(hourLabel(i))).join(", ")}</strong>.` : "No power cuts in this range.";
  }

  function renderCalendar(rows) {
    if (!rows.length) { $("calendar").innerHTML = ""; return; }
    const first = new Date(rows[0].day * 1000);
    const pad = (first.getDay() + 6) % 7;
    let html = Array.from({ length: pad }, () => '<i class="nodata" aria-hidden="true"></i>').join("");
    html += rows.map((d) => {
      const c = !d.monitored ? "nodata" : d.outage_min <= 0 ? "c0" : d.outage_min < 15 ? "c1" : d.outage_min < 60 ? "c2" : d.outage_min < 180 ? "c3" : "c4";
      const tipText = `<b>${esc(dFmt.format(d.day * 1000))}</b><span>${d.monitored ? `${d.outages} cut${d.outages === 1 ? "" : "s"}, ${Math.round(d.outage_min)} min without power` : "Not monitored"}</span>${d.kwh ? `<span>${n(d.kwh, 1)} kWh used</span>` : ""}${d.trips ? `<span>${d.trips} breaker trip${d.trips > 1 ? "s" : ""}</span>` : ""}`;
      return `<i class="${c}${d.trips ? " trip" : ""}" data-tip="${esc(tipText)}"></i>`;
    }).join("");
    $("calendar").innerHTML = html;
    $("cal-legend").innerHTML = ["c0:No cuts", "c1:Under 15 min", "c2:Under 1 h", "c3:Under 3 h", "c4:More"].map((x) => {
      const [c, l] = x.split(":");
      return `<span class="calendar-key"><i class="cal-sw ${c}"></i> ${l}</span>`;
    }).join("") + "<span>Outlined day: a breaker trip</span>";
  }

  $("lookup-go").addEventListener("click", async () => {
    const v = $("lookup-at").value;
    if (!v) return;
    const ts = fromLocalInput(v);
    const r = await api(`api/at?ts=${ts}`);
    const s = r.sample;
    const evs = r.events.filter((e) => e.kind !== "internet");
    const net = r.events.find((e) => e.kind === "internet");
    let html = `<div><strong>${esc(when(ts))}</strong></div>`;
    if (evs.length) html += evs.map((e) => { const [t, sub] = eventLabel(e); return `<div><strong>${esc(t)}</strong> from ${esc(when(e.start))} to ${e.end ? esc(when(e.end)) : "now"} (${dur(e.duration_s)}). ${esc(sub)}</div>`; }).join("");
    else if (s) html += "<div>The power was on.</div>";
    if (s && s.v_avg != null) html += `<div>Voltage ${n(s.v_min)}-${n(s.v_max)} V, power about ${n(s.w_avg)} W${s.relay === 0 ? ", breaker off" : ""}.</div>`;
    if (!s && !evs.length) html += "<div class=\"muted\">No data for that time.</div>";
    if (net) html += "<div>The internet was down at that time too.</div>";
    $("lookup-result").innerHTML = html;
  });

  // ============================================================== PROTECTION
  const LIMIT_UI = [
    ["over_v", "Over-voltage", "V", "Cuts the power above this voltage"],
    ["low_v", "Low voltage", "V", "Cuts the power below this voltage"],
    ["over_a", "Over-current", "A", "0 = off"],
    ["over_kw", "Over-power", "kW", "0 = off"],
    ["over_t", "Over-temperature", "°C", "The breaker's own temperature"],
    ["over_kwh", "Energy limit", "kWh", "0 = off"],
  ];
  loaders.protection = async () => {
    const [p, s] = await Promise.all([api("api/protection"), api("api/status")]);
    status = s;
    const r = p.readings || {};
    const st = s.state;
    $("prot-state").innerHTML = `<span class="pill ${st === "on" ? "good" : st === "off" ? "warn" : "bad"}">${esc(s.label)}</span>`;
    $("prot-actions").innerHTML = `${s.relay === "off" ? '<button class="btn primary" data-control="on"><span>Turn on</span></button>' : ""}
      ${s.relay === "on" ? '<button class="btn danger" data-control="off"><span>Turn off</span></button>' : ""}
      <button class="btn ghost" data-control="clear_flag"><span>Clear trip flag</span></button>`;
    const prob = p.problem.state;
    $("prot-problem").textContent = prob === "unavailable" || prob == null
      ? "The breaker has never sent a fault code to Home Assistant, so its Problem sensor shows unavailable. That's normal for this model; reasons below come from the readings."
      : `Problem sensor: ${prob}${p.problem.attributes && p.problem.attributes.fault_code ? ` (code ${p.problem.attributes.fault_code})` : ""}.`;

    const now = { over_v: r.voltage, low_v: r.voltage, over_a: r.current, over_kw: r.power != null ? r.power / 1000 : null, over_t: r.temp, over_kwh: r.energy };
    $("limits").innerHTML = LIMIT_UI.map(([k, name, unit, help]) => {
      const L = p.limits[k] || {};
      const v = L.value, cur = now[k];
      let room = "", cls = "";
      if (!v) room = '<span class="pill warn off-pill">Off</span>';
      else if (cur != null) {
        const gap = k === "low_v" ? cur - v : v - cur;
        const volt = k.endsWith("_v");
        const frac = Math.min(1, Math.max(0, volt ? gap / 60 : gap / v));  // 1 = far from the limit
        cls = volt ? (gap < 8 ? "bad" : gap < 20 ? "warn" : "") : frac < 0.1 ? "bad" : frac < 0.25 ? "warn" : "";
        room = `<div class="headroom ${cls}"><span>Now ${n(cur, unit === "kW" ? 2 : unit === "A" ? 1 : 0)} ${unit}, ${n(Math.abs(gap), unit === "kW" ? 2 : 0)} ${unit} ${gap >= 0 ? "away" : "past it"}</span><div class="plan-bar"><span style="width:${(100 * (1 - frac)).toFixed(0)}%"></span></div></div>`;
      }
      return `<div class="limit" data-key="${k}">
        <div class="limit-name">${esc(name)}<small>${esc(help)}</small></div>
        <div class="with-unit"><input type="number" value="${v ?? ""}" min="${L.min ?? ""}" max="${L.max ?? ""}" step="${L.step ?? 1}" ${L.available ? "" : "disabled"} aria-label="${esc(name)} limit"><span class="unit">${unit}</span></div>
        ${room || "<span></span>"}
        <button class="btn ghost" data-save-limit="${k}" disabled><span>Save</span></button></div>`;
    }).join("");
    $("advice").innerHTML = p.suggestions.length ? p.suggestions.map((a) => `<li class="${a.level}"><b>${esc(a.title)}</b><p>${esc(a.text)}</p>
      ${a.value != null ? `<button class="linkbtn" data-suggest="${a.key}" data-value="${a.value}">Set it to ${n(a.value, a.key === "over_kw" ? 1 : 0)}</button>` : ""}</li>`).join("")
      : '<li class="good"><b>Nothing to change</b><p>Not enough readings yet for advice.</p></li>';
    $("trip-rows").innerHTML = p.events.length ? p.events.map((e) => {
      const b = (e.data && e.data.before) || {};
      const read = [b.v != null ? `${n(b.v)} V` : "", b.a != null ? `${n(b.a, 1)} A` : "", b.w != null ? `${n(b.w)} W` : ""].filter(Boolean).join(", ");
      const conf = { certain: "good", likely: "warn", guess: "" }[e.confidence] ?? "";
      return `<tr><td>${esc(when(e.start))}</td>
        <td class="wrap"><b>${esc(e.cause_text || e.cause)}</b> ${e.confidence ? `<span class="pill ${conf}">${esc(e.confidence)}</span>` : ""}<br><span class="muted small">${esc(e.detail || "")}</span></td>
        <td>${esc(read || "-")}</td><td class="num">${e.end ? dur(e.duration_s) : '<span class="tag down">still off</span>'}</td>
        <td class="wrap small">${esc((e.data && e.data.restored_by) || (e.end ? "-" : ""))}</td></tr>`;
    }).join("") : '<tr><td colspan="5" class="muted">The breaker hasn\'t switched off since monitoring started.</td></tr>';
    loaded.protection = true;
  };
  $("limits").addEventListener("input", (e) => {
    const row = e.target.closest(".limit");
    if (row) row.querySelector("[data-save-limit]").disabled = false;
  });
  root.addEventListener("click", async (e) => {
    const s = e.target.closest("[data-save-limit]");
    const g = e.target.closest("[data-suggest]");
    if (!s && !g) return;
    const key = s ? s.dataset.saveLimit : g.dataset.suggest;
    const value = s ? Number(document.querySelector(`.limit[data-key="${key}"] input`).value) : Number(g.dataset.value);
    const name = LIMIT_UI.find((x) => x[0] === key)[1];
    if (!(await confirmBox(`Change ${name.toLowerCase()} protection?`, `Set it to ${value} on the breaker.`, "Change"))) return;
    const r = await post("api/control", { action: "set_limit", key, value });
    if (!r.ok) alert(r.body.error || "Not accepted");
    setTimeout(() => loaders.protection(), 1500);
  });

  // ============================================================== USAGE
  let useRange = "day", billMonth = null;
  chips("use-range", (d) => { useRange = d.r; loaders.usage(); });
  loaders.usage = async () => {
    const now = NOW(), d0 = startOfDay(now);
    const cfg = {
      day: { from: d0, period: "hour", title: "Today, by hour" },
      week: { from: d0 - 6 * 86400, period: "day", title: "Last 7 days" },
      month: { from: d0 - 29 * 86400, period: "day", title: "Last 30 days" },
      year: { from: (() => { const d = new Date(); d.setMonth(d.getMonth() - 11, 1); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; })(), period: "month", title: "Last 12 months" },
    }[useRange];
    const ym = billMonth || new Date().toISOString().slice(0, 7);
    const [u, s, bill, months, hourly] = await Promise.all([
      api(`api/usage?period=${cfg.period}&from=${cfg.from}&to=${now}`), api("api/status"),
      api(`api/bill?month=${ym}`), api("api/months"), api(`api/usage?period=hour&from=${now - 30 * 86400}&to=${now}`),
    ]);
    status = s;
    CUR = s.currency || CUR;
    $("use-title").textContent = cfg.title;
    $("use-total").textContent = `${n(u.total, 1)} kWh · ${money(u.cost)}`;
    const days = Math.max(1, (now - cfg.from) / 86400);
    const peak = u.buckets.reduce((a, b) => (b.kwh > (a ? a.kwh : -1) ? b : a), null);
    const peakLabel = peak ? (cfg.period === "hour" ? hourLabel(new Date(peak.ts * 1000).getHours()) : cfg.period === "day" ? dShort.format(peak.ts * 1000) : mShort.format(peak.ts * 1000)) : "-";
    const tiles = [
      ["Used", `${n(u.total, 1)}<small>kWh</small>`, deltaHtml(u.total, u.previous, "vs the period before")],
      ["Cost", money(u.cost), u.previous_cost ? `Before: ${money(u.previous_cost)}` : ""],
      ["Per day", `${n(u.total / days, 1)}<small>kWh</small>`, money(u.cost / days) + " a day"],
      ["Busiest", peakLabel, peak ? `${n(peak.kwh, 1)} kWh` : ""],
      ["Always-on load", s.base_w != null ? `${n(s.base_w)}<small>W</small>` : "-", s.base_w != null ? `${money((s.base_w / 1000) * 24 * 30 * avgRate(s.bill))} a month` : "Needs a few days"],
      ["This year", `${n(s.compare.year)}<small>kWh</small>`, ""],
    ];
    $("use-tiles").innerHTML = tiles.map(([l, v, sub]) => `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${sub || "&nbsp;"}</div></div>`).join("");
    const labels = u.buckets.map((b) => (cfg.period === "hour" ? hourLabel(new Date(b.ts * 1000).getHours()) : cfg.period === "day" ? dShort.format(b.ts * 1000) : mShort.format(b.ts * 1000)));
    chart("use-chart", {
      type: "bar",
      data: { labels, datasets: [{ label: "kWh", data: u.buckets.map((b) => b.kwh), backgroundColor: css("--series-1"), hoverBackgroundColor: css("--accent"), borderRadius: 0 }] },
      options: { ...opts({ xType: "category", yTitle: "kWh", yMin: 0 }), plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${n(c.parsed.y, 2)} kWh, ${money(u.buckets[c.dataIndex].cost)}` } } } },
    });
    renderBill(bill);
    renderUseHeat(hourly);
    $("month-rows").innerHTML = months.length ? months.map((m) => `<tr data-month="${m.month}" class="${m.month === bill.month ? "sel" : ""}">
      <td>${esc(mFmt.format(new Date(`${m.month}-15T12:00:00`)))}</td><td class="num">${n(m.kwh)}</td><td class="num">${money(m.bill)}</td>
      <td class="num">${n(m.outages)}${m.outages ? ` <span class="muted small">(${dur(m.outage_s)})</span>` : ""}</td><td class="num">${n(m.trips)}</td></tr>`).join("")
      : '<tr><td colspan="5" class="muted">No months yet.</td></tr>';
    loaded.usage = true;
  };
  $("month-rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-month]");
    if (!tr) return;
    billMonth = tr.dataset.month;
    loaders.usage();
  });

  function renderBill(b) {
    const bb = b.bill;
    $("bill-title").textContent = b.current ? "This month's bill" : `Bill for ${mFmt.format(new Date(`${b.month}-15T12:00:00`))}`;
    $("bill-total").textContent = money(bb.total);
    const rows = bb.rows.map(([label, units, rate, cost]) => `<tr class="sub"><td>Units ${esc(label)}</td><td class="num">${n(units, 1)} × ${money(rate, 2)}</td><td class="num">${money(cost)}</td></tr>`).join("");
    let html = `<table class="bill-rows"><tbody>${rows}
      <tr><td>Energy</td><td class="num">${n(b.units, 1)} kWh</td><td class="num">${money(bb.energy)}</td></tr>
      <tr><td>Demand charge</td><td></td><td class="num">${money(bb.demand)}</td></tr>
      <tr><td>Meter rent</td><td></td><td class="num">${money(bb.meter_rent)}</td></tr>
      <tr><td>VAT</td><td></td><td class="num">${money(bb.vat)}</td></tr>
      ${bb.rebate ? `<tr><td>Prepaid rebate</td><td></td><td class="num">-${money(bb.rebate)}</td></tr>` : ""}
      <tr class="total"><td>Total</td><td></td><td class="num">${money(bb.total)}</td></tr></tbody></table>`;
    if (b.current && b.projected) {
      html += `<p class="speed-note ${b.projected_units > (b.next_limit || 1e9) && b.next_rate > b.rate ? "lv-warn" : ""} mt-m">At ${n(b.per_day, 1)} kWh a day you'll reach about <strong>${n(b.projected_units)} kWh</strong> and <strong>${money(b.projected.total)}</strong> this month.${
        b.limit_at ? ` You'll pass ${b.next_limit} units around <strong>${esc(dShort.format(b.limit_at * 1000))}</strong>, when the rate rises to ${money(b.next_rate, 2)}.` : ""}</p>`;
    }
    $("bill-body").innerHTML = html;
    const slabs = b.slabs;
    let prev = 0;
    $("ladder").innerHTML = slabs.map((s, i) => {
      const top = s.upto || Math.max(prev + 200, b.units);
      const inSlab = Math.max(0, Math.min(b.units, top) - prev);
      const width = (100 * inSlab) / (top - prev);
      const cur = b.units >= prev && (s.upto == null || b.units < s.upto);
      const label = s.upto ? `${prev + 1}-${s.upto}` : `${prev + 1}+`;
      prev = s.upto || prev;
      return `<div class="step ${cur ? "cur" : ""}"><span class="lbl">${label}</span><span class="bar"><b style="width:${width.toFixed(1)}%"></b></span><span class="rate">${money(s.rate, 2)}</span></div>`;
    }).join("");
    $("ladder-note").textContent = `Up to ${b.lifeline[0]} units in a month, every unit costs ${CUR}${b.lifeline[1]} (lifeline). Rates before 5% VAT.`;
  }

  function renderUseHeat(u) {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const sum = Array.from({ length: 7 }, () => Array(24).fill(0)), cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
    u.buckets.forEach((b) => { const d = new Date(b.ts * 1000); const wd = (d.getDay() + 6) % 7; sum[wd][d.getHours()] += b.kwh; cnt[wd][d.getHours()]++; });
    const avg = sum.map((r, i) => r.map((v, h) => (cnt[i][h] ? v / cnt[i][h] : null)));
    const max = Math.max(0.01, ...avg.flat().filter((x) => x != null));
    let html = '<span></span>' + Array.from({ length: 24 }, (_, i) => `<span class="cl">${i % 6 === 0 ? esc(hourLabel(i)) : ""}</span>`).join("");
    avg.forEach((row, d) => {
      html += `<span class="rl">${days[d]}</span>` + row.map((v, h) => {
        const style = v != null ? ` style="background:color-mix(in srgb, var(--series-1) ${(10 + 90 * (v / max)).toFixed(0)}%, var(--surface-2))"` : "";
        return `<span class="cell"${style} data-tip="<b>${days[d]} ${esc(hourLabel(h))}</b><span>${v != null ? `${n(v, 2)} kWh on average` : "No data"}</span>"></span>`;
      }).join("");
    });
    $("use-heat").innerHTML = html;
  }

  // ============================================================== PREPAID
  loaders.prepaid = async () => {
    const p = await api("api/prepaid");
    document.querySelectorAll(".unit.cur").forEach((el) => { el.textContent = CUR; });
    const card = $("balance-card");
    $("pp-when").value = $("pp-when").value || toLocalInput(NOW());
    if (!p.configured) {
      card.className = "card balance-card reveal unset";
      $("pp-balance").textContent = "Not set";
      $("pp-title").textContent = "Tell it what the meter shows";
      $("pp-text").textContent = "Type the balance shown on your Palli Bidyut prepaid meter. From then on it's counted down from your usage, and each recharge you add is credited.";
      $("pp-bar").style.width = "0";
      $("pp-foot").innerHTML = "";
    } else {
      const lvl = p.balance <= p.low_alert ? "bad" : p.days_left != null && p.days_left <= Math.max(5, p.low_days) ? "warn" : "";
      card.className = `card balance-card reveal ${lvl}`;
      countUp($("pp-balance"), p.balance, (v) => money(v));
      $("pp-verdict").className = `verdict ${lvl === "bad" ? "lv-bad" : lvl === "warn" ? "lv-warn" : ""}`;
      $("pp-title").textContent = p.days_left != null ? (p.days_left > 0 ? `About ${n(p.days_left, 1)} days left` : "Probably used up") : "Estimated";
      $("pp-text").textContent = p.runs_out ? `At your usage over the last week it runs out around ${when(p.runs_out)}.` : "";
      const full = p.synced_balance + p.credit;
      $("pp-bar").style.width = `${Math.max(0, Math.min(100, (100 * p.balance) / Math.max(1, full))).toFixed(0)}%`;
      $("pp-foot").innerHTML = `<div><dt>Per day</dt><dd>${money(p.per_day, 0)}</dd></div>
        <div><dt>Used since last check</dt><dd>${money(p.spent)}</dd></div>
        <div><dt>Last checked</dt><dd>${esc(when(p.synced_at))}</dd></div>
        <div><dt>Monthly charges</dt><dd>${money(p.monthly_fixed)} ${p.fixed_pending ? "(taken from the next recharge)" : "(paid this month)"}</dd></div>`;
    }
    $("pp-help").textContent = `Each month's first recharge pays the demand charge and meter rent (${money(p.monthly_fixed)} with VAT) before the rest becomes credit. Energy costs the slab rate plus 5% VAT. Check the meter now and then and set the balance; the history shows how far the estimate was off.`;
    $("pp-rows").innerHTML = p.history.length ? p.history.map((r) => `<tr><td>${esc(when(r.ts))}</td><td>${r.kind === "sync" ? "Balance check" : "Recharge"}</td>
      <td class="num">${money(r.amount, r.kind === "sync" ? 2 : 0)}</td><td class="small muted">${esc(r.note || "")}</td>
      <td><button class="linkbtn" data-pp-del="${r.id}">Remove</button></td></tr>`).join("")
      : '<tr><td colspan="5" class="muted">Nothing yet.</td></tr>';
    loaded.prepaid = true;
  };
  $("pp-sync-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await post("api/prepaid/sync", { amount: Number($("pp-sync").value) });
    if (!r.ok) return alert(r.body.error || "Not saved");
    $("pp-sync").value = "";
    loaders.prepaid();
  });
  $("pp-recharge-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = await post("api/prepaid/recharge", { amount: Number($("pp-amount").value), ts: fromLocalInput($("pp-when").value) });
    if (!r.ok) return alert(r.body.error || "Not saved");
    $("pp-amount").value = "";
    loaders.prepaid();
  });
  $("pp-rows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pp-del]");
    if (!b || !(await confirmBox("Remove this entry?", "The balance estimate is recalculated without it.", "Remove"))) return;
    await post("api/prepaid/delete", { id: Number(b.dataset.ppDel) });
    loaders.prepaid();
  });

  // ============================================================== QUALITY
  let qDays = 1;
  chips("q-range", (d) => { qDays = Number(d.days); loaders.quality(); });
  loaders.quality = async () => {
    const now = NOW(), lo = now - qDays * 86400;
    const [q, s] = await Promise.all([api(`api/quality?from=${lo}&to=${now}`), status ? Promise.resolve(status) : api("api/status")]);
    status = s;
    const g = q.grade || "-";
    $("q-grade").className = `grade g-${g}`;
    $("q-letter").textContent = g;
    const b = q.bands;
    $("q-bands").innerHTML = ["good", "fair", "bad"].map((k) => `<span class="${k}" style="width:${(b[k] || 0).toFixed(2)}%" data-tip="<b>${k[0].toUpperCase() + k.slice(1)}</b><span>${n(b[k], 1)}% of the time</span>"></span>`).join("");
    const x = q.extremes || {};
    const tiles = [
      ["Highest", x.vmax != null ? `${n(x.vmax)}<small>V</small>` : "-", x.vmax_at ? when(x.vmax_at) : ""],
      ["Lowest", x.vmin != null ? `${n(x.vmin)}<small>V</small>` : "-", x.vmin_at ? when(x.vmin_at) : ""],
      ["Frequency", x.hzmin != null ? `${n(x.hzmin, 1)}-${n(x.hzmax, 1)}<small>Hz</small>` : "-", ""],
      ["Peak power", x.wmax != null ? `${n(x.wmax / 1000, 2)}<small>kW</small>` : "-", x.wmax_at ? when(x.wmax_at) : ""],
      ["Hottest breaker", x.tmax != null ? `${n(x.tmax)}<small>°C</small>` : "-", ""],
      ["Episodes", n(q.events.length), "High or low voltage spells"],
    ];
    $("q-tiles").innerHTML = tiles.map(([l, v, sub]) => `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${esc(sub || " ")}</div></div>`).join("");
    const pts = q.points, span = now - lo, r = s.readings || {};
    const xy = (k, f = (v) => v) => {
      const out = [];
      pts.filter((p) => p[k] != null).forEach((p, i, a) => {
        if (i && p.t - a[i - 1].t > q.group * 3) out.push({ x: a[i - 1].t + q.group, y: null });  // a power cut: break the line
        out.push({ x: p.t, y: f(p[k]) });
      });
      return out;
    };
    const cutLine = (v, label) => (v ? [line(label, [{ x: lo, y: v }, { x: now, y: v }], css("--critical"), { borderDash: [6, 4], borderWidth: 1.5 })] : []);
    chart("q-volt", {
      type: "line",
      data: { datasets: [
        line("Highest", xy("v_max"), `color-mix(in srgb, ${css("--series-1")} 50%, transparent)`, { borderWidth: 1, fill: "+1", backgroundColor: `color-mix(in srgb, ${css("--series-1")} 14%, transparent)` }),
        line("Lowest", xy("v_min"), `color-mix(in srgb, ${css("--series-1")} 50%, transparent)`, { borderWidth: 1 }),
        line("Average", xy("v_avg"), css("--series-1")),
        ...cutLine(r.over_v, "Over-voltage cut-off"), ...cutLine(r.low_v, "Low-voltage cut-off"),
      ] },
      options: { ...opts({ span, yTitle: "V", legend: true }), scales: { ...opts({ span }).scales, x: { ...opts({ span }).scales.x, min: lo, max: now } } },
    });
    const small = (id, sets, yTitle, extra) => chart(id, { type: "line", data: { datasets: sets }, options: { ...opts({ span, yTitle, ...extra }), scales: { ...opts({ span, ...extra }).scales, x: { ...opts({ span }).scales.x, min: lo, max: now } } } });
    small("q-power", [line("Average", xy("w_avg", (v) => v / 1000), css("--series-2"), { fill: true, backgroundColor: `color-mix(in srgb, ${css("--series-2")} 15%, transparent)` }), line("Peak", xy("w_max", (v) => v / 1000), `color-mix(in srgb, ${css("--series-2")} 45%, transparent)`, { borderWidth: 1 })], "kW", { yMin: 0 });
    small("q-hz", [line("Lowest", xy("hz_min"), css("--warning"), { borderWidth: 1.5 }), line("Highest", xy("hz_max"), css("--series-1"), { borderWidth: 1.5 })], "Hz");
    small("q-pf", [line("Power factor", xy("pf"), css("--good"))], "%", { yMax: 100 });
    small("q-temp", [line("Breaker", xy("t_max"), css("--serious")), ...cutLine(r.over_t, "Cut-off")], "°C");
    renderEvents($("q-events"), q.events.map((e) => ({ ...e, kind: "voltage" })), "No high or low voltage spells in this range.");
    loaded.quality = true;
  };

  // ============================================================== APPLIANCES
  loaders.appliances = async () => {
    const a = await api("api/appliances");
    const apps = a.appliances.filter((x) => x.runs > 0);
    const top = apps[0];
    const tiles = [
      ["Always-on load", a.base_w != null ? `${n(a.base_w)}<small>W</small>` : "-", a.base_cost_month != null ? `${money(a.base_cost_month)} a month, day and night` : "Needs a few days of data"],
      ["Big loads found", n(apps.length), "Switching on and off as one step"],
      ["Biggest user", top ? esc(top.name || `${n(top.watts / 1000, 1)} kW load`) : "-", top ? `${n(top.kwh, 1)} kWh, ${money(top.cost)} in 30 days` : ""],
      ["Price per unit", money(a.rate, 2), "Average this month, with VAT"],
    ];
    $("ap-tiles").innerHTML = tiles.map(([l, v, sub]) => `<div class="tile"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${sub || "&nbsp;"}</div></div>`).join("");
    $("ap-rows").innerHTML = apps.length ? apps.map((x) => {
      const max = Math.max(1, ...x.hours);
      return `<tr><td><input class="ap-name ${x.name ? "" : "unnamed"}" data-ap="${x.id}" value="${esc(x.name || "")}" placeholder="Unnamed ${n(x.watts / 1000, 1)} kW load" aria-label="Name"></td>
        <td class="num">${n(x.watts / 1000, 2)} kW</td><td class="num">${n(x.runs)}</td><td class="num">${dur(x.secs)}</td><td class="num">${n(x.kwh, 1)} kWh</td><td class="num">${money(x.cost)}</td>
        <td><span class="hours" data-tip="<b>When it runs</b><span>Starts per hour of the day</span>">${x.hours.map((h) => `<i style="height:${(100 * h) / max}%"></i>`).join("")}</span></td>
        <td><button class="linkbtn" data-ap-del="${x.id}">Remove</button></td></tr>`;
    }).join("") : '<tr><td colspan="8" class="muted">No big loads spotted yet. They show up after they switch on and off a few times.</td></tr>';
    $("ap-runs").innerHTML = a.runs.length ? a.runs.map((r) => `<li class="k-off"><span class="ev-when">${esc(when(r.start))}</span>
      <span class="ev-what"><b>${esc(r.name || `${n(r.watts / 1000, 1)} kW load`)}</b><span>${n(r.watts)} W, ${n(r.kwh, 2)} kWh</span></span>
      <span class="ev-len">${dur(r.end - r.start)}</span></li>`).join("") : '<li class="empty-li">No runs yet.</li>';
    loaded.appliances = true;
  };
  $("ap-rows").addEventListener("change", async (e) => {
    const i = e.target.closest("[data-ap]");
    if (!i) return;
    await post("api/appliances/rename", { id: Number(i.dataset.ap), name: i.value });
    i.classList.toggle("unnamed", !i.value);
  });
  $("ap-rows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ap-del]");
    if (!b || !(await confirmBox("Remove this load?", "Its runs are deleted too. If it keeps switching on and off it will be found again.", "Remove"))) return;
    await post("api/appliances/delete", { id: Number(b.dataset.apDel) });
    loaders.appliances();
  });

  // ============================================================== ALERTS
  const KIND_LABEL = {
    power_cut: "Power cut", power_back: "Power back", trip: "Breaker tripped", stayed_off: "Stayed off after power returned",
    breaker_on: "Breaker back on", voltage: "Voltage near a cut-off", temperature: "Breaker getting hot",
    balance: "Low prepaid balance", slab: "Price slab warnings",
  };
  let repKind = "weekly";
  chips("rep-kind", (d) => { repKind = d.k; loadReport(); });
  const waFormat = (t) => esc(t).replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>").replace(/_([^_\n]+)_/g, "<em>$1</em>");
  async function loadReport() {
    const lastMonth = (() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 7); })();
    const r = await api(`api/report?kind=${repKind}${repKind === "monthly" ? `&month=${lastMonth}` : ""}`);
    $("rep-text").innerHTML = waFormat(r.text);
  }
  $("rep-send").addEventListener("click", async () => {
    const lastMonth = (() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 7); })();
    const r = await post("api/report/send", { kind: repKind, month: lastMonth });
    $("al-test-note").textContent = r.ok ? "Report sent on WhatsApp." : r.body.error || "Not sent";
  });
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-test]");
    if (!b) return;
    const r = await post("api/test/alert", { channel: b.dataset.test });
    $("al-test-note").textContent = r.ok ? `Test sent to ${b.textContent.replace("Test ", "")}.` : r.body.error || "Not sent";
  });
  loaders.alerts = async () => {
    const [set, rows] = await Promise.all([api("api/settings"), api("api/alerts")]);
    const v = set.values;
    const yes = (k, ch) => (v[`alerts_${ch}`] || []).includes(k);
    $("al-matrix").innerHTML = `<table><thead><tr><th>Alert</th><th>Alexa</th><th>Phone</th><th>WhatsApp</th></tr></thead><tbody>${
      set.alert_kinds.map((k) => `<tr><td>${esc(KIND_LABEL[k] || k)}</td>${["alexa", "phone", "whatsapp"].map((ch) => `<td class="${yes(k, ch) ? "yes" : "no"}">${yes(k, ch) ? "On" : "Off"}</td>`).join("")}</tr>`).join("")
    }</tbody></table>
      <p class="small muted">Alexa: ${v.alexa_entities.length ? esc(v.alexa_entities.join(", ")) : "no Echo selected"}. Phone: ${esc(v.notify_service || "not set")}. WhatsApp: ${esc(v.whatsapp_to || "not set")}.</p>`;
    $("al-rows").innerHTML = rows.length ? rows.map((r) => `<li class="k-${["trip", "stayed_off", "power_cut"].includes(r.kind) ? "trip" : "off"}"><span class="ev-when">${esc(when(r.ts))}</span>
      <span class="ev-what"><b>${esc(KIND_LABEL[r.kind] || r.kind)}</b><span>${esc(r.text || "")}</span></span>
      <span class="small muted">${esc(r.channels ? r.channels.replace(/,/g, ", ") : "not sent")}</span></li>`).join("") : '<li class="empty-li">No alerts yet.</li>';
    loadReport();
    loaded.alerts = true;
  };

  // ============================================================== SETTINGS
  const HOURS = Array.from({ length: 24 }, (_, h) => [h, hourLabel(h)]);
  const SETTINGS_UI = [
    { id: "detect", title: "Detection", note: "How power cuts and readings are judged.", fields: [
      { key: "min_outage_seconds", label: "Power cut after", type: "number", unit: "seconds", help: "The breaker has to be silent this long. Your router's daily reboot at 04:01 takes about 30 seconds, so keep this above 60." },
      { key: "nominal_voltage", label: "Normal voltage", type: "number", unit: "V" },
      { key: "voltage_offset", label: "Voltage correction", type: "number", unit: "V", step: 0.1, help: "Added to every reading, if the breaker reads high or low against a trusted meter." },
      { key: "energy_calibration_percent", label: "Energy correction", type: "number", unit: "%", step: 0.1, help: "If the prepaid meter counts more units than the breaker, e.g. 2 for +2%." },
      { key: "appliance_min_watts", label: "Smallest appliance step", type: "number", unit: "W" },
      { key: "breaker_prefix", label: "Breaker entity name", type: "text", help: "The part after switch. in the breaker's entity, e.g. energy_meter. Changing it restarts the add-on." },
      { key: "retention_days", label: "Keep minute readings for", type: "number", unit: "days", help: "Power cuts, trips and hourly energy are kept forever." },
    ] },
    { id: "restore", title: "Breaker staying off", note: "When the power comes back but the breaker doesn't, or it trips on bad voltage.", fields: [
      { key: "auto_restore", label: "Turn it back on automatically", type: "bool", help: "Only after a power cut or a voltage trip, once the voltage has been steady. Never after over-current, over-power or temperature trips." },
      { key: "auto_restore_delay_seconds", label: "Steady voltage for", type: "number", unit: "seconds" },
      { key: "repeat_minutes", label: "Remind every", type: "number", unit: "minutes", help: "While the breaker stays off after a trip." },
      { key: "repeat_max", label: "Reminders at most", type: "number" },
    ] },
    { id: "alerts", title: "Alerts", note: "Which alerts go where.", fields: [
      { key: "alerts_matrix", label: "Alerts", type: "matrix" },
      { key: "voltage_warn_margin", label: "Warn when voltage is within", type: "number", unit: "V of a cut-off" },
      { key: "temperature_warn_margin", label: "Warn when temperature is within", type: "number", unit: "°C of the cut-off" },
    ] },
    { id: "alexa", title: "Alexa", fields: [
      { key: "alexa_entities", label: "Echo devices", type: "players" },
      { key: "alexa_volume", label: "Announcement volume", type: "range" },
      { key: "alexa_quiet_hours", label: "Quiet hours", type: "windows" },
      { key: "critical_ignores_quiet_hours", label: "Trips still announced in quiet hours", type: "bool" },
      { key: "offline_tts_service", label: "Phone speaks if no Echo answers", type: "notify", help: "During a power cut your Echo may be unpowered. This phone (Home Assistant app) reads the alert aloud instead." },
    ] },
    { id: "phone", title: "Phone", fields: [
      { key: "notify_service", label: "Notification service", type: "notify" },
    ] },
    { id: "whatsapp", title: "WhatsApp and reports", note: "Through the PDC WhatsApp Bridge add-on.", fields: [
      { key: "whatsapp_to", label: "Send to", type: "text", placeholder: "+8801XXXXXXXXX" },
      { key: "whatsapp_api_token", label: "Bridge token", type: "password" },
      { key: "whatsapp_bridge_url", label: "Bridge address", type: "text", help: "Leave empty to find it automatically." },
      { key: "daily_report_enabled", label: "Daily report", type: "bool" },
      { key: "daily_report_hour", label: "Daily report at", type: "hour" },
      { key: "weekly_report_enabled", label: "Weekly report", type: "bool" },
      { key: "weekly_report_day", label: "Weekly report on", type: "select", options: [["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]] },
      { key: "weekly_report_hour", label: "Weekly report at", type: "hour" },
      { key: "monthly_report_enabled", label: "Monthly report (on the 1st)", type: "bool" },
      { key: "monthly_report_hour", label: "Monthly report at", type: "hour" },
    ] },
    { id: "tariff", title: "Tariff and prepaid", note: "BERC residential rates from June 2026, the same for Palli Bidyut. Check your meter card for the sanctioned load.", fields: [
      { key: "tariff_slabs", label: "Price slabs", type: "lines", help: "One per line: units up to : price per unit. 0 means everything above, e.g. 0:17.35." },
      { key: "lifeline_units", label: "Lifeline up to", type: "number", unit: "units" },
      { key: "lifeline_rate", label: "Lifeline rate", type: "number", step: 0.01, unitKey: "currency" },
      { key: "sanctioned_load_kw", label: "Sanctioned load", type: "number", step: 0.5, unit: "kW" },
      { key: "demand_charge_per_kw", label: "Demand charge", type: "number", step: 0.01, unit: "per kW a month" },
      { key: "meter_rent", label: "Meter rent", type: "number", unitKey: "currency" },
      { key: "vat_percent", label: "VAT", type: "number", step: 0.1, unit: "%" },
      { key: "prepaid_rebate_percent", label: "Prepaid rebate", type: "number", step: 0.1, unit: "%" },
      { key: "currency", label: "Currency", type: "text", short: true },
      { key: "low_balance_alert", label: "Low balance alert below", type: "number", unitKey: "currency" },
      { key: "low_balance_days", label: "Or when fewer than", type: "number", unit: "days are left" },
      { key: "slab_alerts", label: "Price slab warnings", type: "bool" },
      { key: "slab_warn_units", label: "Warn this many units before a slab", type: "number", unit: "units" },
    ] },
  ];
  const MATRIX_KEYS = ["alerts_alexa", "alerts_phone", "alerts_whatsapp"];
  const FIELDS = SETTINGS_UI.flatMap((s) => s.fields).flatMap((f) => (f.type === "matrix" ? MATRIX_KEYS.map((k) => ({ key: k, type: "matrixcol" })) : [f]));
  let settingsData = null, settingsOriginal = {};

  function fieldControl(f, v) {
    const id = `set-${f.key}`, val = esc(v ?? "");
    const opt = (list, cur) => list.map(([k, l]) => `<option value="${esc(k)}"${String(k) === String(cur) ? " selected" : ""}>${esc(l)}</option>`).join("");
    switch (f.type) {
      case "number": {
        const unit = f.unitKey ? esc(settingsData.values[f.unitKey]) : esc(f.unit || "");
        return `<div class="with-unit"><input type="number" id="${id}" value="${val}" step="${f.step || 1}">${unit ? `<span class="unit">${unit}</span>` : ""}</div>`;
      }
      case "text": return `<input type="text" id="${id}" value="${val}" placeholder="${esc(f.placeholder || "")}"${f.short ? ' class="short"' : ""}>`;
      case "password": return `<input type="password" id="${id}" value="" autocomplete="off" placeholder="${settingsData.secrets_set[f.key] ? "Saved. Type a new one to replace it" : "Not set"}">`;
      case "bool": return `<label class="switch"><input type="checkbox" id="${id}"${v ? " checked" : ""}><span></span></label>`;
      case "select": return `<select id="${id}">${opt(f.options, v)}</select>`;
      case "hour": return `<select id="${id}">${opt(HOURS, v)}</select>`;
      case "range": return `<div class="range"><input type="range" id="${id}" min="0" max="100" step="5" value="${val}"><output for="${id}">${val}%</output></div>`;
      case "players": return `<div class="checks" id="${id}">${settingsData.media_players.map((p) =>
        `<label><input type="checkbox" value="${esc(p.id)}"${(v || []).includes(p.id) ? " checked" : ""}> ${esc(p.name)} <span class="muted small">${esc(p.id)}</span></label>`).join("") || '<span class="muted">No media players found</span>'}</div>`;
      case "notify": return `<input type="text" id="${id}" value="${val}" list="notify-list" placeholder="notify.mobile_app_...">`;
      case "lines": return `<textarea id="${id}" spellcheck="false">${esc((v || []).join("\n"))}</textarea>`;
      case "windows": return `<div class="windows" id="${id}">${(v || []).map(winRow).join("")}<button type="button" class="btn ghost add">+ Add a time window</button></div>`;
      case "matrix": return `<div class="matrix"><table><thead><tr><th>Alert</th><th>Alexa</th><th>Phone</th><th>WhatsApp</th></tr></thead><tbody>${
        settingsData.alert_kinds.map((k) => `<tr><td>${esc(KIND_LABEL[k] || k)}</td>${MATRIX_KEYS.map((mk) =>
          `<td><input type="checkbox" data-mk="${mk}" value="${k}"${(settingsData.values[mk] || []).includes(k) ? " checked" : ""} aria-label="${esc(`${KIND_LABEL[k]} on ${mk.split("_")[1]}`)}"></td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    return "";
  }
  function winRow(spec) {
    const [a, b] = String(spec || "00:00-07:00").split("-").map((t) => t.trim().padStart(5, "0"));
    return `<div class="win"><input type="time" value="${esc(a)}"> to <input type="time" value="${esc(b)}"><button type="button" class="btn ghost" aria-label="Remove">Remove</button></div>`;
  }
  function fieldValue(f) {
    if (f.type === "matrixcol") return settingsData.alert_kinds.filter((k) => document.querySelector(`[data-mk="${f.key}"][value="${k}"]`).checked);
    const el = $(`set-${f.key}`);
    switch (f.type) {
      case "number": return el.value === "" ? "" : Number(el.value);
      case "bool": return el.checked;
      case "hour": case "range": return Number(el.value);
      case "players": return [...el.querySelectorAll("input:checked")].map((c) => c.value);
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
  function settingsStatus(text, cls) {
    const st = $("settings-status");
    st.className = `small ${cls || ""}`;
    st.textContent = text;
  }
  function settingsDirty() {
    const c = Object.keys(settingsChanges()).length;
    $("settings-save").disabled = !c;
    if (!$("settings-status").classList.contains("bad")) settingsStatus(c ? `${c} unsaved change${c > 1 ? "s" : ""}` : "");
  }
  async function openSettings(section) {
    settingsStatus("");
    $("settings-body").innerHTML = '<p class="muted">Loading...</p>';
    $("settings").showModal();
    try { settingsData = await api("api/settings"); } catch (e) {
      $("settings-body").innerHTML = '<p class="muted">Couldn\'t load the settings.</p>';
      return;
    }
    settingsOriginal = JSON.parse(JSON.stringify(settingsData.values));
    $("settings-nav").innerHTML = SETTINGS_UI.map((s) => `<a href="#sec-${s.id}">${esc(s.title)}</a>`).join("");
    $("settings-body").innerHTML = `<datalist id="notify-list">${settingsData.notify_services.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`
      + SETTINGS_UI.map((s) => `<fieldset id="sec-${s.id}"><legend>${esc(s.title)}</legend>${s.note ? `<p class="small muted section-note">${esc(s.note)}</p>` : ""}
        ${s.fields.map((f) => `<div class="field" data-key="${f.key}">
          ${["players", "windows", "bool", "matrix"].includes(f.type) ? `<span class="label">${esc(f.label)}</span>` : `<label for="set-${f.key}">${esc(f.label)}</label>`}
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
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-open-settings]"); if (b) openSettings(b.dataset.openSettings); });
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
    settingsStatus("Saving...");
    const r = await post("api/settings", changes);
    if (!r.ok) {
      Object.entries(r.body.errors || {}).forEach(([k, msg]) => {
        const field = document.querySelector(`.field[data-key="${k}"]`) || document.querySelector('.field[data-key="alerts_matrix"]');
        if (!field) return;
        field.classList.add("invalid");
        const err = field.querySelector(".err");
        err.textContent = `This ${msg}.`.replace("This “", "“");
        err.hidden = false;
      });
      const first = document.querySelector(".field.invalid");
      if (first) first.scrollIntoView({ block: "center" });
      settingsStatus(r.body.error || "Some settings need fixing.", "bad");
      $("settings-save").disabled = false;
      return;
    }
    settingsStatus(r.body.restart ? "Saved. Restarting the add-on..." : "Saved.", "good");
    settingsOriginal = JSON.parse(JSON.stringify({ ...settingsOriginal, ...changes }));
    setTimeout(() => { $("settings").close(); refreshAll(); }, r.body.restart ? 8000 : 700);
  });

  // ------------------------------------------------------------------ polling
  function refreshAll() {
    loaders[tab]().catch((e) => console.error(e));
  }
  setInterval(() => {
    if (document.hidden) return;
    if (tab === "live") loaders.live().catch(() => { $("foot").textContent = "Can't reach the add-on. Retrying..."; });
  }, 5000);
  setInterval(() => { if (!document.hidden && tab !== "live") api("api/status").then((s) => {
    status = s;
    const badge = document.querySelector('#tabs [data-tab="live"]');
    badge.innerHTML = `Live${["trip", "outage", "off"].includes(s.state) ? '<i class="badge" aria-label="needs attention"></i>' : ""}`;
  }).catch(() => {}); }, 30000);
  setInterval(() => { if (!document.hidden && tab === "live") loadStrip().catch(() => {}); }, 60000);
  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-goto][role=button]")) { e.preventDefault(); setTab(e.target.dataset.goto); }
  });

  osDark.addEventListener("change", () => applyTheme());
  setInterval(() => applyTheme(), 3000);
  applyTheme(true);
  setTab(location.hash.slice(1) || "live");
  window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (t !== tab) setTab(t); });
})();
