"""Net Monitor: hourly international speedtest + internet outage tracker.

Runs three loops:
  * connectivity monitor - TCP-connects to a few international (Singapore) hosts every
    N seconds and records outages (start/end) in SQLite.
  * speedtest scheduler - runs the Ookla CLI against a pinned (Singapore) server
    on a wall-clock schedule, postponing while the router shows the line is busy.
  * HTTP server - the Ingress dashboard and its JSON API.
"""

import csv
import io
import json
import logging
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.environ.get("NETMON_DATA_DIR", "/data")
OPTIONS_PATH = os.path.join(DATA_DIR, "options.json")
DB_PATH = os.path.join(DATA_DIR, "netmon.db")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
SPEEDTEST_BIN = os.environ.get("NETMON_SPEEDTEST_BIN", "speedtest")
HTTP_PORT = int(os.environ.get("NETMON_PORT", "38765"))
# Ingress traffic arrives from the Supervisor; nothing else may reach the UI.
ALLOWED_CLIENTS = {"172.30.32.2", "127.0.0.1", "::1"}
if os.environ.get("NETMON_ALLOW_ALL") == "1":
    ALLOWED_CLIENTS = None

DEFAULT_OPTIONS = {
    "speedtest_interval_minutes": 60,
    "server_ids": [13058, 7556, 62530, 67827],
    "check_interval_seconds": 30,
    "check_targets": ["sgp-ping.vultr.com:443", "m1speedtest1.m1net.com.sg:8080",
                      "speedtest.singnet.com.sg:8080", "1.1.1.1:443"],
    "busy_threshold_mbps": 5.0,
    "busy_retry_minutes": 10,
    "recovery_speedtest_min_outage_minutes": 2,
    "notify_service": "",
    "notify_min_outage_minutes": 1,
    "retention_days": 365,
    "plan_download_mbps": 40.0,
    "plan_upload_mbps": 40.0,
    "slow_alert_percent": 50,
    "slow_alert_consecutive_tests": 2,
    "weekly_report_enabled": True,
    "weekly_report_day": "sun",
    "weekly_report_hour": 21,
    "quality_samples": 5,
}
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

log = logging.getLogger("net_monitor")


def load_options():
    opts = dict(DEFAULT_OPTIONS)
    try:
        with open(OPTIONS_PATH, encoding="utf-8") as f:
            opts.update({k: v for k, v in json.load(f).items() if v is not None})
    except FileNotFoundError:
        log.warning("No options.json found, using defaults")
    return opts


OPTS = load_options()


# --------------------------------------------------------------------------- db

class DB:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS checks (
                ts REAL NOT NULL,
                up INTEGER NOT NULL,
                latency_ms REAL
            );
            CREATE INDEX IF NOT EXISTS idx_checks_ts ON checks(ts);
            CREATE TABLE IF NOT EXISTS speedtests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                status TEXT NOT NULL,
                trigger TEXT NOT NULL,
                download_mbps REAL, upload_mbps REAL,
                ping_ms REAL, jitter_ms REAL, packet_loss REAL,
                server_id INTEGER, server_name TEXT, server_location TEXT,
                isp TEXT, external_ip TEXT, result_url TEXT,
                data_used_mb REAL, busy_mbps REAL, error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_speedtests_ts ON speedtests(ts);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL,
                start REAL NOT NULL,
                end REAL,
                recovery_speedtest_id INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS ip_log (ts REAL NOT NULL, ip TEXT, isp TEXT);
            """
        )
        # v1.1: connection-quality columns on existing databases.
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(checks)")}
        for col in ("jitter_ms", "loss_pct"):
            if col not in cols:
                self.conn.execute(f"ALTER TABLE checks ADD COLUMN {col} REAL")
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

    def get_setting(self, key, default=None):
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key, value):
        self.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )


db = None  # initialised in main()


# ---------------------------------------------------------------------- state

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.online = None
        self.last_check_ts = None
        self.last_latency_ms = None
        self.last_jitter_ms = None
        self.last_loss_pct = None
        self.outage_id = None
        self.outage_start = None
        self.test_running = False
        self.test_started_ts = None
        self.test_phase = None      # ping / download / upload
        self.test_progress = 0.0    # 0..1 within the phase
        self.test_live_mbps = None
        self.slow_streak = 0
        self.slow_alerted = False
        self.next_test_ts = None
        self.scheduler_note = ""
        self.router_upnp = None  # None unknown, True reachable, False not found


state = State()
test_lock = threading.Lock()


def fmt_time(ts):
    return time.strftime("%I:%M %p", time.localtime(ts)).lstrip("0")


def fmt_day_time(ts):
    today = time.localtime().tm_yday
    lt = time.localtime(ts)
    t = fmt_time(ts)
    return t if lt.tm_yday == today else f"{time.strftime('%d %b', lt)} {t}"


def fmt_duration(seconds):
    seconds = int(round(seconds))
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    if d:
        return f"{d}d {h}h {m}m"
    if h:
        return f"{h}h {m}m"
    if m:
        return f"{m}m {s}s" if m < 10 else f"{m}m"
    return f"{s}s"


# ------------------------------------------------------------ home assistant

def _supervisor_request(method, path, payload=None):
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None
    body = json.dumps(payload).encode() if payload is not None else None
    for host in ("http://supervisor", "http://172.30.32.2"):
        req = urllib.request.Request(
            f"{host}{path}", data=body, method=method,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status
        except urllib.error.URLError as e:
            if isinstance(e, urllib.error.HTTPError):
                log.warning("HA API %s %s -> %s", method, path, e.code)
                return e.code
            continue  # try the next host name
    log.warning("HA API unreachable for %s", path)
    return None


def ha_set_state(entity_id, value, attributes):
    threading.Thread(
        target=_supervisor_request,
        args=("POST", f"/core/api/states/{entity_id}", {"state": value, "attributes": attributes}),
        daemon=True,
    ).start()


def ha_notify(title, message):
    service = (OPTS.get("notify_service") or "").strip()
    if not service:
        return
    domain, _, name = service.partition(".")
    if not name:
        domain, name = "notify", domain
    _supervisor_request("POST", f"/core/api/services/{domain}/{name}",
                        {"title": title, "message": message})


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(ts)) if ts else None


def publish_connectivity():
    ha_set_state("binary_sensor.net_monitor_internet", "on" if state.online else "off", {
        "friendly_name": "Internet",
        "device_class": "connectivity",
        "latency_ms": round(state.last_latency_ms, 1) if state.last_latency_ms else None,
        "jitter_ms": round(state.last_jitter_ms, 1) if state.last_jitter_ms is not None else None,
        "packet_loss_pct": state.last_loss_pct,
        "online_since": iso(online_since()) if state.online else None,
        "offline_since": iso(state.outage_start),
    })


def publish_all():
    """(Re)publishes every sensor; states set via the REST API vanish on HA restart."""
    publish_connectivity()
    row = db.one("SELECT * FROM speedtests WHERE status='ok' ORDER BY ts DESC LIMIT 1")
    if row:
        common = {"state_class": "measurement", "server": row.get("server_name"),
                  "tested_at": iso(row["ts"])}
        ha_set_state("sensor.net_monitor_download", round(row["download_mbps"], 2), {
            **common, "friendly_name": "Internet download (international)",
            "unit_of_measurement": "Mbit/s", "device_class": "data_rate", "icon": "mdi:download"})
        ha_set_state("sensor.net_monitor_upload", round(row["upload_mbps"], 2), {
            **common, "friendly_name": "Internet upload (international)",
            "unit_of_measurement": "Mbit/s", "device_class": "data_rate", "icon": "mdi:upload"})
        ha_set_state("sensor.net_monitor_ping", round(row["ping_ms"], 1), {
            **common, "friendly_name": "Internet ping (international)",
            "unit_of_measurement": "ms", "device_class": "duration", "icon": "mdi:timer-outline"})
        ha_set_state("sensor.net_monitor_download_plan", round(100 * row["download_mbps"] / plan_down()), {
            **common, "friendly_name": "Internet speed vs plan", "unit_of_measurement": "%",
            "plan_mbps": plan_down(), "icon": "mdi:gauge"})
    now = time.time()
    s = summary(now - 86400, now)
    ha_set_state("sensor.net_monitor_uptime_24h",
                 round(s["uptime_pct"], 2) if s["uptime_pct"] is not None else "unknown", {
                     "friendly_name": "Internet uptime (24h)", "unit_of_measurement": "%",
                     "state_class": "measurement", "outages": s["outages"],
                     "downtime_min": round(s["downtime_s"] / 60, 1), "icon": "mdi:check-network-outline"})
    if state.last_jitter_ms is not None:
        ha_set_state("sensor.net_monitor_jitter", round(state.last_jitter_ms, 1), {
            "friendly_name": "Internet jitter", "unit_of_measurement": "ms", "state_class": "measurement",
            "device_class": "duration", "icon": "mdi:sine-wave"})
    if state.last_loss_pct is not None:
        ha_set_state("sensor.net_monitor_packet_loss", round(state.last_loss_pct, 1), {
            "friendly_name": "Internet packet loss", "unit_of_measurement": "%",
            "state_class": "measurement", "icon": "mdi:package-variant-remove"})
    last = db.one("SELECT start, end FROM events WHERE kind='internet_down' AND end IS NOT NULL "
                  "ORDER BY end DESC LIMIT 1")
    ha_set_state("sensor.net_monitor_last_outage", iso(last["end"]) if last else "unknown", {
        "friendly_name": "Last internet outage", "device_class": "timestamp", "icon": "mdi:lan-disconnect",
        "started": iso(last["start"]) if last else None,
        "duration_min": round((last["end"] - last["start"]) / 60, 1) if last else None,
        "duration": fmt_duration(last["end"] - last["start"]) if last else None})


def publish_loop():
    while True:
        time.sleep(300)
        try:
            publish_all()
        except Exception:
            log.exception("Publishing sensors failed")


# -------------------------------------------------------------- router (UPnP)

class RouterTraffic:
    """Reads WAN byte counters from the router's UPnP IGD service."""

    SERVICE = "urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1"

    def __init__(self):
        self.control_url = None

    def _discover(self):
        msg = "\r\n".join([
            "M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", 'MAN: "ssdp:discover"',
            "MX: 2", "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1", "", ""]).encode()
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(3)
        locations = []
        try:
            s.sendto(msg, ("239.255.255.250", 1900))
            while True:  # other devices (even HA itself) may answer too; collect all
                data, _ = s.recvfrom(4096)
                m = re.search(rb"(?i)^location:\s*(\S+)", data, re.M)
                if m and m.group(1).decode() not in locations:
                    locations.append(m.group(1).decode())
        except OSError:
            pass
        finally:
            s.close()
        for location in locations:
            try:
                with urllib.request.urlopen(location, timeout=5) as r:
                    xml = r.read().decode(errors="replace")
            except (OSError, ValueError):
                continue
            m = re.search(re.escape(self.SERVICE) + r"</serviceType>.*?<controlURL>([^<]+)</controlURL>", xml, re.S)
            if m:
                log.info("Router traffic counters found at %s", location)
                return urllib.parse.urljoin(location, m.group(1))
        return None

    def _soap(self, action, field):
        body = (
            '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
            f'<u:{action} xmlns:u="{self.SERVICE}"/></s:Body></s:Envelope>'
        ).encode()
        req = urllib.request.Request(self.control_url, data=body, headers={
            "Content-Type": 'text/xml; charset="utf-8"', "SOAPAction": f'"{self.SERVICE}#{action}"'})
        with urllib.request.urlopen(req, timeout=5) as r:
            text = r.read().decode(errors="replace")
        return int(re.search(rf"<{field}>(\d+)</{field}>", text).group(1))

    def _counters(self):
        return (self._soap("GetTotalBytesReceived", "NewTotalBytesReceived"),
                self._soap("GetTotalBytesSent", "NewTotalBytesSent"))

    def measure(self, seconds=5.0):
        """Returns (down_mbps, up_mbps) currently flowing through the router, or None."""
        for attempt in range(2):
            try:
                if not self.control_url:
                    self.control_url = self._discover()
                    if not self.control_url:
                        state.router_upnp = False
                        return None
                a, t0 = self._counters(), time.monotonic()
                time.sleep(seconds)
                b, t1 = self._counters(), time.monotonic()
                state.router_upnp = True
                dt = t1 - t0

                def rate(x0, x1):  # counters are 32-bit on most routers
                    delta = x1 - x0 if x1 >= x0 else x1 + 2 ** 32 - x0
                    return delta * 8 / dt / 1e6

                return rate(a[0], b[0]), rate(a[1], b[1])
            except Exception as e:  # router rebooted / URL changed: rediscover once
                log.debug("UPnP read failed (%s), rediscovering", e)
                self.control_url = None
        state.router_upnp = False
        return None


router = RouterTraffic()


# ------------------------------------------------------------- connectivity

def _tcp_probe(target, timeout=3.0):
    host, _, port = target.rpartition(":")
    t0 = time.perf_counter()
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return (time.perf_counter() - t0) * 1000
    except OSError:
        return None


probe_pool = ThreadPoolExecutor(max_workers=8)


def check_once():
    """Returns (up, latency_ms, jitter_ms, loss_pct).

    Up = any target answers. Quality comes from a few extra TCP handshakes to the
    fastest target: a handshake that doesn't complete within 1.5 s counts as lost
    (a real SYN loss would take >1 s to be retransmitted). Costs a few hundred bytes.
    """
    results = list(zip(OPTS["check_targets"], probe_pool.map(_tcp_probe, OPTS["check_targets"])))
    ok = [(t, ms) for t, ms in results if ms is not None]
    if not ok:
        return False, None, None, None
    target, first = min(ok, key=lambda x: x[1])
    samples = [first]
    for _ in range(max(0, OPTS["quality_samples"] - 1)):
        time.sleep(0.2)
        samples.append(_tcp_probe(target, timeout=1.5))
    good = [s for s in samples if s is not None]
    loss = 100.0 * (len(samples) - len(good)) / len(samples)
    jitter = (sum(abs(a - b) for a, b in zip(good, good[1:])) / (len(good) - 1)) if len(good) > 1 else None
    return True, sorted(good)[len(good) // 2], jitter, loss


def plan_down():
    return float(OPTS["plan_download_mbps"]) or 1.0


def plan_up():
    return float(OPTS["plan_upload_mbps"]) or 1.0


def online_since():
    """Start of the current online stretch: end of the last outage, or of a monitor gap
    long enough (>10 min, e.g. a power cut) that we can't vouch for what happened."""
    row = db.one("SELECT MAX(end) AS t FROM events WHERE end IS NOT NULL AND "
                 "(kind = 'internet_down' OR end - start > 600)")
    first = db.one("SELECT MIN(ts) AS t FROM checks")["t"]
    return (row and row["t"]) or first


def open_event(kind, start):
    return db.execute("INSERT INTO events(kind, start) VALUES(?, ?)", (kind, start))


def close_event(event_id, end):
    db.execute("UPDATE events SET end=? WHERE id=?", (end, event_id))


def handle_startup_gap(interval):
    """Records the time the monitor itself was not running (e.g. power cut)."""
    last = db.one("SELECT MAX(ts) AS ts FROM checks")["ts"]
    now = time.time()
    open_outage = db.one("SELECT id, start FROM events WHERE kind='internet_down' AND end IS NULL "
                         "ORDER BY start DESC LIMIT 1")
    if last and now - last > 3 * interval:
        if open_outage:  # we can't know when it really ended; stop at our last observation
            close_event(open_outage["id"], last)
            open_outage = None
        eid = open_event("monitor_offline", last)
        close_event(eid, now)
        log.info("Monitor was not running for %s", fmt_duration(now - last))
    if open_outage:
        state.outage_id, state.outage_start = open_outage["id"], open_outage["start"]


def monitor_loop():
    interval = OPTS["check_interval_seconds"]
    handle_startup_gap(interval)
    fails, first_fail_ts, prev_ts = 0, None, None
    while True:
        t0 = time.time()
        if prev_ts and t0 - prev_ts > 3 * interval:  # host was suspended/stalled
            eid = open_event("monitor_offline", prev_ts)
            close_event(eid, t0)
        up, latency, jitter, loss = check_once()
        db.execute("INSERT INTO checks(ts, up, latency_ms, jitter_ms, loss_pct) VALUES(?, ?, ?, ?, ?)",
                   (t0, int(up), latency, jitter, loss))
        changed = False
        with state.lock:
            state.last_check_ts, state.last_latency_ms = t0, latency
            state.last_jitter_ms, state.last_loss_pct = jitter, loss
            if up:
                fails, first_fail_ts = 0, None
                if state.outage_id:
                    outage_id, start = state.outage_id, state.outage_start
                    close_event(outage_id, t0)
                    state.outage_id = state.outage_start = None
                    log.info("Internet back after %s", fmt_duration(t0 - start))
                    threading.Thread(target=after_outage, args=(outage_id, start, t0), daemon=True).start()
                changed = state.online is not True
                state.online = True
            else:
                fails += 1
                if fails == 1:
                    first_fail_ts = t0
                # Two consecutive failed rounds = outage, dated from the first failure.
                if fails >= 2 and not state.outage_id:
                    state.outage_id = open_event("internet_down", first_fail_ts)
                    state.outage_start = first_fail_ts
                    log.info("Internet DOWN since %s", fmt_time(first_fail_ts))
                if fails >= 2:
                    changed = state.online is not False
                    state.online = False
        if changed:
            publish_connectivity()
        prev_ts = t0
        time.sleep(max(1.0, t0 + interval - time.time()))


def after_outage(outage_id, start, end):
    duration = end - start
    row = None
    if duration >= OPTS["recovery_speedtest_min_outage_minutes"] * 60:
        time.sleep(60)  # let the line settle before measuring
        row = run_speedtest("after_outage")
        if row and row.get("id"):
            db.execute("UPDATE events SET recovery_speedtest_id=? WHERE id=?", (row["id"], outage_id))
    if duration >= OPTS["notify_min_outage_minutes"] * 60:
        msg = f"Down from {fmt_day_time(start)} to {fmt_day_time(end)} ({fmt_duration(duration)})."
        if row and row.get("status") == "ok":
            msg += (f" Back at {row['download_mbps']:.1f} Mbps down / {row['upload_mbps']:.1f} up, "
                    f"{row['ping_ms']:.0f} ms ({row['server_location']}).")
        ha_notify("🌐 Internet is back", msg)


# ---------------------------------------------------------------- speedtest

def _run_ookla(sid):
    """Runs the CLI in JSON-lines mode, updating live progress. Returns (result, error)."""
    cmd = [SPEEDTEST_BIN, "--accept-license", "--accept-gdpr", "-f", "jsonl", "-p", "yes"]
    if sid:
        cmd += ["-s", str(sid)]
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except OSError as e:
        return None, str(e)
    killer = threading.Timer(180, p.kill)
    killer.start()
    result, last_msg = None, ""
    try:
        for line in p.stdout:
            try:
                data = json.loads(line)
            except ValueError:
                if line.strip():
                    last_msg = line.strip()
                continue
            kind = data.get("type")
            if kind == "result":
                result = data
            elif kind in ("ping", "download", "upload"):
                part = data.get(kind) or {}
                state.test_phase = kind
                state.test_progress = float(part.get("progress") or 0)
                bw = part.get("bandwidth")
                state.test_live_mbps = bw * 8 / 1e6 if bw else (part.get("latency") if kind == "ping" else None)
            elif kind == "log" and data.get("level") in ("error", "warning"):
                last_msg = data.get("message", "")
            elif data.get("error"):
                last_msg = data["error"]
        p.wait()
    finally:
        killer.cancel()
    if result is None and p.returncode and p.returncode < 0:
        last_msg = "timed out"
    return result, (None if result else (last_msg or "no result"))


def run_speedtest(trigger, busy_mbps=None):
    """Runs one Ookla test (trying each configured server), stores and returns the row."""
    with test_lock:
        state.test_running, state.test_started_ts = True, time.time()
        state.test_phase, state.test_progress, state.test_live_mbps = "connecting", 0.0, None
        try:
            errors = []
            for sid in OPTS["server_ids"] or [None]:
                data, err = _run_ookla(sid)
                if not data:
                    errors.append(f"{sid}: {err}"[:300])
                    continue
                server = data.get("server", {})
                row = {
                    "ts": time.time(), "status": "ok", "trigger": trigger,
                    "download_mbps": data["download"]["bandwidth"] * 8 / 1e6,
                    "upload_mbps": data["upload"]["bandwidth"] * 8 / 1e6,
                    "ping_ms": data["ping"]["latency"], "jitter_ms": data["ping"].get("jitter"),
                    "packet_loss": data.get("packetLoss"),
                    "server_id": server.get("id"), "server_name": server.get("name"),
                    "server_location": ", ".join(x for x in (server.get("location"), server.get("country")) if x),
                    "isp": data.get("isp"), "external_ip": data.get("interface", {}).get("externalIp"),
                    "result_url": data.get("result", {}).get("url"),
                    "data_used_mb": (data["download"].get("bytes", 0) + data["upload"].get("bytes", 0)) / 1e6,
                    "busy_mbps": busy_mbps, "error": "; ".join(errors) or None,
                }
                row["id"] = insert_speedtest(row)
                log.info("Speedtest (%s): %.1f down / %.1f up / %.0f ms via %s", trigger,
                         row["download_mbps"], row["upload_mbps"], row["ping_ms"], row["server_name"])
                after_speedtest(row)
                return row
            row = {"ts": time.time(), "status": "failed", "trigger": trigger,
                   "busy_mbps": busy_mbps, "error": "; ".join(errors)[:1000]}
            row["id"] = insert_speedtest(row)
            log.warning("Speedtest failed: %s", row["error"])
            return row
        finally:
            state.test_running, state.test_started_ts = False, None
            state.test_phase, state.test_progress, state.test_live_mbps = None, 0.0, None


def after_speedtest(row):
    """Sensors, ISP/IP change log and slow-speed alerts for a successful test."""
    try:
        publish_all()
    except Exception:
        log.exception("Publishing sensors failed")
    last_ip = db.one("SELECT ip, isp FROM ip_log ORDER BY ts DESC LIMIT 1")
    if row.get("external_ip") and (not last_ip or last_ip["ip"] != row["external_ip"]
                                   or last_ip["isp"] != row.get("isp")):
        db.execute("INSERT INTO ip_log(ts, ip, isp) VALUES(?, ?, ?)", (row["ts"], row["external_ip"], row.get("isp")))
    if row["trigger"] == "after_outage":
        return  # a line that just came back isn't representative
    threshold = OPTS["slow_alert_percent"]
    if not threshold:
        return
    pct = 100 * row["download_mbps"] / plan_down()
    if pct < threshold:
        state.slow_streak += 1
        if state.slow_streak >= OPTS["slow_alert_consecutive_tests"] and not state.slow_alerted:
            state.slow_alerted = True
            ha_notify("🐢 Internet is slow",
                      f"Last {state.slow_streak} speedtests were below {threshold}% of your "
                      f"{plan_down():g} Mbps plan. Latest: {row['download_mbps']:.1f} Mbps down "
                      f"({pct:.0f}%), {row['upload_mbps']:.1f} up, {row['ping_ms']:.0f} ms.")
    else:
        if state.slow_alerted:
            ha_notify("✅ Internet speed is back",
                      f"{row['download_mbps']:.1f} Mbps down ({pct:.0f}% of plan), {row['upload_mbps']:.1f} up.")
        state.slow_streak, state.slow_alerted = 0, False


def insert_speedtest(row):
    cols = [c for c in row if c != "id"]
    return db.execute(f"INSERT INTO speedtests({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                      [row[c] for c in cols])


def paused_until():
    return db.get_setting("paused_until", 0) or 0


def is_paused():
    p = paused_until()
    return p == -1 or p > time.time()


def next_slot(after, interval_min):
    """Next wall-clock slot, aligned to local midnight (e.g. every hour on the hour)."""
    lt = time.localtime(after)
    midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    step = interval_min * 60
    n = int((after - midnight) // step) + 1
    return midnight + n * step


def scheduler_loop():
    interval = OPTS["speedtest_interval_minutes"]
    while True:
        slot = next_slot(time.time(), interval)
        state.next_test_ts = slot
        time.sleep(max(0, slot - time.time()))
        try:
            run_scheduled(slot, interval)
        except Exception:
            log.exception("Scheduled speedtest crashed")


def run_scheduled(slot, interval):
    retry = OPTS["busy_retry_minutes"] * 60
    deadline = slot + interval * 60 - 120
    last_busy = None
    while True:
        if is_paused():
            state.scheduler_note = "Paused"
            insert_speedtest({"ts": time.time(), "status": "skipped_paused", "trigger": "scheduled"})
            return
        if state.online is False:
            state.scheduler_note = "Skipped: internet down"
            return  # the outage itself is recorded; a failed test adds nothing
        traffic = router.measure(5)
        busy = max(traffic) if traffic else None
        threshold = OPTS["busy_threshold_mbps"]
        if busy is not None and threshold > 0 and busy > threshold:
            last_busy = busy
            if time.time() + retry < deadline:
                state.scheduler_note = f"Line busy ({busy:.1f} Mbps), retrying at {fmt_time(time.time() + retry)}"
                state.next_test_ts = time.time() + retry
                log.info(state.scheduler_note)
                time.sleep(retry)
                continue
            state.scheduler_note = "Skipped: line busy all hour"
            insert_speedtest({"ts": time.time(), "status": "skipped_busy", "trigger": "scheduled",
                              "busy_mbps": last_busy})
            return
        state.scheduler_note = ""
        run_speedtest("scheduled", busy)
        return


def retention_loop():
    while True:
        cutoff = time.time() - OPTS["retention_days"] * 86400
        db.execute("DELETE FROM checks WHERE ts < ?", (cutoff,))
        db.execute("DELETE FROM speedtests WHERE ts < ?", (cutoff,))
        db.execute("DELETE FROM events WHERE end IS NOT NULL AND end < ?", (cutoff,))
        db.execute("DELETE FROM ip_log WHERE ts < ?", (cutoff,))
        time.sleep(6 * 3600)


def weekly_report_loop():
    while True:
        time.sleep(60)
        if not OPTS["weekly_report_enabled"]:
            continue
        lt = time.localtime()
        day = WEEKDAYS.index(OPTS["weekly_report_day"]) if OPTS["weekly_report_day"] in WEEKDAYS else 6
        if lt.tm_wday != day or lt.tm_hour != OPTS["weekly_report_hour"]:
            continue
        stamp = time.strftime("%Y-%m-%d", lt)
        if db.get_setting("weekly_report_sent") == stamp:
            continue
        db.set_setting("weekly_report_sent", stamp)
        try:
            title, msg = weekly_report_text()
            ha_notify(title, msg)
        except Exception:
            log.exception("Weekly report failed")


def weekly_report_text(now=None):
    now = now or time.time()
    r = report(now - 7 * 86400, now)
    d0 = time.strftime("%d %b", time.localtime(now - 7 * 86400)).lstrip("0")
    d1 = time.strftime("%d %b", time.localtime(now)).lstrip("0")
    parts = [f"Grade {r['grade']}" if r["grade"] else "Not enough data for a grade"]
    if r["uptime_pct"] is not None:
        parts.append(f"Uptime {r['uptime_pct']:.2f}% ({r['outages']} outage{'s' if r['outages'] != 1 else ''}"
                     f"{', ' + fmt_duration(r['downtime_s']) + ' down' if r['downtime_s'] else ''})")
    if r["tests"]:
        parts.append(f"Avg {r['avg_down']:.1f}↓ / {r['avg_up']:.1f}↑ Mbps ({r['avg_down_pct']:.0f}% of plan)")
        if r["slowest_hour"]:
            parts.append(f"Slowest around {r['slowest_hour']['label']} ({r['slowest_hour']['avg_down']:.1f} Mbps)")
    if r["longest_outage"]:
        lo = r["longest_outage"]
        parts.append(f"Longest outage {fmt_duration(lo['duration_s'])} on {time.strftime('%a %d %b', time.localtime(lo['start']))}")
    return f"📊 Internet report {d0} – {d1}", ". ".join(parts) + "."


# ------------------------------------------------------------------ queries

def overlap(start, end, lo, hi):
    return max(0.0, min(end, hi) - max(start, lo))


def events_in(lo, hi):
    rows = db.query(
        "SELECT e.*, s.download_mbps AS rec_download, s.upload_mbps AS rec_upload, "
        "s.ping_ms AS rec_ping, s.status AS rec_status, s.server_location AS rec_server "
        "FROM events e LEFT JOIN speedtests s ON s.id = e.recovery_speedtest_id "
        "WHERE e.start < ? AND (e.end IS NULL OR e.end > ?) ORDER BY e.start DESC", (hi, lo))
    now = time.time()
    for r in rows:
        r["ongoing"] = r["end"] is None
        r["duration_s"] = (r["end"] or now) - r["start"]
    return rows


def summary(lo, hi):
    now = time.time()
    hi_eff = min(hi, now)
    first_check = db.one("SELECT MIN(ts) AS ts FROM checks")["ts"]
    lo_eff = max(lo, first_check) if first_check else hi_eff
    span = max(0.0, hi_eff - lo_eff)
    evs = events_in(lo_eff, hi_eff)
    down = sum(overlap(e["start"], e["end"] or now, lo_eff, hi_eff) for e in evs if e["kind"] == "internet_down")
    offline = sum(overlap(e["start"], e["end"] or now, lo_eff, hi_eff) for e in evs if e["kind"] == "monitor_offline")
    observed = max(0.0, span - offline)
    stats = db.one(
        "SELECT COUNT(*) AS n, AVG(download_mbps) AS avg_down, MIN(download_mbps) AS min_down, "
        "MAX(download_mbps) AS max_down, AVG(upload_mbps) AS avg_up, MIN(upload_mbps) AS min_up, "
        "MAX(upload_mbps) AS max_up, AVG(ping_ms) AS avg_ping, SUM(data_used_mb) AS data_mb "
        "FROM speedtests WHERE status='ok' AND ts BETWEEN ? AND ?", (lo, hi))
    counts = {r["status"]: r["n"] for r in db.query(
        "SELECT status, COUNT(*) AS n FROM speedtests WHERE ts BETWEEN ? AND ? GROUP BY status", (lo, hi))}
    return {
        "from": lo_eff, "to": hi_eff, "observed_s": observed,
        "uptime_pct": (max(0.0, min(100.0, 100.0 * (observed - down) / observed))
                       if observed >= 60 else None),
        "downtime_s": down, "monitor_offline_s": offline,
        "outages": sum(1 for e in evs if e["kind"] == "internet_down"),
        "speed": stats, "test_counts": counts,
    }


def lookup_at(ts):
    before = db.one("SELECT * FROM speedtests WHERE status='ok' AND ts <= ? ORDER BY ts DESC LIMIT 1", (ts,))
    after = db.one("SELECT * FROM speedtests WHERE status='ok' AND ts > ? ORDER BY ts ASC LIMIT 1", (ts,))
    window = OPTS["check_interval_seconds"] * 2
    check = db.one("SELECT * FROM checks WHERE ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1",
                   (ts - window, ts + window, ts))
    event = next(iter(events_in(ts, ts + 0.001)), None)
    return {"ts": ts, "before": before, "after": after, "check": check, "event": event}


def checks_series(lo, hi, max_points=1500):
    bucket = max(OPTS["check_interval_seconds"], (hi - lo) / max_points)
    return db.query(
        "SELECT CAST(ts / ? AS INTEGER) * ? AS ts, MIN(up) AS up, AVG(latency_ms) AS latency_ms, "
        "MAX(latency_ms) AS max_latency_ms, AVG(jitter_ms) AS jitter_ms, AVG(loss_pct) AS loss_pct "
        "FROM checks WHERE ts BETWEEN ? AND ? "
        "GROUP BY CAST(ts / ? AS INTEGER) ORDER BY 1", (bucket, bucket, lo, hi, bucket))


def hour_label(h):
    return time.strftime("%I %p", (2000, 1, 1, h, 0, 0, 0, 1, -1)).lstrip("0")


def grade(avg_pct, uptime):
    """A-F from speed vs plan (60%) and uptime (40%; 99% -> 90 pts, 95% -> 50, 90% -> 0)."""
    if avg_pct is None or uptime is None:
        return None, None
    score = 0.6 * min(avg_pct, 100) + 0.4 * max(0.0, 100 - (100 - uptime) * 10)
    for letter, floor in (("A", 90), ("B", 80), ("C", 70), ("D", 60)):
        if score >= floor:
            return letter, score
    return "F", score


def report(lo, hi):
    s = summary(lo, hi)
    tests = db.query("SELECT ts, download_mbps, upload_mbps, ping_ms FROM speedtests "
                     "WHERE status='ok' AND trigger != 'after_outage' AND ts BETWEEN ? AND ?", (lo, hi))
    pd, pu = plan_down(), plan_up()
    out = {**{k: s[k] for k in ("uptime_pct", "downtime_s", "outages", "monitor_offline_s", "observed_s")},
           "plan_down": pd, "plan_up": pu, "tests": len(tests), "test_counts": s["test_counts"],
           "data_mb": s["speed"]["data_mb"]}
    if tests:
        downs = [t["download_mbps"] for t in tests]
        out.update(
            avg_down=sum(downs) / len(downs), avg_up=sum(t["upload_mbps"] for t in tests) / len(tests),
            avg_ping=sum(t["ping_ms"] for t in tests) / len(tests), min_down=min(downs), max_down=max(downs),
            avg_down_pct=100 * sum(downs) / len(downs) / pd,
            avg_up_pct=100 * sum(t["upload_mbps"] for t in tests) / len(tests) / pu,
            below_50_pct=100 * sum(d < 0.5 * pd for d in downs) / len(downs),
            below_80_pct=100 * sum(d < 0.8 * pd for d in downs) / len(downs))
        by_hour = {}
        for t in tests:
            by_hour.setdefault(time.localtime(t["ts"]).tm_hour, []).append(t["download_mbps"])
        hours = [{"hour": h, "label": hour_label(h), "avg_down": sum(v) / len(v), "n": len(v)}
                 for h, v in by_hour.items()]
        # Prefer hours with repeat samples once there are enough of them to compare.
        if sum(h["n"] >= 2 for h in hours) >= 3:
            hours = [h for h in hours if h["n"] >= 2]
        out["slowest_hour"] = min(hours, key=lambda h: h["avg_down"]) if len(hours) > 1 else None
        out["fastest_hour"] = max(hours, key=lambda h: h["avg_down"]) if len(hours) > 1 else None
    else:
        out.update(avg_down=None, avg_up=None, avg_ping=None, min_down=None, max_down=None, avg_down_pct=None,
                   avg_up_pct=None, below_50_pct=None, below_80_pct=None, slowest_hour=None, fastest_hour=None)
    downs = [e for e in events_in(lo, hi) if e["kind"] == "internet_down"]
    out["longest_outage"] = max(downs, key=lambda e: e["duration_s"]) if downs else None
    out["grade"], out["score"] = grade(out["avg_down_pct"], out["uptime_pct"])
    return out


def timeline(lo, hi, buckets):
    """Per-bucket uptime for the status strip."""
    now = time.time()
    first = db.one("SELECT MIN(ts) AS t FROM checks")["t"]
    evs = events_in(lo, hi)
    step = (hi - lo) / buckets
    out = []
    for i in range(buckets):
        a, b = lo + i * step, lo + (i + 1) * step
        a_eff, b_eff = max(a, first or b), min(b, now)
        span = max(0.0, b_eff - a_eff)
        down = sum(overlap(e["start"], e["end"] or now, a_eff, b_eff) for e in evs if e["kind"] == "internet_down")
        off = sum(overlap(e["start"], e["end"] or now, a_eff, b_eff) for e in evs if e["kind"] == "monitor_offline")
        observed = span - off
        n_out = sum(1 for e in evs if e["kind"] == "internet_down" and e["start"] < b and (e["end"] or now) > a)
        out.append({"from": a, "to": b, "observed_s": observed, "downtime_s": down, "offline_s": off,
                    "outages": n_out,
                    "uptime_pct": (100 * (observed - down) / observed) if observed >= 30 else None})
    return out


def heatmap(days):
    since = time.time() - days * 86400
    cells = {}
    for t in db.query("SELECT ts, download_mbps FROM speedtests WHERE status='ok' "
                      "AND trigger != 'after_outage' AND ts >= ?", (since,)):
        lt = time.localtime(t["ts"])
        cells.setdefault((lt.tm_wday, lt.tm_hour), []).append(t["download_mbps"])
    return {"days": days, "plan_down": plan_down(), "cells": [
        {"wday": w, "hour": h, "avg_down": sum(v) / len(v), "n": len(v), "pct": 100 * sum(v) / len(v) / plan_down()}
        for (w, h), v in sorted(cells.items())]}


def status_payload():
    last_test = db.one("SELECT * FROM speedtests WHERE status='ok' ORDER BY ts DESC LIMIT 1")
    spark = db.query("SELECT ts, up, latency_ms FROM checks ORDER BY ts DESC LIMIT 60")[::-1]
    return {
        "now": time.time(), "online": state.online, "last_check_ts": state.last_check_ts,
        "latency_ms": state.last_latency_ms, "jitter_ms": state.last_jitter_ms, "loss_pct": state.last_loss_pct,
        "online_since": online_since() if state.online else None, "outage_start": state.outage_start,
        "sparkline": spark,
        "test_running": state.test_running, "test_started_ts": state.test_started_ts,
        "test_phase": state.test_phase, "test_progress": state.test_progress, "test_live_mbps": state.test_live_mbps,
        "next_test_ts": state.next_test_ts, "scheduler_note": state.scheduler_note,
        "paused_until": paused_until(), "router_upnp": state.router_upnp, "last_test": last_test,
        "plan_down": plan_down(), "plan_up": plan_up(),
        "options": {k: OPTS[k] for k in ("speedtest_interval_minutes", "check_interval_seconds",
                                         "check_targets", "server_ids", "busy_threshold_mbps",
                                         "slow_alert_percent", "weekly_report_enabled")},
    }


# --------------------------------------------------------------------- http

CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    server_version = "NetMonitor/1.0"

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

    def _range(self, qs):
        now = time.time()
        hi = float(qs.get("to", [now])[0])
        lo = float(qs.get("from", [hi - 86400])[0])
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
            if path == "/api/speedtests":
                lo, hi = self._range(qs)
                return self._send(200, db.query("SELECT * FROM speedtests WHERE ts BETWEEN ? AND ? "
                                                 "ORDER BY ts", (lo, hi)))
            if path == "/api/checks":
                lo, hi = self._range(qs)
                return self._send(200, checks_series(lo, hi))
            if path == "/api/events":
                lo, hi = self._range(qs)
                return self._send(200, events_in(lo, hi))
            if path == "/api/summary":
                lo, hi = self._range(qs)
                return self._send(200, summary(lo, hi))
            if path == "/api/at":
                return self._send(200, lookup_at(float(qs["ts"][0])))
            if path == "/api/report":
                lo, hi = self._range(qs)
                return self._send(200, report(lo, hi))
            if path == "/api/timeline":
                lo, hi = self._range(qs)
                return self._send(200, timeline(lo, hi, max(10, min(180, int(qs.get("buckets", [60])[0])))))
            if path == "/api/heatmap":
                return self._send(200, heatmap(max(1, min(365, int(qs.get("days", [30])[0])))))
            if path == "/api/iplog":
                return self._send(200, db.query("SELECT * FROM ip_log ORDER BY ts DESC LIMIT 50"))
            if path in ("/api/export/speedtests.csv", "/api/export/outages.csv"):
                lo, hi = self._range(qs)
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
        if path == "/api/speedtest/run":
            if state.test_running:
                return self._send(409, {"error": "A speedtest is already running"})
            threading.Thread(target=run_speedtest, args=("manual",), daemon=True).start()
            return self._send(202, {"ok": True})
        if path == "/api/pause":
            minutes = float(body.get("minutes", 0))
            until = -1 if minutes < 0 else (time.time() + minutes * 60 if minutes > 0 else 0)
            db.set_setting("paused_until", until)
            return self._send(200, {"paused_until": until})
        self.send_error(404)

    def _static(self, name):
        full = os.path.realpath(os.path.join(STATIC_DIR, name))
        if not full.startswith(os.path.realpath(STATIC_DIR)) or not os.path.isfile(full):
            return self.send_error(404)
        with open(full, "rb") as f:
            data = f.read()
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream")
        self._send(200, data, ctype)

    def _csv(self, path, lo, hi):
        buf = io.StringIO()
        w = csv.writer(buf)

        def local(ts):
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else ""

        if path.endswith("speedtests.csv"):
            w.writerow(["time", "status", "trigger", "download_mbps", "upload_mbps", "ping_ms", "jitter_ms",
                        "packet_loss_pct", "server", "location", "isp", "result_url", "error"])
            for r in db.query("SELECT * FROM speedtests WHERE ts BETWEEN ? AND ? ORDER BY ts", (lo, hi)):
                w.writerow([local(r["ts"]), r["status"], r["trigger"], r["download_mbps"], r["upload_mbps"],
                            r["ping_ms"], r["jitter_ms"], r["packet_loss"], r["server_name"],
                            r["server_location"], r["isp"], r["result_url"], r["error"]])
            name = "speedtests.csv"
        else:
            w.writerow(["kind", "start", "end", "duration", "recovery_download_mbps", "recovery_upload_mbps"])
            for r in reversed(events_in(lo, hi)):
                w.writerow([r["kind"], local(r["start"]), local(r["end"]) or "ongoing",
                            fmt_duration(r["duration_s"]), r["rec_download"], r["rec_upload"]])
            name = "outages.csv"
        self._send(200, buf.getvalue(), "text/csv; charset=utf-8",
                   {"Content-Disposition": f'attachment; filename="{name}"'})


# --------------------------------------------------------------------- main

def main():
    global db
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S")
    os.makedirs(DATA_DIR, exist_ok=True)
    db = DB(DB_PATH)
    log.info("Net Monitor starting: checks every %ss to %s, speedtest every %s min via servers %s",
             OPTS["check_interval_seconds"], ", ".join(OPTS["check_targets"]),
             OPTS["speedtest_interval_minutes"], OPTS["server_ids"])
    for target in (monitor_loop, scheduler_loop, retention_loop, weekly_report_loop, publish_loop):
        threading.Thread(target=target, daemon=True, name=target.__name__).start()
    threading.Timer(45, publish_all).start()  # after the first checks have run
    server = ThreadingHTTPServer((os.environ.get("NETMON_BIND", "0.0.0.0"), HTTP_PORT), Handler)
    log.info("Dashboard listening on port %s (Ingress)", HTTP_PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
