"""Valorant Store Tracker - Home Assistant add-on.

Signs in to Riot with a saved session cookie (ssid), reads the daily store, featured
bundle, Night Market and wallet, keeps every day's store in SQLite, and sends a
WhatsApp message through the PDC WhatsApp Bridge when a wishlist skin shows up.

Riot's store API is unofficial (the same endpoints the game client uses), so it can
change without notice.
"""

import base64
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("VALSTORE_DATA_DIR", "/data")
OPTIONS_PATH = os.path.join(DATA_DIR, "options.json")
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")
AUTH_PATH = os.path.join(DATA_DIR, "auth.json")
CATALOG_PATH = os.path.join(DATA_DIR, "catalog.json")
DB_PATH = os.path.join(DATA_DIR, "store.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
HTTP_PORT = int(os.environ.get("VALSTORE_PORT", "38766"))
# Ingress proxies from the Supervisor; anything else is refused (None = local development).
ALLOWED_CLIENTS = None if os.environ.get("VALSTORE_DEV") else {"172.30.32.2", "127.0.0.1", "::1"}

DEFAULT_OPTIONS = {"whatsapp_to": "", "whatsapp_api_token": "", "whatsapp_bridge_url": "", "check_every_hours": 6}
REAVER_BUTTERFLY_KNIFE = "81c37ac1-48d4-9747-7fd6-56932358a3fe"
DEFAULT_SETTINGS = {"wishlist": [REAVER_BUTTERFLY_KNIFE], "daily_digest": False, "night_market_alerts": True}

VP, RAD, KC = ("85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741", "e59aa87c-4cbf-517a-5983-6e81511be9b7",
               "85ca954a-41f2-ce94-9b45-8ca3dd39a00d")
ITEM_KINDS = {"e7c63390-eda7-46e0-bb7a-a6abdacd2433": "skin", "dd3bf334-87f3-40bd-b043-682a57a8dc3a": "buddy",
              "3f296c07-64c3-494c-923b-fe692a4fa1bd": "card", "d5f120f8-ff8c-4aac-92ea-f2b5acbe9475": "spray",
              "de7caa6b-adf7-4588-bbd1-143831e786c6": "title"}
SHARDS = {"na": "na", "latam": "na", "br": "na", "pbe": "pbe", "eu": "eu", "ap": "ap", "kr": "kr"}

RIOT_UA = "ShooterGame/13 Windows/10.0.19043.1.256.64bit"
PLATFORM = base64.b64encode(json.dumps({
    "platformType": "PC", "platformOS": "Windows",
    "platformOSVersion": "10.0.19042.1.256.64bit", "platformChipset": "Unknown"}).encode()).decode()
AUTHORIZE_URL = ("https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in"
                 "&client_id=play-valorant-web-prod&response_type=token%20id_token&scope=account%20openid&nonce=1")

log = logging.getLogger("valorant_store")


# ------------------------------------------------------------------ storage

def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    """Atomic, so a power cut can't leave half a file."""
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + ".tmp", path)


OPTS = {**DEFAULT_OPTIONS, **{k: v for k, v in read_json(OPTIONS_PATH, {}).items() if v is not None}}
SETTINGS = {**DEFAULT_SETTINGS, **read_json(SETTINGS_PATH, {})}
AUTH = read_json(AUTH_PATH, {})  # {"cookies": {...}, "puuid", "name", "region", "saved_at", "state"}
auth_lock = threading.Lock()


def save_settings():
    write_json(SETTINGS_PATH, SETTINGS)


def save_auth():
    write_json(AUTH_PATH, AUTH)


class DB:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, fetched_at REAL, data TEXT);
            CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, sent_at REAL, text TEXT, ok INTEGER);
            CREATE TABLE IF NOT EXISTS events (ts REAL, kind TEXT, text TEXT);
        """)

    def q(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def x(self, sql, args=()):
        with self.lock, self.conn:
            self.conn.execute(sql, args)


db = None


def event(kind, text):
    log.info("%s: %s", kind, text)
    db.x("INSERT INTO events VALUES (?,?,?)", (time.time(), kind, text))
    db.x("DELETE FROM events WHERE ts < ?", (time.time() - 60 * 86400,))


# ------------------------------------------------------------------ http client

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def http(method, url, headers=None, body=None, timeout=30):
    """Returns (status, headers, parsed JSON or raw bytes). Redirects are not followed.
    Raises RiotError("network") when the server can't be reached."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "User-Agent": RIOT_UA, **({"Content-Type": "application/json"} if data else {}), **(headers or {})})
    try:
        resp = _opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        resp = e
    except OSError as e:
        raise RiotError("network", f"Couldn't reach {urllib.parse.urlsplit(url).hostname}: {e}")
    raw = resp.read() or b""
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = raw
    return resp.status if hasattr(resp, "status") else resp.code, resp.headers, parsed


class RiotError(Exception):
    """kind: expired (cookie no longer works), maintenance, network, api."""

    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


# ------------------------------------------------------------------ riot auth

def parse_cookie_input(text):
    """Accepts a bare ssid value, 'ssid=...', or a whole Cookie header copied from the
    browser ('a=b; ssid=c; ...'). Returns {name: value}; must contain ssid."""
    text = (text or "").strip().strip('"\'')
    if text.lower().startswith("cookie:"):
        text = text[7:].strip()
    if "=" not in text:
        return {"ssid": text} if text else {}
    cookies = {}
    for part in re.split(r";\s*|\n", text):
        name, sep, value = part.strip().partition("=")
        if sep and name and value and name.lower() not in {"path", "domain", "expires", "max-age", "samesite"}:
            cookies[name.strip()] = value.strip()
    return cookies


def merge_set_cookies(cookies, headers):
    """Riot rotates the session cookies on every sign-in; keeping the new ones is what
    keeps the login alive longer."""
    out = dict(cookies)
    for line in headers.get_all("Set-Cookie") or []:
        name, _, rest = line.partition("=")
        value = rest.split(";", 1)[0]
        if value:
            out[name.strip()] = value
        else:
            out.pop(name.strip(), None)
    return out


def reauth(cookies):
    """Trades the saved cookies for a fresh access token (valid ~1 h)."""
    header = "; ".join(f"{k}={v}" for k, v in cookies.items())
    status, headers, _ = http("GET", AUTHORIZE_URL, {"Cookie": header})
    location = headers.get("Location") or ""
    if "access_token=" not in location:
        if status in (301, 302, 303) and "login" in location:
            raise RiotError("expired", "Riot signed this session out. Paste a fresh ssid cookie.")
        raise RiotError("api", f"Riot sign-in answered {status}; will retry.")
    frag = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(location).fragment))
    return frag["access_token"], frag.get("id_token", ""), merge_set_cookies(cookies, headers)


def _check(status, body, what):
    if status == 200:
        return body
    err = body if isinstance(body, dict) else {}
    if err.get("errorCode") == "BAD_CLAIMS" or status == 401:
        raise RiotError("expired", "Riot rejected the session. Paste a fresh ssid cookie.")
    if "MAINTENANCE" in json.dumps(err).upper() or status == 503:
        raise RiotError("maintenance", "Valorant servers are in maintenance.")
    raise RiotError("api", f"{what} failed ({status} {err.get('errorCode') or ''})".strip())


def sign_in():
    """Returns a session dict with tokens and headers for the game API. Saves rotated cookies."""
    with auth_lock:
        if not AUTH.get("cookies"):
            raise RiotError("expired", "Not signed in yet.")
        token, id_token, cookies = reauth(AUTH["cookies"])
        AUTH["cookies"] = cookies
        AUTH["refreshed_at"] = time.time()
        bearer = {"Authorization": f"Bearer {token}"}
        ent = _check(*http("POST", "https://entitlements.auth.riotgames.com/api/token/v1", bearer, {}),
                     "Entitlements")["entitlements_token"]
        if not AUTH.get("puuid") or not AUTH.get("region"):
            info = _check(*http("GET", "https://auth.riotgames.com/userinfo", bearer), "User info")
            acct = info.get("acct") or {}
            AUTH["puuid"] = info["sub"]
            AUTH["name"] = f"{acct.get('game_name')}#{acct.get('tag_line')}" if acct.get("game_name") else ""
            try:
                pas = _check(*http("PUT", "https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant", bearer,
                                   {"id_token": id_token}), "Region")
                AUTH["region"] = pas["affinities"]["live"]
            except (RiotError, KeyError, TypeError):
                AUTH["region"] = AUTH.get("region") or "ap"
        AUTH["state"] = "ok"
        save_auth()
        return {"puuid": AUTH["puuid"], "shard": SHARDS.get(AUTH["region"], AUTH["region"]),
                "headers": {**bearer, "X-Riot-Entitlements-JWT": ent, "X-Riot-ClientPlatform": PLATFORM,
                            "X-Riot-ClientVersion": client_version()}}


_version = {"v": "", "at": 0}


def client_version():
    if time.time() - _version["at"] > 3600:
        try:
            _, _, body = http("GET", "https://valorant-api.com/v1/version", timeout=15)
            _version.update(v=body["data"]["riotClientVersion"], at=time.time())
        except (RiotError, KeyError, TypeError):
            log.warning("Couldn't read the game version from valorant-api.com; using the last known one")
    return _version["v"] or "release-13.06-shipping-18-5590001"


def fetch_store(session):
    base = f"https://pd.{session['shard']}.a.pvp.net"
    store = _check(*http("POST", f"{base}/store/v3/storefront/{session['puuid']}", session["headers"], {}),
                   "Store")
    wallet = _check(*http("GET", f"{base}/store/v1/wallet/{session['puuid']}", session["headers"]), "Wallet")
    return store, wallet


# ------------------------------------------------------------------ catalog

class Catalog:
    """Names, pictures and tiers of skins and bundle items, from valorant-api.com, cached in /data."""

    def __init__(self):
        self.data = read_json(CATALOG_PATH, {})
        self.lock = threading.Lock()

    def ensure(self, force=False):
        with self.lock:
            if not force and self.data.get("items") and time.time() - self.data.get("at", 0) < 86400:
                return
            try:
                self.data = build_catalog()
                write_json(CATALOG_PATH, self.data)
                log.info("Catalog updated: %d items", len(self.data["items"]))
            except (RiotError, KeyError, TypeError, ValueError) as e:
                log.warning("Couldn't update the skin catalog: %s", e)

    def item(self, uuid, kind="skin"):
        items = self.data.get("items", {})
        if kind == "skin":
            uuid = self.data.get("levels", {}).get(uuid, uuid)
        return items.get(uuid) or {"u": uuid, "n": "Unknown item", "i": "", "k": kind}

    def known(self, level_uuid):
        return level_uuid in self.data.get("levels", {})


def _api(path):
    status, _, body = http("GET", f"https://valorant-api.com/v1/{path}", timeout=60)
    if status != 200:
        raise RiotError("api", f"valorant-api.com {path} answered {status}")
    return body["data"]


def build_catalog():
    items, levels = {}, {}
    for s in _api("weapons/skins"):
        if not s.get("levels") or "Random Favorite" in s["displayName"]:
            continue
        first = s["levels"][0]
        chroma = (s.get("chromas") or [{}])[0]
        items[s["uuid"]] = {"u": s["uuid"], "n": s["displayName"], "k": "skin", "t": s.get("contentTierUuid"),
                            "i": first.get("displayIcon") or s.get("displayIcon") or chroma.get("fullRender") or "",
                            "v": bool(first.get("streamedVideo"))}
        for lv in s["levels"]:
            levels[lv["uuid"]] = s["uuid"]
    for b in _api("buddies"):
        for lv in b.get("levels") or []:
            items[lv["uuid"]] = {"u": lv["uuid"], "n": b["displayName"], "k": "buddy", "i": lv.get("displayIcon") or ""}
    for c in _api("playercards"):
        items[c["uuid"]] = {"u": c["uuid"], "n": c["displayName"], "k": "card", "i": c.get("wideArt") or c.get("displayIcon") or ""}
    for s in _api("sprays"):
        items[s["uuid"]] = {"u": s["uuid"], "n": s["displayName"], "k": "spray",
                            "i": s.get("fullTransparentIcon") or s.get("displayIcon") or ""}
    for t in _api("playertitles"):
        items[t["uuid"]] = {"u": t["uuid"], "n": t.get("titleText") or t["displayName"], "k": "title", "i": ""}
    bundles = {b["uuid"]: {"n": b["displayName"], "i": b.get("displayIcon") or "", "p": b.get("verticalPromoImage") or ""}
               for b in _api("bundles")}
    tiers = {t["uuid"]: {"n": t["devName"], "c": "#" + (t.get("highlightColor") or "8b978fff")[:6], "r": t["rank"],
                         "i": t.get("displayIcon") or ""} for t in _api("contenttiers")}
    return {"at": time.time(), "items": items, "levels": levels, "bundles": bundles, "tiers": tiers}


catalog = Catalog()


# ------------------------------------------------------------------ store snapshot

def store_day(expires_at):
    """The daily store resets at 00:00 UTC. A store is named after the UTC date it started on."""
    return time.strftime("%Y-%m-%d", time.gmtime(expires_at - 86400 + 3600))


def _skin(level_uuid, **extra):
    it = catalog.item(level_uuid)
    return {"skin": it["u"], "name": it["n"], "icon": it["i"], "tier": it.get("t"), "video": it.get("v", False), **extra}


def resolve(store, wallet, now=None):
    """Turns Riot's raw store and wallet into the snapshot the dashboard and history use."""
    now = now or time.time()
    panel = store.get("SkinsPanelLayout") or {}
    expires = now + (panel.get("SingleItemOffersRemainingDurationInSeconds") or 0)
    offers = panel.get("SingleItemStoreOffers") or [{"OfferID": o, "Cost": {}} for o in panel.get("SingleItemOffers") or []]
    snap = {
        "day": store_day(expires), "fetched_at": now, "expires_at": expires,
        "offers": [_skin(o["OfferID"], cost=(o.get("Cost") or {}).get(VP)) for o in offers],
        "bundles": [],
        "night": None,
        "wallet": {"vp": (wallet.get("Balances") or {}).get(VP, 0), "rad": (wallet.get("Balances") or {}).get(RAD, 0),
                   "kc": (wallet.get("Balances") or {}).get(KC, 0)},
    }
    for b in (store.get("FeaturedBundle") or {}).get("Bundles") or []:
        meta = catalog.data.get("bundles", {}).get(b.get("DataAssetID"), {})
        items = []
        for it in b.get("Items") or []:
            kind = ITEM_KINDS.get(it["Item"]["ItemTypeID"], "other")
            info = catalog.item(it["Item"]["ItemID"], kind)
            items.append({"name": info["n"], "icon": info["i"], "kind": kind, "tier": info.get("t"),
                          "skin": info["u"] if kind == "skin" else None, "amount": it["Item"].get("Amount", 1),
                          "price": it.get("DiscountedPrice"), "base": it.get("BasePrice")})
        snap["bundles"].append({
            "uuid": b.get("DataAssetID"), "name": meta.get("n") or "Featured bundle", "icon": meta.get("i", ""),
            "price": b.get("TotalDiscountedCost", {}).get(VP) or sum(i["price"] or 0 for i in items),
            "base": b.get("TotalBaseCost", {}).get(VP) or sum(i["base"] or 0 for i in items),
            "expires_at": now + (b.get("DurationRemainingInSeconds") or 0), "items": items})
    bonus = store.get("BonusStore")
    if bonus and bonus.get("BonusStoreOffers"):
        snap["night"] = {"expires_at": now + (bonus.get("BonusStoreRemainingDurationInSeconds") or 0), "offers": [
            _skin(o["Offer"]["OfferID"], cost=(o.get("DiscountCosts") or {}).get(VP),
                  was=(o["Offer"].get("Cost") or {}).get(VP), percent=o.get("DiscountPercent"),
                  seen=bool(o.get("IsSeen")))
            for o in bonus["BonusStoreOffers"]]}
    return snap


def wishlist_hits(snap, wishlist):
    """[(place, offer)] for wishlist skins in the daily store or Night Market."""
    wanted = set(wishlist)
    hits = [("store", o) for o in snap["offers"] if o["skin"] in wanted]
    if snap.get("night"):
        hits += [("night", o) for o in snap["night"]["offers"] if o["skin"] in wanted]
    return hits


def save_snapshot(snap):
    db.x("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)", (snap["day"], snap["fetched_at"], json.dumps(snap)))


def latest_snapshot():
    rows = db.q("SELECT data FROM snapshots ORDER BY day DESC LIMIT 1")
    return json.loads(rows[0]["data"]) if rows else None


# ------------------------------------------------------------------ home assistant + whatsapp

def _supervisor(method, path, payload=None, timeout=10):
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None, None
    req = urllib.request.Request(f"http://supervisor{path}", method=method,
                                 data=json.dumps(payload).encode() if payload is not None else None,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, None
    except (OSError, ValueError):
        return None, None


def ha_notification(title, message, notification_id="valorant_store"):
    _supervisor("POST", "/core/api/services/persistent_notification/create",
                {"title": title, "message": message, "notification_id": notification_id})


_bridge = {"url": None, "to": "", "token": ""}


def _bridge_info():
    """The PDC WhatsApp Bridge add-on's Supervisor info (IP and options), looked up by slug."""
    own = ((_supervisor("GET", "/addons/self/info")[1] or {}).get("data") or {}).get("slug") or ""
    slug = re.sub(r"valorant_store$", "pdc_whatsapp", own)
    return ((_supervisor("GET", f"/addons/{slug}/info")[1] or {}).get("data") or {}) if slug else {}


def bridge_url():
    """The bridge isn't published on the host; it's reached on its Supervisor-network IP."""
    if OPTS["whatsapp_bridge_url"]:
        return OPTS["whatsapp_bridge_url"].rstrip("/")
    if not _bridge["url"]:
        info = _bridge_info()
        if info.get("ip_address"):
            _bridge["url"] = f"http://{info['ip_address']}:8787"
        else:
            log.warning("Couldn't find the PDC WhatsApp Bridge add-on; set whatsapp_bridge_url")
    return _bridge["url"]


def whatsapp_config():
    """(to, token): this add-on's options, or else the bridge's own recipient_number and
    api_token, so nothing has to be copied between add-ons."""
    to, token = OPTS["whatsapp_to"], OPTS["whatsapp_api_token"]
    if not (to and token) and not (_bridge["to"] and _bridge["token"]):
        opts = _bridge_info().get("options") or {}
        _bridge.update(to=opts.get("recipient_number") or "", token=opts.get("api_token") or "")
    return to or _bridge["to"], token or _bridge["token"]


def whatsapp_ready():
    return all(whatsapp_config())


def whatsapp_post(text, key):
    url = bridge_url()
    to, token = whatsapp_config()
    if not url:
        return None, {}
    req = urllib.request.Request(
        f"{url}/send", method="POST",
        data=json.dumps({"to": to, "text": text, "idempotencyKey": key}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}
    except (OSError, ValueError):
        return None, {}


def whatsapp_send(text, key, give_up_after=3 * 3600):
    """Sends once per key (the bridge also dedupes by key), retrying while WhatsApp reconnects."""
    if not whatsapp_ready():
        return False
    if db.q("SELECT 1 FROM alerts WHERE key=? AND ok=1", (key,)):
        return True
    deadline, delay = time.time() + give_up_after, 15
    while True:
        status, body = whatsapp_post(text, key)
        if status == 200:
            db.x("INSERT OR REPLACE INTO alerts VALUES (?,?,?,1)", (key, time.time(), text))
            event("whatsapp", text.splitlines()[0])
            return True
        if status in (400, 401, 403, 413):
            event("error", f"WhatsApp bridge refused the message ({status}).")
            _bridge.update(to="", token="")  # re-read the bridge's settings next time
            return False
        if status is None:
            _bridge["url"] = None  # the bridge may have restarted with a new IP
        if time.time() + delay > deadline:
            event("error", f"Gave up sending a WhatsApp message ({status} {body.get('status', '')})")
            return False
        time.sleep(delay)
        delay = min(300, delay * 2)


def send_async(text, key):
    threading.Thread(target=whatsapp_send, args=(text, key), daemon=True).start()


def local_time(ts):
    return time.strftime("%-I:%M %p", time.localtime(ts)) if os.name != "nt" else time.strftime("%I:%M %p", time.localtime(ts))


def hours_left(ts):
    h = max(0, round((ts - time.time()) / 3600))
    return f"{h} hour{'s' if h != 1 else ''}" if h else "less than an hour"


def alert_text(place, offer, snap):
    if place == "store":
        return (f"🎯 {offer['name']} is in your Valorant store today!\n"
                f"Price: {offer['cost']:,} VP\n"
                f"It leaves at {local_time(snap['expires_at'])} ({hours_left(snap['expires_at'])} left).")
    return (f"🌙 {offer['name']} is in your Night Market!\n"
            f"{offer['cost']:,} VP instead of {offer['was']:,} VP ({offer['percent']}% off). "
            f"Flip your cards to check; the Night Market ends in {hours_left(snap['night']['expires_at'])}.")


def digest_text(snap):
    lines = [f"🛒 Today's Valorant store ({snap['day']})"]
    lines += [f"• {o['name']} - {o['cost']:,} VP" if o.get("cost") else f"• {o['name']}" for o in snap["offers"]]
    lines.append(f"Wallet: {snap['wallet']['vp']:,} VP")
    return "\n".join(lines)


def after_check(snap):
    for place, offer in wishlist_hits(snap, SETTINGS["wishlist"]):
        if place == "night" and not SETTINGS["night_market_alerts"]:
            continue
        when = snap["day"] if place == "store" else store_day(snap["night"]["expires_at"])
        key = f"valstore-{place}-{when}-{offer['skin']}"
        if not db.q("SELECT 1 FROM alerts WHERE key=?", (key,)):  # once per store, even without WhatsApp
            db.x("INSERT INTO alerts VALUES (?,?,?,0)", (key, time.time(), alert_text(place, offer, snap)))
            event("found", f"{offer['name']} is in your {'store' if place == 'store' else 'Night Market'}")
            ha_notification("Valorant store", alert_text(place, offer, snap), f"valorant_store_{offer['skin'][:8]}")
            send_async(alert_text(place, offer, snap), key)
    if SETTINGS["daily_digest"]:
        send_async(digest_text(snap), f"valstore-digest-{snap['day']}")


# ------------------------------------------------------------------ checker

STATUS = {"checking": False, "last_ok": None, "last_try": None, "error": None, "error_kind": None, "next_check": None}
wake = threading.Event()
check_lock = threading.Lock()


def check(reason="scheduled"):
    """One full check. Returns the snapshot or None."""
    with check_lock:
        STATUS.update(checking=True, last_try=time.time())
        try:
            catalog.ensure()
            session = sign_in()
            store, wallet = fetch_store(session)
            if any(not catalog.known(o) for o in (store.get("SkinsPanelLayout") or {}).get("SingleItemOffers") or []):
                catalog.ensure(force=True)  # a new skin line came out today
            snap = resolve(store, wallet)
            save_snapshot(snap)
            STATUS.update(last_ok=time.time(), error=None, error_kind=None)
            log.info("Store checked (%s): %s", reason, ", ".join(o["name"] for o in snap["offers"]))
            after_check(snap)
            return snap
        except RiotError as e:
            STATUS.update(error=str(e), error_kind=e.kind)
            if e.kind == "expired" and AUTH.get("cookies"):
                session_expired()
            else:
                log.warning("Check failed (%s): %s", e.kind, e)
            return None
        except Exception as e:  # never let one odd response stop the daily checks
            log.exception("Check failed")
            STATUS.update(error=f"Unexpected error: {e}", error_kind="api")
            return None
        finally:
            STATUS["checking"] = False


def session_expired():
    with auth_lock:
        if AUTH.get("state") == "expired":
            return
        AUTH["state"] = "expired"
        AUTH["expired_at"] = time.time()
        save_auth()
    event("signed_out", "Riot signed the session out; waiting for a new ssid cookie")
    text = ("⚠️ Valorant Store Tracker was signed out by Riot, so it can't check your store.\n"
            "Open Valorant Store in Home Assistant > Settings and paste a fresh ssid cookie.")
    ha_notification("Valorant Store Tracker signed out", text, "valorant_store_auth")
    send_async(text, f"valstore-signed-out-{int(AUTH['expired_at'])}")


def next_check_at(snap, now):
    """Right after the next daily reset, or every check_every_hours (Night Market, bundles,
    keeping the session fresh), whichever comes first."""
    every = now + max(1, float(OPTS["check_every_hours"])) * 3600
    if snap and snap["expires_at"] > now:
        return min(every, snap["expires_at"] + 90)
    return every


def checker_loop():
    failures = 0
    while True:
        snap = check()
        now = time.time()
        if snap:
            failures = 0
            nxt = next_check_at(snap, now)
        elif STATUS["error_kind"] == "expired":
            nxt = now + 12 * 3600  # nothing to do until a new cookie arrives (which wakes us)
        else:
            failures += 1
            nxt = now + min(3600, 300 * 2 ** (failures - 1))
        STATUS["next_check"] = nxt
        wake.wait(max(5, nxt - time.time()))
        wake.clear()


# ------------------------------------------------------------------ dashboard data

def wishlist_payload(snaps):
    out = []
    for uuid in SETTINGS["wishlist"]:
        it = catalog.item(uuid)
        seen = [s["day"] for s in snaps if any(o["skin"] == uuid for o in s["offers"])]
        night = [s["day"] for s in snaps if s.get("night") and any(o["skin"] == uuid for o in s["night"]["offers"])]
        out.append({"skin": uuid, "name": it["n"], "icon": it["i"], "tier": it.get("t"),
                    "times_seen": len(seen), "last_seen": seen[0] if seen else None,
                    "night_seen": night[0] if night else None})
    return out


def all_snapshots(limit=400):
    return [json.loads(r["data"]) for r in db.q("SELECT data FROM snapshots ORDER BY day DESC LIMIT ?", (limit,))]


def state_payload():
    snaps = all_snapshots()
    today = snaps[0] if snaps else None
    wanted = set(SETTINGS["wishlist"])
    by_day = {s["day"]: any(o["skin"] in wanted for o in s["offers"]) for s in snaps}
    strip_days = [time.strftime("%Y-%m-%d", time.gmtime(time.time() - i * 86400)) for i in range(59, -1, -1)]
    return {
        "account": {"name": AUTH.get("name"), "region": AUTH.get("region")} if AUTH.get("puuid") else None,
        "auth": {"state": AUTH.get("state") or ("missing" if not AUTH.get("cookies") else "unknown"),
                 "saved_at": AUTH.get("saved_at"), "refreshed_at": AUTH.get("refreshed_at"),
                 "expired_at": AUTH.get("expired_at")},
        "status": STATUS,
        "today": today,
        "wishlist": wishlist_payload(snaps),
        "hunt": {"days_tracked": len(snaps), "first_day": snaps[-1]["day"] if snaps else None,
                 "strip": [{"day": d, "hit": by_day.get(d)} for d in strip_days]},
        "tiers": catalog.data.get("tiers", {}),
        "settings": {k: SETTINGS[k] for k in ("daily_digest", "night_market_alerts")},
        "whatsapp": {"ready": whatsapp_ready(), "to": whatsapp_config()[0]},
        "events": db.q("SELECT ts, kind, text FROM events ORDER BY ts DESC LIMIT 25"),
    }


def history_payload():
    snaps = all_snapshots()
    counts = {}
    for s in snaps:
        for o in s["offers"]:
            c = counts.setdefault(o["skin"], {**o, "times": 0, "last": s["day"]})
            c["times"] += 1
    return {"days": [{"day": s["day"], "offers": s["offers"], "night": bool(s.get("night"))} for s in snaps],
            "most_seen": sorted(counts.values(), key=lambda c: (-c["times"], c["name"]))[:12],
            "tiers": catalog.data.get("tiers", {}), "wishlist": SETTINGS["wishlist"]}


def catalog_payload():
    skins = [{"u": i["u"], "n": i["n"], "i": i["i"], "t": i.get("t")}
             for i in catalog.data.get("items", {}).values() if i["k"] == "skin" and "Standard" not in i["n"]]
    return {"skins": sorted(skins, key=lambda s: s["n"]), "tiers": catalog.data.get("tiers", {})}


# ------------------------------------------------------------------ actions

def action_login(body):
    cookies = parse_cookie_input(body.get("cookie"))
    if not cookies.get("ssid"):
        return 400, {"error": "That doesn't contain an ssid cookie. Copy the value of the cookie named ssid."}
    try:
        token, id_token, cookies = reauth(cookies)
    except RiotError as e:
        msg = "Riot didn't accept that cookie. It may be expired or copied incompletely; sign in again and copy it fresh." \
            if e.kind == "expired" else str(e)
        return 400, {"error": msg}
    with auth_lock:
        AUTH.clear()
        AUTH.update(cookies=cookies, saved_at=time.time(), state="ok")
        save_auth()
    event("signed_in", "Signed in with a new session cookie")
    snap = check("sign-in")
    wake.set()  # reschedule the next check from this fresh store
    if not snap:
        return 502, {"error": STATUS["error"] or "Signed in, but the store couldn't be read yet."}
    return 200, {"ok": True, "name": AUTH.get("name")}


def action_logout(_body):
    with auth_lock:
        AUTH.clear()
        save_auth()
    event("signed_out", "Signed out from the dashboard")
    return 200, {"ok": True}


def action_refresh(_body):
    if not AUTH.get("cookies"):
        return 400, {"error": "Sign in first (Settings)."}
    snap = check("refresh button")
    return (200, {"ok": True}) if snap else (502, {"error": STATUS["error"]})


def action_wishlist(body):
    uuid = body.get("skin") or ""
    if uuid not in catalog.data.get("items", {}):
        return 400, {"error": "Unknown skin"}
    wl = SETTINGS["wishlist"]
    if body.get("remove"):
        SETTINGS["wishlist"] = [u for u in wl if u != uuid]
    elif uuid not in wl:
        SETTINGS["wishlist"] = wl + [uuid]
    if body.get("first") and uuid in SETTINGS["wishlist"]:
        SETTINGS["wishlist"] = [uuid] + [u for u in SETTINGS["wishlist"] if u != uuid]
    save_settings()
    snap = latest_snapshot()
    if snap and not body.get("remove"):
        after_check(snap)  # added a skin that's already in today's store
    return 200, {"ok": True, "wishlist": SETTINGS["wishlist"]}


def action_settings(body):
    for k in ("daily_digest", "night_market_alerts"):
        if isinstance(body.get(k), bool):
            SETTINGS[k] = body[k]
    save_settings()
    return 200, {"ok": True}


def action_test_whatsapp(_body):
    if not whatsapp_ready():
        return 400, {"error": "The PDC WhatsApp Bridge add-on wasn't found, so there's nowhere to send messages."}
    status, body = whatsapp_post("✅ Valorant Store Tracker can reach you on WhatsApp.", f"valstore-test-{int(time.time())}")
    if status == 200:
        return 200, {"ok": True}
    return 502, {"error": f"The WhatsApp bridge answered {status or 'nothing'} {body.get('status', '')}".strip()}


ACTIONS = {"/api/login": action_login, "/api/logout": action_logout, "/api/refresh": action_refresh,
           "/api/wishlist": action_wishlist, "/api/settings": action_settings,
           "/api/test-whatsapp": action_test_whatsapp}


# ------------------------------------------------------------------ http server

CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ValorantStore/1.0"

    def log_message(self, fmt, *args):
        log.debug("http: " + fmt, *args)

    def _allowed(self):
        if ALLOWED_CLIENTS is None or self.client_address[0] in ALLOWED_CLIENTS:
            return True
        self.send_error(403)
        return False

    def _send(self, code, body, ctype="application/json", cache="no-store"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._allowed():
            return
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/state":
            return self._send(200, state_payload())
        if path == "/api/history":
            return self._send(200, history_payload())
        if path == "/api/catalog":
            return self._send(200, catalog_payload())
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC_DIR, name))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            return self._send(404, {"error": "not found"})
        with open(full, "rb") as f:
            self._send(200, f.read(), CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream"),
                       "max-age=31536000, immutable" if full.endswith(".woff2") else "no-cache")

    def do_POST(self):
        if not self._allowed():
            return
        action = ACTIONS.get(urllib.parse.urlsplit(self.path).path)
        if not action:
            return self._send(404, {"error": "not found"})
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 65536)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "Bad request"})
        code, out = action(body if isinstance(body, dict) else {})
        self._send(code, out)


def main():
    global db
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    os.makedirs(DATA_DIR, exist_ok=True)
    db = DB(DB_PATH)
    log.info("Valorant Store Tracker starting; wishlist: %d skin(s); WhatsApp %s",
             len(SETTINGS["wishlist"]), "on" if whatsapp_ready() else "not configured")
    threading.Thread(target=checker_loop, daemon=True, name="checker").start()
    server = ThreadingHTTPServer((os.environ.get("VALSTORE_BIND", "0.0.0.0"), HTTP_PORT), Handler)
    log.info("Dashboard listening on port %s (Ingress)", HTTP_PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
