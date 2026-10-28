/* Electricity Monitor dashboard. Times are shown in the viewer's local time zone. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const api = async (path) => {
    const r = await fetch(path);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `${path.split("?")[0]}: ${r.status}`);
    }
    return r.json();
  };
  const post = async (path, body) => {
    try {
      const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
    } catch (e) {
      return { ok: false, status: 0, body: { error: "Can't reach the add-on." } };
    }
  };
  const root = $("root");
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NOW = () => Date.now() / 1000;
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(`emon.${k}`)) ?? d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(`emon.${k}`, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // ---------------------------------------------------------------- formatting
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const hFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const dFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const dShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const dYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  const mFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const mShort = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
  const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const time = (ts) => tFmt.format(ts * 1000);
  const hourLabel = (h) => hFmt.format(new Date(2026, 0, 1, h));
  const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  const when = (ts) => {
    if (!ts) return "-";
    if (sameDay(ts, NOW())) return `Today ${time(ts)}`;
    if (sameDay(ts, NOW() - 86400)) return `Yesterday ${time(ts)}`;
    return `${dFmt.format(ts * 1000)}, ${time(ts)}`;
  };
  const dayName = (ts) => (sameDay(ts, NOW()) ? "Today" : sameDay(ts, NOW() - 86400) ? "Yesterday" : dFmt.format(ts * 1000));
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
  const money = (v, d = 0) => (v == null || Number.isNaN(v) ? "-" : `${v < 0 ? "-" : ""}${CUR}${n(Math.abs(v), d)}`);
  const toLocalInput = (ts) => {
    const d = new Date(ts * 1000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const toDateInput = (ts) => toLocalInput(ts).slice(0, 10);
  const fromLocalInput = (v) => new Date(v).getTime() / 1000;
  const startOfDay = (ts) => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  const ymOf = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const monthLabel = (ym) => mFmt.format(new Date(`${ym}-15T12:00:00`));
  const pctChange = (a, b) => (b > 0 ? (100 * (a - b)) / b : null);
  const deltaHtml = (a, b, label) => {
    const p = pctChange(a, b);
    if (p == null) return "";
    const r = Math.round(p);
    if (r === 0) return `About the same as ${esc(label)}`;
    const cls = r > 3 ? "delta-up" : r < -3 ? "delta-down" : "";
    return `<span class="${cls}">${r > 0 ? "+" : ""}${r}%</span> vs ${esc(label)}`;
  };

  // ------------------------------------------------------------------- toasts
  function toast(text, kind) {
    const el = document.createElement("div");
    el.className = `toast ${kind || ""}`;
    el.textContent = text;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "bad" ? 7000 : 4000);
  }

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
    if (loaded[tab]) refreshAll();
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
  const axisTime = (span) => (v) => (span > 2 * 86400 ? dShort.format(v * 1000) : time(v));
  function opts({ span, yTitle, legend, yMin, yMax, xType = "linear", stacked }) {
    const grid = css("--grid"), tick = css("--text-muted");
    return {
      responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 450 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: !!legend, labels: { color: css("--text-secondary"), boxWidth: 12, boxHeight: 3 } },
        tooltip: {
          backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"),
          borderColor: css("--axis"), borderWidth: 1, cornerRadius: 0,
          callbacks: xType === "linear" ? { title: (items) => (items.length ? when(items[0].parsed.x) : "") } : {},
        },
      },
      scales: {
        x: {
          type: xType, stacked, grid: { color: grid, drawTicks: false }, border: { color: css("--axis") },
          ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 10,
            callback: xType === "linear" ? axisTime(span) : function (v) { return this.getLabelForValue(v); } },
        },
        y: {
          stacked, grid: { color: grid, drawTicks: false }, border: { display: false }, min: yMin, max: yMax,
          ticks: { color: tick, maxTicksLimit: 6 }, title: yTitle ? { display: true, text: yTitle, color: tick } : undefined,
        },
      },
    };
  }
  const line = (label, data, color, extra) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.2, ...extra });
  const fade = (c, p) => `color-mix(in srgb, ${c} ${p}%, transparent)`;

  // ---------------------------------------------------------------- periods
  // A period is [lo, hi) in seconds. Calendar presets step by their unit; rolling ones by their length.
  const DAY = 86400;
  const at = (y, m, d) => new Date(y, m, d).getTime() / 1000;
  function calRange(unit, off) {
    const now = new Date();
    if (unit === "day") return [at(now.getFullYear(), now.getMonth(), now.getDate() + off), at(now.getFullYear(), now.getMonth(), now.getDate() + off + 1)];
    if (unit === "week") {
      const back = (now.getDay() + 6) % 7;
      const s = at(now.getFullYear(), now.getMonth(), now.getDate() - back + 7 * off);
      const d = new Date(s * 1000);
      return [s, at(d.getFullYear(), d.getMonth(), d.getDate() + 7)];
    }
    if (unit === "month") return [at(now.getFullYear(), now.getMonth() + off, 1), at(now.getFullYear(), now.getMonth() + off + 1, 1)];
    return [at(now.getFullYear() + off, 0, 1), at(now.getFullYear() + off + 1, 0, 1)];
  }
  const PRESETS = {
    today: { label: "Today", unit: "day", base: 0 },
    yesterday: { label: "Yesterday", unit: "day", base: -1 },
    week: { label: "This week", unit: "week", base: 0 },
    last_week: { label: "Last week", unit: "week", base: -1 },
    month: { label: "This month", unit: "month", base: 0 },
    last_month: { label: "Last month", unit: "month", base: -1 },
    d7: { label: "7 days", days: 7 },
    d30: { label: "30 days", days: 30 },
    d90: { label: "90 days", days: 90 },
    year: { label: "This year", unit: "year", base: 0 },
    custom: { label: "Custom" },
  };
  function periodLabel(lo, hi, unit) {
    const last = hi - 1;
    if (unit === "day") return dayName(lo);
    if (unit === "month") return mFmt.format(lo * 1000);
    if (unit === "year") return String(new Date(lo * 1000).getFullYear());
    if (sameDay(lo, last)) return dayName(lo);
    const sameYear = new Date(lo * 1000).getFullYear() === new Date(last * 1000).getFullYear();
    return `${(sameYear ? dShort : dYear).format(lo * 1000)} - ${dYear.format(Math.min(last, NOW()) * 1000)}`;
  }

  function periodPicker(el, { presets, initial, key, onChange }) {
    const saved = store.get(`period.${key}`, null);
    const st = saved && presets.includes(saved.p) ? saved : { p: initial, off: 0 };
    el.innerHTML = `<div class="chips" role="radiogroup" aria-label="Period">${presets.map((p) =>
      `<button class="chip" role="radio" data-p="${p}">${esc(PRESETS[p].label)}</button>`).join("")}</div>
      <div class="period-step">
        <button class="btn ghost icon-btn" data-step="-1" aria-label="Earlier"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
        <span class="period-label" aria-live="polite"></span>
        <button class="btn ghost icon-btn" data-step="1" aria-label="Later"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
      <div class="period-custom" hidden>
        <input type="date" aria-label="From" data-c="from"> to <input type="date" aria-label="To" data-c="to">
        <button class="btn ghost small-btn" data-apply><span>Show</span></button>
      </div>`;
    const range = () => {
      const P = PRESETS[st.p];
      if (st.p === "custom") return [st.lo, st.hi];
      if (P.days) { const hi = NOW() + st.off * P.days * DAY; return [hi - P.days * DAY, hi]; }
      return calRange(P.unit, P.base + st.off);
    };
    const previous = () => {
      const [lo, hi] = range(), P = PRESETS[st.p];
      if (P.unit && st.p !== "custom") return calRange(P.unit, P.base + st.off - 1);
      return [lo - (hi - lo), lo];
    };
    function paint() {
      if (st.p === "custom" && !st.lo) { st.lo = startOfDay(NOW()) - 29 * DAY; st.hi = startOfDay(NOW()) + DAY; }
      const [lo, hi] = range(), P = PRESETS[st.p];
      el.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-checked", String(c.dataset.p === st.p)));
      el.querySelector(".period-label").textContent = periodLabel(lo, hi, P.unit);
      el.querySelector('[data-step="1"]').disabled = hi > NOW();
      const custom = el.querySelector(".period-custom");
      custom.hidden = st.p !== "custom";
      if (st.p === "custom") {
        custom.querySelector('[data-c="from"]').value = toDateInput(st.lo);
        custom.querySelector('[data-c="to"]').value = toDateInput(st.hi - 1);
      }
      store.set(`period.${key}`, st);
    }
    el.addEventListener("click", (e) => {
      const c = e.target.closest(".chip"), s = e.target.closest("[data-step]"), a = e.target.closest("[data-apply]");
      if (c) { st.p = c.dataset.p; st.off = 0; }
      else if (s) {
        const k = Number(s.dataset.step);
        if (st.p === "custom") { const span = st.hi - st.lo; st.lo += k * span; st.hi += k * span; } else st.off += k;
      } else if (a) {
        const f = el.querySelector('[data-c="from"]').value, t = el.querySelector('[data-c="to"]').value;
        if (!f || !t) return;
        let lo = fromLocalInput(`${f}T00:00`), hi = fromLocalInput(`${t}T00:00`) + DAY;
        if (hi <= lo) [lo, hi] = [hi - DAY, lo + DAY];
        st.lo = lo; st.hi = hi;
      } else return;
      paint();
      onChange();
    });
    paint();
    return {
      range, previous, get preset() { return st.p; }, get unit() { return PRESETS[st.p].unit; },
      setMonth(ym) { // jump to a calendar month
        const [y, m] = ym.split("-").map(Number), now = new Date();
        st.p = "month"; st.off = (y - now.getFullYear()) * 12 + (m - 1 - now.getMonth());
        paint();
      },
    };
  }

  // ------------------------------------------------------------------- tabs
  const loaders = {}, loaded = {};
  let tab = "live";
  async function run(t) {
    const page = $(`page-${t}`);
    page.setAttribute("aria-busy", "true");
    try { await loaders[t](); loaded[t] = true; } catch (e) {
      console.error(e);
      toast(`Couldn't load this page: ${e.message}`, "bad");
    } finally { page.removeAttribute("aria-busy"); }
  }
  function setTab(t) {
    if (!loaders[t]) t = "live";
    tab = t;
    document.querySelectorAll("#tabs [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    document.querySelectorAll(".page").forEach((p) => { p.hidden = p.id !== `page-${t}`; });
    if (location.hash !== `#${t}`) history.replaceState(null, "", `#${t}`);
    hideTip();
    run(t);
  }
  const refreshAll = () => run(tab);
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("[role=tab]"); if (b) setTab(b.dataset.tab); });
  $("tabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const tabs = [...document.querySelectorAll("#tabs [role=tab]")];
    const i = tabs.findIndex((b) => b.dataset.tab === tab) + (e.key === "ArrowRight" ? 1 : -1);
    const b = tabs[(i + tabs.length) % tabs.length];
    b.focus();
    setTab(b.dataset.tab);
  });
  root.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) { e.preventDefault(); setTab(g.dataset.goto); scrollTo({ top: 0 }); } });
  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-goto][role=button]")) { e.preventDefault(); setTab(e.target.dataset.goto); }
  });

  function chips(id, onPick) {
    $(id).addEventListener("click", (e) => {
      const c = e.target.closest(".chip, .seg button");
      if (!c || c.disabled) return;
      $(id).querySelectorAll(".chip, .seg button").forEach((x) => x.setAttribute("aria-checked", String(x === c)));
      onPick(c.dataset);
    });
  }
  const pick = (id, attr, value) => $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x.dataset[attr] === value)));

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
    toast(r.ok ? { on: "Breaker switched on", off: "Breaker switched off", clear_flag: "Trip flag cleared", set_limit: "Limit saved on the breaker" }[action] : r.body.error || "Home Assistant didn't accept that.", r.ok ? "" : "bad");
    setTimeout(() => { refreshAll(); refreshStatus(); }, 1500);
    return r.ok;
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-control]"); if (b) control(b.dataset.control); });

  // ============================================================== STATUS + BANNER
  let status = null, oddsCache = null, oddsAt = 0;
  async function refreshStatus() {
    status = await api("api/status");
    CUR = status.currency || CUR;
    renderBanner();
    return status;
  }
  function renderBanner() {
    const s = status, b = $("banner");
    let html = "", cls = "";
    const ev = s.off_event;
    if (!s.ha_connected) {
      cls = "warn";
      html = `<b>Home Assistant isn't connected</b><span>Readings are paused; anything missed is caught up when it's back.</span>`;
    } else if (s.state === "trip" || (s.state === "off" && ev && !["ha_user", "automation", "addon"].includes(ev.cause))) {
      html = `<b>${ev && ev.cause === "stayed_off" ? "Breaker stayed off" : "Breaker is off"}</b><span>${esc(ev ? `${ev.cause_text || ""}. Since ${when(ev.start)}.` : "")}</span>
        <button class="btn primary" data-control="on"><span>Turn on</span></button>`;
    } else if (s.state === "outage") {
      html = `<b>Power cut</b><span>Since ${esc(when(s.since))} (${dur(NOW() - s.since)}). The add-on keeps watching and tells you when it's back.</span>`;
    } else if (s.prepaid && s.prepaid.balance != null && s.prepaid.balance <= s.prepaid.low_alert) {
      cls = "warn";
      html = s.prepaid.balance <= 0
        ? `<b>Balance may have run out</b><span>By the estimate the meter is empty. If the power is still on, check the meter and set the balance.</span>`
        : `<b>Recharge soon</b><span>About ${money(s.prepaid.balance)} left on the meter${s.prepaid.days_left != null ? `, ${n(s.prepaid.days_left, 1)} days at your usage` : ""}.</span>`;
      html += `<button class="btn ghost" data-goto="prepaid"><span>Prepaid</span></button>`;
    }
    b.className = `banner ${cls}`;
    b.innerHTML = html;
    b.hidden = !html;
    const live = document.querySelector('#tabs [data-tab="live"]');
    live.innerHTML = `Live${["trip", "outage"].includes(s.state) ? '<i class="badge" aria-label="needs attention"></i>' : ""}`;
  }

  // ============================================================== LIVE
  const STATE_TEXT = {
    on: ["Power on", "Everything is normal."],
    outage: ["Power cut", "The breaker went silent and isn't metering: load shedding or a supply fault."],
    offline: ["Breaker offline", ""],
    trip: ["Breaker tripped", ""],
    off: ["Breaker off", ""],
    unknown: ["Not connected", "Can't reach Home Assistant right now. Events are caught up when it's back."],
  };
  function stateLines(s) {
    const st = s.state, ev = s.off_event, p = s.prediction;
    let title = "", text = STATE_TEXT[st][1], level = st === "on" ? "" : "lv-bad";
    if (st === "on") {
      title = s.last_outage && s.last_outage.end ? `Last power cut ${when(s.last_outage.end)}` : "No power cuts recorded yet";
      if (p && p.next) text = `Cuts have often come around ${hourLabel(p.next.hour)} lately (${Math.round(p.next.chance * 100)}% of days).`;
    } else if (st === "outage") {
      title = "Load shedding";
      if (s.last_outage && s.last_outage.data && s.last_outage.data.v_before) text += ` Voltage just before: ${n(s.last_outage.data.v_before)} V.`;
    } else if (st === "offline") {
      title = "Waiting to see if it's a power cut";
      text = `The breaker stopped answering. If it's still silent after ${dur(s.min_outage_s)}, it counts as a power cut; if it comes back still metering, it was only Wi-Fi.`;
      level = "lv-warn";
    } else if (st === "trip" || st === "off") {
      title = ev ? ev.cause_text || "Switched off" : "Switched off";
      text = ev ? ev.detail || "" : "";
      if (ev && ev.cause === "stayed_off" && s.auto_restore) text += " It will be switched back on automatically once the voltage is steady.";
      level = st === "trip" ? "lv-bad" : "lv-warn";
    }
    return { title, text, level };
  }

  function renderLive() {
    const s = status, st = s.state;
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

    const r = s.readings || {}, online = s.avail && s.ha_connected;
    countUp($("m-power"), online ? r.power : null, (v) => n(v));
    $("m-power-note").textContent = online && r.power != null && r.power > 0 ? `About ${money((r.power / 1000) * s.unit_price, 1)} an hour at this load` : st === "outage" ? "No power from the grid" : "";
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
      { label: "Used today", value: `${n(c.today, 1)}<small>kWh</small>`, sub: deltaHtml(c.today, c.yesterday_same, "this time yesterday"), goto: "usage" },
      { label: "Cost today", value: money(c.today_cost), sub: `Yesterday ${money(c.yesterday_cost)}`, goto: "usage" },
      { label: "Power cuts today", value: `${t.outages}`, sub: t.outages ? `${dur(t.outage_s)} without power` : "None so far", cls: t.outages ? "bad" : "good", goto: "outages" },
      { label: "This month", value: money(b.bill.total), sub: `${n(b.units)} kWh so far, about ${money(b.projected && b.projected.total)} by month end`, goto: "usage" },
      { label: "Next unit costs", value: money(s.unit_price, 2), sub: b.next_limit ? `${n(b.next_limit - b.units)} units until ${money(b.next_rate, 2)} slab` : "Top slab", cls: b.next_limit && b.next_limit - b.units < 20 && b.next_rate > b.rate ? "warn" : "", goto: "usage" },
      p.configured
        ? { label: "Prepaid balance", value: money(p.balance), sub: p.balance <= 0 ? "Probably used up. Check the meter" : p.days_left != null ? `About ${n(p.days_left, 1)} days left` : "", cls: p.balance <= p.low_alert ? "bad" : p.days_left != null && p.days_left <= 5 ? "warn" : "good", goto: "prepaid" }
        : { label: "Prepaid balance", value: "Not set", sub: "Enter the meter's balance to track it", goto: "prepaid" },
    ];
    $("today-tiles").innerHTML = tiles.map((x) => `<div class="tile ${x.cls || ""}" data-goto="${x.goto}" role="button" tabindex="0">
      <div class="label">${esc(x.label)}</div><div class="value">${x.value}</div><div class="sub">${x.sub || "&nbsp;"}</div></div>`).join("");
    renderForecast();
    renderEvents($("recent"), s.recent, "No power cuts, trips or drops in the last 3 days.");
    renderSpark();
    $("foot").textContent = `Updated ${time(s.now)}${s.ha_connected ? "" : " - Home Assistant not connected"}`;
  }

  function tickSince() {
    if (!status) return;
    const s = status, since = s.since;
    let txt = "&nbsp;";
    if (since && s.state !== "unknown") txt = `for ${dur(NOW() - since)}, since ${when(since)}`;
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
    if (!oddsCache || NOW() - oddsAt > 600) { oddsCache = await api("api/heatmap?days=28"); oddsAt = NOW(); }
    const p = status.prediction, odds = oddsCache.odds, hour = new Date().getHours();
    if (!p) { $("forecast").innerHTML = '<p class="muted">The forecast needs at least three days of readings.</p>'; return; }
    const next = p.next, top = Math.max(...odds);
    $("forecast").innerHTML = `
      <div class="forecast-big">
        <div><div class="k">Chance this hour</div><div class="v">${Math.round(p.now * 100)}%</div></div>
        <div><div class="k">Most likely next</div><div class="v">${next ? esc(hourLabel(next.hour)) : "No clear pattern"}</div></div>
        ${next ? `<div><div class="k">Days with a cut then</div><div class="v">${Math.round(next.chance * 100)}%</div></div>` : ""}
      </div>
      <div class="oddsbar" aria-label="Share of days with a power cut in each hour">${odds.map((o, h) =>
        `<i class="${h === hour ? "now" : o >= 0.3 ? "hot" : ""}" style="height:${Math.max(4, (o / Math.max(top, 0.01)) * 100)}%" data-tip="<b>${esc(hourLabel(h))}</b><span>${Math.round(o * 100)}% of the last ${p.days} days had a cut</span>"></i>`).join("")}</div>
      <div class="odds-axis"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
      <p class="small muted hint">From ${p.days} days of readings. ${next ? "" : "No hour has had a cut on 30% of days yet. "}Bars are scaled to the busiest hour.</p>`;
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
      data: { datasets: [line("Power", pts.map((p) => ({ x: p.ts, y: p.w })), css("--accent"), { fill: true, backgroundColor: fade(css("--accent"), 14), borderWidth: 1.5 })] },
      options: { ...opts({ span: 3600 }), animation: false, scales: { x: { type: "linear", display: false }, y: { display: false, beginAtZero: true } }, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    });
  }

  async function loadStrip() {
    const now = NOW();
    const rows = await api(`api/timeline?from=${now - DAY}&to=${now}&buckets=96`);
    const word = { on: "Power on", outage: "Power cut", off: "Breaker off", wifi: "Breaker offline", gap: "Monitor offline", none: "No data", future: "" };
    $("strip24").innerHTML = rows.map((r) => `<span class="${r.state}" data-tip="<b>${esc(word[r.state])}</b><span>${esc(time(r.lo))} - ${esc(time(r.hi))}</span>"></span>`).join("");
    $("strip24-axis").innerHTML = [0, 6, 12, 18, 24].map((h) => `<span>${esc(time(now - DAY + h * 3600))}</span>`).join("");
    const l = status && status.last24;
    $("strip-note").textContent = l && l.outages ? `${l.outages} cut${l.outages > 1 ? "s" : ""}, ${dur(l.outage_s)} without power` : "No power cuts";
  }

  loaders.live = async () => {
    await refreshStatus();
    renderLive();
    loadStrip();
  };

  // ============================================================== POWER CUTS
  let outKinds = "outage", outLimit = 60, calCache = null;
  const outPicker = periodPicker($("out-period"), {
    presets: ["today", "yesterday", "week", "month", "last_month", "d30", "d90", "year", "custom"], initial: "d30", key: "out",
    onChange: () => { outLimit = 60; run("outages"); },
  });
  chips("out-kinds", (d) => { outKinds = d.k; outLimit = 60; run("outages"); });
  $("out-more").addEventListener("click", () => { outLimit += 120; run("outages"); });

  loaders.outages = async () => {
    const [lo, hi] = outPicker.range(), hiEff = Math.min(hi, NOW());
    const days = Math.max(1, Math.ceil((hiEff - lo) / DAY));
    const [sum, evs, nets, heat, odds] = await Promise.all([
      api(`api/summary?from=${lo}&to=${hiEff}`), api(`api/events?from=${lo}&to=${hiEff}&kinds=${outKinds}`),
      api(`api/events?from=${lo}&to=${hiEff}&kinds=internet`), api(`api/heatmap?days=${Math.min(365, Math.max(7, days))}`), api("api/heatmap?days=28"),
    ]);
    if (!calCache || NOW() - calCache.at > 600) calCache = { at: NOW(), rows: await api("api/calendar?days=365") };
    $("out-csv").href = `api/export/events.csv?from=${lo}&to=${hiEff}`;
    const tiles = [
      ["Power cuts", n(sum.outages), sum.outages ? `${n(sum.outages / days, 1)} a day on average` : "None in this period", sum.outages ? "bad" : "good"],
      ["Without power", dur(sum.outage_s), `${n(100 - sum.power_pct, 1)}% of the time`],
      ["Longest", sum.outages ? dur(sum.longest_s) : "-", ""],
      ["Average cut", sum.outages ? dur(sum.average_s) : "-", ""],
      ["Breaker trips", n(sum.trips), sum.trips ? Object.entries(sum.trip_causes).map(([k, v]) => `${k.replace(/_/g, " ")} x${v}`).join(", ") : "None", sum.trips ? "bad" : "good"],
      ["Internet down too", sum.outages ? `${n(sum.outages_with_internet_down)} of ${n(sum.outages)}` : "-", "Cuts where Net Monitor saw the internet drop"],
      ["Wi-Fi drops", n(sum.wifi), "Breaker offline, power on"],
    ];
    $("out-tiles").innerHTML = tiles.map(([l, v, s, c]) => `<div class="tile ${c || ""}"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="sub">${esc(s || " ")}</div></div>`).join("");
    renderHeat(heat);
    chart("odds-chart", {
      type: "bar",
      data: { labels: odds.odds.map((_, h) => hourLabel(h)), datasets: [{ label: "Days with a cut", data: odds.odds.map((o) => Math.round(o * 100)), backgroundColor: odds.odds.map((o) => (o >= 0.3 ? css("--critical") : fade(css("--critical"), 35))), borderRadius: 0 }] },
      options: { ...opts({ xType: "category", yMin: 0 }), plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y}% of days` } } } },
    });
    renderCalendar(calCache.rows);

    // The list, grouped by day.
    const netOverlap = (e) => nets.some((x) => x.start < (e.end || NOW()) && (x.end || NOW()) > e.start);
    const rows = evs.slice(0, outLimit);
    let html = "", lastDay = null;
    const dayTotals = {};
    evs.forEach((e) => { const k = startOfDay(e.start); dayTotals[k] = dayTotals[k] || { n: 0, s: 0 }; if (e.kind === "outage") { dayTotals[k].n++; dayTotals[k].s += e.duration_s; } });
    rows.forEach((e) => {
      const k = startOfDay(e.start);
      if (k !== lastDay) {
        lastDay = k;
        const t = dayTotals[k];
        html += `<tr class="year-row"><td colspan="5">${esc(dayName(k))}${t.n ? ` <span class="muted small">${t.n} cut${t.n > 1 ? "s" : ""}, ${dur(t.s)}</span>` : ""}</td></tr>`;
      }
      const [title, sub] = eventLabel(e);
      html += `<tr><td>${esc(time(e.start))}</td><td>${e.end ? esc(sameDay(e.start, e.end) ? time(e.end) : when(e.end)) : '<span class="tag down">ongoing</span>'}</td>
        <td class="num">${dur(e.duration_s)}</td><td class="wrap"><b>${esc(title)}</b>${sub ? `<br><span class="muted small">${esc(sub)}</span>` : ""}</td>
        <td>${e.kind === "outage" ? (netOverlap(e) ? '<span class="tag down">Down too</span>' : '<span class="tag ok">Stayed up</span>') : ""}</td></tr>`;
    });
    $("out-rows").innerHTML = html || '<tr><td colspan="5" class="muted">Nothing in this period.</td></tr>';
    $("out-more").hidden = evs.length <= outLimit;
    $("lookup-at").value = $("lookup-at").value || toLocalInput(NOW() - 3600);
  };

  function renderHeat(h) {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const max = Math.max(1, ...h.grid.flat());
    let html = '<span></span>' + Array.from({ length: 24 }, (_, i) => `<span class="cl">${i % 6 === 0 ? esc(hourLabel(i)) : ""}</span>`).join("");
    h.grid.forEach((row, d) => {
      html += `<span class="rl">${days[d]}</span>` + row.map((m, hr) => {
        const style = m ? ` style="background:color-mix(in srgb, var(--critical) ${(15 + 85 * (m / max)).toFixed(0)}%, var(--surface-2))"` : "";
        return `<span class="cell"${style} data-tip="<b>${days[d]} ${esc(hourLabel(hr))}</b><span>${m ? `${Math.round(m)} min without power` : "No cuts"}</span>"></span>`;
      }).join("");
    });
    $("heatmap").innerHTML = html;
    $("heat-note").textContent = `${h.outages} cuts in ${h.days} monitored days`;
    $("heat-legend").innerHTML = '<span>Fewer minutes</span>' + [15, 40, 65, 100].map((p) => `<i style="background:color-mix(in srgb, var(--critical) ${p}%, var(--surface-2))"></i>`).join("") + "<span>More</span>";
    const byHour = Array.from({ length: 24 }, (_, i) => h.grid.reduce((a, r) => a + r[i], 0));
    const top = byHour.map((m, i) => [m, i]).filter(([m]) => m > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i).sort((a, b) => a - b);
    $("heat-summary").innerHTML = top.length ? `Most of the time without power falls around <strong>${top.map((i) => esc(hourLabel(i))).join(", ")}</strong>.` : "No power cuts in this period.";
  }

  function renderCalendar(rows) {
    if (!rows.length) { $("calendar").innerHTML = ""; return; }
    const pad = (new Date(rows[0].day * 1000).getDay() + 6) % 7;
    let html = Array.from({ length: pad }, () => '<i class="nodata" aria-hidden="true"></i>').join("");
    html += rows.map((d) => {
      const c = !d.monitored ? "nodata" : d.outage_min <= 0 ? "c0" : d.outage_min < 15 ? "c1" : d.outage_min < 60 ? "c2" : d.outage_min < 180 ? "c3" : "c4";
      const t = `<b>${esc(dFmt.format(d.day * 1000))}</b><span>${d.monitored ? `${d.outages} cut${d.outages === 1 ? "" : "s"}, ${Math.round(d.outage_min)} min without power` : "Not monitored"}</span>${d.kwh ? `<span>${n(d.kwh, 1)} kWh used</span>` : ""}${d.trips ? `<span>${d.trips} breaker trip${d.trips > 1 ? "s" : ""}</span>` : ""}`;
      return `<i class="${c}${d.trips ? " trip" : ""}" data-tip="${esc(t)}"></i>`;
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
    const s = r.sample, evs = r.events.filter((e) => e.kind !== "internet"), net = r.events.find((e) => e.kind === "internet");
    let html = `<div><strong>${esc(when(ts))}</strong></div>`;
    if (evs.length) html += evs.map((e) => { const [t, sub] = eventLabel(e); return `<div><strong>${esc(t)}</strong> from ${esc(when(e.start))} to ${e.end ? esc(when(e.end)) : "now"} (${dur(e.duration_s)}). ${esc(sub)}</div>`; }).join("");
    else if (s) html += "<div>The power was on.</div>";
    if (s && s.v_avg != null) html += `<div>Voltage ${n(s.v_min)}-${n(s.v_max)} V, power about ${n(s.w_avg)} W${s.relay === 0 ? ", breaker off" : ""}.</div>`;
    if (!s && !evs.length) html += '<div class="muted">No readings for that time.</div>';
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
    const [p, s] = await Promise.all([api("api/protection"), refreshStatus()]);
    const r = p.readings || {}, st = s.state;
    $("prot-state").innerHTML = `<span class="pill ${st === "on" ? "good" : st === "off" ? "warn" : "bad"}">${esc(s.label)}</span>`;
    $("prot-actions").innerHTML = `${s.relay === "off" ? '<button class="btn primary" data-control="on"><span>Turn on</span></button>' : ""}
      ${s.relay === "on" ? '<button class="btn danger" data-control="off"><span>Turn off</span></button>' : ""}
      <button class="btn ghost" data-control="clear_flag"><span>Clear trip flag</span></button>`;
    const prob = p.problem.state;
    $("prot-problem").textContent = prob === "unavailable" || prob == null
      ? "The breaker has never sent a fault code to Home Assistant, so its Problem sensor shows unavailable. That's normal for this model; the reasons below come from the readings."
      : `Problem sensor: ${prob}${p.problem.attributes && p.problem.attributes.fault_code ? ` (code ${p.problem.attributes.fault_code})` : ""}.`;
    const now = { over_v: r.voltage, low_v: r.voltage, over_a: r.current, over_kw: r.power != null ? r.power / 1000 : null, over_t: r.temp, over_kwh: r.energy };
    $("limits").innerHTML = LIMIT_UI.map(([k, name, unit, help]) => {
      const L = p.limits[k] || {}, v = L.value, cur = now[k];
      let room = "";
      if (!v) room = '<span class="pill warn off-pill">Off</span>';
      else if (cur != null) {
        const volt = k.endsWith("_v"), gap = k === "low_v" ? cur - v : v - cur;
        const frac = Math.min(1, Math.max(0, volt ? gap / 60 : gap / v));
        const cls = volt ? (gap < 8 ? "bad" : gap < 20 ? "warn" : "") : frac < 0.1 ? "bad" : frac < 0.25 ? "warn" : "";
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
  };
  $("limits").addEventListener("input", (e) => { const row = e.target.closest(".limit"); if (row) row.querySelector("[data-save-limit]").disabled = false; });
  root.addEventListener("click", async (e) => {
    const s = e.target.closest("[data-save-limit]"), g = e.target.closest("[data-suggest]");
    if (!s && !g) return;
    const key = s ? s.dataset.saveLimit : g.dataset.suggest;
    const value = s ? Number(document.querySelector(`.limit[data-key="${key}"] input`).value) : Number(g.dataset.value);
    const name = LIMIT_UI.find((x) => x[0] === key)[1];
    if (!(await confirmBox(`Change ${name.toLowerCase()} protection?`, `Set it to ${value} on the breaker.`, "Change"))) return;
    const r = await post("api/control", { action: "set_limit", key, value });
    toast(r.ok ? `${name} set to ${value}` : r.body.error || "Not accepted", r.ok ? "" : "bad");
    setTimeout(() => run("protection"), 1500);
  });

  // ============================================================== USAGE & BILL
  let gran = store.get("use.gran", "auto"), measure = store.get("use.measure", "kwh");
  let billMonth = null, monthsCache = null, lastUsage = null;
  $("use-compare").checked = store.get("use.compare", true);
  pick("use-gran", "g", gran);
  pick("use-measure", "m", measure);
  const usePicker = periodPicker($("use-period"), {
    presets: ["today", "yesterday", "week", "month", "last_month", "d30", "year", "custom"], initial: "month", key: "use",
    onChange: () => {
      if (usePicker.unit === "month") billMonth = ymOf(usePicker.range()[0]);
      loadUsage().then(() => usePicker.unit === "month" && loadBill());
    },
  });
  chips("use-gran", (d) => { gran = d.g; store.set("use.gran", gran); loadUsage(); });
  chips("use-measure", (d) => { measure = d.m; store.set("use.measure", measure); renderUsage(); });
  $("use-compare").addEventListener("change", () => { store.set("use.compare", $("use-compare").checked); renderUsage(); });
  $("use-table-toggle").addEventListener("click", () => {
    const t = $("use-table"), open = t.hidden;
    t.hidden = !open;
    $("use-table-toggle").setAttribute("aria-expanded", String(open));
    $("use-table-toggle").querySelector("span").textContent = open ? "Hide table" : "Show table";
  });

  const GRAN_OK = { hour: (s) => s <= 8 * DAY, day: (s) => s >= DAY && s <= 400 * DAY, week: (s) => s >= 14 * DAY, month: (s) => s >= 45 * DAY };
  function bucketLabel(ts, period, long) {
    const d = new Date(ts * 1000);
    if (period === "hour") return long ? `${dFmt.format(d)} ${hFmt.format(d)}` : hFmt.format(d);
    if (period === "day") return long ? dFmt.format(d) : dShort.format(d);
    if (period === "week") return `Week of ${dShort.format(d)}`;
    return long ? mFmt.format(d) : mShort.format(d);
  }

  async function loadUsage() {
    const [lo, hi] = usePicker.range(), [plo, phi] = usePicker.previous(), span = hi - lo;
    $("use-gran").querySelectorAll("button").forEach((b) => { b.disabled = b.dataset.g !== "auto" && !GRAN_OK[b.dataset.g](span); });
    if (gran !== "auto" && !GRAN_OK[gran](span)) { gran = "auto"; pick("use-gran", "g", "auto"); }
    lastUsage = await api(`api/usage?from=${lo}&to=${hi}&period=${gran}&prev_from=${plo}&prev_to=${phi}`);
    lastUsage.prevLabel = periodLabel(plo, phi, usePicker.unit);
    renderUsage();
  }

  function renderUsage() {
    const u = lastUsage;
    if (!u) return;
    const per = u.period, cost = measure === "cost";
    const val = (b) => (cost ? b.cost : b.kwh);
    const fmtVal = (v) => (cost ? money(v) : `${n(v, v < 10 ? 2 : 1)} kWh`);
    const past = u.buckets.filter((b) => !b.future);
    const busiest = past.reduce((a, b) => (b.kwh > (a ? a.kwh : 0) ? b : a), null);
    const prev = u.previous, prevOk = prev.coverage != null && prev.coverage >= 0.8;
    $("use-title").textContent = periodLabel(u.from, u.to, usePicker.unit);
    $("use-sub").textContent = `${n(u.total, 1)} kWh, ${money(u.cost)} · by ${per}${$("use-compare").checked ? ` · compared with ${u.prevLabel}` : ""}`;
    const tiles = [
      ["Used", `${n(u.total, 1)}<small>kWh</small>`, prevOk ? deltaHtml(u.total, prev.total, u.prevLabel) : `${esc(u.prevLabel)} has too few readings to compare`],
      ["Cost", money(u.cost), prevOk && prev.cost ? `${money(prev.cost)} in ${esc(u.prevLabel)}` : "Energy at slab rates, VAT in"],
      ["Per day", `${n(u.per_day, 1)}<small>kWh</small>`, `${money(u.cost_per_day)} a day`],
      ["Busiest", busiest ? esc(bucketLabel(busiest.ts, per, true)) : "-", busiest ? `${n(busiest.kwh, 1)} kWh, ${money(busiest.cost)}` : ""],
      ["Power cuts", n(u.outages), u.outages ? `${dur(u.outage_s)} without power` : "None", u.outages ? "bad" : "good"],
      ["Always-on load", u.base_w != null ? `${n(u.base_w)}<small>W</small>` : "-", u.base_w != null ? `${money((u.base_w / 1000) * 24 * 30 * u.unit_price)} a month` : "Needs a few days of readings"],
    ];
    $("use-tiles").innerHTML = tiles.map(([l, v, sub, c]) => `<div class="tile ${c || ""}"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${sub || "&nbsp;"}</div></div>`).join("");
    const notice = $("use-notice");
    if (u.coverage != null && u.coverage < 0.95) {
      const before = u.first_data && u.from < u.first_data;
      notice.innerHTML = before
        ? `<b>Readings start ${esc(dYear.format(u.first_data * 1000))}.</b> Nothing was recorded before that, so this period shows ${Math.round(u.coverage * 100)}% of its time.`
        : `<b>${Math.round((1 - u.coverage) * 100)}% of this period has no readings</b> (Home Assistant or the breaker was offline), so the totals are a little low.`;
      notice.hidden = false;
    } else notice.hidden = true;

    const labels = u.buckets.map((b) => bucketLabel(b.ts, per));
    const sets = [{
      label: cost ? `Cost (${CUR})` : "kWh", data: u.buckets.map((b) => (b.future ? null : val(b))), order: 2,
      backgroundColor: u.buckets.map((b) => (b.coverage != null && b.coverage < 0.9 ? fade(css("--series-1"), 45) : css("--series-1"))),
      hoverBackgroundColor: css("--accent"), borderRadius: 0,
    }];
    if ($("use-compare").checked && u.previous_buckets.length) {
      sets.push({ type: "line", label: u.prevLabel, data: u.buckets.map((_, i) => (u.previous_buckets[i] ? val(u.previous_buckets[i]) : null)),
        borderColor: css("--text-muted"), backgroundColor: css("--text-muted"), borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.25, order: 1 });
    }
    chart("use-chart", {
      type: "bar", data: { labels, datasets: sets },
      options: { ...opts({ xType: "category", yTitle: cost ? CUR : "kWh", yMin: 0 }), plugins: { legend: { display: false }, tooltip: {
        backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"), borderColor: css("--axis"), borderWidth: 1, cornerRadius: 0,
        callbacks: {
          title: (items) => (items.length ? bucketLabel(u.buckets[items[0].dataIndex].ts, per, true) : ""),
          label: (c) => {
            if (c.datasetIndex === 1) { const p = u.previous_buckets[c.dataIndex]; return p ? `${u.prevLabel}: ${n(p.kwh, 2)} kWh, ${money(p.cost)}` : ""; }
            const b = u.buckets[c.dataIndex];
            return `${n(b.kwh, 2)} kWh, ${money(b.cost)}${b.coverage != null && b.coverage < 0.9 ? ` (readings for ${Math.round(b.coverage * 100)}%)` : ""}`;
          },
        } } } },
    });
    $("use-legend").innerHTML = `<span><i class="band" style="background:var(--series-1)"></i>${cost ? "Cost" : "Energy used"}</span>`
      + ($("use-compare").checked ? `<span><i class="dash"></i>${esc(u.prevLabel)}</span>` : "")
      + '<span><i class="band" style="background:color-mix(in srgb, var(--series-1) 45%, transparent)"></i>Readings missing for part of it</span>';
    $("use-csv").href = `api/export/usage.csv?from=${u.from}&to=${u.to}&period=${per}`;
    $("use-table").innerHTML = `<table><thead><tr><th>${esc(per[0].toUpperCase() + per.slice(1))}</th><th class="num">kWh</th><th class="num">Cost</th><th class="num">Readings</th></tr></thead>
      <tbody>${past.slice().reverse().map((b) => `<tr><td>${esc(bucketLabel(b.ts, per, true))}</td><td class="num">${n(b.kwh, 2)}</td><td class="num">${money(b.cost, 2)}</td>
      <td class="num">${b.coverage == null ? "-" : `${Math.round(b.coverage * 100)}%`}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${n(u.total, 2)}</td><td class="num">${money(u.cost, 2)}</td><td class="num">${u.coverage == null ? "-" : `${Math.round(u.coverage * 100)}%`}</td></tr></tfoot></table>`;
  }

  // ----- bills
  async function loadMonths() {
    monthsCache = await api("api/months");
    const sel = $("bill-month");
    sel.innerHTML = monthsCache.map((m) => `<option value="${m.month}">${esc(monthLabel(m.month))}${m.current ? " (this month)" : m.partial ? " (partial)" : ""}</option>`).join("");
    if (!billMonth || !monthsCache.some((m) => m.month === billMonth)) billMonth = monthsCache.length ? monthsCache[0].month : ymOf(NOW());
    renderMonths();
  }
  function stepMonth(k) {
    const i = monthsCache.findIndex((m) => m.month === billMonth) - k;  // the list is newest first
    if (i < 0 || i >= monthsCache.length) return;
    selectBillMonth(monthsCache[i].month);
  }
  function selectBillMonth(ym) {  // keeps the usage chart on the same month when it's showing a month
    billMonth = ym;
    if (usePicker.unit === "month") { usePicker.setMonth(ym); loadUsage(); }
    return loadBill();
  }
  $("bill-prev").addEventListener("click", () => stepMonth(-1));
  $("bill-next").addEventListener("click", () => stepMonth(1));
  $("bill-month").addEventListener("change", () => selectBillMonth($("bill-month").value));

  async function loadBill() {
    if (!monthsCache) return;
    $("bill-month").value = billMonth;
    const i = monthsCache.findIndex((m) => m.month === billMonth);
    $("bill-prev").disabled = i < 0 || i >= monthsCache.length - 1;
    $("bill-next").disabled = i <= 0;
    const b = await api(`api/bill?month=${billMonth}`);
    renderStatement(b);
    renderBillDays(b);
    renderBillRecharges(b);
    renderLadder(b);
    renderExplain(b);
    renderMonths();
  }

  function renderStatement(b) {
    const bb = b.bill;
    const status = b.current ? '<span class="pill warn">In progress</span>' : b.partial ? '<span class="pill warn">Partial data</span>' : b.units > 0 ? '<span class="pill good">Complete</span>' : '<span class="pill">No data</span>';
    const perDay = b.units / Math.max(1, b.current ? b.days_elapsed : b.coverage ? b.days_in_month * b.coverage : b.days_in_month);
    let html = `<div class="st-top">
        <div><div class="k">Electricity bill</div><div class="st-month">${esc(monthLabel(b.month))}</div><div class="st-sub">${status}</div></div>
        <div class="st-total"><div class="k">${b.current ? "So far" : b.partial ? "Recorded part" : "Total cost"}</div><div class="big">${money(bb.total)}</div>
        <div class="st-sub">${n(b.units, 1)} kWh · ${n(perDay, 1)} kWh a day</div></div></div>`;
    if (b.current && b.projected) {
      const pct = (100 * b.days_elapsed) / b.days_in_month;
      html += `<div class="st-progress"><div class="st-sub">Day ${Math.ceil(b.days_elapsed)} of ${b.days_in_month}. At ${n(b.per_day, 1)} kWh a day the month ends near
        <strong>${n(b.projected_units)} kWh</strong> and <strong>${money(b.projected.total)}</strong>.${b.limit_at ? ` You'll pass ${b.next_limit} units around <strong>${esc(dShort.format(b.limit_at * 1000))}</strong>; after that each unit costs ${money(b.next_rate, 2)}.` : ""}</div>
        <div class="plan-bar"><span style="width:${pct.toFixed(1)}%"></span></div></div>`;
    }
    if (b.partial) {
      html += `<div class="notice">Readings cover <b>${Math.round(b.coverage * 100)}%</b> of this month${b.first_data ? ` (from ${esc(dShort.format(b.first_data * 1000))})` : ""}.
        The full month was probably around <b>${n(b.estimated_units)} kWh, ${money(b.estimated.total)}</b>.</div>`;
    }
    if (b.units <= 0 && !b.current) {
      html += '<p class="muted">No readings for this month.</p>';
    } else {
      html += `<table class="st-lines"><tbody>
        <tr><td>Energy<span class="why">${n(b.units, 1)} kWh at stepped slab rates</span></td><td class="num">${money(bb.energy, 2)}</td></tr>
        ${bb.rows.map(([label, units, rate, cost]) => `<tr class="slab"><td>Units ${esc(label)}: ${n(units, 1)} × ${money(rate, 2)}</td><td class="num">${money(cost, 2)}</td></tr>`).join("")}
        <tr><td>Demand charge<span class="why">${n(b.sanctioned_kw, 1)} kW sanctioned load × ${money(b.demand_rate)}, once a month</span></td><td class="num">${money(bb.demand, 2)}</td></tr>
        <tr><td>Meter rent<span class="why">Once a month, with the first recharge</span></td><td class="num">${money(bb.meter_rent, 2)}</td></tr>
        <tr><td>VAT ${n(b.vat_percent)}%<span class="why">Taken out of each recharge</span></td><td class="num">${money(bb.vat, 2)}</td></tr>
        <tr><td>Prepaid rebate ${n(b.rebate_percent, 1)}%</td><td class="num">-${money(bb.rebate, 2)}</td></tr>
        <tr class="total"><td>${b.current ? "Cost so far" : "Cost of the month"}</td><td class="num">${money(bb.total, 2)}</td></tr>
      </tbody></table>`;
    }
    const pv = b.previous;
    if (pv && pv.units >= 1 && b.units > 0) {
      html += `<div class="st-foot"><p class="small">${b.current ? `At this point in ${esc(monthLabel(pv.month))} you had used ${n(pv.units)} kWh (${money(pv.total)}).` : `${esc(monthLabel(pv.month))}: ${n(pv.units)} kWh, ${money(pv.total)}.`}
        ${deltaHtml(b.units, pv.units, b.current ? "the same point last month" : "the month before")}</p>
        <p class="small muted">Total cost = what you'd have to recharge for this month's energy plus its monthly charges. The meter itself spent ${money(b.energy_spent, 2)} of energy credit on these units.</p></div>`;
    }
    $("statement").innerHTML = html;
  }

  function renderBillDays(b) {
    const days = b.daily;
    $("bill-days-note").textContent = `${n(b.units, 1)} kWh`;
    chart("bill-days", {
      type: "bar",
      data: { labels: days.map((d) => new Date(d.ts * 1000).getDate()), datasets: [{ label: "kWh", data: days.map((d) => (d.future ? null : d.kwh)),
        backgroundColor: days.map((d) => (d.coverage != null && d.coverage < 0.9 ? fade(css("--series-1"), 45) : css("--series-1"))), borderRadius: 0 }] },
      options: { ...opts({ xType: "category", yMin: 0 }), plugins: { legend: { display: false }, tooltip: {
        backgroundColor: css("--surface-1"), titleColor: css("--text-primary"), bodyColor: css("--text-secondary"), borderColor: css("--axis"), borderWidth: 1, cornerRadius: 0,
        callbacks: { title: (it) => (it.length ? dFmt.format(days[it[0].dataIndex].ts * 1000) : ""), label: (c) => { const d = days[c.dataIndex]; return `${n(d.kwh, 2)} kWh, ${money(d.cost)}`; } } } } },
    });
  }

  function renderBillRecharges(b) {
    const rc = b.recharges, t = b.recharged;
    if (!rc.length) {
      $("bill-recharges").innerHTML = `<p class="muted small">No recharges saved for ${esc(monthLabel(b.month))}. Paste the recharge SMS on the Prepaid page to see where each taka went.</p>`;
      return;
    }
    $("bill-recharges").innerHTML = `<ul class="rc-list">${rc.map((r) => {
      const k = r.breakdown;
      return `<li><span><b>${esc(dFmt.format(r.ts * 1000))}</b> <span class="pill ${k.source === "sms" ? "good" : ""} src">${k.source === "sms" ? "from SMS" : "worked out"}</span></span>
        <span class="rc-amt">${money(r.amount)}</span>
        <span class="rc-sub">${money(k.energy, 2)} energy credit${k.demand ? ` · demand ${money(k.demand)}` : ""}${k.meter_rent ? ` · rent ${money(k.meter_rent)}` : ""} · VAT ${money(k.vat, 2)} · rebate ${money(k.rebate, 2)}</span></li>`;
    }).join("")}</ul>
    <div class="rc-sum"><span>Recharged</span><span class="num">${money(t.amount)}</span>
      <span>Energy credit you got</span><span class="num">${money(t.energy, 2)}</span>
      <span>Energy credit used this month</span><span class="num">${money(b.energy_spent, 2)}</span>
      <span>${t.energy >= b.energy_spent ? "Left over for later" : "Taken from earlier credit"}</span><span class="num">${money(Math.abs(t.energy - b.energy_spent), 2)}</span></div>`;
  }

  function renderLadder(b) {
    let prev = 0;
    $("ladder-head").textContent = `${monthLabel(b.month)}: ${n(b.units)} units`;
    $("ladder").innerHTML = b.slabs.map((s) => {
      const top = s.upto || Math.max(prev + 200, b.units);
      const inSlab = Math.max(0, Math.min(b.units, top) - prev);
      const width = (100 * inSlab) / (top - prev);
      const cur = b.units >= prev && (s.upto == null || b.units < s.upto);
      const label = s.upto ? `${prev + 1}-${s.upto}` : `${prev + 1}+`;
      prev = s.upto || prev;
      return `<div class="step ${cur ? "cur" : ""}" data-tip="<b>Units ${esc(label)}</b><span>${n(inSlab, 1)} kWh at ${esc(money(s.rate, 2))}</span>"><span class="lbl">${label}</span><span class="bar"><b style="width:${width.toFixed(1)}%"></b></span><span class="rate">${money(s.rate, 2)}</span></div>`;
    }).join("");
    $("ladder-note").textContent = `If the whole month stays at ${b.lifeline[0]} units or less, every unit costs ${CUR}${b.lifeline[1]} instead (lifeline). Rates are before VAT.`;
  }

  function renderExplain(b) {
    const last = b.recharges.length ? b.recharges[b.recharges.length - 1] : null;
    const k = last ? last.breakdown : null;
    const amt = last ? last.amount : 3000;
    const vat = k ? k.vat : amt * b.vat_percent / (100 + b.vat_percent);
    const cf = b.cash_factor;
    $("cost-explain").innerHTML = `
      <p>You recharge <b>${money(amt)}</b>. VAT (${n(b.vat_percent)}%) is already inside it: <b>${money(vat, 2)}</b>.</p>
      <p>The month's <b>first</b> recharge also pays the meter rent (${money(b.bill.meter_rent || 40)}) and the demand charge (${n(b.sanctioned_kw, 1)} kW × ${money(b.demand_rate)} = ${money(b.sanctioned_kw * b.demand_rate)}). Later recharges that month don't.</p>
      <p>You get a ${n(b.rebate_percent, 1)}% prepaid rebate back${k ? `: <b>${money(k.rebate, 2)}</b>` : ""}.</p>
      <p>What's left${k ? `, <b>${money(k.energy, 2)}</b>,` : ""} is energy credit. The meter spends it at each unit's slab rate, so units get dearer as the month goes on and reset on the 1st.</p>
      <p>In cash, each unit costs about <b>${n((cf - 1) * 100, 1)}%</b> more than its slab rate. Right now the next unit costs <b>${money((b.next_rate && b.units >= (b.next_limit || 1e9) ? b.next_rate : b.rate) * cf, 2)}</b>.</p>`;
  }

  function renderMonths() {
    if (!monthsCache) return;
    const max = Math.max(1, ...monthsCache.map((m) => m.kwh));
    let html = "", year = null;
    const years = {};
    monthsCache.forEach((m) => { const y = m.month.slice(0, 4); years[y] = years[y] || { kwh: 0, bill: 0, rc: 0, cuts: 0, s: 0, trips: 0 }; Object.assign(years[y], { kwh: years[y].kwh + m.kwh, bill: years[y].bill + m.bill, rc: years[y].rc + m.recharged, cuts: years[y].cuts + m.outages, s: years[y].s + m.outage_s, trips: years[y].trips + m.trips }); });
    monthsCache.forEach((m) => {
      const y = m.month.slice(0, 4);
      if (y !== year) {
        year = y;
        const t = years[y];
        html += `<tr class="year-row"><td>${y}</td><td class="num">${n(t.kwh)}</td><td></td><td></td><td class="num">${money(t.bill)}</td><td class="num">${t.rc ? money(t.rc) : "-"}</td><td class="num">${n(t.cuts)}</td><td class="num">${n(t.trips)}</td></tr>`;
      }
      html += `<tr data-month="${m.month}" class="${m.month === billMonth ? "sel" : ""} ${m.current ? "cur" : ""}">
        <td>${esc(monthLabel(m.month))} ${m.current ? '<span class="pill warn">now</span>' : m.partial ? `<span class="pill" data-tip="<b>Partial</b><span>Readings for ${Math.round(m.coverage * 100)}% of the month</span>">partial</span>` : ""}</td>
        <td class="num">${n(m.kwh)}</td><td class="bar-col"><span class="mbar" style="width:${((100 * m.kwh) / max).toFixed(1)}%"></span></td>
        <td class="num">${n(m.per_day, 1)}</td>
        <td class="num">${money(m.bill)}${m.estimated_bill ? `<span class="cov" data-tip="<b>Whole month, estimated</b><span>${esc(money(m.estimated_bill))}</span>">~${esc(money(m.estimated_bill))}</span>` : ""}</td>
        <td class="num">${m.recharged ? money(m.recharged) : "-"}</td>
        <td class="num">${n(m.outages)}${m.outages ? ` <span class="muted small">(${dur(m.outage_s)})</span>` : ""}</td><td class="num">${n(m.trips)}</td></tr>`;
    });
    $("month-rows").innerHTML = html || '<tr><td colspan="8" class="muted">No months yet.</td></tr>';
  }
  $("month-rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-month]");
    if (!tr) return;
    selectBillMonth(tr.dataset.month).then(() => $("statement").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" }));
  });

  async function loadPatterns() {
    const now = NOW();
    const [hourly, daily] = await Promise.all([api(`api/usage?from=${now - 30 * DAY}&to=${now}&period=hour`), api(`api/usage?from=${startOfDay(now) - 56 * DAY}&to=${startOfDay(now)}&period=day`)]);
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const sum = Array.from({ length: 7 }, () => Array(24).fill(0)), cnt = Array.from({ length: 7 }, () => Array(24).fill(0));
    hourly.buckets.forEach((b) => { if (!b.hours) return; const d = new Date(b.ts * 1000); const wd = (d.getDay() + 6) % 7; sum[wd][d.getHours()] += b.kwh; cnt[wd][d.getHours()]++; });
    const avg = sum.map((r, i) => r.map((v, h) => (cnt[i][h] ? v / cnt[i][h] : null)));
    const max = Math.max(0.01, ...avg.flat().filter((x) => x != null));
    let html = '<span></span>' + Array.from({ length: 24 }, (_, i) => `<span class="cl">${i % 6 === 0 ? esc(hourLabel(i)) : ""}</span>`).join("");
    avg.forEach((row, d) => {
      html += `<span class="rl">${days[d]}</span>` + row.map((v, h) => {
        const style = v != null ? ` style="background:color-mix(in srgb, var(--series-1) ${(10 + 90 * (v / max)).toFixed(0)}%, var(--surface-2))"` : "";
        return `<span class="cell"${style} data-tip="<b>${days[d]} ${esc(hourLabel(h))}</b><span>${v != null ? `${n(v, 2)} kWh on average` : "No readings"}</span>"></span>`;
      }).join("");
    });
    $("use-heat").innerHTML = html;
    const wk = Array(7).fill(0), wc = Array(7).fill(0);
    daily.buckets.forEach((b) => { if (b.coverage == null || b.coverage < 0.9) return; const wd = (new Date(b.ts * 1000).getDay() + 6) % 7; wk[wd] += b.kwh; wc[wd]++; });
    chart("use-weekday", {
      type: "bar",
      data: { labels: days, datasets: [{ label: "kWh a day", data: wk.map((v, i) => (wc[i] ? v / wc[i] : null)), backgroundColor: days.map((_, i) => (i >= 5 ? css("--series-2") : css("--series-1"))), borderRadius: 0 }] },
      options: { ...opts({ xType: "category", yMin: 0, yTitle: "kWh" }), plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${n(c.parsed.y, 1)} kWh on an average ${days[c.dataIndex]}` } } } },
    });
  }

  loaders.usage = async () => {
    await refreshStatus();
    if (usePicker.unit === "month" && !billMonth) billMonth = ymOf(usePicker.range()[0]);
    await Promise.all([loadUsage(), loadMonths()]);
    await loadBill();
    loadPatterns().catch((e) => console.error(e));
  };

  // ============================================================== PREPAID
  let ppTab = "sms", parsed = null, parseTimer = null;
  $("pp-tabs").addEventListener("click", (e) => {
    const c = e.target.closest("[data-p]");
    if (!c) return;
    ppTab = c.dataset.p;
    $("pp-tabs").querySelectorAll("[data-p]").forEach((x) => x.setAttribute("aria-selected", String(x === c)));
    document.querySelectorAll(".pp-pane").forEach((p) => { p.hidden = p.dataset.pane !== ppTab; });
    if (ppTab === "calc") calc();
  });
  const breakdownTable = (k, title) => `<table><tbody>
    ${title ? `<tr><td colspan="2"><b>${esc(title)}</b></td></tr>` : ""}
    <tr><td>Paid</td><td class="num">${money(k.amount, 2)}</td></tr>
    <tr><td>VAT</td><td class="num">-${money(k.vat, 2)}</td></tr>
    ${k.meter_rent ? `<tr><td>Meter rent</td><td class="num">-${money(k.meter_rent, 2)}</td></tr>` : ""}
    ${k.demand ? `<tr><td>Demand charge</td><td class="num">-${money(k.demand, 2)}</td></tr>` : ""}
    <tr><td>Rebate</td><td class="num">+${money(k.rebate, 2)}</td></tr>
    <tr class="total"><td>Energy credit on the meter</td><td class="num">${money(k.energy, 2)}</td></tr></tbody></table>`;

  function ppReady() {
    $("pp-save").disabled = !(parsed || Number($("pp-amount").value) > 0);
  }
  $("pp-sms").addEventListener("input", () => {
    clearTimeout(parseTimer);
    const text = $("pp-sms").value.trim();
    if (!text) { parsed = null; $("pp-parse").innerHTML = ""; ppReady(); return; }
    parseTimer = setTimeout(async () => {
      const r = await post("api/prepaid/parse", { text });
      const box = $("pp-parse");
      if (!r.ok) { parsed = null; box.className = "pp-preview bad"; box.textContent = r.body.error || "Couldn't read that."; ppReady(); return; }
      parsed = r.body;
      box.className = "pp-preview";
      box.innerHTML = breakdownTable(parsed, `${parsed.ts ? when(parsed.ts) : "Date not in the SMS: it will use the time below, or now"}${parsed.sequence ? ` · sequence ${parsed.sequence}` : ""}`)
        + `${parsed.estimated ? '<p class="small muted">Only the payment SMS was pasted, so the split is worked out. Paste the BREB token SMS too for the exact figures.</p>' : ""}`
        + `${parsed.token ? `<p class="small muted">Token <span class="token">${esc(parsed.token)}</span></p>` : ""}`;
      ppReady();
    }, 250);
  });
  $("pp-amount").addEventListener("input", ppReady);
  $("pp-save").addEventListener("click", async () => {
    const when_ = $("pp-when").value ? fromLocalInput($("pp-when").value) : null;
    const body = parsed ? { sms: $("pp-sms").value, ts: parsed.ts ? null : when_ } : { amount: Number($("pp-amount").value), ts: when_ };
    const r = await post("api/prepaid/recharge", body);
    if (!r.ok) { toast(r.body.error || "Not saved", "bad"); return; }
    toast("Recharge saved");
    $("pp-sms").value = ""; $("pp-amount").value = ""; parsed = null; $("pp-parse").innerHTML = ""; ppReady();
    run("prepaid");
  });
  $("pp-sync-save").addEventListener("click", async () => {
    const v = $("pp-sync").value;
    if (v === "") { toast("Type the balance the meter shows", "warn"); return; }
    const r = await post("api/prepaid/sync", { amount: Number(v) });
    if (!r.ok) { toast(r.body.error || "Not saved", "bad"); return; }
    toast("Balance set");
    $("pp-sync").value = "";
    run("prepaid");
  });
  let calcTimer = null;
  async function calc() {
    const a = Number($("pp-calc").value);
    if (!(a > 0)) { $("pp-calc-out").innerHTML = ""; return; }
    try {
      const c = await api(`api/prepaid/calc?amount=${a}`);
      $("pp-calc-out").innerHTML = breakdownTable(c) + `<p class="small mt-s">That's about <b>${n(c.units)} units</b> from where this month is now${c.days != null ? `, roughly <b>${n(c.days, 1)} days</b> at your usage` : ""}.
        ${c.first_of_month ? "It includes this month's meter rent and demand charge, because you haven't recharged yet this month." : "No monthly charges: they were paid with this month's first recharge."}</p>`;
    } catch (e) { $("pp-calc-out").textContent = e.message; }
  }
  $("pp-calc").addEventListener("input", () => { clearTimeout(calcTimer); calcTimer = setTimeout(calc, 250); });

  loaders.prepaid = async () => {
    const p = await api("api/prepaid");
    document.querySelectorAll(".unit.cur").forEach((el) => { el.textContent = CUR; });
    $("pp-when").value = $("pp-when").value || toLocalInput(NOW());
    const card = $("balance-card");
    const lr = p.last_recharge;
    if (!p.configured) {
      card.className = "card balance-card reveal unset";
      $("pp-balance").textContent = "Not set";
      $("pp-verdict").className = "verdict";
      $("pp-title").textContent = "Tell it what the meter shows";
      $("pp-text").textContent = "Open Set the balance and type the taka on your meter's display. From then on it counts down with your use, and every recharge you add goes on top.";
      $("pp-bar").style.width = "0";
      $("pp-foot").innerHTML = `${lr ? `<div><dt>Last recharge</dt><dd>${money(lr.amount)}, ${esc(when(lr.ts))}</dd></div>` : ""}
        <div><dt>Energy you use a day</dt><dd>${money(p.per_day, 0)}</dd></div>`;
    } else {
      const lvl = p.balance <= p.low_alert ? "bad" : p.days_left != null && p.days_left <= Math.max(5, p.low_days) ? "warn" : "";
      card.className = `card balance-card reveal ${lvl}`;
      countUp($("pp-balance"), p.balance, (v) => money(v));
      $("pp-verdict").className = `verdict ${lvl === "bad" ? "lv-bad" : lvl === "warn" ? "lv-warn" : ""}`;
      $("pp-title").textContent = p.balance <= 0 ? "Probably used up" : p.days_left != null ? `About ${n(p.days_left, 1)} days left` : "Estimated";
      $("pp-text").textContent = (p.runs_out ? `At your last week's usage it runs out around ${when(p.runs_out)}. ` : "")
        + (p.to_month_end > 0 ? `Recharge about ${money(Math.ceil(p.to_month_end / 50) * 50)} to last until the end of the month.` : p.balance > 0 ? "Enough to last until the end of the month." : "");
      const full = p.synced_balance + p.credit;
      $("pp-bar").style.width = `${Math.max(0, Math.min(100, (100 * p.balance) / Math.max(1, full))).toFixed(0)}%`;
      $("pp-foot").innerHTML = `<div><dt>Energy a day</dt><dd>${money(p.per_day, 0)}</dd></div>
        <div><dt>Used since last check</dt><dd>${money(p.spent)}</dd></div>
        <div><dt>Credit added since</dt><dd>${money(p.credit)}</dd></div>
        <div><dt>Last checked</dt><dd>${esc(when(p.synced_at))}</dd></div>
        <div><dt>Monthly charges</dt><dd>${money(p.demand + p.meter_rent)} ${p.fixed_pending ? "due with the next recharge" : "paid this month"}</dd></div>`;
    }
    const recharges = p.history.filter((h) => h.kind === "recharge");
    $("pp-hist-note").textContent = recharges.length ? `${recharges.length} recharge${recharges.length > 1 ? "s" : ""}, ${money(recharges.reduce((a, r) => a + r.amount, 0))} in total` : "";
    $("pp-rows").innerHTML = p.history.length ? p.history.map((r) => {
      const k = r.breakdown;
      if (r.kind === "sync") {
        return `<tr><td>${esc(when(r.ts))}</td><td>Balance check</td><td class="num">${money(r.amount, 2)}</td><td colspan="6" class="small muted">${esc(r.note || "Meter balance typed in")}</td>
          <td><button class="linkbtn" data-pp-del="${r.id}">Remove</button></td></tr>`;
      }
      return `<tr><td>${esc(when(r.ts))}</td><td>Recharge <span class="pill ${k.source === "sms" ? "good" : ""} src">${k.source === "sms" ? "SMS" : "worked out"}</span></td>
        <td class="num">${money(r.amount)}</td><td class="num"><b>${money(k.energy, 2)}</b></td><td class="num">${k.meter_rent ? money(k.meter_rent) : "-"}</td>
        <td class="num">${k.demand ? money(k.demand) : "-"}</td><td class="num">${money(k.vat, 2)}</td><td class="num">${money(k.rebate, 2)}</td>
        <td>${r.details && r.details.token ? `<button class="linkbtn token" data-copy="${esc(r.details.token)}" data-tip="<b>Copy the token</b>">${esc(r.details.token)}</button>` : "-"}</td>
        <td><button class="linkbtn" data-pp-del="${r.id}">Remove</button></td></tr>`;
    }).join("") : '<tr><td colspan="10" class="muted">Nothing yet. Paste a recharge SMS above, or set the meter balance.</td></tr>';
    if (ppTab === "calc") calc();
  };
  $("pp-rows").addEventListener("click", async (e) => {
    const c = e.target.closest("[data-copy]");
    if (c) { navigator.clipboard.writeText(c.dataset.copy).then(() => toast("Token copied")).catch(() => toast("Couldn't copy", "bad")); return; }
    const b = e.target.closest("[data-pp-del]");
    if (!b || !(await confirmBox("Remove this entry?", "The balance estimate is recalculated without it.", "Remove"))) return;
    const r = await post("api/prepaid/delete", { id: Number(b.dataset.ppDel) });
    toast(r.ok ? "Removed" : "Not removed", r.ok ? "" : "bad");
    run("prepaid");
  });

  // ============================================================== QUALITY
  const qPicker = periodPicker($("q-period"), {
    presets: ["today", "yesterday", "d7", "d30", "month", "last_month", "custom"], initial: "today", key: "q", onChange: () => run("quality"),
  });
  loaders.quality = async () => {
    const [lo, hi] = qPicker.range(), now = Math.min(hi, NOW());
    const [q, s] = await Promise.all([api(`api/quality?from=${lo}&to=${now}`), status ? Promise.resolve(status) : refreshStatus()]);
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
        if (i && p.t - a[i - 1].t > q.group * 3) out.push({ x: a[i - 1].t + q.group, y: null });  // a gap: break the line
        out.push({ x: p.t, y: f(p[k]) });
      });
      return out;
    };
    const cutLine = (v, label) => (v ? [line(label, [{ x: lo, y: v }, { x: now, y: v }], css("--critical"), { borderDash: [6, 4], borderWidth: 1.5 })] : []);
    const xScale = { ...opts({ span }).scales.x, min: lo, max: now };
    chart("q-volt", {
      type: "line",
      data: { datasets: [
        line("Highest", xy("v_max"), fade(css("--series-1"), 50), { borderWidth: 1, fill: "+1", backgroundColor: fade(css("--series-1"), 14) }),
        line("Lowest", xy("v_min"), fade(css("--series-1"), 50), { borderWidth: 1 }),
        line("Average", xy("v_avg"), css("--series-1")),
        ...cutLine(r.over_v, "Over-voltage cut-off"), ...cutLine(r.low_v, "Low-voltage cut-off"),
      ] },
      options: { ...opts({ span, yTitle: "V", legend: true }), scales: { ...opts({ span }).scales, x: xScale } },
    });
    const xSmall = { ...xScale, ticks: { ...xScale.ticks, maxTicksLimit: 5 } };
    const small = (id, sets, yTitle, extra) => chart(id, { type: "line", data: { datasets: sets }, options: { ...opts({ span, yTitle, ...extra }), scales: { ...opts({ span, ...extra }).scales, x: xSmall } } });
    small("q-power", [line("Average", xy("w_avg", (v) => v / 1000), css("--series-2"), { fill: true, backgroundColor: fade(css("--series-2"), 15) }), line("Peak", xy("w_max", (v) => v / 1000), fade(css("--series-2"), 45), { borderWidth: 1 })], "kW", { yMin: 0 });
    small("q-hz", [line("Lowest", xy("hz_min"), css("--warning"), { borderWidth: 1.5 }), line("Highest", xy("hz_max"), css("--series-1"), { borderWidth: 1.5 })], "Hz");
    small("q-pf", [line("Power factor", xy("pf"), css("--good"))], "%", { yMax: 100 });
    small("q-temp", [line("Breaker", xy("t_max"), css("--serious")), ...cutLine(r.over_t, "Cut-off")], "°C");
    renderEvents($("q-events"), q.events.map((e) => ({ ...e, kind: "voltage" })), "No high or low voltage spells in this period.");
  };

  // ============================================================== APPLIANCES
  loaders.appliances = async () => {
    const a = await api("api/appliances");
    const apps = a.appliances.filter((x) => x.runs > 0), top = apps[0];
    const tiles = [
      ["Always-on load", a.base_w != null ? `${n(a.base_w)}<small>W</small>` : "-", a.base_cost_month != null ? `${money(a.base_cost_month)} a month, day and night` : "Needs a few days of readings"],
      ["Big loads found", n(apps.length), "Switching on and off as one step"],
      ["Biggest user", top ? esc(top.name || `${n(top.watts / 1000, 1)} kW load`) : "-", top ? `${n(top.kwh, 1)} kWh, ${money(top.cost)} in 30 days` : ""],
      ["Next unit costs", money(a.rate, 2), "This month's slab, VAT in"],
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
  };
  $("ap-rows").addEventListener("change", async (e) => {
    const i = e.target.closest("[data-ap]");
    if (!i) return;
    const r = await post("api/appliances/rename", { id: Number(i.dataset.ap), name: i.value });
    i.classList.toggle("unnamed", !i.value);
    toast(r.ok ? (i.value ? `Named “${i.value}”` : "Name cleared") : "Not saved", r.ok ? "" : "bad");
  });
  $("ap-rows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-ap-del]");
    if (!b || !(await confirmBox("Remove this load?", "Its runs are deleted too. If it keeps switching on and off it will be found again.", "Remove"))) return;
    await post("api/appliances/delete", { id: Number(b.dataset.apDel) });
    run("appliances");
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
  const lastMonth = () => { const d = new Date(); d.setDate(0); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  async function loadReport() {
    const r = await api(`api/report?kind=${repKind}${repKind === "monthly" ? `&month=${lastMonth()}` : ""}`);
    $("rep-text").innerHTML = waFormat(r.text);
  }
  $("rep-send").addEventListener("click", async () => {
    const r = await post("api/report/send", { kind: repKind, month: lastMonth() });
    toast(r.ok ? "Report sent on WhatsApp" : r.body.error || "Not sent", r.ok ? "" : "bad");
  });
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-test]");
    if (!b) return;
    const r = await post("api/test/alert", { channel: b.dataset.test });
    toast(r.ok ? `Test sent to ${b.textContent.replace("Test ", "")}` : r.body.error || "Not sent", r.ok ? "" : "bad");
  });
  loaders.alerts = async () => {
    const [set, rows] = await Promise.all([api("api/settings"), api("api/alerts")]);
    const v = set.values, yes = (k, ch) => (v[`alerts_${ch}`] || []).includes(k);
    $("al-matrix").innerHTML = `<table><thead><tr><th>Alert</th><th>Alexa</th><th>Phone</th><th>WhatsApp</th></tr></thead><tbody>${
      set.alert_kinds.map((k) => `<tr><td>${esc(KIND_LABEL[k] || k)}</td>${["alexa", "phone", "whatsapp"].map((ch) => `<td class="${yes(k, ch) ? "yes" : "no"}">${yes(k, ch) ? "On" : "Off"}</td>`).join("")}</tr>`).join("")
    }</tbody></table>
      <p class="small muted">Alexa: ${v.alexa_entities.length ? esc(v.alexa_entities.join(", ")) : "no Echo selected"}. Phone: ${esc(v.notify_service || "not set")}. WhatsApp: ${esc(v.whatsapp_to || "the WhatsApp Bridge's own number")}.</p>`;
    $("al-rows").innerHTML = rows.length ? rows.map((r) => `<li class="k-${["trip", "stayed_off", "power_cut"].includes(r.kind) ? "trip" : "off"}"><span class="ev-when">${esc(when(r.ts))}</span>
      <span class="ev-what"><b>${esc(KIND_LABEL[r.kind] || r.kind)}</b><span>${esc(r.text || "")}</span></span>
      <span class="small muted">${esc(r.channels ? r.channels.replace(/,/g, ", ") : "not sent")}</span></li>`).join("") : '<li class="empty-li">No alerts yet.</li>';
    loadReport();
  };

  // ============================================================== SETTINGS
  const HOURS = Array.from({ length: 24 }, (_, h) => [h, hourLabel(h)]);
  const SETTINGS_UI = [
    { id: "tariff", title: "Tariff and prepaid", note: "BERC residential rates from June 2026, the same for Palli Bidyut. Checked against your BREB token SMS.", fields: [
      { key: "sanctioned_load_kw", label: "Sanctioned load", type: "number", step: 0.5, unit: "kW", help: "On the token SMS: Demand Charge ÷ 42. 168 Tk means 4 kW." },
      { key: "tariff_slabs", label: "Price slabs", type: "lines", help: "One per line: units up to : price per unit. 0 means everything above, e.g. 0:17.35." },
      { key: "lifeline_units", label: "Lifeline up to", type: "number", unit: "units" },
      { key: "lifeline_rate", label: "Lifeline rate", type: "number", step: 0.01, unitKey: "currency" },
      { key: "demand_charge_per_kw", label: "Demand charge", type: "number", step: 0.01, unit: "per kW a month" },
      { key: "meter_rent", label: "Meter rent", type: "number", unitKey: "currency" },
      { key: "vat_percent", label: "VAT", type: "number", step: 0.1, unit: "%", help: "Taken out of each recharge (inside the amount you pay)." },
      { key: "prepaid_rebate_percent", label: "Prepaid rebate", type: "number", step: 0.1, unit: "%" },
      { key: "currency", label: "Currency", type: "text", short: true },
      { key: "low_balance_alert", label: "Low balance alert below", type: "number", unitKey: "currency" },
      { key: "low_balance_days", label: "Or when fewer than", type: "number", unit: "days are left" },
      { key: "slab_alerts", label: "Price slab warnings", type: "bool" },
      { key: "slab_warn_units", label: "Warn this many units before a slab", type: "number", unit: "units" },
    ] },
    { id: "alerts", title: "Alerts", note: "Which alerts go where.", fields: [
      { key: "alerts_matrix", label: "Alerts", type: "matrix" },
      { key: "voltage_warn_margin", label: "Warn when voltage is within", type: "number", unit: "V of a cut-off" },
      { key: "temperature_warn_margin", label: "Warn when temperature is within", type: "number", unit: "°C of the cut-off" },
    ] },
    { id: "restore", title: "Breaker staying off", note: "When the power comes back but the breaker doesn't, or it trips on bad voltage.", fields: [
      { key: "auto_restore", label: "Turn it back on automatically", type: "bool", help: "Only after a power cut or a voltage trip, once the voltage has been steady. Never after over-current, over-power or temperature trips." },
      { key: "auto_restore_delay_seconds", label: "Steady voltage for", type: "number", unit: "seconds" },
      { key: "repeat_minutes", label: "Remind every", type: "number", unit: "minutes", help: "While the breaker stays off after a trip." },
      { key: "repeat_max", label: "Reminders at most", type: "number" },
    ] },
    { id: "alexa", title: "Alexa", fields: [
      { key: "alexa_entities", label: "Echo devices", type: "players" },
      { key: "alexa_volume", label: "Announcement volume", type: "range" },
      { key: "alexa_quiet_hours", label: "Quiet hours", type: "windows" },
      { key: "critical_ignores_quiet_hours", label: "Trips still announced in quiet hours", type: "bool" },
      { key: "offline_tts_service", label: "Phone speaks if no Echo answers", type: "notify", help: "During a power cut your Echo may be unpowered. This phone (Home Assistant app) reads the alert aloud instead." },
    ] },
    { id: "phone", title: "Phone", fields: [{ key: "notify_service", label: "Notification service", type: "notify" }] },
    { id: "whatsapp", title: "WhatsApp and reports", note: "Through the PDC WhatsApp Bridge add-on. Leave the number and token empty to use the bridge's own.", fields: [
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
    { id: "detect", title: "Detection", note: "How power cuts and readings are judged.", fields: [
      { key: "min_outage_seconds", label: "Power cut after", type: "number", unit: "seconds", help: "The breaker has to be silent this long. Your router's daily reboot at 04:01 takes about 30 seconds, so keep this above 60." },
      { key: "nominal_voltage", label: "Normal voltage", type: "number", unit: "V" },
      { key: "voltage_offset", label: "Voltage correction", type: "number", unit: "V", step: 0.1, help: "Added to every reading, if the breaker reads high or low against a trusted meter." },
      { key: "energy_calibration_percent", label: "Energy correction", type: "number", unit: "%", step: 0.1, help: "If the prepaid meter counts more units than the breaker, e.g. 2 for +2%." },
      { key: "appliance_min_watts", label: "Smallest appliance step", type: "number", unit: "W" },
      { key: "breaker_prefix", label: "Breaker entity name", type: "text", help: "The part after switch. in the breaker's entity, e.g. energy_meter. Changing it restarts the add-on." },
      { key: "retention_days", label: "Keep minute readings for", type: "number", unit: "days", help: "Power cuts, trips and hourly energy are kept forever." },
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
  function settingsStatus(text, cls) { const st = $("settings-status"); st.className = `small ${cls || ""}`; st.textContent = text; }
  function settingsDirty() {
    const c = Object.keys(settingsChanges()).length;
    $("settings-save").disabled = !c;
    if (!$("settings-status").classList.contains("bad")) settingsStatus(c ? `${c} unsaved change${c > 1 ? "s" : ""}` : "");
  }
  async function openSettings(section) {
    settingsStatus("");
    $("settings-body").innerHTML = '<p class="muted">Loading...</p>';
    $("settings").showModal();
    try { settingsData = await api("api/settings"); } catch (e) { $("settings-body").innerHTML = '<p class="muted">Couldn\'t load the settings.</p>'; return; }
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
    toast(r.body.restart ? "Settings saved. The add-on is restarting" : "Settings saved");
    setTimeout(() => { $("settings").close(); oddsCache = null; refreshAll(); }, r.body.restart ? 8000 : 600);
  });

  // ------------------------------------------------------------------ polling
  setInterval(() => {
    if (document.hidden) return;
    if (tab === "live") loaders.live().catch(() => { $("foot").textContent = "Can't reach the add-on. Retrying..."; });
    else refreshStatus().catch(() => {});
  }, 5000);
  setInterval(() => { if (!document.hidden && tab === "live") loadStrip().catch(() => {}); }, 60000);

  osDark.addEventListener("change", () => applyTheme());
  setInterval(() => applyTheme(), 3000);
  applyTheme(true);
  setTab(location.hash.slice(1) || "live");
  window.addEventListener("hashchange", () => { const t = location.hash.slice(1); if (t !== tab) setTab(t); });
})();
