// Sentinel dashboard card (written to /config/www/sentinel/ by the Sentinel add-on).
// Shows Sentinel's own live grid and recent motion inside a Lovelace dashboard. The card
// opens a Home Assistant ingress session for the add-on, exactly like the sidebar panel
// does, so no ports are exposed and HA's login protects it.
//
//   type: custom:sentinel-card
//   height: calc(100vh - var(--header-height))   # optional, default 75vh
const SENTINEL_SLUG = "__SENTINEL_SLUG__";

class SentinelCard extends HTMLElement {
  setConfig(config) {
    this._config = { height: "75vh", ...config };
    if (this._frame) this._frame.parentElement.style.height = this._config.height;
  }

  static getStubConfig() {
    return {};
  }

  getCardSize() {
    return 12;
  }

  getGridOptions() {
    return { columns: "full", rows: 8, min_rows: 4 };
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._started && this.isConnected) this._start();
  }

  connectedCallback() {
    if (this._hass && !this._started) this._start();
  }

  disconnectedCallback() {
    clearInterval(this._keepAlive);
    this._started = false;
  }

  _ws(endpoint, method, data) {
    return this._hass.callWS({ type: "supervisor/api", endpoint, method, ...(data ? { data } : {}) });
  }

  _setCookie(session) {
    document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${location.protocol === "https:" ? ";Secure" : ""}`;
  }

  async _newSession() {
    const r = await this._ws("/ingress/session", "post");
    this._session = r.session;
    this._setCookie(r.session);
  }

  _render() {
    if (this._frame) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { overflow: hidden; background: #06080d; border-radius: var(--ha-card-border-radius, 12px); position: relative; }
        iframe { border: 0; width: 100%; height: 100%; display: block; background: #06080d; }
        .msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: #94a3b8; font: 14px/1.5 var(--paper-font-body1_-_font-family, sans-serif); }
      </style>
      <ha-card><iframe name="sentinel-card" allow="fullscreen; autoplay" allowfullscreen></iframe><div class="msg">Opening Sentinel…</div></ha-card>`;
    this._frame = root.querySelector("iframe");
    this._msg = root.querySelector(".msg");
    this._frame.parentElement.style.height = this._config.height;
    this._frame.addEventListener("load", () => (this._msg.style.display = "none"));
  }

  async _start() {
    this._started = true;
    this._render();
    try {
      const info = await this._ws(`/addons/${SENTINEL_SLUG}/info`, "get");
      if (info.state !== "started") throw new Error("the Sentinel add-on isn't running");
      await this._newSession();
      if (!this._frame.src) this._frame.src = `${info.ingress_url}#/embed`;
      clearInterval(this._keepAlive);
      this._keepAlive = setInterval(async () => {
        try {
          await this._ws("/ingress/validate_session", "post", { session: this._session });
          this._setCookie(this._session);
        } catch {
          this._newSession().catch(() => {});
        }
      }, 60000);
    } catch (e) {
      this._started = false;
      this._msg.style.display = "flex";
      this._msg.textContent = `Couldn't open Sentinel: ${e?.message || e}. Retrying…`;
      setTimeout(() => this._hass && !this._started && this.isConnected && this._start(), 15000);
    }
  }
}

if (!customElements.get("sentinel-card")) customElements.define("sentinel-card", SentinelCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "sentinel-card")) {
  window.customCards.push({ type: "sentinel-card", name: "Sentinel", description: "Live cameras and recent motion from the Sentinel add-on", preview: false });
}
