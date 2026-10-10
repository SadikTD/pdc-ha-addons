"use strict";

const SIGN_IN_URL = "https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1";
const COOKIE_PAGE = "https://auth.riotgames.com/userinfo";
const CURRENCY = {
  vp: "https://media.valorant-api.com/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/displayicon.png",
  rad: "https://media.valorant-api.com/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png",
  kc: "https://media.valorant-api.com/currencies/85ca954a-41f2-ce94-9b45-8ca3dd39a00d/displayicon.png",
};

let S = null;          // /api/state
let H = null;          // /api/history (loaded when the tab opens)
let C = null;          // /api/catalog (loaded when the wishlist tab opens)
let O = null;          // /api/collection (loaded when the collection tab opens)
let stripAnimated = false;
const ui = { historyQuery: "", wishQuery: "", weapon: "All", shown: 48, colWeapon: "All", colQuery: "" };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (n ?? 0).toLocaleString();

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(text, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.className = "toast show" + (error ? " error" : "");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = "toast" + (error ? " error" : "")), error ? 6000 : 3200);
}

// ---------- formatting

function left(ts) {
  const s = Math.max(0, ts - Date.now() / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  return `${m} m`;
}
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayLabel = (day, opts = { weekday: "short", month: "short", day: "numeric" }) =>
  new Date(day + "T12:00:00Z").toLocaleDateString([], opts);
function ago(ts) {
  if (!ts) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const stamp = (ts) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const tierOf = (uuid) => (S?.tiers || C?.tiers || H?.tiers || {})[uuid];
const tierStyle = (uuid) => (tierOf(uuid) ? ` style="--tier:${tierOf(uuid).c}"` : "");
const tierIcon = (uuid) => (tierOf(uuid)?.i ? `<img class="tier-icon" src="${esc(tierOf(uuid).i)}" alt="${esc(tierOf(uuid).n)} edition" title="${esc(tierOf(uuid).n)} edition">` : "");
const vp = (n) => (n == null ? "" : `<span class="price" title="${num(n)} Valorant Points"><img src="${CURRENCY.vp}" alt="">${num(n)} <small>VP</small></span>`);
const wanted = (skin) => (S?.wishlist || []).some((w) => w.skin === skin);
const owned = (skin) => (S?.owned || []).includes(skin);

// ---------- header

function renderTop() {
  const acc = S.account;
  $("#account").innerHTML = acc ? `<b>${esc(acc.name || "Signed in")}</b> ${acc.region ? `on ${esc(acc.region.toUpperCase())}` : ""}` : "Not signed in";
  const w = S.today?.wallet;
  $("#wallet").innerHTML = w && Object.keys(w).length ? [["vp", "VP", "Valorant Points: buys skins and bundles"],
    ["rad", "Radianite", "Radianite Points: upgrades skin levels"], ["kc", "Kingdom Credits", "Kingdom Credits: buys accessories"]]
    .map(([k, label, tip]) => `<span title="${tip}"><img src="${CURRENCY[k]}" alt="">${num(w[k])} <small>${label}</small></span>`).join("") : "";
  const btn = $("#refresh");
  btn.disabled = S.status.checking;
  btn.textContent = S.status.checking ? "Checking…" : "Check now";
  btn.hidden = !S.auth || S.auth.state === "missing";
}

// ---------- today

function huntPanel() {
  const target = S.wishlist[0];
  if (!target) {
    return `<div class="panel"><h3>Nothing on your wishlist</h3><p class="muted">Add the skin you're waiting for and you'll get a WhatsApp message the day it shows up.</p><a class="btn" href="#wishlist">Choose a skin</a></div>`;
  }
  const t = S.today;
  const inStore = t?.offers.find((o) => o.skin === target.skin);
  const inNight = t?.night?.offers.find((o) => o.skin === target.skin);
  const found = !!(inStore || inNight);
  let status;
  if (owned(target.skin)) status = "It's in your collection, so no more alerts for it. Pick a new main target on the Wishlist tab.";
  else if (inStore) status = `It's in your store right now for ${num(inStore.cost)} VP. It leaves in ${left(t.expires_at)}.`;
  else if (inNight) status = `It's in your Night Market for ${num(inNight.cost)} VP (${inNight.percent}% off). The Night Market ends in ${left(t.night.expires_at)}.`;
  else if (t) status = `Not in today's store. The next store opens in ${left(t.expires_at)}, at ${clock(t.expires_at)}.`;
  else status = "Waiting for the first store check.";

  const todayKey = S.hunt.strip[S.hunt.strip.length - 1]?.day;
  const ticks = S.hunt.strip.map((d, i) => {
    const cls = { target: "hit", other: "other", none: "miss" }[d.hit] || "";
    const label = `${dayLabel(d.day)}: ${{ target: `${target.name} was in your store`, other: "another wishlist skin was in your store",
      none: "no wishlist skin" }[d.hit] || "not checked"}`;
    return `<i class="${cls}${d.day === todayKey ? " today" : ""}" style="--i:${i}" title="${label}"></i>`;
  }).join("");
  const animate = !stripAnimated ? " animate" : "";
  stripAnimated = true;
  return `
  <article class="hunt${found ? " found" : ""}" aria-live="polite">
    <div class="hunt-art"><img src="${esc(target.icon)}" alt=""></div>
    <div class="hunt-body">
      <div class="hunt-kicker">${found ? "Found it" : "You're waiting for"}</div>
      <h1 class="hunt-name">${esc(target.name)}</h1>
      <div class="hunt-status">${status}</div>
      <div class="hunt-facts">
        <div><b>${num(S.hunt.days_tracked)}</b><span>stores checked</span></div>
        <div><b>${num(target.times_seen)}</b><span>times seen</span></div>
        <div><b>${target.last_seen ? dayLabel(target.last_seen, { month: "short", day: "numeric" }) : "Not yet"}</b><span>last in your store</span></div>
      </div>
      <div>
        <div class="strip${animate}" role="img" aria-label="The last 60 stores">${ticks}</div>
        <div class="strip-legend"><span>60 days ago</span>
          <span class="keys"><span><i class="key hit"></i>${esc(target.name)}</span>${S.wishlist.length > 1 ? `<span><i class="key other"></i>Other wishlist skins</span>` : ""}</span>
          <span>Today</span></div>
      </div>
    </div>
  </article>`;
}

function skinCard(o, extra = "") {
  const cls = owned(o.skin) ? " owned" : wanted(o.skin) ? " wanted" : "";
  return `<div class="card${cls}"${tierStyle(o.tier)}>
    ${tierIcon(o.tier)}${extra}
    <div class="art">${o.icon ? `<img src="${esc(o.icon)}" alt="" loading="lazy">` : ""}</div>
    <div class="meta"><div class="name">${esc(o.name)}</div><div class="prices">${o.was ? `<span class="price"><s>${num(o.was)}</s></span>` : ""}${vp(o.cost)}</div></div>
  </div>`;
}

function bundleBlock(b) {
  const items = b.items.map((it) => `<div${it.skin && owned(it.skin) ? ' class="owned"' : ""}${tierStyle(it.tier)} title="${esc(it.name)}${it.skin && owned(it.skin) ? " (you own this)" : ""}">
      ${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy">` : `<img alt="">`}
      <span>${esc(it.name)}</span><em>${it.price != null ? num(it.price) + " VP" : ""}</em></div>`).join("");
  return `<article class="bundle" style="background-image:url('${esc(b.icon)}')">
    <h3>${esc(b.name)}</h3>
    <div class="row">${vp(b.price)}${b.base > b.price ? `<span class="price"><s>${num(b.base)} VP</s></span>` : ""}
      <span class="muted">Leaves in ${left(b.expires_at)}</span></div>
    <div class="bundle-items">${items}</div>
  </article>`;
}

function renderToday() {
  const v = $("#view-today");
  const auth = S.auth.state;
  if (!S.today && (auth === "missing" || auth === "expired")) {
    v.innerHTML = `<div class="empty"><h2>Sign in to start tracking</h2>
      <p>Paste your Riot session cookie once and your store will be checked every day, even when your PC is off.</p>
      <a class="btn" href="#settings">Go to sign-in</a></div>`;
    return;
  }
  let html = "";
  if (auth === "expired") {
    html += `<div class="notice"><span>Riot signed this tracker out ${ago(S.auth.expired_at)}, so your store isn't being checked. Sign in again to resume.</span><a class="btn small" href="#settings">Sign in again</a></div>`;
  } else if (S.status.error && S.status.error_kind !== "expired") {
    html += `<div class="notice"><span>The last check didn't work: ${esc(S.status.error)} Retrying ${S.status.next_check ? "in " + left(S.status.next_check) : "soon"}.</span></div>`;
  }
  html += huntPanel();
  const t = S.today;
  if (t) {
    const stale = t.expires_at < Date.now() / 1000;
    html += `<h2>Today's store <small>${stale ? "This store has ended; checking for the new one" : `Changes in ${left(t.expires_at)}, at ${clock(t.expires_at)}`}</small></h2>
      <div class="grid">${t.offers.map((o) => skinCard(o)).join("")}</div>`;
    for (const b of t.bundles) html += `<h2>Featured bundle <small>${b.items.length} items</small></h2>${bundleBlock(b)}`;
    if (t.night) {
      html += `<h2>Night Market <small>Ends in ${left(t.night.expires_at)}</small></h2>
        <div class="grid six">${t.night.offers.map((o) => skinCard(o, `<span class="badge">-${o.percent}%</span>`)).join("")}</div>`;
    } else {
      html += `<h2>Night Market <small>Not running right now. When it opens, its six skins show up here.</small></h2>`;
    }
    html += `<p class="muted">Last checked ${ago(S.status.last_ok || t.fetched_at)}${S.status.next_check ? `. Next check in ${left(S.status.next_check)}` : ""}.</p>`;
  }
  v.innerHTML = html;
}

// ---------- history

function renderHistory() {
  const v = $("#view-history");
  if (!H) { v.innerHTML = `<p class="muted">Loading history…</p>`; return; }
  if (!H.days.length) {
    v.innerHTML = `<div class="empty"><h2>No stores recorded yet</h2><p>Every daily store is saved here after the first check.</p></div>`;
    return;
  }
  const q = ui.historyQuery.trim().toLowerCase();
  const wl = new Set(H.wishlist);
  const days = q ? H.days.filter((d) => d.offers.some((o) => o.name.toLowerCase().includes(q))) : H.days;
  const rows = days.map((d) => `<div class="day">
      <div class="day-date"><b>${dayLabel(d.day, { month: "short", day: "numeric" })}</b><span>${dayLabel(d.day, { weekday: "long" })}${d.night ? "<br>Night Market on" : ""}</span></div>
      <div class="day-offers">${d.offers.map((o) => `<div class="mini${wl.has(o.skin) ? " wanted" : ""}${q && o.name.toLowerCase().includes(q) ? " match" : ""}"${tierStyle(o.tier)} title="${esc(o.name)}${o.cost ? `, ${num(o.cost)} VP` : ""}">
        ${o.icon ? `<img src="${esc(o.icon)}" alt="" loading="lazy">` : ""}<span>${esc(o.name)}</span></div>`).join("")}</div>
    </div>`).join("");
  const top = H.most_seen.map((o) => `<li><img src="${esc(o.icon)}" alt="" loading="lazy"><span>${esc(o.name)}</span><b>${o.times}×</b></li>`).join("");
  v.innerHTML = `<div class="history">
    <div>
      <h2>Every store <small>${num(H.days.length)} days recorded</small></h2>
      <input type="search" id="history-q" placeholder="Find a skin, e.g. Reaver" value="${esc(ui.historyQuery)}" aria-label="Find a skin in your history">
      <div style="margin-top:8px">${rows || `<p class="muted">No store had a skin matching "${esc(ui.historyQuery)}".</p>`}</div>
    </div>
    <aside class="sticky"><h2>Seen most often</h2><ul class="ranked">${top}</ul></aside>
  </div>`;
  const input = $("#history-q");
  input.addEventListener("input", () => {
    ui.historyQuery = input.value;
    const pos = input.selectionStart;
    renderHistory();
    const again = $("#history-q");
    again.focus();
    again.setSelectionRange(pos, pos);
  });
}

// ---------- wishlist

function renderWishlist() {
  const v = $("#view-wishlist");
  const list = S.wishlist.map((w, i) => `<div class="card${i === 0 ? " target" : ""}"${tierStyle(w.tier)}>
      ${tierIcon(w.tier)}
      <div class="art">${w.icon ? `<img src="${esc(w.icon)}" alt="" loading="lazy">` : ""}</div>
      <div class="name">${esc(w.name)}</div>
      <div class="facts">${owned(w.skin) ? "<b>You own this.</b> " : ""}${i === 0 ? "Your main target, shown on Today. " : ""}Seen ${w.times_seen} time${w.times_seen === 1 ? "" : "s"}${w.last_seen ? `, last on ${dayLabel(w.last_seen)}` : ""}.</div>
      <div class="actions">
        ${i ? `<button class="btn small ghost" data-first="${w.skin}">Make main target</button>` : ""}
        <button class="btn small ghost" data-remove="${w.skin}">Remove</button>
      </div>
    </div>`).join("");

  v.innerHTML = `
    <h2>Your wishlist <small>You get a WhatsApp message when any of these is in your store${S.settings.night_market_alerts ? " or Night Market" : ""}.</small></h2>
    ${S.wishlist.length ? `<div class="grid">${list}</div>` : `<p class="muted">Empty. Pick skins below.</p>`}
    <h2>Add skins <small>${C ? `${num(C.skins.length)} skins can show up in the store` : ""}</small></h2>
    <div class="wish-search"><input type="search" id="wish-q" placeholder="Search, e.g. Butterfly, Prime, Kuronami" value="${esc(ui.wishQuery)}" aria-label="Search skins"></div>
    <div class="chips" id="wish-weapons" role="group" aria-label="Weapon"></div>
    <div id="wish-results"></div>`;

  $("#wish-q").addEventListener("input", (ev) => { ui.wishQuery = ev.target.value; ui.shown = PAGE; renderSkinResults(); });
  v.onclick = wishlistClick; // one handler, however often the tab redraws
  renderSkinResults();
}

const PAGE = 48;
const WEAPON_ORDER = ["Melee", "Vandal", "Phantom", "Operator", "Sheriff", "Spectre", "Ghost", "Classic"];

function renderSkinResults() {
  const box = $("#wish-results");
  if (!box) return;
  if (!C) { box.innerHTML = `<p class="muted">${C === false ? "Couldn't load the skin list. Open this tab again to retry." : "Loading skins…"}</p>`; return; }
  const weapons = [...new Set(C.skins.map((s) => s.w).filter(Boolean))]
    .sort((a, b) => ((WEAPON_ORDER.indexOf(a) + 1 || 99) - (WEAPON_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  $("#wish-weapons").innerHTML = ["All", ...weapons].map((w) =>
    `<button type="button" data-weapon="${esc(w)}" aria-pressed="${ui.weapon === w}">${esc(w)}</button>`).join("");

  const q = ui.wishQuery.trim().toLowerCase();
  const matches = C.skins.filter((s) => (ui.weapon === "All" || s.w === ui.weapon) && (!q || s.n.toLowerCase().includes(q)));
  const onList = new Set(S.wishlist.map((w) => w.skin));
  const cards = matches.slice(0, ui.shown).map((s) => {
    const on = onList.has(s.u), mine = owned(s.u);
    return `<div class="card"${tierStyle(s.t)}>${tierIcon(s.t)}
      <div class="art">${s.i ? `<img src="${esc(s.i)}" alt="" loading="lazy">` : ""}</div>
      <div class="name" style="font-size:17px">${esc(s.n)}</div>
      ${mine ? `<button class="btn small ghost" disabled>You own this</button>`
        : `<button class="btn small${on ? " ghost" : ""}" data-add="${s.u}" ${on ? "disabled" : ""}>${on ? "On your wishlist" : "Add to wishlist"}</button>`}
    </div>`;
  }).join("");
  box.innerHTML = matches.length
    ? `<div class="grid six results">${cards}</div>${matches.length > ui.shown
      ? `<div class="field-row" style="justify-content:center;margin-top:18px"><button class="btn ghost" type="button" data-more>Show more (${num(matches.length - ui.shown)} left)</button></div>` : ""}`
    : `<p class="muted">No ${ui.weapon === "All" ? "" : esc(ui.weapon) + " "}skin matches "${esc(ui.wishQuery)}". Try part of the name, like "Prime".</p>`;
}

async function wishlistClick(ev) {
  const b = ev.target.closest("button");
  if (!b) return;
  if (b.dataset.weapon) { ui.weapon = b.dataset.weapon; ui.shown = PAGE; renderSkinResults(); return; }
  if ("more" in b.dataset) { ui.shown += PAGE; renderSkinResults(); return; }
  const skin = b.dataset.add || b.dataset.remove || b.dataset.first;
  if (!skin) return;
  b.disabled = true;
  try {
    await api("api/wishlist", { skin, remove: !!b.dataset.remove, first: !!b.dataset.first });
    toast(b.dataset.add ? "Added to your wishlist" : b.dataset.remove ? "Removed from your wishlist" : "Main target changed");
    const y = scrollY;
    await load();
    scrollTo(0, y);
  } catch (e) { toast(e.message, true); b.disabled = false; }
}

// ---------- collection

function renderCollection() {
  const v = $("#view-collection");
  if (!O) { v.innerHTML = `<p class="muted">Loading your collection…</p>`; return; }
  if (!O.skins.length) {
    v.innerHTML = `<div class="empty"><h2>No skins yet</h2><p>${S.auth.state === "ok"
      ? "Your collection is read on every store check. Press Check now if you just bought something." : "Sign in on the Settings tab to see the skins you own."}</p></div>`;
    return;
  }
  const weapons = [...new Set(O.skins.map((s) => s.w).filter(Boolean))]
    .sort((a, b) => ((WEAPON_ORDER.indexOf(a) + 1 || 99) - (WEAPON_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  const count = (w) => O.skins.filter((s) => w === "All" || s.w === w).length;
  v.innerHTML = `
    <h2>Your collection <small>${num(O.skins.length)} skins${O.at ? `, updated ${ago(O.at)}` : ""}</small></h2>
    <div class="wish-search"><input type="search" id="col-q" placeholder="Search your skins" value="${esc(ui.colQuery)}" aria-label="Search your skins"></div>
    <div class="chips" role="group" aria-label="Weapon">${["All", ...weapons].map((w) =>
      `<button type="button" data-col-weapon="${esc(w)}" aria-pressed="${ui.colWeapon === w}">${esc(w)} <span class="count">${count(w)}</span></button>`).join("")}</div>
    <div id="col-results"></div>`;
  $("#col-q").addEventListener("input", (ev) => { ui.colQuery = ev.target.value; renderCollectionResults(); });
  v.onclick = (ev) => {
    const b = ev.target.closest("[data-col-weapon]");
    if (!b) return;
    ui.colWeapon = b.dataset.colWeapon;
    v.querySelectorAll("[data-col-weapon]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderCollectionResults();
  };
  renderCollectionResults();
}

function renderCollectionResults() {
  const q = ui.colQuery.trim().toLowerCase();
  const list = O.skins.filter((s) => (ui.colWeapon === "All" || s.w === ui.colWeapon) && (!q || s.n.toLowerCase().includes(q)));
  $("#col-results").innerHTML = list.length ? `<div class="grid six">${list.map((s) => `<div class="card"${tierStyle(s.t)}>
      ${tierIcon(s.t)}
      <div class="art">${s.i ? `<img src="${esc(s.i)}" alt="" loading="lazy">` : ""}</div>
      <div class="name" style="font-size:17px">${esc(s.n)}</div>
    </div>`).join("")}</div>` : `<p class="muted">None of your ${ui.colWeapon === "All" ? "" : esc(ui.colWeapon) + " "}skins match "${esc(ui.colQuery)}".</p>`;
}

// ---------- settings

function renderSettings() {
  const v = $("#view-settings");
  const a = S.auth;
  const stateLine = {
    ok: `<span class="state good">Signed in${S.account?.name ? " as " + esc(S.account.name) : ""}</span> <span class="muted">Session renewed ${ago(a.refreshed_at)}.</span>`,
    expired: `<span class="state bad">Signed out by Riot ${ago(a.expired_at)}</span> <span class="muted">Paste a fresh ssid cookie below.</span>`,
    missing: `<span class="state">Not signed in</span>`,
  }[a.state] || `<span class="state">Session saved</span>`;
  const log = S.events.map((e) => `<li class="${esc(e.kind)}"><time>${stamp(e.ts)}</time><span>${esc(e.text)}</span></li>`).join("");

  v.innerHTML = `<div class="cols">
    <div>
      <div class="panel">
        <h3>Riot sign-in</h3>
        <p>${stateLine}</p>
        <p class="muted">Riot's sign-in has a captcha, so the tracker uses your browser's session cookie instead of your password. It renews itself on every check; if Riot ever ends the session you'll get a WhatsApp message to paste a new one.</p>
        <ol class="steps">
          <li><a href="${SIGN_IN_URL}" target="_blank" rel="noopener">Sign in to Riot</a> in this browser. Tick <b>Stay signed in</b>, it makes the session last much longer.</li>
          <li>Then open <a href="${COOKIE_PAGE}" target="_blank" rel="noopener">auth.riotgames.com</a> in the same browser. It's fine if the page only shows an error.</li>
          <li>Press <kbd>F12</kbd>, go to <b>Application</b> (Firefox: <b>Storage</b>) &gt; <b>Cookies</b> &gt; <code>https://auth.riotgames.com</code>.</li>
          <li>Double-click the value of the cookie named <code>ssid</code>, copy it and paste it here.</li>
        </ol>
        <textarea id="cookie" placeholder="Paste the ssid value here (a long string starting with eyJ…)" spellcheck="false" autocomplete="off"></textarea>
        <div class="field-row">
          <button class="btn" id="signin" type="button">${a.state === "ok" ? "Replace session" : "Sign in"}</button>
          ${a.state !== "missing" ? `<button class="btn ghost" id="signout" type="button">Sign out</button>` : ""}
        </div>
        <p class="muted" style="font-size:14px">The cookie is stored only on your Home Assistant (in this add-on's private data folder) and is sent only to Riot. Checking the store this way isn't officially supported by Riot.</p>
      </div>
    </div>
    <div>
      <div class="panel">
        <h3>WhatsApp alerts</h3>
        <p>${S.whatsapp.ready ? `<span class="state good">Sending to ${esc(S.whatsapp.to)}</span> <span class="muted">through the PDC WhatsApp Bridge.</span>` :
          `<span class="state bad">Not connected</span> <span class="muted">The PDC WhatsApp Bridge add-on wasn't found. It's picked up automatically once it's installed and running.</span>`}</p>
        <div class="field-row"><button class="btn ghost small" id="test-wa" type="button" ${S.whatsapp.ready ? "" : "disabled"}>Send test message</button></div>
        <div style="margin-top:16px">
          <label class="toggle"><input type="checkbox" id="opt-night" ${S.settings.night_market_alerts ? "checked" : ""}>
            <div>Night Market alerts<span>Also message me when a wishlist skin is in my Night Market.</span></div></label>
          <label class="toggle"><input type="checkbox" id="opt-digest" ${S.settings.daily_digest ? "checked" : ""}>
            <div>Daily store message<span>Send all four skins every day, not only wishlist matches.</span></div></label>
        </div>
      </div>
      <div class="panel">
        <h3>Activity</h3>
        ${log ? `<ul class="log">${log}</ul>` : `<p class="muted">Nothing yet.</p>`}
      </div>
    </div>
  </div>`;

  $("#signin").addEventListener("click", async (ev) => {
    const cookie = $("#cookie").value.trim();
    if (!cookie) { toast("Paste the ssid cookie first.", true); $("#cookie").focus(); return; }
    ev.target.disabled = true;
    ev.target.textContent = "Signing in…";
    try {
      const r = await api("api/login", { cookie });
      toast(`Signed in${r.name ? " as " + r.name : ""}. Your store is loaded.`);
      await load();
      location.hash = "#today";
    } catch (e) {
      toast(e.message, true);
      ev.target.disabled = false;
      ev.target.textContent = "Sign in";
    }
  });
  $("#signout")?.addEventListener("click", async () => {
    if (!confirm("Sign out? Your store won't be checked until you sign in again. History is kept.")) return;
    await api("api/logout", {});
    toast("Signed out");
    await load();
  });
  $("#test-wa").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    try { await api("api/test-whatsapp", {}); toast("Test message sent. Check WhatsApp."); }
    catch (e) { toast(e.message, true); }
    ev.target.disabled = false;
  });
  for (const [id, key] of [["#opt-night", "night_market_alerts"], ["#opt-digest", "daily_digest"]]) {
    $(id).addEventListener("change", async (ev) => {
      try { await api("api/settings", { [key]: ev.target.checked }); S.settings[key] = ev.target.checked; toast("Saved"); }
      catch (e) { toast(e.message, true); ev.target.checked = !ev.target.checked; }
    });
  }
}

// ---------- routing and refresh

function tab() { return (location.hash.slice(1) || "today").split("?")[0]; }

async function render(background = false) {
  const t = ["today", "history", "wishlist", "collection", "settings"].includes(tab()) ? tab() : "today";
  document.querySelectorAll(".tabs a").forEach((a) => a.setAttribute("aria-selected", a.dataset.tab === t));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + t));
  renderTop();
  if (background && t !== "today") return; // don't redraw a tab the user may be typing in
  if (t === "today") renderToday();
  if (t === "history") {
    renderHistory();
    if (!H) {
      try { H = await api("api/history"); } catch (e) { toast(e.message, true); return; }
      renderHistory();
    }
  }
  if (t === "wishlist") {
    renderWishlist();
    if (!C) {
      try { C = await api("api/catalog"); } catch (e) { C = false; toast(e.message, true); }
      renderSkinResults();
      if (C === false) C = null; // retry next time the tab opens
      else $("#view-wishlist h2:nth-of-type(2) small").textContent = `${num(C.skins.length)} skins can show up in the store`;
    }
  }
  if (t === "collection") {
    renderCollection();
    if (!O) {
      try { O = await api("api/collection"); } catch (e) { toast(e.message, true); return; }
      renderCollection();
    }
  }
  if (t === "settings") renderSettings();
}

async function load(background = false) {
  S = await api("api/state");
  if (!background) H = O = null;
  await render(background);
}

$("#refresh").addEventListener("click", async (ev) => {
  ev.target.disabled = true;
  ev.target.textContent = "Checking…";
  try { await api("api/refresh", {}); toast("Store checked"); }
  catch (e) { toast(e.message, true); }
  await load();
});

window.addEventListener("hashchange", () => render());
load().catch((e) => { $("#view-today").hidden = false; $("#view-today").innerHTML = `<div class="empty"><h2>Can't reach the tracker</h2><p>${esc(e.message)}</p></div>`; });
setInterval(() => { if (!document.hidden) load(true).catch(() => {}); }, 60000);
