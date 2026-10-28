"""Electricity Monitor: watches the smart breaker (Gaqqee KWS-302WF via Tuya Local) in
Home Assistant and keeps its own history in SQLite.

  * HA link - a WebSocket subscription to the breaker's entities (live, with who-did-it
    context). After any restart of HA or this add-on it replays HA's recorder history from
    where it stopped, so nothing in between is lost; time HA itself was down is judged
    from the breaker's energy counter.
  * tracker - turns the stream into events: power cuts (load shedding), Wi-Fi drops, the
    breaker switching off (protection trips, with the likely reason), staying off after
    the power returns, voltage episodes, appliance runs, hourly energy.
  * alerts - Alexa, phone and WhatsApp (PDC WhatsApp Bridge); daily/weekly/monthly reports.
  * HTTP server - the Ingress dashboard and its JSON API.
"""

import base64
import csv
import io
import json
import logging
import os
import queue
import re
import select
import socket
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import logic
from logic import CAUSE_TEXT

DATA_DIR = os.environ.get("EMON_DATA_DIR", "/data")
OPTIONS_PATH = os.path.join(DATA_DIR, "options.json")
DB_PATH = os.path.join(DATA_DIR, "electricity.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
HTTP_PORT = int(os.environ.get("EMON_PORT", "38767"))
SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN")
# Local development: talk to HA directly (EMON_HA_URL=http://homeassistant.local:8123, EMON_HA_TOKEN=...).
HA_URL = (os.environ.get("EMON_HA_URL") or "").rstrip("/")
HA_TOKEN = os.environ.get("EMON_HA_TOKEN", "")
ALLOWED_CLIENTS = {"172.30.32.2", "127.0.0.1", "::1"}
if os.environ.get("EMON_ALLOW_ALL") == "1":
    ALLOWED_CLIENTS = None

ALERT_KINDS = ["power_cut", "power_back", "trip", "stayed_off", "breaker_on", "voltage", "temperature",
               "balance", "slab"]
DEFAULT_OPTIONS = {
    "breaker_prefix": "energy_meter",
    "min_outage_seconds": 90,
    "auto_restore": False,
    "auto_restore_delay_seconds": 60,
    "repeat_minutes": 10,
    "repeat_max": 6,
    "voltage_warn_margin": 8,
    "temperature_warn_margin": 5,
    "nominal_voltage": 230,
    "voltage_offset": 0.0,
    "energy_calibration_percent": 0.0,
    "alexa_entities": [],
    "alexa_volume": 60,
    "alexa_quiet_hours": [],
    "critical_ignores_quiet_hours": True,
    "notify_service": "",
    "offline_tts_service": "",
    "whatsapp_to": "",
    "whatsapp_api_token": "",
    "whatsapp_bridge_url": "",
    "alerts_alexa": ["power_cut", "power_back", "trip", "stayed_off", "breaker_on", "voltage", "balance"],
    "alerts_phone": ["power_cut", "power_back", "trip", "stayed_off", "breaker_on", "voltage", "temperature",
                     "balance", "slab"],
    "alerts_whatsapp": ["power_back", "trip", "stayed_off", "balance", "slab"],
    "daily_report_enabled": False,
    "daily_report_hour": 22,
    "weekly_report_enabled": True,
    "weekly_report_day": "sun",
    "weekly_report_hour": 21,
    "monthly_report_enabled": True,
    "monthly_report_hour": 10,
    "currency": "৳",
    # BERC residential (LT-A) rates from June 2026, same for every distributor incl. Palli Bidyut.
    "tariff_slabs": ["75:5.26", "200:8.50", "300:9.10", "400:9.62", "600:15.01", "0:17.35"],
    "lifeline_units": 50,
    "lifeline_rate": 4.63,
    "sanctioned_load_kw": 2.0,
    "demand_charge_per_kw": 42.0,
    "meter_rent": 40.0,
    "vat_percent": 5.0,
    "prepaid_rebate_percent": 0.5,
    "low_balance_alert": 200.0,
    "low_balance_days": 2,
    "slab_alerts": True,
    "slab_warn_units": 15,
    "appliance_min_watts": 300,
    "retention_days": 400,
}
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
PROTECTION = {"over_voltage", "under_voltage", "over_current", "over_power", "over_temperature", "over_energy",
              "short_circuit", "surge", "over_load", "leakage", "high_power", "unknown"}
SELF_CAUSED = {"ha_user", "automation", "addon"}           # someone in HA did it: no alarm
REPEAT_CAUSES = PROTECTION | {"stayed_off"}                # keep reminding until it's back on
AUTO_RESTORE_CAUSES = {"stayed_off", "over_voltage", "under_voltage"}  # supply problems, not the house's

log = logging.getLogger("electricity_monitor")


def load_options():
    opts = dict(DEFAULT_OPTIONS)
    try:
        with open(OPTIONS_PATH, encoding="utf-8") as f:
            opts.update({k: v for k, v in json.load(f).items() if v is not None})
    except FileNotFoundError:
        log.warning("No options.json found, using defaults")
    return opts


OPTS = load_options()


def entities():
    p = OPTS["breaker_prefix"]
    return {
        "relay": f"switch.{p}", "voltage": f"sensor.{p}_voltage", "current": f"sensor.{p}_current",
        "power": f"sensor.{p}_power", "pf": f"sensor.{p}_power_factor", "hz": f"sensor.{p}_frequency",
        "temp": f"sensor.{p}_temperature", "energy": f"sensor.{p}_energy", "problem": f"binary_sensor.{p}_problem",
        "low_v": f"number.{p}_low_voltage", "over_v": f"number.{p}_overvoltage", "over_a": f"number.{p}_overcurrent",
        "over_kw": f"number.{p}_over_power", "over_t": f"number.{p}_over_temperature",
        "over_kwh": f"number.{p}_over_energy", "timer": f"time.{p}_timer", "clear": f"button.{p}_clear_flag",
        "internet": "binary_sensor.net_monitor_internet",
    }


ENT = entities()
KEY_OF = {v: k for k, v in ENT.items()}
READINGS = {"voltage", "current", "power", "pf", "hz", "temp", "energy"}
LIMITS = {"low_v", "over_v", "over_a", "over_kw", "over_t", "over_kwh"}


# --------------------------------------------------------------------------- db

class DB:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS samples (
                ts INTEGER PRIMARY KEY, secs REAL NOT NULL,
                v_min REAL, v_avg REAL, v_max REAL, a_avg REAL, a_max REAL, w_avg REAL, w_max REAL,
                pf_avg REAL, hz_min REAL, hz_max REAL, t_max REAL, relay INTEGER, energy REAL
            );
            CREATE TABLE IF NOT EXISTS energy_hourly (hour INTEGER PRIMARY KEY, kwh REAL NOT NULL, source TEXT);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, start REAL NOT NULL, end REAL,
                cause TEXT, confidence TEXT, detail TEXT, data TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);
            CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, start);
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, ts REAL NOT NULL, kind TEXT,
                text TEXT, channels TEXT
            );
            CREATE TABLE IF NOT EXISTS prepaid (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT NOT NULL,
                amount REAL NOT NULL, note TEXT
            );
            CREATE TABLE IF NOT EXISTS appliances (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, watts REAL NOT NULL, created REAL
            );
            CREATE TABLE IF NOT EXISTS appliance_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, appliance_id INTEGER, start REAL NOT NULL,
                end REAL NOT NULL, watts REAL, kwh REAL
            );
            CREATE INDEX IF NOT EXISTS idx_runs_start ON appliance_runs(start);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
            """
        )
        self.conn.commit()

    def execute(self, sql, params=()):
        with self.lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur.lastrowid

    def query(self, sql, params=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def one(self, sql, params=()):
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def scalar(self, sql, params=()):
        with self.lock:
            row = self.conn.execute(sql, params).fetchone()
            return row[0] if row else None

    def get_setting(self, key, default=None):
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key, value):
        self.execute("INSERT INTO settings(key, value) VALUES(?, ?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))


db = None  # initialised in main()


def open_event(kind, start, end=None, cause=None, confidence=None, detail=None, data=None):
    return db.execute("INSERT INTO events(kind, start, end, cause, confidence, detail, data) VALUES(?,?,?,?,?,?,?)",
                      (kind, start, end, cause, confidence, detail, json.dumps(data or {})))


def update_event(eid, **fields):
    if "data" in fields:
        old = json.loads(db.scalar("SELECT data FROM events WHERE id=?", (eid,)) or "{}")
        fields["data"] = json.dumps({**old, **fields["data"]})
    sets = ", ".join(f"{k}=?" for k in fields)
    db.execute(f"UPDATE events SET {sets} WHERE id=?", (*fields.values(), eid))


def get_event(eid):
    row = db.one("SELECT * FROM events WHERE id=?", (eid,)) if eid else None
    if row:
        row["data"] = json.loads(row["data"] or "{}")
    return row


# ------------------------------------------------------------------- formatting

def fmt_time(ts):
    return time.strftime("%I:%M %p", time.localtime(ts)).lstrip("0")


def fmt_day_time(ts):
    if time.strftime("%Y%m%d", time.localtime(ts)) == time.strftime("%Y%m%d"):
        return fmt_time(ts)
    return f"{time.strftime('%a %d %b', time.localtime(ts))}, {fmt_time(ts)}"


def fmt_duration(seconds):
    seconds = int(round(max(0, seconds)))
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s" if m < 10 and s else f"{m}m"
    return f"{s}s"


def spoken_duration(seconds):
    seconds = int(round(max(0, seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    parts = [f"{n} {unit}{'s' if n != 1 else ''}" for n, unit in ((h, "hour"), (m, "minute")) if n]
    if not parts:
        return f"{s} seconds"
    return parts[0] if len(parts) == 1 else f"{parts[0]} and {parts[1]}"


def money(v):
    return f"{OPTS['currency']}{v:,.0f}"


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(ts)) if ts else None


def iso_utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def parse_iso(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def num(state):
    try:
        return float(state)
    except (TypeError, ValueError):
        return None


def day_start(ts):
    lt = time.localtime(ts)
    return time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))


def month_start(ts):
    lt = time.localtime(ts)
    return time.mktime((lt.tm_year, lt.tm_mon, 1, 0, 0, 0, 0, 0, -1))


def month_bounds(year, month):
    lo = time.mktime((year, month, 1, 0, 0, 0, 0, 0, -1))
    hi = time.mktime((year + month // 12, month % 12 + 1, 1, 0, 0, 0, 0, 0, -1))
    return lo, hi


def in_window(ts, specs):
    lt = time.localtime(ts)
    now = lt.tm_hour * 60 + lt.tm_min
    for spec in specs:
        a, b = spec.split("-")
        lo = int(a.split(":")[0]) * 60 + int(a.split(":")[1])
        hi = int(b.split(":")[0]) * 60 + int(b.split(":")[1])
        if (lo <= now < hi) if lo <= hi else (now >= lo or now < hi):
            return True
    return False


def cal():
    return 1 + OPTS["energy_calibration_percent"] / 100


def kwh_between(lo, hi):
    """Calibrated kWh used in the hours starting in [lo, hi)."""
    return (db.scalar("SELECT SUM(kwh) FROM energy_hourly WHERE hour >= ? AND hour < ?", (lo, hi)) or 0) * cal()


# ------------------------------------------------------------- home assistant

def _http(method, url, token, payload=None, timeout=15):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            try:
                return r.status, json.loads(raw) if raw else None
            except ValueError:
                return r.status, None
    except urllib.error.HTTPError as e:
        log.warning("HA API %s %s -> %s", method, url.split("?")[0], e.code)
        try:
            return e.code, json.loads(e.read() or b"null")
        except (OSError, ValueError):
            return e.code, None
    except OSError as e:
        log.warning("HA API unreachable for %s (%s)", url.split("?")[0], e)
        return None, None


def ha(method, path, payload=None, timeout=15):
    """Home Assistant REST API; path starts with /api/."""
    if SUPERVISOR_TOKEN:
        return _http(method, f"http://supervisor/core{path}", SUPERVISOR_TOKEN, payload, timeout)
    if HA_URL:
        return _http(method, f"{HA_URL}{path}", HA_TOKEN, payload, timeout)
    return None, None


def supervisor(method, path, payload=None, timeout=15):
    if not SUPERVISOR_TOKEN:
        return None, None
    return _http(method, f"http://supervisor{path}", SUPERVISOR_TOKEN, payload, timeout)


def ha_service(domain, service, data, timeout=30):
    return ha("POST", f"/api/services/{domain}/{service}", data, timeout)[0]


def ha_get_state(entity_id):
    return ha("GET", f"/api/states/{entity_id}")[1]


def ha_set_state(entity_id, value, attributes):
    return ha("POST", f"/api/states/{entity_id}", {"state": value, "attributes": attributes})[0]


class HAWebSocket:
    """Just enough of RFC 6455 for Home Assistant's API (text frames, ping/pong, close)."""

    def __init__(self):
        if SUPERVISOR_TOKEN:
            host, port, path, token, tls = "supervisor", 80, "/core/websocket", SUPERVISOR_TOKEN, False
        elif HA_URL:
            u = urllib.parse.urlparse(HA_URL)
            tls = u.scheme == "https"
            host, port, path, token = u.hostname, u.port or (443 if tls else 80), "/api/websocket", HA_TOKEN
        else:
            raise ConnectionError("no Home Assistant to connect to")
        self.sock = socket.create_connection((host, port), timeout=20)
        if tls:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=host)
        self.buf = bytearray()
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        while b"\r\n\r\n" not in self.buf:
            self._fill()
        head, _, rest = bytes(self.buf).partition(b"\r\n\r\n")
        self.buf = bytearray(rest)
        status_line = head.split(b"\r\n")[0]
        if b" 101 " not in status_line:
            raise ConnectionError(f"WebSocket handshake failed: {status_line!r}")
        self.next_id = 1
        if self.recv(30).get("type") != "auth_required":
            raise ConnectionError("unexpected greeting")
        self.send({"type": "auth", "access_token": token})
        reply = self.recv(30)
        if reply.get("type") != "auth_ok":
            raise ConnectionError(f"auth failed: {reply}")

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise ConnectionError("connection closed")
        self.buf += chunk

    def _read(self, n):
        while len(self.buf) < n:
            self._fill()
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def send(self, obj):
        self.sock.sendall(logic.ws_frame(json.dumps(obj).encode()))

    def recv(self, timeout):
        """Next JSON message, or None if nothing arrives within timeout seconds."""
        if not self.buf and not select.select([self.sock], [], [], timeout)[0]:
            return None
        data = b""
        while True:
            fin, op, payload = logic.ws_read_frame(self._read)
            if op == 0x8:
                raise ConnectionError("Home Assistant closed the connection")
            if op == 0x9:
                self.sock.sendall(logic.ws_frame(payload, 0xA))
                continue
            if op == 0xA:
                continue
            data += payload
            if fin:
                return json.loads(data)

    def call(self, msg, timeout=120):
        mid = self.next_id
        self.next_id += 1
        self.send({**msg, "id": mid})
        deadline = time.time() + timeout
        while time.time() < deadline:
            reply = self.recv(5)
            if reply and reply.get("id") == mid and reply.get("type") == "result":
                if not reply.get("success"):
                    raise RuntimeError(f"{msg['type']}: {reply.get('error')}")
                return reply.get("result")
        raise TimeoutError(msg["type"])

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ----------------------------------------------------------------- tracker

class Bucket:
    """Time-weighted readings for one minute."""

    def __init__(self):
        self.secs = 0.0
        self.sums = {}
        self.mins = {}
        self.maxs = {}
        self.relay = None
        self.energy = None

    def add(self, cur, relay, dt):
        self.secs += dt
        self.relay = relay
        self.energy = cur.get("energy", self.energy)
        for k in ("voltage", "current", "power", "pf", "hz", "temp"):
            v = cur.get(k)
            if v is None:
                continue
            self.sums[k] = self.sums.get(k, 0) + v * dt
            self.mins[k] = min(self.mins.get(k, v), v)
            self.maxs[k] = max(self.maxs.get(k, v), v)

    def row(self, ts):
        avg = lambda k: self.sums[k] / self.secs if k in self.sums and self.secs else None
        return (ts, round(self.secs, 1), self.mins.get("voltage"), avg("voltage"), self.maxs.get("voltage"),
                avg("current"), self.maxs.get("current"), avg("power"), self.maxs.get("power"), avg("pf"),
                self.mins.get("hz"), self.maxs.get("hz"), self.maxs.get("temp"),
                None if self.relay is None else int(self.relay == "on"), self.energy)


PERSIST = ("last_ts", "avail", "relay", "cur", "unavail_since", "unavail_kwh", "unavail_w", "relay_before",
           "outage_id", "off_id", "net_id", "band_id", "last_energy", "heartbeat", "repeat", "warned")


class Tracker:
    def __init__(self):
        self.lock = threading.RLock()
        s = db.get_setting("tracker", {})
        self.last_ts = s.get("last_ts")
        self.avail = s.get("avail")
        self.relay = s.get("relay")
        self.cur = s.get("cur") or {}
        self.unavail_since = s.get("unavail_since")
        self.unavail_kwh = s.get("unavail_kwh")
        self.unavail_w = s.get("unavail_w")
        self.relay_before = s.get("relay_before")
        self.outage_id = s.get("outage_id")
        self.off_id = s.get("off_id")
        self.net_id = s.get("net_id")
        self.band_id = s.get("band_id")
        self.last_energy = s.get("last_energy")
        self.heartbeat = s.get("heartbeat")
        self.repeat = {int(k): v for k, v in (s.get("repeat") or {}).items()}  # off event id -> [count, last]
        self.warned = s.get("warned") or {}
        self.returning = None
        self.pending_off = None
        self.window = deque(maxlen=600)
        self.bucket, self.bucket_min, self.sample_ts = Bucket(), None, None
        self.last_event_ts = None
        self.band = None            # (kind, since, extreme) of a voltage episode being watched
        self.detector = logic.StepDetector(OPTS["appliance_min_watts"])
        self.timer_prev, self.timer_end_ts = None, None
        self.fault = None
        self.artifact = None        # (lo, hi): HA was starting; short drops then are its own doing
        self.addon_action = None    # (action, ts) of our own service call
        self.restore_tries = {}
        self.persons = {}
        self.ha_connected = False
        self.caught_up = False
        self.recent = deque(maxlen=400)

    def save(self):
        db.set_setting("tracker", {k: getattr(self, k) for k in PERSIST})

    # ----- input

    def handle(self, ts, eid, state, attrs, context, live):
        key = KEY_OF.get(eid)
        if key is None:
            return
        sig = (eid, round(ts, 3), state)
        if sig in self.recent or (self.last_ts and ts < self.last_ts - 120):
            return
        self.recent.append(sig)
        self.advance(ts, live)
        self.last_ts = max(self.last_ts or 0, ts)
        if key == "relay":
            return self._relay(ts, state, context or {}, live)
        if key == "internet":
            return self._internet(ts, state)
        if key == "problem":
            return self._problem(ts, state, attrs or {}, live)
        if key == "timer":
            if self.timer_prev not in (None, "00:00:00", "unknown", "unavailable") and state == "00:00:00":
                self.timer_end_ts = ts
            self.timer_prev = state
            return
        value = num(state)
        if value is None:
            return
        if key == "voltage":
            value += OPTS["voltage_offset"]
        self.cur[key] = value
        if key in READINGS:
            self.last_event_ts = ts
            c = self.cur
            self.window.append((ts, c.get("voltage"), c.get("current"), c.get("power"), c.get("temp")))
        if key == "energy":
            self._energy(ts, value)
            if self.returning:
                self.returning["kwh_after"] = value
                self._finish_return(ts, live)
        elif key == "power" and self.avail:
            for run in self.detector.feed(ts, value):
                save_run(*run)

    def _relay(self, ts, state, ctx, live):
        if state == "unavailable":
            if self.returning:
                self._finish_return(ts, live)
            if self.avail is not False:
                self.avail = False
                self.unavail_since, self.relay_before = ts, self.relay
                self.unavail_kwh = self.cur.get("energy")
                self.unavail_w = avg_power(ts - 600, ts)
                for run in self.detector.feed(ts, None):
                    save_run(*run)
                self.save()
            return
        if state not in ("on", "off"):
            return
        if self.avail is False:
            self.avail, self.relay = True, state
            self.returning = {"ts": ts, "deadline": ts + 20, "kwh_before": self.unavail_kwh}
            return
        first, prev = self.avail is None, self.relay
        self.avail, self.relay = True, state
        if first or prev == state:
            if first and state == "off" and not self.off_id:
                self.off_id = open_event("off", ts, cause="unknown", confidence="guess",
                                         detail="The breaker was already off when monitoring started")
            return
        if state == "off":
            self.pending_off = {"ts": ts, "ctx": self._ctx(ctx, "off", ts), "deadline": ts + 8, "live": live}
        else:
            if self.pending_off:
                self._finish_off(ts)
            self._on(ts, self._ctx(ctx, "on", ts), live)
        self.save()

    def _ctx(self, ctx, action, ts):
        out = {}
        if self.addon_action and self.addon_action[0] == action and ts - self.addon_action[1] < 20:
            out["addon"] = True
            self.addon_action = None
        elif ctx.get("user_id"):
            out["user_id"] = ctx["user_id"]
            out["user_name"] = self.persons.get(ctx["user_id"])
        elif ctx.get("parent_id"):
            out["parent_id"] = ctx["parent_id"]
        return out

    def _finish_off(self, now):
        p, self.pending_off = self.pending_off, None
        ts = p["ts"]
        window = [dict(zip(("ts", "v", "a", "w", "t"), r)) for r in self.window if ts - 60 <= r[0] <= ts + 10]
        limits = {k: self.cur.get(k) for k in LIMITS}
        limits["kwh"] = self.cur.get("energy")
        fault = self.fault[1] if self.fault and abs(self.fault[0] - ts) < 120 else None
        timer = bool(self.timer_end_ts and abs(self.timer_end_ts - ts) < 90)
        cause, conf, detail = logic.infer_off_reason(window, limits, p["ctx"], fault, timer)
        before = [r for r in window if r["ts"] <= ts]
        snap = before[-1] if before else {}
        if self.off_id:  # already off (e.g. seen as off after a drop); keep the first
            return
        self.off_id = open_event("off", ts, cause=cause, confidence=conf, detail=detail, data={
            "before": snap, "peak_v": max((r["v"] for r in window if r["v"]), default=None),
            "low_v": min((r["v"] for r in window if r["v"]), default=None), "by": p["ctx"]})
        if cause not in SELF_CAUSED:
            fresh_alert("trip", f"trip:{self.off_id}", ts, trip_texts(cause, detail, ts))
        if cause in REPEAT_CAUSES:
            self.repeat[self.off_id] = [0, ts]
        self.save()

    def _on(self, ts, ctx, live):
        if not self.off_id:
            return
        ev = get_event(self.off_id)
        if ctx.get("addon"):
            by = "automatic restore" if self.restore_tries.get(self.off_id) else "this dashboard"
        elif ctx.get("user_id"):
            by = f"{ctx.get('user_name') or 'a user'} in Home Assistant"
        elif ctx.get("parent_id"):
            by = "an automation"
        else:
            by = "outside Home Assistant (Smart Life app or the breaker)"
        update_event(self.off_id, end=ts, data={"restored_by": by})
        if ev and ev["cause"] not in SELF_CAUSED:
            fresh_alert("breaker_on", f"on:{self.off_id}", ts, {
                "speak": "The main breaker is back on.",
                "push": f"Breaker back on at {fmt_time(ts)}, after {fmt_duration(ts - ev['start'])} off. Turned on by {by}.",
                "title": "Breaker back on"})
        self.repeat.pop(self.off_id, None)
        self.off_id = None

    def _finish_return(self, now, live):
        r, self.returning = self.returning, None
        start, end = self.unavail_since or r["ts"], r["ts"]
        dur = end - start
        before, after = r.get("kwh_before"), r.get("kwh_after")
        delta = after - before if before is not None and after is not None else None
        kind = logic.classify_gap(dur, delta, self.unavail_w or 0, OPTS["min_outage_seconds"])
        artifact = bool(self.artifact and self.artifact[0] <= start <= self.artifact[1] and dur < 240)
        data = {"kwh_delta": None if delta is None else round(delta, 3), "load_w": round(self.unavail_w or 0)}
        outage = kind == "outage" and not artifact
        if outage:
            v_before = [x[1] for x in self.window if start - 120 <= x[0] <= start and x[1]]
            data["v_before"] = v_before[-1] if v_before else None
            if self.outage_id:
                update_event(self.outage_id, end=end, data=data)
            else:
                self.outage_id = open_event("outage", start, end, data=data)
            fresh_alert("power_back", f"back:{self.outage_id}", end, {
                "speak": f"The power is back. It was out for {spoken_duration(dur)}.",
                "push": f"Power back at {fmt_time(end)} after {fmt_duration(dur)} (out since {fmt_time(start)}).",
                "title": "Power is back", "whatsapp": outage_report(self.outage_id)})
        else:
            if self.outage_id:
                update_event(self.outage_id, kind="wifi", end=end, cause="wifi", data=data)
                if db.one("SELECT 1 FROM alerts WHERE key=?", (f"cut:{self.outage_id}",)):
                    fresh_alert("power_back", f"wifi:{self.outage_id}", end, {
                        "speak": "False alarm. The power didn't go out, the breaker only lost Wi-Fi.",
                        "push": f"False alarm: the breaker was offline for {fmt_duration(dur)} but kept metering, so the power never went out.",
                        "title": "Not a power cut"})
            elif dur >= 10 and not artifact:
                open_event("wifi", start, end, cause="wifi" if kind == "wifi_drop" else "short", data=data)
        self.outage_id, self.unavail_since = None, None
        # What the relay did across the gap.
        if self.relay == "off" and self.relay_before != "off" and not self.off_id:
            if outage:
                vb = data.get("v_before")
                detail = (f"The power came back at {fmt_time(end)} but the breaker stayed off"
                          + (f" (voltage was {vb:.0f} V just before the cut)" if vb else ""))
                self.off_id = open_event("off", end, cause="stayed_off", confidence="certain", detail=detail,
                                         data={"outage_start": start})
                texts = {"speak": "Warning! The power is back, but the main breaker is still off. "
                                  + ("I'll turn it back on in a minute." if OPTS["auto_restore"]
                                     else "Turn it on from the Smart Life app."),
                         "push": detail + ". Turn it on from the dashboard or the Smart Life app.",
                         "title": "Power is back but the breaker is OFF"}
                texts["whatsapp"] = "*Breaker is OFF*\n" + texts["push"]
                fresh_alert("stayed_off", f"stayed:{self.off_id}", end, texts)
                self.repeat[self.off_id] = [0, end]
            else:
                self.pending_off = {"ts": end, "ctx": {}, "deadline": end + 8, "live": live}
        elif self.relay == "on" and self.off_id:
            self._on(end, {}, live)
        self.save()

    def _energy(self, ts, value):
        if self.last_energy is None or value < self.last_energy or value - self.last_energy > 50:
            self.last_energy = value  # first reading, a reset, or a few Wh lost at a power cut
            return
        d = value - self.last_energy
        self.last_energy = value
        if d > 0:
            hour = int(ts // 3600 * 3600)
            db.execute("INSERT INTO energy_hourly(hour, kwh, source) VALUES(?, ?, 'live') "
                       "ON CONFLICT(hour) DO UPDATE SET kwh = kwh + excluded.kwh", (hour, d))

    def _internet(self, ts, state):
        if state == "off" and not self.net_id:
            self.net_id = open_event("internet", ts)
        elif state == "on" and self.net_id:
            update_event(self.net_id, end=ts)
            self.net_id = None

    def _problem(self, ts, state, attrs, live):
        if state != "on":
            return
        code = attrs.get("fault_code")
        self.fault = (ts, code)
        causes = logic.fault_causes(code)
        text = ", ".join(CAUSE_TEXT.get(c, c) for c in causes) or f"fault code {code}"
        if self.off_id and abs((get_event(self.off_id) or {}).get("start", 0) - ts) < 120:
            update_event(self.off_id, cause=causes[0] if causes else "unknown", confidence="certain",
                         detail=f"The breaker reported: {text}")
        elif not self.pending_off:
            eid = open_event("fault", ts, ts, cause=causes[0] if causes else "unknown", confidence="certain",
                             detail=f"The breaker reported: {text}", data={"code": code})
            fresh_alert("trip", f"fault:{eid}", ts, {"speak": f"Warning! The breaker reports a problem: {text}.",
                                                     "push": f"The breaker reports: {text}.", "title": "Breaker problem"})

    # ----- time passing

    def advance(self, to, live=True):
        if self.pending_off and to >= self.pending_off["deadline"]:
            self._finish_off(to)
        if self.returning and to >= self.returning["deadline"]:
            self._finish_return(to, live)
        if (self.avail is False and self.unavail_since and not self.outage_id
                and to - self.unavail_since >= OPTS["min_outage_seconds"]
                and not (self.artifact and self.artifact[0] <= self.unavail_since <= self.artifact[1]
                         and to - self.unavail_since < 240)):
            start = self.unavail_since
            self.outage_id = open_event("outage", start)
            fresh_alert("power_cut", f"cut:{self.outage_id}", start, {
                "speak": f"Load shedding. The power went out at {fmt_time(start)}.",
                "push": f"Power cut since {fmt_time(start)}. The breaker went silent and isn't metering.",
                "title": "Power cut"})
            self.save()
        if self.sample_ts is None or to - self.sample_ts > 6 * 3600:
            self.sample_ts = to
            return
        while self.sample_ts < to:
            m = self.sample_ts // 60 * 60
            step_end = min(to, m + 60)
            if (self.avail and self.last_event_ts and step_end - self.last_event_ts < 1800):
                self.bucket.add(self.cur, self.relay, step_end - self.sample_ts)
                self._band(step_end)
            if step_end >= m + 60:
                if self.bucket.secs:
                    db.execute("INSERT OR REPLACE INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               self.bucket.row(int(m)))
                self.bucket = Bucket()
            self.sample_ts = step_end

    def _band(self, ts):
        """Voltage episodes outside ±10 % of nominal lasting 30 s or more."""
        v = self.cur.get("voltage")
        nominal = OPTS["nominal_voltage"]
        kind = None if v is None or self.relay is None else "high" if v > nominal * 1.10 else "low" if 0 < v < nominal * 0.90 else None
        if self.band and self.band[0] != kind:
            if self.band_id:
                update_event(self.band_id, end=ts)
                self.band_id = None
            self.band = None
        if kind and not self.band:
            self.band = [kind, ts, v]
        if self.band:
            self.band[2] = max(self.band[2], v) if kind == "high" else min(self.band[2], v)
            if not self.band_id and ts - self.band[1] >= 30:
                self.band_id = open_event("voltage", self.band[1], cause=kind,
                                          detail=f"{'High' if kind == 'high' else 'Low'} voltage")
            if self.band_id:
                update_event(self.band_id, data={"extreme": round(self.band[2], 1)})

    def tick(self, now):
        """Every few seconds while connected: the clock-driven checks."""
        self.advance(now)
        self.heartbeat = now
        self._warnings(now)
        self._repeats(now)
        self._auto_restore(now)

    def _warnings(self, now):
        v, t = self.cur.get("voltage"), self.cur.get("temp")
        if not self.avail or self.relay != "on":
            return
        hi, lo, tmax = self.cur.get("over_v"), self.cur.get("low_v"), self.cur.get("over_t")
        margin = OPTS["voltage_warn_margin"]
        recent = [r[1] for r in self.window if now - r[0] <= 20 and r[1]]
        if v and recent and now - self.warned.get("voltage", 0) > 1800:
            if hi and min(recent) >= hi - margin:
                self.warned["voltage"] = now
                send_alert("voltage", f"volt:{int(now)}", {
                    "speak": f"Caution. The voltage is {v:.0f} volts, close to the {hi:.0f} volt cut-off.",
                    "push": f"Voltage {v:.0f} V, {hi - v:.0f} V from the breaker's {hi:.0f} V cut-off.",
                    "title": "Voltage near the cut-off"})
            elif lo and max(recent) <= lo + margin:
                self.warned["voltage"] = now
                send_alert("voltage", f"volt:{int(now)}", {
                    "speak": f"Caution. The voltage is down to {v:.0f} volts, close to the {lo:.0f} volt cut-off.",
                    "push": f"Voltage {v:.0f} V, {v - lo:.0f} V from the breaker's {lo:.0f} V cut-off.",
                    "title": "Low voltage"})
        if t and tmax and t >= tmax - OPTS["temperature_warn_margin"] and now - self.warned.get("temp", 0) > 3600:
            self.warned["temp"] = now
            send_alert("temperature", f"temp:{int(now)}", {
                "speak": f"Caution. The main breaker is at {t:.0f} degrees, close to its {tmax:.0f} degree cut-off.",
                "push": f"Breaker temperature {t:.0f} °C (cut-off {tmax:.0f} °C). Check the load and the connections.",
                "title": "Breaker getting hot"})

    def _repeats(self, now):
        if not self.off_id or self.relay != "off" or self.off_id not in self.repeat:
            return
        count, last = self.repeat[self.off_id]
        if count >= OPTS["repeat_max"] or now - last < OPTS["repeat_minutes"] * 60:
            return
        self.repeat[self.off_id] = [count + 1, now]
        ev = get_event(self.off_id)
        off_for = spoken_duration(now - ev["start"]) if ev else "a while"
        send_alert("stayed_off" if ev and ev["cause"] == "stayed_off" else "trip", f"repeat:{self.off_id}:{count + 1}", {
            "speak": f"Reminder: the main breaker has been off for {off_for}.",
            "push": f"Reminder: the breaker is still off ({off_for}).", "title": "Breaker still off"},
            channels=("alexa", "phone"))

    def _auto_restore(self, now):
        if not (OPTS["auto_restore"] and self.off_id and self.relay == "off" and self.avail):
            return
        ev = get_event(self.off_id)
        if not ev or ev["cause"] not in AUTO_RESTORE_CAUSES or self.restore_tries.get(self.off_id, 0) >= 2:
            return
        lo, hi = (self.cur.get("low_v") or 180) + 10, (self.cur.get("over_v") or 270) - 10
        delay = OPTS["auto_restore_delay_seconds"]
        recent = [r[1] for r in self.window if now - r[0] <= delay and r[1]]
        last_try = self.warned.get("restore_at", 0)
        if (now - ev["start"] < delay or not recent or not all(lo <= v <= hi for v in recent)
                or now - last_try < 120):
            return
        self.restore_tries[self.off_id] = self.restore_tries.get(self.off_id, 0) + 1
        self.warned["restore_at"] = now
        log.info("Auto-restore: voltage steady at %.0f V, switching the breaker back on", recent[-1])
        self.addon_action = ("on", now)
        threading.Thread(target=ha_service, args=("switch", "turn_on", {"entity_id": ENT["relay"]}), daemon=True).start()


tracker = None  # initialised in main()


def avg_power(lo, hi):
    row = db.one("SELECT SUM(w_avg * secs) / SUM(secs) AS w FROM samples WHERE ts >= ? AND ts < ? AND w_avg IS NOT NULL",
                 (lo, hi))
    if row and row["w"] is not None:
        return row["w"]
    return tracker.cur.get("power") or 0 if tracker else 0


def save_run(start, end, watts):
    if end - start < 30 or watts <= 0:
        return
    apps = db.query("SELECT id, watts FROM appliances")
    aid = logic.match_appliance(watts, apps)
    if aid is None:
        aid = db.execute("INSERT INTO appliances(name, watts, created) VALUES(NULL, ?, ?)", (watts, start))
    else:
        db.execute("UPDATE appliances SET watts = watts * 0.9 + ? * 0.1 WHERE id=?", (watts, aid))
    db.execute("INSERT INTO appliance_runs(appliance_id, start, end, watts, kwh) VALUES(?,?,?,?,?)",
               (aid, start, end, watts, watts * (end - start) / 3.6e6))


# ------------------------------------------------------------------ HA link

def fetch_history(lo, hi):
    ids = ",".join(ENT[k] for k in ENT if k != "clear")
    path = (f"/api/history/period/{urllib.parse.quote(iso_utc(lo))}?end_time={urllib.parse.quote(iso_utc(hi))}"
            f"&filter_entity_id={ids}&minimal_response&significant_changes_only=0")
    status, body = ha("GET", path, timeout=180)
    if status != 200:
        raise ConnectionError(f"history {status}")
    rows = []
    for series in body or []:
        eid = None
        for st in series:
            eid = st.get("entity_id", eid)
            ts = parse_iso(st.get("last_updated") or st["last_changed"])
            rows.append((ts, eid, st.get("state"), st.get("attributes") or {}))
    return sorted(rows, key=lambda r: (r[0], r[1] != ENT["relay"]))


def fetch_switch_context(lo, hi):
    """Who switched the breaker, from HA's logbook (the device page's Activity)."""
    path = (f"/api/logbook/{urllib.parse.quote(iso_utc(lo))}?end_time={urllib.parse.quote(iso_utc(hi))}"
            f"&entity={ENT['relay']}")
    status, body = ha("GET", path, timeout=60)
    out = {}
    for e in (body or []) if status == 200 else []:
        try:
            ts = round(parse_iso(e["when"]))
        except (KeyError, ValueError):
            continue
        if e.get("context_user_id"):
            out[ts] = {"user_id": e["context_user_id"]}
        elif e.get("context_event_type") in ("automation_triggered", "script_started") or \
                str(e.get("context_entity_id", "")).startswith(("automation.", "script.")):
            out[ts] = {"parent_id": e.get("context_entity_id") or "automation"}
    return out


def replay(lo, hi):
    """Feeds HA's recorded history for [lo, hi] through the tracker, in 6-hour chunks."""
    t = lo
    while t < hi:
        t2 = min(hi, t + 6 * 3600)
        rows = fetch_history(t, t2)
        ctx = fetch_switch_context(t, t2)
        with tracker.lock:
            for ts, eid, state, attrs in rows:
                c = ctx.get(round(ts)) if eid == ENT["relay"] else None
                tracker.handle(ts, eid, state, attrs, c, live=False)
            tracker.advance(t2, live=False)
            tracker.save()
        t = t2


def import_statistics(ws, before):
    """First run: hourly energy and readings from HA's long-term statistics (kept forever),
    for the time before the detailed history starts."""
    lo = before - 3 * 365 * 86400
    ids = [ENT["energy"], ENT["voltage"], ENT["current"], ENT["power"], ENT["pf"], ENT["hz"], ENT["temp"]]
    res = ws.call({"type": "recorder/statistics_during_period", "start_time": iso_utc(lo), "end_time": iso_utc(before),
                   "statistic_ids": ids, "period": "hour", "types": ["change", "mean", "min", "max"]}, timeout=300) or {}
    n = 0
    for row in res.get(ENT["energy"], []):
        if row.get("change") is not None and 0 <= row["change"] < 100:
            db.execute("INSERT OR IGNORE INTO energy_hourly(hour, kwh, source) VALUES(?, ?, 'statistics')",
                       (int(row["start"] / 1000), row["change"]))
            n += 1
    by_hour = {}
    for key, eid in (("v", ENT["voltage"]), ("a", ENT["current"]), ("w", ENT["power"]), ("pf", ENT["pf"]),
                     ("hz", ENT["hz"]), ("t", ENT["temp"])):
        for row in res.get(eid, []):
            by_hour.setdefault(int(row["start"] / 1000), {})[key] = row
    for hour, r in by_hour.items():
        g = lambda k, f: (r.get(k) or {}).get(f)
        if g("v", "mean") is None:
            continue
        db.execute("INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (hour, 3600, g("v", "min"), g("v", "mean"), g("v", "max"), g("a", "mean"), g("a", "max"),
                    g("w", "mean"), g("w", "max"), g("pf", "mean"), g("hz", "min"), g("hz", "max"), g("t", "max"),
                    None, None))
    log.info("Imported %s hours of energy and %s hours of readings from HA's statistics", n, len(by_hour))


def ha_downtime(lo, hi):
    """(stopped, started) of a Home Assistant restart in [lo, hi], from its logbook."""
    path = f"/api/logbook/{urllib.parse.quote(iso_utc(lo))}?end_time={urllib.parse.quote(iso_utc(hi))}"
    status, body = ha("GET", path, timeout=60)
    stopped = started = None
    for e in (body or []) if status == 200 else []:
        if e.get("domain") != "homeassistant":
            continue
        ts = parse_iso(e["when"])
        if e.get("message") == "stopped":
            stopped = ts
        elif e.get("message") == "started" and ts > lo:
            started = ts
    return stopped, started


def first_energy_after(ts):
    rows = [r for r in fetch_history(ts, ts + 900) if r[1] == ENT["energy"] and num(r[2]) is not None and r[0] >= ts]
    return num(rows[0][2]) if rows else None


def judge_gap(gap_lo, gap_hi, before, load):
    """HA was down from gap_lo to gap_hi: nobody saw the breaker. Its energy counter
    shows whether the power stayed on."""
    if gap_hi - gap_lo < 180 or not tracker.avail:
        return
    after = first_energy_after(gap_hi)
    delta = after - before if after is not None and before is not None else None
    est = logic.gap_estimate(gap_hi - gap_lo, delta, load)
    data = {"kwh_delta": None if delta is None else round(delta, 3), "load_w": round(load), "estimated_min": None}
    if est and est >= 120:
        data["estimated_min"] = round(est / 60)
        open_event("outage", gap_lo, gap_hi, confidence="estimated",
                   detail=f"Home Assistant was offline; the energy counter suggests about {round(est / 60)} min without power",
                   data=data)
    else:
        open_event("gap", gap_lo, gap_hi, detail="Home Assistant was offline" +
                   ("; the energy counter kept running, so the power was on" if est == 0 else ""), data=data)


def on_connect(ws):
    now = time.time()
    states = ws.call({"type": "get_states"}) or []
    tracker.persons = {s["attributes"].get("user_id"): s["attributes"].get("friendly_name")
                       for s in states if s["entity_id"].startswith("person.") and s["attributes"].get("user_id")}
    hist_from = now - 10 * 86400
    if not db.get_setting("imported"):
        # First run: HA's statistics for the older months, then its 10 days of detail.
        try:
            import_statistics(ws, hist_from)
        except Exception:
            log.exception("Importing HA statistics failed; continuing with history only")
        log.info("Importing the last 10 days of history (takes a minute)")
        replay(hist_from, time.time())
        db.set_setting("imported", True)
    ws.call({"type": "subscribe_trigger", "trigger": {"trigger": "state", "entity_id": [
        ENT[k] for k in ENT if k != "clear"]}})
    # Catch up on whatever happened while this add-on or HA was down.
    gap_lo = tracker.heartbeat
    lo = max((tracker.last_ts or hist_from) - 5, hist_from)
    try:
        stopped = started = None
        if gap_lo and now - gap_lo > 120:
            stopped, started = ha_downtime(gap_lo - 300, now)
        log.info("Catching up from %s", time.strftime("%d %b %H:%M:%S", time.localtime(lo)))
        if started:
            down_from = stopped or gap_lo
            replay(lo, down_from)
            with tracker.lock:
                before, load = tracker.last_energy, avg_power(down_from - 1800, down_from)
                tracker.last_event_ts, tracker.sample_ts = None, started  # nothing was seen while HA was down
                tracker.artifact = (started - 5, started + 180)          # its startup drops are HA's own doing
                judge_gap(down_from, started, before, load)
            replay(started - 5, time.time())
        else:
            replay(lo, time.time())
    except Exception:
        log.exception("Replaying HA history failed")
    with tracker.lock:
        tracker.ha_connected = tracker.caught_up = True
        tracker.save()
    threading.Thread(target=publish_all, daemon=True).start()


def ha_loop():
    delay = 5
    while True:
        ws = None
        try:
            ws = HAWebSocket()
            log.info("Connected to Home Assistant")
            on_connect(ws)
            delay, last = 5, time.time()
            while True:
                msg = ws.recv(30)
                now = time.time()
                if msg is None:
                    if now - last > 95:
                        raise ConnectionError("Home Assistant stopped answering")
                    ws.send({"type": "ping", "id": ws.next_id})
                    ws.next_id += 1
                    continue
                last = now
                if msg.get("type") != "event":
                    continue
                trig = ((msg.get("event") or {}).get("variables") or {}).get("trigger") or {}
                to = trig.get("to_state")
                if not to:
                    continue
                ts = parse_iso(to.get("last_updated") or to["last_changed"])
                with tracker.lock:
                    tracker.handle(ts, to["entity_id"], to["state"], to.get("attributes"), to.get("context"), live=True)
        except Exception as e:
            log.warning("Home Assistant link down: %s", e)
        finally:
            if ws:
                ws.close()
            with tracker.lock:
                tracker.ha_connected = tracker.caught_up = False
                tracker.save()
        time.sleep(delay)
        delay = min(60, delay * 2)


def tick_loop():
    n = 0
    while True:
        time.sleep(5)
        n += 1
        try:
            with tracker.lock:
                if tracker.caught_up:
                    tracker.tick(time.time())
                if n % 6 == 0:
                    tracker.save()
            if n % 60 == 0 and tracker.caught_up:
                money_checks()
                publish_all()
        except Exception:
            log.exception("Tick failed")


# ------------------------------------------------------------------ alerts

alert_queue = queue.Queue()


def fresh_alert(kind, key, event_ts, texts):
    """Alerts only for things that just happened (not when replaying old history)."""
    if time.time() - event_ts < 900:
        send_alert(kind, key, texts)


def send_alert(kind, key, texts, channels=("alexa", "phone", "whatsapp")):
    """Each key is sent once, across restarts too."""
    chosen = [c for c in channels if kind in OPTS.get(f"alerts_{c}", [])]
    try:
        db.execute("INSERT INTO alerts(key, ts, kind, text, channels) VALUES(?,?,?,?,?)",
                   (key, time.time(), kind, texts.get("push") or texts.get("speak"), ",".join(chosen)))
    except sqlite3.IntegrityError:
        return
    if chosen:
        alert_queue.put((kind, key, texts, chosen))


CRITICAL = {"trip", "stayed_off"}


def alert_loop():
    while True:
        kind, key, texts, chosen = alert_queue.get()
        try:
            quiet = in_window(time.time(), OPTS["alexa_quiet_hours"]) and not (
                kind in CRITICAL and OPTS["critical_ignores_quiet_hours"])
            if "phone" in chosen:
                ha_notify(texts.get("title", "Electricity"), texts.get("push") or texts["speak"], critical=kind in CRITICAL)
            if "alexa" in chosen and not quiet:
                speak(texts["speak"])
            if "whatsapp" in chosen:
                threading.Thread(target=whatsapp_send, args=(
                    texts.get("whatsapp") or f"*{texts.get('title', 'Electricity')}*\n{texts.get('push') or texts['speak']}",
                    f"emon-{key}"), daemon=True).start()
        except Exception:
            log.exception("Alert %s failed", key)


def ha_notify(title, message, critical=False):
    service = (OPTS.get("notify_service") or "").strip()
    if not service:
        return
    domain, _, name = service.partition(".")
    if not name:
        domain, name = "notify", domain
    data = {"tag": "electricity", "channel": "Electricity"}
    if critical:
        data.update({"priority": "high", "ttl": 0, "importance": "high"})
    ha_service(domain, name, {"title": title, "message": message, "data": data})


def speak(text):
    entities_ = [e for e in OPTS["alexa_entities"]
                 if ((ha_get_state(e) or {}).get("state") not in (None, "unavailable"))]
    if entities_:
        alexa_say(entities_, text)
    elif OPTS["offline_tts_service"]:
        log.info("No Echo is reachable (maybe unpowered); speaking on the phone")
        phone_say(text)


def alexa_say(entities_, text):
    """Raises the Echo(s) to alexa_volume, announces, then restores each one's volume."""
    target = max(0, min(100, OPTS["alexa_volume"])) / 100
    restore = {}
    for entity in entities_:
        volume = ((ha_get_state(entity) or {}).get("attributes") or {}).get("volume_level")
        if volume is not None and abs(volume - target) > 0.005:
            restore[entity] = volume
    for entity in restore:
        ha_service("media_player", "volume_set", {"entity_id": entity, "volume_level": target})
    if restore:
        time.sleep(1.5)
    status = ha_service("notify", "alexa_media", {"message": text, "target": entities_,
                                                   "data": {"type": "announce", "method": "speak"}})
    log.info("Alexa announcement (%s): %s", status, text)
    time.sleep(5 + len(text) / 12)
    for entity, volume in restore.items():
        ha_service("media_player", "volume_set", {"entity_id": entity, "volume_level": volume})


def phone_say(text):
    domain, _, name = OPTS["offline_tts_service"].strip().partition(".")
    if not name:
        domain, name = "notify", domain
    ha_service(domain, name, {"message": "TTS", "data": {"tts_text": text, "media_stream": "alarm_stream_max"}})


_bridge = {"url": None, "to": "", "token": ""}


def _bridge_info():
    """The PDC WhatsApp Bridge add-on's Supervisor info (IP and options), looked up by slug."""
    own = ((supervisor("GET", "/addons/self/info")[1] or {}).get("data") or {}).get("slug") or ""
    slug = re.sub(r"electricity_monitor$", "pdc_whatsapp", own)
    return ((supervisor("GET", f"/addons/{slug}/info")[1] or {}).get("data") or {}) if slug else {}


def bridge_url():
    """The bridge publishes no host port; it's reached on its Supervisor-network IP."""
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


def whatsapp_send(text, key, give_up_after=1800):
    to, token = whatsapp_config()
    if not (to and token):
        return False
    deadline, delay = time.time() + give_up_after, 15
    while True:
        url = bridge_url()
        status, body = (None, {})
        if url:
            status, body = _http("POST", f"{url}/send", token, {"to": to, "text": text, "idempotencyKey": key}, 40)
            body = body or {}
        if status == 200:
            log.info("WhatsApp message sent (%s)", key)
            return True
        if status in (400, 401, 403, 413):
            log.error("WhatsApp bridge rejected the message (%s): check whatsapp_to / whatsapp_api_token", status)
            return False
        if status is None:
            _bridge["url"] = None  # the bridge restarted and may have a new IP
        if time.time() + delay > deadline:
            log.warning("Gave up sending the WhatsApp message (%s)", status)
            return False
        time.sleep(delay)
        delay = min(120, delay * 2)


def trip_texts(cause, detail, ts):
    what = CAUSE_TEXT.get(cause, "Unknown reason")
    protective = cause in PROTECTION
    return {
        "speak": (f"Warning! The main breaker has switched off. {what}. {detail}." if protective
                  else f"Warning! The main breaker has switched off. {detail}."),
        "push": f"Breaker switched OFF at {fmt_time(ts)}. {what}: {detail}.",
        "title": "Breaker switched OFF",
        "whatsapp": f"*Breaker switched OFF* at {fmt_time(ts)}\n{what}\n{detail}",
    }


# ------------------------------------------------------------ money checks

def bill_cfg():
    return {k: OPTS[k] for k in ("tariff_slabs", "lifeline_units", "lifeline_rate", "sanctioned_load_kw",
                                 "demand_charge_per_kw", "meter_rent", "vat_percent", "prepaid_rebate_percent")}


def month_units(ts=None):
    ts = ts or time.time()
    return kwh_between(month_start(ts), ts + 1)


def money_checks():
    """Low balance and slab warnings (every few minutes)."""
    now = time.time()
    p = prepaid_status()
    if p.get("configured") and p["balance"] is not None:
        last = db.scalar("SELECT MAX(id) FROM prepaid") or 0
        if p["balance"] <= OPTS["low_balance_alert"]:
            send_alert("balance", f"bal:{last}", {
                "speak": f"Your electricity balance is low: about {p['balance']:.0f} taka" +
                         (f", enough for {p['days_left']:.0f} days." if p.get("days_left") is not None else "."),
                "push": f"Prepaid balance ≈ {money(p['balance'])}" +
                        (f", about {p['days_left']:.1f} days left at your usage." if p.get("days_left") is not None else "."),
                "title": "Recharge the meter soon"})
        elif p.get("days_left") is not None and p["days_left"] <= OPTS["low_balance_days"]:
            send_alert("balance", f"days:{last}", {
                "speak": f"Your electricity balance will run out in about {p['days_left']:.0f} days.",
                "push": f"Prepaid balance ≈ {money(p['balance'])}, runs out around {fmt_day_time(p['runs_out'])}.",
                "title": "Recharge the meter soon"})
    if not OPTS["slab_alerts"]:
        return
    units = month_units(now)
    slabs = logic.parse_slabs(OPTS["tariff_slabs"])
    rate, limit, nxt = logic.slab_position(units, slabs, OPTS["lifeline_units"], OPTS["lifeline_rate"])
    month = time.strftime("%Y-%m")
    if limit and nxt and nxt > rate and units >= limit - OPTS["slab_warn_units"]:
        send_alert("slab", f"slab:{month}:{limit}", {
            "speak": f"You've used {units:.0f} units this month. After {limit} units, each unit costs "
                     f"{nxt:g} taka instead of {rate:g}.",
            "push": f"{units:.0f} kWh used this month. From unit {limit + 1} the rate rises from "
                    f"{money(rate)} to {money(nxt)} per unit.", "title": "Close to the next price slab"})
    # Crossed into a pricier slab since the last check.
    prev = db.get_setting("slab_seen", {})
    if prev.get("month") == month and prev.get("rate") is not None and rate > prev["rate"]:
        send_alert("slab", f"slabin:{month}:{rate}", {
            "speak": f"This month's usage just moved into the {rate:g} taka per unit slab.",
            "push": f"{units:.0f} kWh this month: every extra unit now costs {money(rate)}.",
            "title": "New price slab"})
    db.set_setting("slab_seen", {"month": month, "rate": rate})


# ---------------------------------------------------------------- payloads

STATE_LABEL = {"on": "Power on", "outage": "Power cut", "off": "Breaker off", "trip": "Breaker tripped",
               "offline": "Breaker offline", "unknown": "Not connected"}


def live_state():
    t = tracker
    if not t.ha_connected:
        return "unknown", t.heartbeat, None
    if t.avail is False:
        return ("outage" if t.outage_id else "offline"), t.unavail_since, None
    if t.relay == "off":
        ev = get_event(t.off_id)
        cause = ev["cause"] if ev else "unknown"
        return ("trip" if cause in PROTECTION or cause == "stayed_off" else "off"), ev["start"] if ev else None, ev
    if t.relay == "on":
        last = db.one("SELECT MAX(end) AS e FROM events WHERE kind IN ('outage','off') AND end IS NOT NULL")
        return "on", last["e"] if last else None, None
    return "unknown", None, None


def events_in(lo, hi, kinds=None):
    sql = "SELECT * FROM events WHERE start < ? AND (end IS NULL OR end > ?)"
    params = [hi, lo]
    if kinds:
        sql += f" AND kind IN ({','.join('?' * len(kinds))})"
        params += kinds
    rows = db.query(sql + " ORDER BY start DESC", params)
    now = time.time()
    for r in rows:
        r["data"] = json.loads(r["data"] or "{}")
        r["duration_s"] = (r["end"] or now) - r["start"]
        r["cause_text"] = CAUSE_TEXT.get(r["cause"]) if r["kind"] in ("off", "fault") else None
    return rows


def clipped(rows, lo, hi):
    now = time.time()
    return sum(max(0, min(r["end"] or now, hi) - max(r["start"], lo)) for r in rows)


def summary(lo, hi):
    outs = events_in(lo, hi, ["outage"])
    offs = events_in(lo, hi, ["off"])
    trips = [r for r in offs if r["cause"] not in SELF_CAUSED]
    nets = events_in(lo, hi, ["internet"])
    down = clipped(outs, lo, hi)
    span = max(1, min(hi, time.time()) - lo)
    kwh = kwh_between(lo, hi)
    both = sum(1 for o in outs if any(n["start"] < (o["end"] or time.time()) and (n["end"] or time.time()) > o["start"]
                                      for n in nets))
    causes = {}
    for r in trips:
        causes[r["cause"]] = causes.get(r["cause"], 0) + 1
    return {
        "outages": len(outs), "outage_s": down, "longest_s": max((r["duration_s"] for r in outs), default=0),
        "average_s": down / len(outs) if outs else 0, "power_pct": 100 * (1 - down / span),
        "trips": len(trips), "offs": len(offs), "trip_causes": causes,
        "wifi": len(events_in(lo, hi, ["wifi"])), "kwh": kwh, "outages_with_internet_down": both,
        "voltage_events": len(events_in(lo, hi, ["voltage"])),
    }


def timeline(lo, hi, buckets):
    step = (hi - lo) / buckets
    evs = events_in(lo, hi, ["outage", "off", "wifi", "gap"])
    have = {r["b"] for r in db.query("SELECT CAST((ts - ?) / ? AS INTEGER) AS b FROM samples WHERE ts >= ? AND ts < ? "
                                     "GROUP BY b", (lo, step, lo, hi))}
    rank = {"outage": 4, "off": 3, "gap": 2, "wifi": 1}
    out = []
    now = time.time()
    for i in range(buckets):
        a, b = lo + i * step, lo + (i + 1) * step
        state, worst = ("on" if i in have else "none"), 0
        for e in evs:
            if e["start"] < b and (e["end"] or now) > a and rank[e["kind"]] > worst:
                worst, state = rank[e["kind"]], e["kind"]
        if a > now:
            state = "future"
        out.append({"lo": a, "hi": b, "state": state})
    return out


def monitored_days(days):
    lo = day_start(time.time()) - (days - 1) * 86400
    rows = db.query("SELECT DISTINCT CAST(ts / 3600 AS INTEGER) * 3600 AS h FROM samples WHERE ts >= ?", (lo,))
    return sorted({day_start(r["h"]) for r in rows})


def heatmap(days):
    lo = day_start(time.time()) - (days - 1) * 86400
    outs = [(r["start"], r["end"] or time.time()) for r in events_in(lo, time.time(), ["outage"])]
    grid = [[0.0] * 24 for _ in range(7)]
    for s, e in outs:
        t = max(s, lo)
        while t < e:
            lt = time.localtime(t)
            nxt = min(e, (t // 3600 + 1) * 3600)
            grid[lt.tm_wday][lt.tm_hour] += (nxt - t) / 60
            t = nxt
    mdays = monitored_days(days)
    odds = logic.hourly_odds(outs, len(mdays), mdays)
    return {"grid": grid, "odds": odds, "days": len(mdays), "outages": len(outs)}


def prediction():
    h = heatmap(28)
    if h["days"] < 3:
        return None
    nl = logic.next_likely(h["odds"], time.localtime().tm_hour - 1, 0.3)
    lt = time.localtime()
    now_odds = h["odds"][lt.tm_hour]
    if not nl:
        return {"now": now_odds, "next": None, "days": h["days"]}
    k, hour, p = nl
    return {"now": now_odds, "next": {"hour": hour, "in_hours": k - 1, "chance": p,
                                      "ts": (time.time() // 3600 + k - 1) * 3600}, "days": h["days"]}


def calendar_days(days):
    lo = day_start(time.time()) - (days - 1) * 86400
    out = {}
    d = lo
    while d <= time.time():
        out[int(d)] = {"day": int(d), "outage_min": 0, "outages": 0, "kwh": 0, "trips": 0}
        d = day_start(d + 90000)
    for r in events_in(lo, time.time(), ["outage", "off"]):
        k = int(day_start(r["start"]))
        if k in out:
            if r["kind"] == "outage":
                out[k]["outages"] += 1
                out[k]["outage_min"] += r["duration_s"] / 60
            elif r["cause"] not in SELF_CAUSED:
                out[k]["trips"] += 1
    for r in db.query("SELECT hour, kwh FROM energy_hourly WHERE hour >= ?", (lo,)):
        k = int(day_start(r["hour"]))
        if k in out:
            out[k]["kwh"] += r["kwh"] * cal()
    have = set(monitored_days(days))
    for k, v in out.items():
        v["monitored"] = k in have or v["kwh"] > 0
    return list(out.values())


def avg_rate(units):
    """Average price per unit incl. VAT at a month's usage level."""
    if units <= 0:
        return logic.parse_slabs(OPTS["tariff_slabs"])[0][1] * (1 + OPTS["vat_percent"] / 100)
    cost = logic.energy_cost(units, logic.parse_slabs(OPTS["tariff_slabs"]), OPTS["lifeline_units"], OPTS["lifeline_rate"])[0]
    return cost / units * (1 + OPTS["vat_percent"] / 100)


def usage(period, lo, hi):
    rows = db.query("SELECT hour, kwh FROM energy_hourly WHERE hour >= ? AND hour < ? ORDER BY hour", (lo, hi))
    fmt = {"hour": "%Y-%m-%d %H", "day": "%Y-%m-%d", "month": "%Y-%m"}[period]
    groups = {}
    for r in rows:
        lt = time.localtime(r["hour"])
        k = time.strftime(fmt, lt)
        if period == "hour":
            start = r["hour"]
        elif period == "day":
            start = day_start(r["hour"])
        else:
            start = month_start(r["hour"])
        g = groups.setdefault(k, {"ts": start, "kwh": 0.0, "month": time.strftime("%Y-%m", lt)})
        g["kwh"] += r["kwh"] * cal()
    rate_cache = {}
    for g in groups.values():
        if g["month"] not in rate_cache:
            y, m = (int(x) for x in g["month"].split("-"))
            a, b = month_bounds(y, m)
            rate_cache[g["month"]] = avg_rate(kwh_between(a, b))
        g["cost"] = g["kwh"] * rate_cache[g["month"]]
    out = sorted(groups.values(), key=lambda g: g["ts"])
    return {"buckets": out, "total": sum(g["kwh"] for g in out), "cost": sum(g["cost"] for g in out)}


def base_load(days=7):
    """The always-on draw: 5th percentile of minute power while the breaker was on."""
    rows = db.query("SELECT w_avg FROM samples WHERE ts >= ? AND w_avg IS NOT NULL AND relay = 1 AND secs >= 50 "
                    "ORDER BY w_avg", (time.time() - days * 86400,))
    if len(rows) < 60:
        return None
    return rows[len(rows) // 20]["w_avg"]


def comparisons():
    now = time.time()
    d0 = day_start(now)
    w0 = d0 - time.localtime(now).tm_wday * 86400
    m0 = month_start(now)
    pm0 = month_start(m0 - 86400)
    elapsed_m = now - m0
    return {
        "today": kwh_between(d0, now + 1), "yesterday_same": kwh_between(d0 - 86400, now - 86400 + 1),
        "yesterday": kwh_between(d0 - 86400, d0),
        "week": kwh_between(w0, now + 1), "last_week_same": kwh_between(w0 - 7 * 86400, now - 7 * 86400 + 1),
        "month": kwh_between(m0, now + 1), "last_month_same": kwh_between(pm0, min(m0, pm0 + elapsed_m) + 1),
        "last_month": kwh_between(pm0, m0),
        "year": kwh_between(time.mktime((time.localtime(now).tm_year, 1, 1, 0, 0, 0, 0, 0, -1)), now + 1),
    }


def bill_payload(year, month):
    lo, hi = month_bounds(year, month)
    now = time.time()
    units = kwh_between(lo, min(hi, now + 1))
    b = logic.month_bill(units, bill_cfg())
    slabs = logic.parse_slabs(OPTS["tariff_slabs"])
    rate, limit, nxt = logic.slab_position(units, slabs, OPTS["lifeline_units"], OPTS["lifeline_rate"])
    out = {"month": f"{year:04d}-{month:02d}", "units": units, "bill": b, "rate": rate, "next_limit": limit,
           "next_rate": nxt, "current": lo <= now < hi,
           "slabs": [{"upto": u, "rate": r} for u, r in slabs], "lifeline": [OPTS["lifeline_units"], OPTS["lifeline_rate"]]}
    if lo <= now < hi:
        days_total = (hi - lo) / 86400
        recent = kwh_between(now - 7 * 86400, now + 1) / 7
        days_left = (hi - now) / 86400
        proj = units + recent * days_left
        out["projected_units"] = proj
        out["projected"] = logic.month_bill(proj, bill_cfg())
        out["per_day"] = recent
        out["days_total"] = days_total
        if limit and recent > 0:
            out["limit_in_days"] = (limit - units) / recent
            out["limit_at"] = now + out["limit_in_days"] * 86400 if out["limit_in_days"] <= days_left else None
    return out


def prepaid_status():
    sync = db.one("SELECT * FROM prepaid WHERE kind='sync' ORDER BY ts DESC LIMIT 1")
    history = db.query("SELECT * FROM prepaid ORDER BY ts DESC LIMIT 60")
    fixed = logic.monthly_fixed(bill_cfg())
    m0 = month_start(time.time())
    paid_this_month = db.one("SELECT 1 FROM prepaid WHERE kind='recharge' AND ts >= ?", (m0,)) is not None
    base = {"configured": bool(sync), "history": history, "monthly_fixed": fixed,
            "fixed_pending": not paid_this_month, "balance": None, "low_alert": OPTS["low_balance_alert"],
            "low_days": OPTS["low_balance_days"]}
    if not sync:
        return base
    now = time.time()
    credit = 0.0
    for r in db.query("SELECT * FROM prepaid WHERE kind='recharge' AND ts > ? ORDER BY ts", (sync["ts"],)):
        first = not db.one("SELECT 1 FROM prepaid WHERE kind='recharge' AND ts >= ? AND ts < ?",
                           (month_start(r["ts"]), r["ts"]))
        credit += logic.recharge_credit(r["amount"], first, bill_cfg())
    cost, t = 0.0, sync["ts"]
    while t < now:
        m_lo = month_start(t)
        m_hi = month_bounds(time.localtime(t).tm_year, time.localtime(t).tm_mon)[1]
        seg_end = min(now, m_hi)
        before = kwh_between(m_lo, t)
        after = kwh_between(m_lo, seg_end + 1)
        cost += logic.usage_cost(before, after, bill_cfg())
        t = m_hi
    balance = sync["amount"] + credit - cost
    week = kwh_between(now - 7 * 86400, now + 1)
    m_units = month_units(now)
    per_day = (logic.usage_cost(m_units, m_units + week, bill_cfg()) / 7) if week > 0 else None
    days_left = max(0.0, balance / per_day) if per_day else None
    base.update({"balance": balance, "synced_at": sync["ts"], "synced_balance": sync["amount"], "spent": cost,
                 "credit": credit, "per_day": per_day, "days_left": days_left,
                 "runs_out": now + days_left * 86400 if days_left is not None and days_left > 0 else None})
    return base


def quality(lo, hi):
    span = hi - lo
    group = 60 if span <= 2 * 86400 else 3600 if span <= 31 * 86400 else 86400
    rows = db.query(
        f"""SELECT CAST(ts / {group} AS INTEGER) * {group} AS t, MIN(v_min) AS v_min, SUM(v_avg * secs) / SUM(secs) AS v_avg,
            MAX(v_max) AS v_max, SUM(w_avg * secs) / SUM(secs) AS w_avg, MAX(w_max) AS w_max,
            SUM(pf_avg * secs) / SUM(secs) AS pf, MIN(hz_min) AS hz_min, MAX(hz_max) AS hz_max, MAX(t_max) AS t_max,
            MAX(a_max) AS a_max
            FROM samples WHERE ts >= ? AND ts < ? AND v_avg IS NOT NULL GROUP BY t ORDER BY t""", (lo, hi))
    nominal = OPTS["nominal_voltage"]
    bands = {"good": 0.0, "fair": 0.0, "bad": 0.0}
    for r in db.query("SELECT v_avg, v_min, v_max, secs FROM samples WHERE ts >= ? AND ts < ? AND v_avg IS NOT NULL",
                      (lo, hi)):
        bands[logic.voltage_band(r["v_avg"], nominal)] += r["secs"]
    total = sum(bands.values()) or 1
    pct = {k: 100 * v / total for k, v in bands.items()}
    ext = db.one("SELECT MAX(v_max) AS vmax, MIN(v_min) AS vmin, MAX(t_max) AS tmax, MAX(a_max) AS amax, "
                 "MAX(w_max) AS wmax, MIN(hz_min) AS hzmin, MAX(hz_max) AS hzmax FROM samples WHERE ts >= ? AND ts < ?",
                 (lo, hi)) or {}
    when = lambda col, val: db.scalar(f"SELECT ts FROM samples WHERE ts >= ? AND ts < ? AND {col} = ? LIMIT 1",
                                      (lo, hi, val)) if val is not None else None
    return {"group": group, "points": rows, "bands": pct, "grade": logic.grade(pct["good"], pct["bad"]) if total > 1 else None,
            "extremes": {**ext, "vmax_at": when("v_max", ext.get("vmax")), "vmin_at": when("v_min", ext.get("vmin")),
                         "wmax_at": when("w_max", ext.get("wmax"))},
            "events": events_in(lo, hi, ["voltage"])[:200], "nominal": nominal}


def suggestions():
    """Plain advice on the breaker's protection settings from what's been measured."""
    c = tracker.cur
    q = db.one("SELECT MAX(v_max) AS vmax, MIN(v_min) AS vmin, MAX(a_max) AS amax, MAX(w_max) AS wmax, "
               "MAX(t_max) AS tmax FROM samples WHERE ts >= ?", (time.time() - 30 * 86400,)) or {}
    out = []
    if not c.get("over_a"):
        amax = q.get("amax")
        sug = max(16, min(63, round((amax or 20) * 1.3 / 2) * 2))
        out.append({"key": "over_a", "level": "warn", "title": "Over-current protection is off",
                    "text": f"The highest current in 30 days was {amax:.1f} A. A limit around {sug} A would cut "
                            "the power on a real overload without tripping on normal use." if amax else
                            "Set a limit a little above your highest normal current.", "value": sug})
    if not c.get("over_kw"):
        wmax = q.get("wmax")
        sug = round(max(3.0, (wmax or 3000) / 1000 * 1.3), 1)
        out.append({"key": "over_kw", "level": "info", "title": "Over-power protection is off",
                    "text": (f"Peak power in 30 days was {wmax / 1000:.2f} kW. About {sug} kW would guard against "
                             "overload; over-current protection does the same job.") if wmax else "Optional.",
                    "value": sug})
    hi, lo = c.get("over_v"), c.get("low_v")
    if hi and q.get("vmax"):
        room = hi - q["vmax"]
        out.append({"key": "over_v", "level": "warn" if room < 8 else "good",
                    "title": f"Over-voltage cut-off at {hi:.0f} V",
                    "text": f"Highest voltage in 30 days: {q['vmax']:.0f} V ({room:.0f} V of headroom)." +
                            (" It may trip on the evening peaks; appliances are rated to about 250-260 V, so "
                             "keep it no higher than 270 V." if room < 8 else " Good protection for your appliances.")})
    if lo and q.get("vmin"):
        room = q["vmin"] - lo
        out.append({"key": "low_v", "level": "warn" if room < 8 else "good",
                    "title": f"Low-voltage cut-off at {lo:.0f} V",
                    "text": f"Lowest voltage in 30 days: {q['vmin']:.0f} V ({room:.0f} V above the cut-off)." +
                            (" Motors (fridge, pump, AC) suffer below about 190 V." if lo < 185 else "")})
    tmax, tlim = q.get("tmax"), c.get("over_t")
    if tmax and tlim:
        out.append({"key": "over_t", "level": "warn" if tlim - tmax < 8 else "good",
                    "title": f"Over-temperature cut-off at {tlim:.0f} °C",
                    "text": f"Hottest the breaker got in 30 days: {tmax:.0f} °C."})
    return out


def appliances_payload(days=30):
    lo = time.time() - days * 86400
    apps = db.query("SELECT a.id, a.name, a.watts, COUNT(r.id) AS runs, SUM(r.kwh) AS kwh, SUM(r.end - r.start) AS secs, "
                    "MAX(r.end) AS last FROM appliances a LEFT JOIN appliance_runs r ON r.appliance_id = a.id "
                    "AND r.start >= ? GROUP BY a.id ORDER BY kwh DESC", (lo,))
    rate = avg_rate(month_units())
    for a in apps:
        a["kwh"] = (a["kwh"] or 0) * cal()
        a["cost"] = a["kwh"] * rate
        hours = db.query("SELECT start FROM appliance_runs WHERE appliance_id=? AND start >= ?", (a["id"], lo))
        hist = [0] * 24
        for h in hours:
            hist[time.localtime(h["start"]).tm_hour] += 1
        a["hours"] = hist
    runs = db.query("SELECT r.*, a.name FROM appliance_runs r LEFT JOIN appliances a ON a.id = r.appliance_id "
                    "ORDER BY r.start DESC LIMIT 60")
    base = base_load()
    return {"appliances": apps, "runs": runs, "base_w": base, "rate": rate,
            "base_cost_month": base / 1000 * 24 * 30 * rate if base else None}


def lookup_at(ts):
    row = db.one("SELECT * FROM samples WHERE ts <= ? AND ts > ? ORDER BY ts DESC LIMIT 1", (ts, ts - 3600))
    evs = [e for e in events_in(ts - 1, ts + 1) if e["kind"] in ("outage", "off", "wifi", "gap", "voltage", "internet")]
    return {"ts": ts, "sample": row, "events": evs}


def spark(minutes=60):
    now = time.time()
    rows = db.query("SELECT ts, w_avg, v_avg FROM samples WHERE ts >= ? ORDER BY ts", (now - minutes * 60,))
    pts = [{"ts": r["ts"], "w": r["w_avg"], "v": r["v_avg"]} for r in rows]
    with tracker.lock:
        live = [{"ts": r[0], "w": r[3], "v": r[1]} for r in tracker.window if r[0] > (pts[-1]["ts"] + 60 if pts else 0)]
    return pts + live


def status_payload():
    now = time.time()
    with tracker.lock:
        state, since, off_ev = live_state()
        cur = dict(tracker.cur)
        avail, relay = tracker.avail, tracker.relay
    d0 = day_start(now)
    today = summary(d0, now)
    bill = bill_payload(time.localtime(now).tm_year, time.localtime(now).tm_mon)
    p = prepaid_status()
    p.pop("history", None)
    probe = ha_get_state(ENT["problem"]) if tracker.ha_connected else None
    return {
        "now": now, "state": state, "label": STATE_LABEL[state], "since": since, "off_event": off_ev,
        "avail": avail, "relay": relay, "readings": cur, "ha_connected": tracker.ha_connected,
        "today": today, "compare": comparisons(), "bill": bill, "prepaid": p, "prediction": prediction(),
        "base_w": base_load(), "spark": spark(60), "currency": OPTS["currency"],
        "problem_state": (probe or {}).get("state"), "auto_restore": OPTS["auto_restore"],
        "open_outage": get_event(tracker.outage_id), "unavail_since": tracker.unavail_since,
        "recent": events_in(now - 3 * 86400, now, ["outage", "off", "fault", "wifi", "gap"])[:12],
        "last_outage": next(iter(events_in(0, now, ["outage"])), None),
        "min_outage_s": OPTS["min_outage_seconds"],
    }


def alerts_payload():
    return db.query("SELECT * FROM alerts ORDER BY ts DESC LIMIT 100")


# ------------------------------------------------------------------ reports

def outage_report(eid):
    ev = get_event(eid)
    if not ev:
        return ""
    dur = (ev["end"] or time.time()) - ev["start"]
    d0 = day_start(ev["start"])
    s = summary(d0, time.time())
    lines = [f"*Power is back* after {fmt_duration(dur)}",
             f"Out: {fmt_time(ev['start'])} - {fmt_time(ev['end'] or time.time())}",
             f"Today: {s['outages']} cut{'s' if s['outages'] != 1 else ''}, {fmt_duration(s['outage_s'])} without power"]
    if ev["data"].get("v_before"):
        lines.append(f"Voltage just before: {ev['data']['v_before']:.0f} V")
    return "\n".join(lines)


def period_report(title, lo, hi, prev_lo=None):
    s = summary(lo, hi)
    u = usage("day", lo, hi)
    q = quality(lo, hi)
    lines = [f"*{title}*", f"Used: {s['kwh']:.1f} kWh (≈ {money(u['cost'])})"]
    if prev_lo is not None:
        prev = kwh_between(prev_lo, lo)
        if prev > 0:
            ch = 100 * (s["kwh"] - prev) / prev
            lines[-1] += f", {'+' if ch >= 0 else ''}{ch:.0f}% vs before"
    lines.append(f"Power cuts: {s['outages']}" + (f", {fmt_duration(s['outage_s'])} in total, longest "
                                                  f"{fmt_duration(s['longest_s'])}" if s["outages"] else ""))
    lines.append(f"Breaker trips: {s['trips'] or 'none'}" + (
        " (" + ", ".join(f"{CAUSE_TEXT.get(c, c).lower()} x{n}" for c, n in s["trip_causes"].items()) + ")" if s["trips"] else ""))
    ex = q["extremes"]
    if ex.get("vmin"):
        lines.append(f"Voltage: {ex['vmin']:.0f}-{ex['vmax']:.0f} V" + (f", grade {q['grade']}" if q["grade"] else ""))
    p = prepaid_status()
    if p.get("balance") is not None:
        lines.append(f"Prepaid balance: ≈ {money(p['balance'])}" + (
            f" ({p['days_left']:.0f} days left)" if p.get("days_left") is not None else ""))
    return "\n".join(lines)


def monthly_report(year, month):
    lo, hi = month_bounds(year, month)
    plo = month_bounds(year - (month == 1), 12 if month == 1 else month - 1)[0]
    text = period_report(f"Electricity in {time.strftime('%B %Y', time.localtime(lo))}", lo, hi, plo)
    b = bill_payload(year, month)["bill"]
    text += (f"\n\nEstimated bill: {money(b['total'])}\n  energy {money(b['energy'])}, demand {money(b['demand'])}, "
             f"meter rent {money(b['meter_rent'])}, VAT {money(b['vat'])}")
    h = heatmap(31)
    worst = max(range(24), key=lambda i: h["odds"][i]) if h["outages"] else None
    if worst is not None and h["odds"][worst] > 0:
        text += f"\nMost load shedding around {time.strftime('%I %p', time.strptime(str(worst), '%H')).lstrip('0')}"
    return text


def report_loop():
    while True:
        time.sleep(30)
        try:
            now = time.time()
            lt = time.localtime(now)
            day = time.strftime("%Y-%m-%d", lt)
            if OPTS["daily_report_enabled"] and lt.tm_hour == OPTS["daily_report_hour"] and \
                    db.get_setting("daily_sent") != day:
                db.set_setting("daily_sent", day)
                whatsapp_send(period_report(f"Electricity today ({time.strftime('%a %d %b', lt)})", day_start(now), now,
                                            day_start(now) - 86400), f"emon-daily-{day}")
            if OPTS["weekly_report_enabled"] and WEEKDAYS[lt.tm_wday] == OPTS["weekly_report_day"] and \
                    lt.tm_hour == OPTS["weekly_report_hour"] and db.get_setting("weekly_sent") != day:
                db.set_setting("weekly_sent", day)
                lo = day_start(now) - 6 * 86400
                whatsapp_send(period_report("Electricity this week", lo, now, lo - 7 * 86400), f"emon-weekly-{day}")
            if OPTS["monthly_report_enabled"] and lt.tm_mday == 1 and lt.tm_hour == OPTS["monthly_report_hour"]:
                y, m = (lt.tm_year - 1, 12) if lt.tm_mon == 1 else (lt.tm_year, lt.tm_mon - 1)
                tag = f"{y}-{m:02d}"
                if db.get_setting("monthly_sent") != tag:
                    db.set_setting("monthly_sent", tag)
                    whatsapp_send(monthly_report(y, m), f"emon-monthly-{tag}")
            if db.get_setting("retention_day") != day:
                db.set_setting("retention_day", day)
                db.execute("DELETE FROM samples WHERE ts < ?", (now - OPTS["retention_days"] * 86400,))
        except Exception:
            log.exception("Report loop failed")


# ------------------------------------------------------------------ sensors

def publish_all():
    """(Re)publishes the add-on's sensors; states set via the REST API vanish on HA restart."""
    if not tracker.ha_connected:
        return
    try:
        s = status_payload()
    except Exception:
        log.exception("Building status failed")
        return
    now = time.time()
    t = s["today"]
    cur = OPTS["currency"]
    ha_set_state("binary_sensor.electricity_grid_power", "off" if s["state"] in ("outage",) else "on" if s["state"] != "unknown" else "unknown", {
        "friendly_name": "Grid power", "device_class": "power", "since": iso(s["since"])})
    ha_set_state("sensor.electricity_status", s["label"], {
        "friendly_name": "Electricity status", "icon": "mdi:transmission-tower", "since": iso(s["since"]),
        "reason": (s["off_event"] or {}).get("detail")})
    last = s["last_outage"]
    ha_set_state("sensor.electricity_last_power_cut", iso(last["end"] or last["start"]) if last else "unknown", {
        "friendly_name": "Last power cut", "device_class": "timestamp", "icon": "mdi:flash-off",
        "started": iso(last["start"]) if last else None, "ongoing": bool(last and not last["end"]),
        "duration": fmt_duration(last["duration_s"]) if last else None})
    ha_set_state("sensor.electricity_power_cuts_today", t["outages"], {
        "friendly_name": "Power cuts today", "icon": "mdi:flash-alert", "state_class": "measurement",
        "minutes": round(t["outage_s"] / 60), "longest_min": round(t["longest_s"] / 60)})
    ha_set_state("sensor.electricity_power_cut_minutes_today", round(t["outage_s"] / 60), {
        "friendly_name": "Power cut time today", "unit_of_measurement": "min", "icon": "mdi:timer-off-outline",
        "state_class": "measurement"})
    trip = next(iter(events_in(0, now, ["off", "fault"])), None)
    ha_set_state("sensor.electricity_last_breaker_off", iso(trip["start"]) if trip else "unknown", {
        "friendly_name": "Last breaker switch-off", "device_class": "timestamp", "icon": "mdi:electric-switch",
        "reason": trip["cause_text"] if trip else None, "detail": trip["detail"] if trip else None})
    c = s["compare"]
    ha_set_state("sensor.electricity_energy_today", round(c["today"], 2), {
        "friendly_name": "Electricity used today", "unit_of_measurement": "kWh", "icon": "mdi:lightning-bolt"})
    ha_set_state("sensor.electricity_energy_month", round(c["month"], 1), {
        "friendly_name": "Electricity used this month", "unit_of_measurement": "kWh", "icon": "mdi:calendar-month"})
    b = s["bill"]
    ha_set_state("sensor.electricity_bill_month", round(b["bill"]["total"]), {
        "friendly_name": "Electricity bill this month", "unit_of_measurement": cur, "icon": "mdi:cash",
        "projected": round(b.get("projected", {}).get("total", 0)), "units": round(b["units"], 1),
        "projected_units": round(b.get("projected_units", 0))})
    ha_set_state("sensor.electricity_price_slab", b["rate"], {
        "friendly_name": "Electricity price per unit", "unit_of_measurement": f"{cur}/kWh", "icon": "mdi:stairs-up",
        "next_limit": b["next_limit"], "next_rate": b["next_rate"]})
    p = s["prepaid"]
    if p.get("balance") is not None:
        ha_set_state("sensor.electricity_prepaid_balance", round(p["balance"]), {
            "friendly_name": "Prepaid meter balance (estimated)", "unit_of_measurement": cur, "icon": "mdi:wallet",
            "days_left": round(p["days_left"], 1) if p.get("days_left") is not None else None,
            "runs_out": iso(p.get("runs_out"))})
    pr = s["prediction"]
    if pr:
        nxt = pr.get("next")
        ha_set_state("sensor.electricity_next_likely_power_cut", iso(nxt["ts"]) if nxt else "unknown", {
            "friendly_name": "Next likely power cut", "device_class": "timestamp", "icon": "mdi:crystal-ball",
            "chance_pct": round(nxt["chance"] * 100) if nxt else None, "chance_now_pct": round(pr["now"] * 100)})


# ----------------------------------------------------------------- settings

WINDOW_RE = r"^\d{1,2}:\d{2}-\d{1,2}:\d{2}$"
SETTINGS = {
    "breaker_prefix": ("text", True, r"^[a-z0-9_]+$"),
    "min_outage_seconds": ("int", 20, 3600),
    "auto_restore": ("bool",),
    "auto_restore_delay_seconds": ("int", 10, 1800),
    "repeat_minutes": ("int", 1, 240),
    "repeat_max": ("int", 0, 50),
    "voltage_warn_margin": ("int", 0, 60),
    "temperature_warn_margin": ("int", 0, 40),
    "nominal_voltage": ("int", 100, 260),
    "voltage_offset": ("float", -30, 30),
    "energy_calibration_percent": ("float", -50, 50),
    "alexa_entities": ("texts", r"^media_player\.[a-z0-9_]+$", "media_player.xxx"),
    "alexa_volume": ("int", 0, 100),
    "alexa_quiet_hours": ("texts", WINDOW_RE, "HH:MM-HH:MM"),
    "critical_ignores_quiet_hours": ("bool",),
    "notify_service": ("text", False, None),
    "offline_tts_service": ("text", False, None),
    "whatsapp_to": ("text", False, r"^\+[1-9]\d{7,14}$"),
    "whatsapp_api_token": ("text", False, None),
    "whatsapp_bridge_url": ("text", False, r"^https?://\S+$"),
    "alerts_alexa": ("multi", ALERT_KINDS),
    "alerts_phone": ("multi", ALERT_KINDS),
    "alerts_whatsapp": ("multi", ALERT_KINDS),
    "daily_report_enabled": ("bool",),
    "daily_report_hour": ("int", 0, 23),
    "weekly_report_enabled": ("bool",),
    "weekly_report_day": ("choice", WEEKDAYS),
    "weekly_report_hour": ("int", 0, 23),
    "monthly_report_enabled": ("bool",),
    "monthly_report_hour": ("int", 0, 23),
    "currency": ("text", True, None),
    "tariff_slabs": ("texts", logic.SLAB_RE, "200:8.50 (0:rate = above the rest)", 1),
    "lifeline_units": ("int", 0, 500),
    "lifeline_rate": ("float", 0, 100),
    "sanctioned_load_kw": ("float", 0, 100),
    "demand_charge_per_kw": ("float", 0, 1000),
    "meter_rent": ("float", 0, 10000),
    "vat_percent": ("float", 0, 50),
    "prepaid_rebate_percent": ("float", 0, 20),
    "low_balance_alert": ("float", 0, 100000),
    "low_balance_days": ("int", 0, 60),
    "slab_alerts": ("bool",),
    "slab_warn_units": ("int", 0, 200),
    "appliance_min_watts": ("int", 50, 10000),
    "retention_days": ("int", 30, 3650),
}
RESTART_KEYS = {"breaker_prefix", "appliance_min_watts"}
SECRET_KEYS = {"whatsapp_api_token"}


def _check(spec, value):
    kind = spec[0]
    if kind in ("int", "float"):
        if isinstance(value, bool) or value is None or value == "":
            raise ValueError("must be a number")
        v = float(value)
        if kind == "int":
            if v != int(v):
                raise ValueError("must be a whole number")
            v = int(v)
        if not spec[1] <= v <= spec[2]:
            raise ValueError(f"must be between {spec[1]:g} and {spec[2]:g}")
        return v
    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError("must be on or off")
        return value
    if kind == "choice":
        if value not in spec[1]:
            raise ValueError("must be one of the options")
        return value
    if kind == "multi":
        if not isinstance(value, list) or any(v not in spec[1] for v in value):
            raise ValueError("unknown option")
        return [v for v in spec[1] if v in value]
    if kind == "text":
        v = str(value if value is not None else "").strip()
        if spec[1] and not v:
            raise ValueError("can't be empty")
        if v and spec[2] and not re.match(spec[2], v):
            raise ValueError("isn't in the right format")
        return v
    if kind == "texts":
        if not isinstance(value, list):
            raise ValueError("must be a list")
        v = [str(x).strip() for x in value if str(x).strip()]
        bad = [x for x in v if not re.match(spec[1], x)]
        if bad:
            raise ValueError(f"“{bad[0]}” should look like {spec[2]}")
        if len(v) < (spec[3] if len(spec) > 3 else 0):
            raise ValueError("needs at least one entry")
        return v
    raise ValueError("unknown type")


def save_settings(changes):
    clean, errors = {}, {}
    for key, value in changes.items():
        if key not in SETTINGS:
            errors[key] = "unknown setting"
            continue
        if key in SECRET_KEYS and not value:
            continue
        try:
            clean[key] = _check(SETTINGS[key], value)
        except ValueError as e:
            errors[key] = str(e)
    if errors:
        return 400, {"errors": errors}
    clean = {k: v for k, v in clean.items() if v != OPTS.get(k)}
    if not clean:
        return 200, {"ok": True, "changed": [], "restart": False}
    if SUPERVISOR_TOKEN:
        status, info = supervisor("GET", "/addons/self/info")
        current = ((info or {}).get("data") or {}).get("options") if status == 200 else None
        if current is None:
            return 502, {"error": "Couldn't read the current settings from Home Assistant"}
        status, body = supervisor("POST", "/addons/self/options", {"options": {**current, **clean}})
        if status != 200:
            return 400 if status == 400 else 502, {
                "error": (body or {}).get("message") or f"Home Assistant didn't accept the settings ({status})"}
    else:
        try:
            with open(OPTIONS_PATH, encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError):
            stored = {}
        with open(OPTIONS_PATH + ".tmp", "w", encoding="utf-8") as f:
            json.dump({**stored, **clean}, f, indent=2, ensure_ascii=False)
        os.replace(OPTIONS_PATH + ".tmp", OPTIONS_PATH)
    OPTS.update(clean)
    log.info("Settings changed: %s", ", ".join(sorted(clean)))
    restart = bool(RESTART_KEYS & clean.keys())
    if restart and SUPERVISOR_TOKEN:
        threading.Timer(1.5, supervisor, args=("POST", "/addons/self/restart")).start()
    threading.Thread(target=publish_all, daemon=True).start()
    return 200, {"ok": True, "changed": sorted(clean), "restart": restart}


def settings_payload():
    values = {k: OPTS.get(k) for k in SETTINGS}
    for k in SECRET_KEYS:
        values[k] = ""
    states = ha("GET", "/api/states", timeout=20)[1] or []
    players = {s["entity_id"]: (s.get("attributes") or {}).get("friendly_name") or s["entity_id"]
               for s in states if s.get("entity_id", "").startswith("media_player.")}
    for e in OPTS["alexa_entities"]:
        players.setdefault(e, e)
    services = ha("GET", "/api/services", timeout=20)[1] or []
    notify = sorted(f"notify.{name}" for d in services if d.get("domain") == "notify" for name in (d.get("services") or {}))
    return {"values": values, "secrets_set": {k: bool(OPTS.get(k)) for k in SECRET_KEYS},
            "media_players": [{"id": k, "name": v} for k, v in sorted(players.items(), key=lambda x: x[1].lower())],
            "notify_services": notify, "alert_kinds": ALERT_KINDS, "restart_keys": sorted(RESTART_KEYS)}


# ---------------------------------------------------------------- controls

LIMIT_ENTITY = {"low_v": "low_v", "over_v": "over_v", "over_a": "over_a", "over_kw": "over_kw", "over_t": "over_t",
                "over_kwh": "over_kwh"}


def control(body):
    action = body.get("action")
    if action in ("on", "off"):
        with tracker.lock:
            tracker.addon_action = (action, time.time())
        status = ha_service("switch", f"turn_{action}", {"entity_id": ENT["relay"]})
    elif action == "clear_flag":
        status = ha_service("button", "press", {"entity_id": ENT["clear"]})
    elif action == "set_limit":
        key = body.get("key")
        if key not in LIMIT_ENTITY:
            return 400, {"error": "unknown limit"}
        value = float(body.get("value"))
        st = ha_get_state(ENT[key]) or {}
        a = st.get("attributes") or {}
        if not (a.get("min", -1e9) <= value <= a.get("max", 1e9)):
            return 400, {"error": f"must be between {a.get('min')} and {a.get('max')}"}
        status = ha_service("number", "set_value", {"entity_id": ENT[key], "value": value})
    else:
        return 400, {"error": "unknown action"}
    return (200, {"ok": True}) if status in (200, 201) else (502, {"error": f"Home Assistant answered {status}"})


def prepaid_post(path, body):
    if path == "/api/prepaid/delete":
        db.execute("DELETE FROM prepaid WHERE id=?", (int(body["id"]),))
        return 200, {"ok": True}
    amount = float(body.get("amount"))
    ts = float(body.get("ts") or time.time())
    if not (0 <= amount <= 1e6) or ts > time.time() + 300:
        return 400, {"error": "check the amount and time"}
    kind = "sync" if path.endswith("sync") else "recharge"
    if kind == "recharge" and amount < 1:
        return 400, {"error": "enter the recharge amount"}
    note = None
    if kind == "sync":
        before = prepaid_status()
        if before.get("balance") is not None:
            note = f"Estimate was {money(before['balance'])} ({'+' if amount - before['balance'] >= 0 else ''}{amount - before['balance']:.0f})"
    db.execute("INSERT INTO prepaid(ts, kind, amount, note) VALUES(?,?,?,?)", (ts, kind, amount, note))
    threading.Thread(target=publish_all, daemon=True).start()
    return 200, {"ok": True, "status": prepaid_status()}


# --------------------------------------------------------------------- http

CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ElectricityMonitor/1.0"

    def log_message(self, fmt, *args):
        log.debug("http: " + fmt, *args)

    def _allowed(self):
        if ALLOWED_CLIENTS is None or self.client_address[0] in ALLOWED_CLIENTS:
            return True
        self.send_error(403)
        return False

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=str)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _range(self, qs, default=86400):
        now = time.time()
        hi = float(qs.get("to", [now])[0])
        lo = float(qs.get("from", [hi - default])[0])
        return lo, hi

    def do_GET(self):
        if not self._allowed():
            return
        url = urllib.parse.urlparse(self.path)
        path, qs = url.path.rstrip("/") or "/", urllib.parse.parse_qs(url.query)
        try:
            if path == "/":
                return self._static("index.html")
            if path.startswith("/static/"):
                return self._static(path[len("/static/"):])
            if path == "/api/status":
                return self._send(200, status_payload())
            if path == "/api/events":
                lo, hi = self._range(qs, 30 * 86400)
                kinds = [k for k in qs.get("kinds", [""])[0].split(",") if k] or None
                return self._send(200, events_in(lo, hi, kinds)[:1000])
            if path == "/api/summary":
                lo, hi = self._range(qs)
                return self._send(200, summary(lo, hi))
            if path == "/api/timeline":
                lo, hi = self._range(qs)
                return self._send(200, timeline(lo, hi, max(10, min(400, int(qs.get("buckets", [96])[0])))))
            if path == "/api/heatmap":
                return self._send(200, heatmap(max(1, min(365, int(qs.get("days", [30])[0])))))
            if path == "/api/calendar":
                return self._send(200, calendar_days(max(7, min(366, int(qs.get("days", [365])[0])))))
            if path == "/api/usage":
                lo, hi = self._range(qs, 86400)
                period = qs.get("period", ["hour"])[0]
                if period not in ("hour", "day", "month"):
                    raise ValueError("period")
                span = hi - lo
                prev = usage(period, lo - span, lo)
                return self._send(200, {**usage(period, lo, hi), "previous": prev["total"], "previous_cost": prev["cost"]})
            if path == "/api/bill":
                y, m = (int(x) for x in qs.get("month", [time.strftime("%Y-%m")])[0].split("-"))
                return self._send(200, bill_payload(y, m))
            if path == "/api/months":
                rows = db.query("SELECT DISTINCT CAST(hour AS INTEGER) AS h FROM energy_hourly ORDER BY h")
                months = sorted({time.strftime("%Y-%m", time.localtime(r["h"])) for r in rows}, reverse=True)
                out = []
                for mth in months[:36]:
                    y, m = (int(x) for x in mth.split("-"))
                    lo, hi = month_bounds(y, m)
                    s = summary(lo, min(hi, time.time()))
                    out.append({"month": mth, "kwh": s["kwh"], "bill": logic.month_bill(s["kwh"], bill_cfg())["total"],
                                "outages": s["outages"], "outage_s": s["outage_s"], "trips": s["trips"]})
                return self._send(200, out)
            if path == "/api/prepaid":
                return self._send(200, prepaid_status())
            if path == "/api/quality":
                lo, hi = self._range(qs)
                return self._send(200, quality(lo, hi))
            if path == "/api/protection":
                with tracker.lock:
                    cur = dict(tracker.cur)
                limits = {}
                for k in LIMIT_ENTITY:
                    st = ha_get_state(ENT[k]) or {}
                    a = st.get("attributes") or {}
                    limits[k] = {"value": num(st.get("state")) if st else cur.get(k), "min": a.get("min"), "max": a.get("max"),
                                 "step": a.get("step"), "unit": a.get("unit_of_measurement"),
                                 "available": st.get("state") not in (None, "unavailable", "unknown")}
                probe = ha_get_state(ENT["problem"]) or {}
                return self._send(200, {"limits": limits, "readings": cur, "suggestions": suggestions(),
                                        "problem": {"state": probe.get("state"), "attributes": probe.get("attributes")},
                                        "events": events_in(0, time.time(), ["off", "fault"])[:200]})
            if path == "/api/appliances":
                return self._send(200, appliances_payload(int(qs.get("days", [30])[0])))
            if path == "/api/at":
                return self._send(200, lookup_at(float(qs["ts"][0])))
            if path == "/api/alerts":
                return self._send(200, alerts_payload())
            if path == "/api/settings":
                return self._send(200, settings_payload())
            if path == "/api/report":
                kind = qs.get("kind", ["weekly"])[0]
                now = time.time()
                if kind == "monthly":
                    y, m = (int(x) for x in qs.get("month", [time.strftime("%Y-%m")])[0].split("-"))
                    return self._send(200, {"text": monthly_report(y, m)})
                lo = day_start(now) - (6 * 86400 if kind == "weekly" else 0)
                return self._send(200, {"text": period_report("Electricity this week" if kind == "weekly"
                                                              else "Electricity today", lo, now, lo - (now - lo))})
            if path in ("/api/export/events.csv", "/api/export/usage.csv"):
                lo, hi = self._range(qs, 365 * 86400)
                return self._csv(path, lo, hi)
            self.send_error(404)
        except (KeyError, ValueError) as e:
            self._send(400, {"error": str(e)})

    def do_POST(self):
        if not self._allowed():
            return
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": "invalid json"})
        try:
            if path == "/api/control":
                return self._send(*control(body))
            if path == "/api/settings":
                return self._send(*save_settings(body if isinstance(body, dict) else {}))
            if path.startswith("/api/prepaid/"):
                return self._send(*prepaid_post(path, body))
            if path == "/api/appliances/rename":
                name = str(body.get("name") or "").strip()[:40] or None
                db.execute("UPDATE appliances SET name=? WHERE id=?", (name, int(body["id"])))
                return self._send(200, {"ok": True})
            if path == "/api/appliances/delete":
                db.execute("DELETE FROM appliance_runs WHERE appliance_id=?", (int(body["id"]),))
                db.execute("DELETE FROM appliances WHERE id=?", (int(body["id"]),))
                return self._send(200, {"ok": True})
            if path == "/api/test/alert":
                channel = body.get("channel", "alexa")
                text = "This is a test from Electricity Monitor. The power is on."
                if channel == "alexa":
                    if not OPTS["alexa_entities"]:
                        return self._send(400, {"error": "No Echo devices are selected"})
                    threading.Thread(target=speak, args=(text,), daemon=True).start()
                elif channel == "phone":
                    if not OPTS["notify_service"]:
                        return self._send(400, {"error": "No phone notification service is set"})
                    threading.Thread(target=ha_notify, args=("Electricity Monitor test", text), daemon=True).start()
                elif channel == "whatsapp":
                    ok = whatsapp_send("_Test message_\n\n" + period_report("Electricity today", day_start(time.time()),
                                                                           time.time()), f"emon-test-{int(time.time())}", 0)
                    return self._send(200 if ok else 502, {"ok": ok} if ok else {"error": "Not sent, see the add-on log"})
                return self._send(202, {"ok": True})
            if path == "/api/report/send":
                kind = body.get("kind", "weekly")
                now = time.time()
                if kind == "monthly":
                    y, m = (int(x) for x in str(body.get("month")).split("-"))
                    text = monthly_report(y, m)
                else:
                    lo = day_start(now) - (6 * 86400 if kind == "weekly" else 0)
                    text = period_report("Electricity this week" if kind == "weekly" else "Electricity today", lo, now)
                ok = whatsapp_send(text, f"emon-manual-{kind}-{int(now)}", 0)
                return self._send(200 if ok else 502, {"ok": ok} if ok else {"error": "Not sent, see the add-on log"})
        except (KeyError, ValueError, TypeError) as e:
            return self._send(400, {"error": str(e)})
        self.send_error(404)

    def _static(self, name):
        full = os.path.realpath(os.path.join(STATIC_DIR, name))
        if not full.startswith(os.path.realpath(STATIC_DIR)) or not os.path.isfile(full):
            return self.send_error(404)
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))

    def _csv(self, path, lo, hi):
        buf = io.StringIO()
        w = csv.writer(buf)
        local = lambda ts: time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else ""
        if path.endswith("events.csv"):
            w.writerow(["kind", "start", "end", "duration_min", "cause", "confidence", "detail"])
            for r in reversed(events_in(lo, hi)):
                w.writerow([r["kind"], local(r["start"]), local(r["end"]) or "ongoing", round(r["duration_s"] / 60, 1),
                            r["cause_text"] or r["cause"] or "", r["confidence"] or "", r["detail"] or ""])
            name = "electricity-events.csv"
        else:
            w.writerow(["day", "kwh", "cost", "power_cuts", "power_cut_min", "trips"])
            for d in calendar_days(max(7, min(366, int((hi - lo) / 86400) + 1))):
                w.writerow([time.strftime("%Y-%m-%d", time.localtime(d["day"])), round(d["kwh"], 3),
                            round(d["kwh"] * avg_rate(month_units(d["day"] + 86399)), 2), d["outages"],
                            round(d["outage_min"]), d["trips"]])
            name = "electricity-daily.csv"
        self._send(200, buf.getvalue(), "text/csv; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="{name}"'})


# --------------------------------------------------------------------- main

def main():
    global db, tracker
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    os.makedirs(DATA_DIR, exist_ok=True)
    db = db or DB(DB_PATH)
    tracker = tracker or Tracker()
    if os.environ.get("EMON_DEMO"):
        tracker.ha_connected = tracker.caught_up = True
    log.info("Electricity Monitor starting: breaker %s, power cut after %ss without the breaker",
             ENT["relay"], OPTS["min_outage_seconds"])
    targets = [alert_loop, report_loop]
    if SUPERVISOR_TOKEN or HA_URL:
        targets += [ha_loop, tick_loop]
    else:
        log.warning("No Home Assistant connection configured (demo mode)")
    for target in targets:
        threading.Thread(target=target, daemon=True, name=target.__name__).start()
    server = ThreadingHTTPServer((os.environ.get("EMON_BIND", "0.0.0.0"), HTTP_PORT), Handler)
    log.info("Dashboard listening on port %s (Ingress)", HTTP_PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
