"""Net Monitor: hourly international speedtest + internet outage tracker.

Runs three loops:
  * connectivity monitor - TCP-connects to a few international (Singapore) hosts every
    N seconds and records outages (start/end) in SQLite. Outages are announced on Alexa
    and reported over WhatsApp once the line is back.
  * speedtest scheduler - runs the Ookla CLI against a pinned (Singapore) server
    on a wall-clock schedule, postponing while the router shows the line is busy.
  * HTTP server - the Ingress dashboard and its JSON API.
"""

import csv
import io
import json
import logging
import os
import queue
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
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
                      "speedtest.singnet.com.sg:8080", "sin-speed.hetzner.com:443"],
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
    "busy_upload_mbps": 0.25,
    "busy_packets_per_second": 40,
    "maintenance_windows": [],
    "alexa_entities": [],
    "alexa_volume": 60,
    "alexa_down_message": "Warning! The internet is down right now.",
    "alexa_up_message": "Good news! The internet is back. It was down for {duration}.",
    "alexa_quiet_hours": [],
    "offline_tts_service": "",
    "whatsapp_to": "",
    "whatsapp_api_token": "",
    "whatsapp_bridge_url": "",
    "monthly_report_enabled": True,
    "monthly_report_hour": 10,
    "plan_price": 0,
    "plan_currency": "৳",
    "dns_check_server": "auto",
    "valorant_region": "mumbai",
    "valorant_max_ping_ms": 80,
    "valorant_alerts": True,
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
            DROP TABLE IF EXISTS valorant;
            CREATE TABLE IF NOT EXISTS valorant_min (
                ts REAL NOT NULL, region TEXT NOT NULL,
                ping_ms REAL, jitter_ms REAL, loss_pct REAL, playable INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_valorant_min ON valorant_min(region, ts);
            CREATE INDEX IF NOT EXISTS idx_valorant_min_ts ON valorant_min(ts);
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
        self.down_reason = None     # why the last failed round failed
        self.dns_seen_ok = False    # the DNS check counts only once the server has answered
        self.publish_ok = True      # False = the last connectivity push to HA failed; retry


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

def _supervisor_call(method, path, payload=None, timeout=10):
    """Returns (HTTP status, parsed JSON body); status is None if the API is unreachable."""
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None, None
    body = json.dumps(payload).encode() if payload is not None else None
    for host in ("http://supervisor", "http://172.30.32.2"):
        req = urllib.request.Request(
            f"{host}{path}", data=body, method=method,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                try:
                    return r.status, json.loads(raw) if raw else None
                except ValueError:
                    return r.status, None
        except urllib.error.HTTPError as e:
            log.warning("HA API %s %s -> %s", method, path, e.code)
            try:
                return e.code, json.loads(e.read() or b"null")
            except (OSError, ValueError):
                return e.code, None
        except OSError:
            continue  # try the next host name
    log.warning("HA API unreachable for %s", path)
    return None, None


def _supervisor_request(method, path, payload=None):
    return _supervisor_call(method, path, payload)[0]


def ha_service(domain, service, data, timeout=30):
    return _supervisor_call("POST", f"/core/api/services/{domain}/{service}", data, timeout)[0]


def ha_get_state(entity_id):
    return _supervisor_call("GET", f"/core/api/states/{entity_id}")[1]


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
    """Pushes the connectivity sensor; a failed push is retried on the next check."""
    entity = "binary_sensor.net_monitor_internet"
    body = {"state": "on" if state.online else "off", "attributes": {
        "friendly_name": "Internet",
        "device_class": "connectivity",
        "latency_ms": round(state.last_latency_ms, 1) if state.last_latency_ms else None,
        "jitter_ms": round(state.last_jitter_ms, 1) if state.last_jitter_ms is not None else None,
        "packet_loss_pct": state.last_loss_pct,
        "online_since": iso(online_since()) if state.online else None,
        "offline_since": iso(state.outage_start),
        # True while the internet is down only because of the router's scheduled restart.
        "planned_outage": outage_is_planned(),
        "down_reason": state.down_reason if state.online is False else None,
    }}

    def push():
        state.publish_ok = _supervisor_request("POST", f"/core/api/states/{entity}", body) in (200, 201)

    state.publish_ok = True  # one push in flight at a time; push() resets it on failure
    threading.Thread(target=push, daemon=True).start()


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
                self._soap("GetTotalBytesSent", "NewTotalBytesSent"),
                self._soap("GetTotalPacketsSent", "NewTotalPacketsSent"))

    def measure(self, seconds=8.0):
        """Returns {"down": Mbps, "up": Mbps, "pps_out": packets/s} flowing through the
        router's WAN right now, or None if the router can't be read."""
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

                def delta(x0, x1):  # counters are 32-bit on most routers
                    return x1 - x0 if x1 >= x0 else x1 + 2 ** 32 - x0

                out = {"down": delta(a[0], b[0]) * 8 / dt / 1e6, "up": delta(a[1], b[1]) * 8 / dt / 1e6,
                       "pps_out": delta(a[2], b[2]) / dt}
                if max(out["down"], out["up"]) > 10000:  # counters reset (router rebooted)
                    return None
                return out
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

# Nothing abroad answers a handshake this fast from Bangladesh (Singapore is ~45 ms).
# A quicker answer comes from an in-country copy (1.1.1.1 and 8.8.8.8 have Dhaka
# servers) or the router/ISP intercepting the connection, and keeps answering while
# the international link is dead.
# ponytail: fixed floor; make it an option if the add-on is ever used next to its targets.
MIN_INTERNATIONAL_MS = 10.0
_local_warned = set()


def international(results):
    """The (target, ms) pairs that answered from abroad; logs too-fast targets once."""
    ok = []
    for target, ms in results:
        if ms is None:
            continue
        if ms < MIN_INTERNATIONAL_MS:
            if target not in _local_warned:
                _local_warned.add(target)
                log.warning("%s answers in %.1f ms, so it's in-country (or intercepted), not abroad; "
                            "ignoring it. Replace it in check_targets.", target, ms)
            continue
        ok.append((target, ms))
    return ok


def quorum(n_targets):
    """Answers needed for the line to count as up: one lucky handshake through a
    collapsing link shouldn't hide an outage."""
    return min(2, n_targets)


def dns_server():
    """The DNS server LAN devices use: the router (default gateway) for "auto"."""
    spec = (OPTS.get("dns_check_server") or "").strip()
    if spec != "auto":
        return spec or None
    try:
        with open("/proc/net/route") as f:
            for line in f.readlines()[1:]:
                parts = line.split()
                if parts[1] == "00000000" and int(parts[3], 16) & 2:  # default route via a gateway
                    return socket.inet_ntoa(int(parts[2], 16).to_bytes(4, "little"))
    except (OSError, ValueError, IndexError):
        pass
    return None


def dns_query(server, name, timeout=2.0, port=53):
    """Sends an A query; returns the response code (0 ok, 3 no such name, 2 server
    failure...) or None if nothing valid came back."""
    tid = os.urandom(2)
    qname = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\0"
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        try:
            s.sendto(tid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + qname + b"\x00\x01\x00\x01", (server, port))
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                data = s.recv(512)
                if len(data) >= 12 and data[:2] == tid and data[2] & 0x80:
                    return data[3] & 0x0F
        except OSError:
            pass
    return None


def dns_check():
    """True/False = the LAN's DNS resolves / doesn't; None = not checked.

    Asks for a random name under google.com: no cache can hold it, so a "no such
    name" reply proves the router -> ISP resolver -> internet chain works."""
    server = dns_server()
    if not server:
        return None
    for _ in range(2):  # one lost UDP packet isn't an outage
        if dns_query(server, f"netmon-{os.urandom(4).hex()}.google.com") in (0, 3):
            return True
    return False


def round_verdict(results, dns_ok, dns_seen_ok):
    """(up, reason why not) from the probe results and the DNS check."""
    need, ok = quorum(len(results)), international(results)
    if len(ok) < need:
        return False, f"only {len(ok)} of {len(results)} international targets answered (need {need})"
    if dns_ok is False and dns_seen_ok:  # a server that never answered isn't a DNS server
        return False, f"DNS ({dns_server()}) isn't resolving names"
    return True, None


def check_once():
    """Returns (up, latency_ms, jitter_ms, loss_pct).

    Up = enough international targets answer and the LAN's DNS works. Quality comes
    from a few extra TCP handshakes to the fastest target: a handshake that doesn't
    complete within 1.5 s counts as lost (a real SYN loss would take >1 s to be
    retransmitted). Costs a few hundred bytes.
    """
    dns_future = probe_pool.submit(dns_check)
    results = list(zip(OPTS["check_targets"], probe_pool.map(_tcp_probe, OPTS["check_targets"])))
    dns_ok = dns_future.result()
    if dns_ok and not state.dns_seen_ok:
        state.dns_seen_ok = True
        log.info("DNS check active via %s", dns_server())
    up, state.down_reason = round_verdict(results, dns_ok, state.dns_seen_ok)
    ok = international(results)
    if not up:
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


def in_maintenance(ts):
    """If ts falls in a configured daily window (e.g. "02:58-03:10", the router's
    scheduled reboot), returns that window's end timestamp; otherwise None."""
    return in_window(ts, OPTS["maintenance_windows"])


def in_window(ts, specs):
    """End timestamp of the daily "HH:MM-HH:MM" window in specs that ts falls in, or None."""
    lt = time.localtime(ts)
    midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    for spec in specs or []:
        try:
            a, b = [int(h) * 3600 + int(m) * 60 for h, m in (p.strip().split(":") for p in spec.split("-"))]
        except ValueError:
            continue
        for day in (-86400, 0):  # a window crossing midnight may have started yesterday
            start, end = midnight + day + a, midnight + day + (b if b > a else b + 86400)
            if start <= ts < end:
                return end
    return None


def classify_outage(outage_id, start, end):
    """Splits off the part of an outage that happened inside a maintenance window.
    Returns (event_id, start) of the remaining real outage, or None if it was all planned."""
    window_end = in_maintenance(start)
    if not window_end:
        return outage_id, start
    db.execute("UPDATE events SET kind='planned_restart', end=? WHERE id=?", (min(end, window_end), outage_id))
    if end <= window_end:
        log.info("Outage %s-%s was the scheduled router restart", fmt_time(start), fmt_time(end))
        return None
    real_id = open_event("internet_down", window_end)
    close_event(real_id, end)
    return real_id, window_end


def outage_is_planned(now=None):
    """True while the current outage is still inside its maintenance window."""
    now = now or time.time()
    if not state.outage_start:
        return False
    window_end = in_maintenance(state.outage_start)
    return bool(window_end and now < window_end)


def open_event(kind, start):
    return db.execute("INSERT INTO events(kind, start) VALUES(?, ?)", (kind, start))


def close_event(event_id, end):
    db.execute("UPDATE events SET end=? WHERE id=?", (end, event_id))


def stall_gap(interval):
    """Silence longer than this means the monitor wasn't running. At least 90 s, so a
    slow round during an outage (DNS timeouts) or a quick add-on restart isn't one."""
    return max(3 * interval, 90)


def handle_startup_gap(interval):
    """Records the time the monitor itself was not running (e.g. power cut)."""
    last = db.one("SELECT MAX(ts) AS ts FROM checks")["ts"]
    now = time.time()
    open_outage = db.one("SELECT id, start FROM events WHERE kind='internet_down' AND end IS NULL "
                         "ORDER BY start DESC LIMIT 1")
    if last and now - last > stall_gap(interval):
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
    m = {"fails": 0, "first_fail_ts": None, "oks": 0, "first_ok_ts": None, "prev_ts": None,
         "planned": False, "down_announced": False}
    while True:
        t0 = time.time()
        try:
            monitor_step(m, t0, interval)
        except Exception:  # a crash here would freeze the sensor on its last state forever
            log.exception("Connectivity check failed; retrying")
        m["prev_ts"] = t0
        time.sleep(max(1.0, t0 + interval - time.time()))


def monitor_step(m, t0, interval):
    if m["prev_ts"] and t0 - m["prev_ts"] > stall_gap(interval):  # host was suspended/stalled
        eid = open_event("monitor_offline", m["prev_ts"])
        close_event(eid, t0)
    up, latency, jitter, loss = check_once()
    db.execute("INSERT INTO checks(ts, up, latency_ms, jitter_ms, loss_pct) VALUES(?, ?, ?, ?, ?)",
               (t0, int(up), latency, jitter, loss))
    changed = False
    with state.lock:
        state.last_check_ts, state.last_latency_ms = t0, latency
        state.last_jitter_ms, state.last_loss_pct = jitter, loss
        if up:
            m["fails"], m["first_fail_ts"] = 0, None
            m["oks"] += 1
            if m["oks"] == 1:
                m["first_ok_ts"] = t0
            # Like going down, coming back takes two good rounds in a row (a flapping
            # line isn't "back"); it's dated from the first one.
            if state.outage_id and m["oks"] >= 2:
                outage_id, start, back = state.outage_id, state.outage_start, m["first_ok_ts"]
                close_event(outage_id, back)
                state.outage_id = state.outage_start = None
                real = classify_outage(outage_id, start, back)
                if real:
                    log.info("Internet back after %s", fmt_duration(back - real[1]))
                    announce("up", back - real[1])
                    threading.Thread(target=after_outage, args=(real[0], real[1], back), daemon=True).start()
                m["down_announced"] = False
            if not state.outage_id:
                changed = state.online is not True
                state.online = True
        else:
            m["oks"], m["first_ok_ts"] = 0, None
            m["fails"] += 1
            if m["fails"] == 1:
                m["first_fail_ts"] = t0
            # Two consecutive failed rounds = outage, dated from the first failure.
            if m["fails"] >= 2 and not state.outage_id:
                state.outage_id = open_event("internet_down", m["first_fail_ts"])
                state.outage_start = m["first_fail_ts"]
                log.info("Internet DOWN since %s (%s)", fmt_time(m["first_fail_ts"]), state.down_reason)
            if m["fails"] >= 2:
                changed = state.online is not False
                state.online = False
        # A planned restart that overruns its window becomes a real outage right then.
        now_planned = outage_is_planned(t0)
        changed = changed or now_planned != m["planned"]
        m["planned"] = now_planned
        if state.online is False and not now_planned and not m["down_announced"]:
            m["down_announced"] = True
            announce("down")
    if changed or not state.publish_ok:
        publish_connectivity()


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
        whatsapp_send(outage_report(outage_id, start, end, row), f"netmon-outage-{outage_id}-{int(start)}")


# ------------------------------------------------------------ announcements

# Alexa speaks through Amazon's cloud, so it can't announce while the international
# link is down. The "down" warning goes to Alexa only if Amazon is still reachable
# (partial outages); otherwise to the phone (HA companion app TTS), which gets it
# over the home Wi-Fi without internet if its persistent connection is on.
AMAZON_PROBE = "alexa.amazon.com:443"
announce_queue = queue.Queue()


def spoken_duration(seconds):
    """27 minutes / 1 hour and 5 minutes / 3 minutes and 20 seconds."""
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    parts = [f"{n} {unit}{'s' if n != 1 else ''}" for n, unit in ((h, "hour"), (m, "minute")) if n]
    if s and not h and m < 10:
        parts.append(f"{s} second{'s' if s != 1 else ''}")
    if not parts:
        return "less than a second"
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def announce_message(kind, duration=None):
    template = OPTS["alexa_down_message"] if kind == "down" else OPTS["alexa_up_message"]
    return template.replace("{duration}", spoken_duration(duration or 0))


def announce(kind, duration=None):
    """Queues a spoken "down" / "up" announcement, unless it's quiet hours."""
    if not OPTS["alexa_entities"] and not (kind == "down" and OPTS["offline_tts_service"]):
        return
    if in_window(time.time(), OPTS["alexa_quiet_hours"]):
        log.info("Quiet hours: not announcing internet %s", kind)
        return
    announce_queue.put((kind, duration))


def announcer_loop():
    while True:
        kind, duration = announce_queue.get()
        try:
            speak(kind, duration)
        except Exception:
            log.exception("Announcement failed")


def speak(kind, duration):
    text = announce_message(kind, duration)
    if kind == "down":
        if state.online is not False:
            return  # already back; the "up" announcement follows
        if OPTS["alexa_entities"] and _tcp_probe(AMAZON_PROBE) is not None:
            alexa_say(text)
        elif OPTS["offline_tts_service"]:
            log.info("Amazon unreachable, so Alexa can't speak; announcing on the phone instead")
            phone_say(text)
        else:
            log.info("Amazon unreachable, so Alexa can't announce the outage")
        return
    # Up: the link is back, but give Alexa a moment if Amazon isn't answering yet.
    for _ in range(18):
        if _tcp_probe(AMAZON_PROBE) is not None:
            alexa_say(text)
            return
        time.sleep(10)
    log.warning("Amazon still unreachable 3 minutes after the internet came back; skipped announcement")


def alexa_say(text):
    """Raises the Echo(s) to alexa_volume, announces, then restores each one's volume."""
    entities = OPTS["alexa_entities"]
    target = max(0, min(100, OPTS["alexa_volume"])) / 100
    restore = {}
    for entity in entities:
        volume = ((ha_get_state(entity) or {}).get("attributes") or {}).get("volume_level")
        if volume is None:
            log.warning("%s doesn't report its volume; announcing at its current volume", entity)
        elif abs(volume - target) > 0.005:
            restore[entity] = volume
    for entity in restore:
        ha_service("media_player", "volume_set", {"entity_id": entity, "volume_level": target})
    if restore:
        time.sleep(1.5)  # the Echo applies the volume before it starts speaking
    status = ha_service("notify", "alexa_media", {
        "message": text, "target": entities, "data": {"type": "announce", "method": "speak"}})
    log.info("Alexa announcement (%s): %s", status, text)
    time.sleep(5 + len(text) / 12)  # cloud round trip + chime + speech
    for entity, volume in restore.items():
        ha_service("media_player", "volume_set", {"entity_id": entity, "volume_level": volume})


def phone_say(text):
    service = OPTS["offline_tts_service"].strip()
    domain, _, name = service.partition(".")
    if not name:
        domain, name = "notify", domain
    # alarm_stream_max: plays at full alarm volume, then Android restores it.
    ha_service(domain, name, {"message": "TTS", "data": {"tts_text": text, "media_stream": "alarm_stream_max"}})


# ------------------------------------------------------------------ whatsapp

_bridge_url = None


def bridge_url():
    """The PDC WhatsApp Bridge's address. It isn't published on the host, so it's
    reached on its Supervisor-network IP, looked up via the Supervisor API."""
    global _bridge_url
    if OPTS["whatsapp_bridge_url"]:
        return OPTS["whatsapp_bridge_url"].rstrip("/")
    if not _bridge_url:
        own = (_supervisor_call("GET", "/addons/self/info")[1] or {}).get("data") or {}
        slug = re.sub(r"net_monitor$", "pdc_whatsapp", own.get("slug") or "")
        info = ((_supervisor_call("GET", f"/addons/{slug}/info")[1] or {}).get("data") or {}) if slug else {}
        if info.get("ip_address"):
            _bridge_url = f"http://{info['ip_address']}:8787"
        else:
            log.warning("Couldn't find the PDC WhatsApp Bridge add-on; set whatsapp_bridge_url")
    return _bridge_url


def whatsapp_post(url, text, key):
    body = json.dumps({"to": OPTS["whatsapp_to"], "text": text, "idempotencyKey": key}).encode()
    req = urllib.request.Request(f"{url}/send", data=body, method="POST", headers={
        "Authorization": f"Bearer {OPTS['whatsapp_api_token']}", "Content-Type": "application/json"})
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


def whatsapp_send(text, key, give_up_after=1800):
    """Sends text through the bridge. Retries while WhatsApp reconnects after the outage;
    the idempotency key keeps a retry from sending the message twice."""
    global _bridge_url
    if not (OPTS["whatsapp_to"] and OPTS["whatsapp_api_token"]):
        return False
    deadline, delay = time.time() + give_up_after, 15
    while True:
        url = bridge_url()
        status, body = whatsapp_post(url, text, key) if url else (None, {})
        if status == 200:
            log.info("WhatsApp message sent (%s)", key)
            return True
        if status in (400, 401, 403, 413):
            log.error("WhatsApp bridge rejected the message (%s %s): check whatsapp_to / whatsapp_api_token",
                      status, body.get("status"))
            return False
        if status in (409, 502) and body.get("status") == "unknown":
            log.warning("WhatsApp message may or may not have been delivered (bridge lost track)")
            return False
        if status is None:
            _bridge_url = None  # the bridge restarted and may have a new IP
        if time.time() + delay > deadline:
            log.warning("Gave up sending the WhatsApp message (%s %s)", status, body.get("status"))
            return False
        time.sleep(delay)
        delay = min(120, delay * 2)


def _bar(pct, width=10):
    filled = max(0, min(width, round((pct or 0) / 100 * width)))
    return "▰" * filled + "▱" * (width - filled)


def _when(ts, with_date):
    return time.strftime("%a %d %b, ", time.localtime(ts)) + fmt_time(ts) if with_date else fmt_time(ts)


def _plural(n, word):
    return f"{n} {word}{'s' if n != 1 else ''}"


def outage_report(outage_id, start, end, row=None):
    """WhatsApp-formatted report for an outage that has just ended."""
    duration = end - start
    two_days = time.strftime("%Y%m%d", time.localtime(start)) != time.strftime("%Y%m%d", time.localtime(end))
    lines = ["✅ *INTERNET IS BACK*", "_Net Monitor · outage report_", "",
             f"🔴 *Went down:*  {_when(start, two_days)}",
             f"🟢 *Came back:*  {_when(end, two_days)}",
             f"⏱️ *Lasted:*  {fmt_duration(duration)}"]
    if not two_days:
        lines.append(f"📅 {time.strftime('%A, %d %B', time.localtime(start))}")
    lines += ["", "━━━━━━━━━━━━━━━", ""]

    if row and row.get("status") == "ok":
        pd_pct, pu_pct = 100 * row["download_mbps"] / plan_down(), 100 * row["upload_mbps"] / plan_up()
        lines += ["⚡ *Speed after recovery*",
                  f"⬇️ {row['download_mbps']:.1f} Mbps  {_bar(pd_pct)} {pd_pct:.0f}%",
                  f"⬆️ {row['upload_mbps']:.1f} Mbps  {_bar(pu_pct)} {pu_pct:.0f}%",
                  f"📶 {row['ping_ms']:.0f} ms ping · {row.get('server_location') or row.get('server_name')}"]
    else:
        after = db.one("SELECT AVG(latency_ms) AS lat, AVG(loss_pct) AS loss FROM checks "
                       "WHERE up=1 AND ts BETWEEN ? AND ?", (end, end + 300))
        lines.append("⚡ *Connection now*")
        if after and after["lat"] is not None:
            lines.append(f"📶 {after['lat']:.0f} ms ping · {after['loss'] or 0:.0f}% packet loss")
        lines.append("_Speedtest failed after recovery._" if row else "_Short outage, so no speedtest was run._")
    lines.append("")

    # What the line looked like in the 10 minutes before it dropped, vs the day before.
    pre = db.one("SELECT AVG(latency_ms) AS lat, MAX(loss_pct) AS loss, COUNT(*) AS n FROM checks "
                 "WHERE up=1 AND ts BETWEEN ? AND ?", (start - 600, start))
    base = db.one("SELECT AVG(latency_ms) AS lat FROM checks WHERE up=1 AND ts BETWEEN ? AND ?",
                  (start - 86400, start - 600))
    if pre and pre["n"] and pre["lat"] is not None:
        signs = []
        if pre["loss"] and pre["loss"] >= 20:
            signs.append(f"packet loss up to {pre['loss']:.0f}%")
        if base and base["lat"] and pre["lat"] > 1.5 * base["lat"] + 20:
            signs.append(f"ping {pre['lat']:.0f} ms (usually {base['lat']:.0f} ms)")
        lines += ["🔎 *Before it dropped*",
                  ("⚠️ Warning signs: " + ", ".join(signs) + ".") if signs else
                  f"Line was healthy ({pre['lat']:.0f} ms, {pre['loss'] or 0:.0f}% loss), then cut out suddenly.", ""]

    lt = time.localtime(end)
    midnight = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    today, week = report(midnight, end), report(end - 7 * 86400, end)
    lines += ["📊 *Today*",
              f"{_plural(today['outages'], 'outage')} · {fmt_duration(today['downtime_s'])} down"
              + (f" · {today['uptime_pct']:.1f}% uptime" if today["uptime_pct"] is not None else ""),
              "", "📈 *Last 7 days*",
              f"{_plural(week['outages'], 'outage')} · {fmt_duration(week['downtime_s'])} down"
              + (f" · {week['uptime_pct']:.2f}% uptime" if week["uptime_pct"] is not None else "")]
    lo = week["longest_outage"]
    if lo and lo["id"] != outage_id:
        lines.append(f"Longest: {fmt_duration(lo['duration_s'])} on {time.strftime('%a %d %b', time.localtime(lo['start']))}")
    if week["grade"]:
        lines.append(f"Grade: *{week['grade']}*")
    lines.append("")

    longer = db.one("SELECT start FROM events WHERE kind='internet_down' AND id != ? AND end IS NOT NULL "
                    "AND end - start > ? ORDER BY start DESC LIMIT 1", (outage_id, duration))
    first = db.one("SELECT MIN(ts) AS t FROM checks")["t"] or start
    if not longer:
        lines.append(f"🏷️ Longest outage since monitoring began ({fmt_duration(end - first)} ago)")
    elif start - longer["start"] > 2 * 86400:
        lines.append(f"🏷️ Longest outage in {int((start - longer['start']) // 86400)} days")
    prev = db.one("SELECT start, end FROM events WHERE kind='internet_down' AND id != ? AND end IS NOT NULL "
                  "AND end <= ? ORDER BY end DESC LIMIT 1", (outage_id, start))
    if prev:
        lines.append(f"🕒 Previous outage ended {fmt_duration(start - prev['end'])} earlier "
                     f"(lasted {fmt_duration(prev['end'] - prev['start'])})")
    if row and row.get("external_ip"):
        before = db.one("SELECT ip, isp FROM ip_log WHERE ts < ? ORDER BY ts DESC LIMIT 1", (row["ts"] - 1,))
        if before and before["ip"] != row["external_ip"]:
            lines.append(f"🔁 Public IP changed: {before['ip']} → {row['external_ip']}")
        if before and row.get("isp") and before["isp"] != row["isp"]:
            lines.append(f"🏢 ISP now shows as {row['isp']}")
    return "\n".join(lines).rstrip()


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


def busy_reason(traffic):
    """Why the line counts as in use, or None. Download catches downloads/streaming;
    upload and outgoing packet rate catch gaming and calls, which use little bandwidth."""
    if not traffic:
        return None
    if OPTS["busy_threshold_mbps"] > 0 and traffic["down"] > OPTS["busy_threshold_mbps"]:
        return f"{traffic['down']:.1f} Mbps download in use"
    if OPTS["busy_upload_mbps"] > 0 and traffic["up"] > OPTS["busy_upload_mbps"]:
        return f"{traffic['up']:.2f} Mbps upload in use (gaming / call?)"
    if OPTS["busy_packets_per_second"] > 0 and traffic["pps_out"] > OPTS["busy_packets_per_second"]:
        return f"{traffic['pps_out']:.0f} packets/s outgoing (gaming / call?)"
    return None


def run_scheduled(slot, interval):
    retry = OPTS["busy_retry_minutes"] * 60
    deadline = slot + interval * 60 - 120
    window_end = in_maintenance(time.time())
    if window_end:  # e.g. the router's nightly reboot: test once it's back
        state.scheduler_note = f"Waiting for scheduled router restart to finish ({fmt_time(window_end)})"
        state.next_test_ts = window_end + 120
        time.sleep(max(0, window_end + 120 - time.time()))
    last_busy = None
    while True:
        if is_paused():
            state.scheduler_note = "Paused"
            insert_speedtest({"ts": time.time(), "status": "skipped_paused", "trigger": "scheduled"})
            return
        if state.online is False:
            state.scheduler_note = "Skipped: internet down"
            return  # the outage itself is recorded; a failed test adds nothing
        traffic = router.measure()
        reason = busy_reason(traffic)
        if reason:
            last_busy = traffic["down"]
            if time.time() + retry < deadline:
                state.scheduler_note = f"Line busy ({reason}), retrying at {fmt_time(time.time() + retry)}"
                state.next_test_ts = time.time() + retry
                log.info(state.scheduler_note)
                time.sleep(retry)
                continue
            state.scheduler_note = "Skipped: line busy all hour"
            insert_speedtest({"ts": time.time(), "status": "skipped_busy", "trigger": "scheduled",
                              "busy_mbps": last_busy, "error": reason})
            return
        state.scheduler_note = ""
        run_speedtest("scheduled", traffic["down"] if traffic else None)
        return


def retention_loop():
    while True:
        cutoff = time.time() - OPTS["retention_days"] * 86400
        db.execute("DELETE FROM checks WHERE ts < ?", (cutoff,))
        db.execute("DELETE FROM speedtests WHERE ts < ?", (cutoff,))
        db.execute("DELETE FROM events WHERE end IS NOT NULL AND end < ?", (cutoff,))
        db.execute("DELETE FROM ip_log WHERE ts < ?", (cutoff,))
        # ponytail: fixed 90 days (~780k rows); tie it to retention_days if longer history is wanted.
        db.execute("DELETE FROM valorant_min WHERE ts < ?", (time.time() - 90 * 86400,))
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


# ----------------------------------------------------------- monthly report

def month_bounds(year, month):
    ny, nm = (year + 1, 1) if month == 12 else (year, month + 1)
    return (time.mktime((year, month, 1, 0, 0, 0, 0, 0, -1)), time.mktime((ny, nm, 1, 0, 0, 0, 0, 0, -1)))


def prev_month(year, month):
    return (year - 1, 12) if month == 1 else (year, month - 1)


def month_name(year, month):
    return time.strftime("%B %Y", (year, month, 1, 0, 0, 0, 0, 1, -1))


def month_stats(year, month):
    """report() for a calendar month (to now if it's the current one), plus the worst day."""
    lo, hi = month_bounds(year, month)
    hi = min(hi, time.time())
    r = report(lo, hi)
    now = time.time()
    downs = [e for e in events_in(lo, hi) if e["kind"] == "internet_down"]
    worst, day = None, lo
    while day < hi:
        lt = time.localtime(day)
        nxt = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + 1, 0, 0, 0, 0, 0, -1))
        down = sum(overlap(e["start"], e["end"] or now, day, nxt) for e in downs)
        n = sum(1 for e in downs if day <= e["start"] < nxt)
        if down and (not worst or down > worst["downtime_s"]):
            worst = {"day": day, "downtime_s": down, "outages": n}
        day = nxt
    first = db.one("SELECT MIN(ts) AS t FROM checks")["t"]
    r.update(year=year, month=month, label=month_name(year, month), worst_day=worst,
             days=(hi - lo) / 86400, monitored_days=max(0.0, hi - max(lo, first or hi)) / 86400)
    return r


def _delta(now, before, unit="%", digits=0):
    d = now - before
    arrow = "▲" if d > 0 else "▼" if d < 0 else "="
    return f"{arrow} {abs(d):.{digits}f}{unit}"


def monthly_report_text(year, month):
    """WhatsApp-formatted ISP report card for one calendar month."""
    r = month_stats(year, month)
    lines = ["📅 *MONTHLY ISP REPORT*", f"_{r['label']} · Net Monitor_", ""]
    if r["grade"]:
        lines.append(f"🏅 Grade: *{r['grade']}*  ({r['score']:.0f}/100)")
    if r["monitored_days"] < r["days"] - 1:
        lines.append(f"_Monitored {r['monitored_days']:.0f} of {r['days']:.0f} days_")
    lines += ["", "━━━━━━━━━━━━━━━", ""]

    lines.append(f"💰 *You pay for {r['plan_down']:g} / {r['plan_up']:g} Mbps*")
    if r["tests"]:
        lines += [f"⬇️ Avg {r['avg_down']:.1f} Mbps  {_bar(r['avg_down_pct'])} {r['avg_down_pct']:.0f}%",
                  f"⬆️ Avg {r['avg_up']:.1f} Mbps  {_bar(r['avg_up_pct'])} {r['avg_up_pct']:.0f}%",
                  f"📶 Avg ping {r['avg_ping']:.0f} ms",
                  f"🎯 {100 - r['below_80_pct']:.0f}% of tests got at least 80% of your plan",
                  f"🐢 {r['below_50_pct']:.0f}% of tests got less than half",
                  f"📉 Slowest test: {r['min_down']:.1f} Mbps · fastest: {r['max_down']:.1f} Mbps",
                  f"_{_plural(r['tests'], 'speedtest')}_"]
    else:
        lines.append("_No speedtests this month._")
    lines.append("")

    lines.append("🌐 *Reliability*")
    if r["uptime_pct"] is not None:
        lines.append(f"Uptime *{r['uptime_pct']:.2f}%*")
    lines.append(f"{_plural(r['outages'], 'outage')} · {fmt_duration(r['downtime_s'])} down in total")
    if r["longest_outage"]:
        lo = r["longest_outage"]
        lines.append(f"Longest: {fmt_duration(lo['duration_s'])} on {time.strftime('%a %d %b', time.localtime(lo['start']))}")
    if r["worst_day"]:
        w = r["worst_day"]
        lines.append(f"Worst day: {time.strftime('%a %d %b', time.localtime(w['day']))} "
                     f"({_plural(w['outages'], 'outage')}, {fmt_duration(w['downtime_s'])} down)")
    if r["planned_restarts"]:
        lines.append(f"_{_plural(r['planned_restarts'], 'scheduled router restart')} not counted_")
    lines.append("")

    if r["fastest_hour"] and r["slowest_hour"]:
        lines += ["⏰ *Best & worst times*",
                  f"Fastest around {r['fastest_hour']['label']} ({r['fastest_hour']['avg_down']:.1f} Mbps)",
                  f"Slowest around {r['slowest_hour']['label']} ({r['slowest_hour']['avg_down']:.1f} Mbps)", ""]

    py, pm = prev_month(year, month)
    p = month_stats(py, pm)
    if p["tests"] and r["tests"] and p["uptime_pct"] is not None and r["uptime_pct"] is not None:
        lines += [f"📊 *vs {month_name(py, pm).split()[0]}*",
                  f"Speed {_delta(r['avg_down_pct'], p['avg_down_pct'])} of plan · "
                  f"Uptime {_delta(r['uptime_pct'], p['uptime_pct'], ' pts', 2)}",
                  f"Outages {r['outages']} vs {p['outages']}"
                  + (f" · Grade {p['grade']} → {r['grade']}" if p["grade"] and r["grade"] else ""), ""]

    price = float(OPTS["plan_price"] or 0)
    if price > 0 and r["tests"] and r["uptime_pct"] is not None:
        got = min(r["avg_down_pct"], 100) / 100 * r["uptime_pct"] / 100
        cur = OPTS["plan_currency"]
        lines += ["💸 *Value for money*",
                  f"You paid {cur}{price:,.0f} · got about {cur}{price * got:,.0f} worth",
                  f"_({got * 100:.0f}% of what you pay for: average speed vs plan × uptime)_"]
    return "\n".join(lines).rstrip()


def monthly_summary_line(year, month):
    r = month_stats(year, month)
    parts = [f"Grade {r['grade']}" if r["grade"] else r["label"]]
    if r["uptime_pct"] is not None:
        parts.append(f"uptime {r['uptime_pct']:.2f}%, {_plural(r['outages'], 'outage')}")
    if r["tests"]:
        parts.append(f"avg {r['avg_down']:.1f} Mbps ({r['avg_down_pct']:.0f}% of plan)")
    return ". ".join(parts) + "."


def monthly_report_loop():
    """On the 1st (from monthly_report_hour on), sends last month's report once."""
    while True:
        time.sleep(60)
        if not OPTS["monthly_report_enabled"]:
            continue
        lt = time.localtime()
        if lt.tm_mday == 1 and lt.tm_hour < OPTS["monthly_report_hour"]:
            continue
        year, month = prev_month(lt.tm_year, lt.tm_mon)
        stamp = f"{year}-{month:02d}"
        if db.get_setting("monthly_report_sent") == stamp:
            continue
        db.set_setting("monthly_report_sent", stamp)
        first = db.one("SELECT MIN(ts) AS t FROM checks")["t"]
        if not first or first >= month_bounds(year, month)[1]:
            continue  # wasn't monitoring yet
        try:
            ha_notify(f"📅 ISP report {month_name(year, month)}", monthly_summary_line(year, month))
            whatsapp_send(monthly_report_text(year, month), f"netmon-monthly-{stamp}", give_up_after=6 * 3600)
        except Exception:
            log.exception("Monthly report failed")


def months_payload():
    """Per-month ISP report cards, newest first, back to the first month with data."""
    first = db.one("SELECT MIN(ts) AS t FROM checks")["t"]
    if not first:
        return []
    lt, ft = time.localtime(), time.localtime(first)
    y, m, out = lt.tm_year, lt.tm_mon, []
    while (y, m) >= (ft.tm_year, ft.tm_mon) and len(out) < 24:
        r = month_stats(y, m)
        out.append({k: r[k] for k in ("year", "month", "label", "grade", "score", "uptime_pct", "outages",
                                      "downtime_s", "avg_down", "avg_up", "avg_down_pct", "tests",
                                      "monitored_days", "days")})
        y, m = prev_month(y, m)
    return out


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
    planned = sum(overlap(e["start"], e["end"] or now, lo_eff, hi_eff) for e in evs if e["kind"] == "planned_restart")
    observed = max(0.0, span - offline - planned)
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
        "downtime_s": down, "monitor_offline_s": offline, "planned_s": planned,
        "planned_restarts": sum(1 for e in evs if e["kind"] == "planned_restart"),
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
    out = {**{k: s[k] for k in ("uptime_pct", "downtime_s", "outages", "monitor_offline_s", "observed_s",
                                "planned_s", "planned_restarts")},
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
        planned = sum(overlap(e["start"], e["end"] or now, a_eff, b_eff) for e in evs if e["kind"] == "planned_restart")
        observed = span - off - planned
        n_out = sum(1 for e in evs if e["kind"] == "internet_down" and e["start"] < b and (e["end"] or now) > a)
        out.append({"from": a, "to": b, "observed_s": observed, "downtime_s": down, "offline_s": off, "planned_s": planned,
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


def latest_outage_report():
    """Report for the most recent outage (or a made-up 27-minute one ending now), for
    the dashboard preview and test messages."""
    e = db.one("SELECT * FROM events WHERE kind='internet_down' AND end IS NOT NULL ORDER BY end DESC LIMIT 1")
    if not e:
        now = time.time()
        return outage_report(-1, now - 27 * 60, now), False
    row = db.one("SELECT * FROM speedtests WHERE id=?", (e["recovery_speedtest_id"],)) if e["recovery_speedtest_id"] else None
    return outage_report(e["id"], e["start"], e["end"], row), True


def alerts_payload():
    text, real = latest_outage_report()
    names = {e: ((ha_get_state(e) or {}).get("attributes") or {}).get("friendly_name") or e
             for e in OPTS["alexa_entities"]}
    return {"alexa_entities": OPTS["alexa_entities"], "alexa_names": names, "alexa_volume": OPTS["alexa_volume"],
            "alexa_quiet_hours": OPTS["alexa_quiet_hours"], "offline_tts_service": OPTS["offline_tts_service"],
            "whatsapp_configured": bool(OPTS["whatsapp_to"] and OPTS["whatsapp_api_token"]),
            "down_message": announce_message("down"), "up_message": announce_message("up", 27 * 60),
            "preview": text, "preview_is_real": real}


def status_payload():
    last_test = db.one("SELECT * FROM speedtests WHERE status='ok' ORDER BY ts DESC LIMIT 1")
    spark = db.query("SELECT ts, up, latency_ms FROM checks ORDER BY ts DESC LIMIT 60")[::-1]
    # How the line feels right now: the last 10 minutes, not one 30-second sample.
    recent = db.one("SELECT COUNT(*) AS n, SUM(up = 0) AS fails, AVG(CASE WHEN up THEN latency_ms END) AS latency_ms, "
                    "AVG(CASE WHEN up THEN jitter_ms END) AS jitter_ms, AVG(CASE WHEN up THEN loss_pct END) AS loss_pct "
                    "FROM checks WHERE ts > ?", (time.time() - 600,))
    return {
        "recent": recent,
        "now": time.time(), "online": state.online, "last_check_ts": state.last_check_ts,
        "latency_ms": state.last_latency_ms, "jitter_ms": state.last_jitter_ms, "loss_pct": state.last_loss_pct,
        "online_since": online_since() if state.online else None, "outage_start": state.outage_start,
        "down_reason": state.down_reason if state.online is False else None,
        "planned_outage": outage_is_planned(),
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


# ------------------------------------------------------------------ valorant
# VALORANT pings each server with a 36-byte UDP packet to a Riot Direct route on port
# 8181, which relays it over Riot's backbone to that server and back. The first 8 bytes
# pick the server (taken from the game's own pings, Oct 2026). The reply starts with
# bytes 4-8 of the request and echoes everything from byte 8 on.
VALORANT_REGIONS = {  # key: (name, server bytes, routes the game pings it through)
    "mumbai": ("Mumbai", "7d2a1f22fe32f110", ["151.106.246.1", "151.106.248.1", "43.229.65.1", "162.249.75.1"]),
    "singapore": ("Singapore", "ccfec3841f32f9b7", ["151.106.248.1", "43.229.65.1"]),
    "hongkong": ("Hong Kong", "7cfea47eb432f191", ["151.106.248.1", "43.229.65.1"]),
    "manila": ("Manila", "04881dd63032c6df", ["151.106.248.1", "43.229.65.1"]),
    "tokyo": ("Tokyo", "e53a4109fd32f8df", ["151.106.248.1", "43.229.65.1"]),
    "sydney": ("Sydney", "f04b9bc9ed32fbf1", ["151.106.248.1", "43.229.65.1"]),
}
# A match connects through whichever route is fastest when it starts (the game's logs
# show Mumbai matches moving from 151.106.246.1 to 151.106.248.1 once the first slowed
# down), so a server's ping is its fastest route's, as in the game's server list.
VALORANT_INTERVAL = 10
# 3 pings x 14 routes per round is ~4 packets/s of 36 bytes: nothing next to a game
# (~70 KB/s) and far under busy_packets_per_second.
VALORANT_SAMPLES = 3
VALORANT_WINDOW = 12  # rounds (2 minutes) behind each verdict
VALORANT_HOLD = 6     # rounds (1 minute) a new verdict must hold before it's alerted
_valorant_jobs = [(k, e) for k, r in VALORANT_REGIONS.items() for e in r[2]]
valorant_pool = ThreadPoolExecutor(max_workers=len(_valorant_jobs))
valorant_lock = threading.Lock()
valorant_live = deque(maxlen=360)  # the last hour of rounds, for the live view
_valorant_usual = {}


def valorant_probe(edge, header, n=VALORANT_SAMPLES):
    """(median ms, jitter ms, loss %) of n pings to a server through one route."""
    rtts = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        for i in range(n):
            # Same layout as the game's own ping: server, client tag, nonce, fixed trailer.
            body = header + b"\xab\x59\x7f\x81" + os.urandom(12) + bytes.fromhex("0f000000aaaaaaaabbbbbbbb")
            t0 = time.perf_counter()
            try:
                s.sendto(body, (edge, 8181))
                while (left := t0 + 1.0 - time.perf_counter()) > 0:
                    s.settimeout(left)
                    reply = s.recv(256)
                    if reply[:4] == body[4:8] and reply[8:] == body[8:]:  # not a late reply to an earlier ping
                        rtts.append((time.perf_counter() - t0) * 1000)
                        break
            except OSError:
                pass
            if i < n - 1:
                time.sleep(0.1)
    loss = 100.0 * (n - len(rtts)) / n
    if not rtts:
        return None, None, loss
    jitter = sum(abs(a - b) for a, b in zip(rtts, rtts[1:])) / (len(rtts) - 1) if len(rtts) > 1 else None
    return sorted(rtts)[len(rtts) // 2], jitter, loss


def valorant_verdict(ping, jitter, loss, max_ping):
    """(playable, reasons not) for a server over the verdict window."""
    if ping is None:
        return False, ["the server isn't answering"]
    why = []
    if ping > max_ping:
        why.append(f"ping around {ping:.0f} ms (limit {max_ping:g})")
    if loss is not None and loss >= 3:
        why.append(f"{loss:.0f}% packet loss")
    if jitter is not None and jitter >= 20:
        why.append(f"ping jumping ±{jitter:.0f} ms")
    return not why, why


def _median(values):
    v = sorted(x for x in values if x is not None)
    return v[len(v) // 2] if v else None


def _mean(values):
    v = [x for x in values if x is not None]
    return sum(v) / len(v) if v else None


def valorant_round():
    """Pings every server through every route once; the result joins the live view."""
    t0 = time.time()
    res = dict(zip(_valorant_jobs, valorant_pool.map(
        lambda j: valorant_probe(j[1], bytes.fromhex(VALORANT_REGIONS[j[0]][1])), _valorant_jobs)))
    rnd = {"ts": t0, "regions": {}}
    for k, (_, _, routes) in VALORANT_REGIONS.items():
        edges = [{"edge": e, "ping_ms": res[(k, e)][0], "jitter_ms": res[(k, e)][1], "loss_pct": res[(k, e)][2]}
                 for e in routes]
        main = min(edges, key=lambda x: (x["ping_ms"] is None, x["ping_ms"] or 0))
        rnd["regions"][k] = {**{f: main[f] for f in ("ping_ms", "jitter_ms", "loss_pct")}, "edges": edges,
                             "route": main["edge"]}
    valorant_live.append(rnd)
    return rnd


def valorant_summary(k, live):
    """One server's state: latest ping, verdict over the last 2 minutes, routes."""
    rounds = [r["regions"][k] for r in live[-VALORANT_WINDOW:]]
    window = {"ping_ms": _median(r["ping_ms"] for r in rounds), "jitter_ms": _mean(r["jitter_ms"] for r in rounds),
              "loss_pct": _mean(r["loss_pct"] for r in rounds)}
    playable, why = valorant_verdict(window["ping_ms"], window["jitter_ms"], window["loss_pct"],
                                     OPTS["valorant_max_ping_ms"])
    latest = rounds[-1]
    return {"key": k, "name": VALORANT_REGIONS[k][0], "ping_ms": latest["ping_ms"], "window": window,
            "playable": playable, "why": why, "edges": latest["edges"], "route": latest["route"]}


def valorant_rollup(live, minute):
    """Stores one row per server for the minute that just ended (history keeps minutes)."""
    rounds = [r for r in live if minute <= r["ts"] < minute + 60]
    for k in VALORANT_REGIONS:
        rs = [r["regions"][k] for r in rounds]
        ping, jit, loss = _median(r["ping_ms"] for r in rs), _mean(r["jitter_ms"] for r in rs), _mean(r["loss_pct"] for r in rs)
        playable = valorant_verdict(ping, jit, loss, OPTS["valorant_max_ping_ms"])[0]
        db.execute("INSERT INTO valorant_min(ts, region, ping_ms, jitter_ms, loss_pct, playable) VALUES(?, ?, ?, ?, ?, ?)",
                   (minute, k, ping, jit, loss, int(playable)))


def valorant_publish(s):
    w, p = s["window"], s["ping_ms"]
    ha_set_state("sensor.net_monitor_valorant_ping", round(p) if p is not None else "unavailable", {
        "friendly_name": f"Valorant ping ({s['name']})", "unit_of_measurement": "ms",
        "state_class": "measurement", "device_class": "duration", "icon": "mdi:crosshairs-gps",
        "network_delay_ms": round(p / 2) if p is not None else None,
        "jitter_ms": round(w["jitter_ms"], 1) if w["jitter_ms"] is not None else None,
        "packet_loss_pct": round(w["loss_pct"], 1) if w["loss_pct"] is not None else None,
        "route": s["route"], "server": s["name"]})
    ha_set_state("binary_sensor.net_monitor_valorant_playable", "on" if s["playable"] else "off", {
        "friendly_name": f"Valorant good to play ({s['name']})", "icon": "mdi:controller",
        "reasons": ", ".join(s["why"]) or None, "max_ping_ms": OPTS["valorant_max_ping_ms"]})


def valorant_after_round(m):
    """Minute history, sensors and alerts for the main server."""
    live = list(valorant_live)
    minute = int(live[-1]["ts"] // 60 * 60)
    if m["minute"] is not None and minute != m["minute"]:
        valorant_rollup(live, m["minute"])
    m["minute"] = minute
    s = valorant_summary(OPTS["valorant_region"], live)
    m["rounds"] += 1
    if m["rounds"] % 6 == 1 or s["playable"] != m["last"]:
        valorant_publish(s)
    # Alert once a new verdict has held for a minute, so a flicker at the limit stays
    # quiet. The first verdict after startup isn't news; a dead line has its own alerts.
    m["streak"] = m["streak"] + 1 if s["playable"] == m["last"] else 1
    m["last"] = s["playable"]
    if m["streak"] >= VALORANT_HOLD and s["playable"] != m["told"] and state.online is not False:
        first, m["told"] = m["told"] is None, s["playable"]
        if not first and OPTS["valorant_alerts"]:
            ha_notify(f"Valorant: {'good to play' if s['playable'] else 'hold off'}",
                      f"{s['name']} is back to {s['window']['ping_ms']:.0f} ms. Good time to queue." if s["playable"]
                      else f"Don't queue {s['name']} right now: {', '.join(s['why'])}.")


def valorant_loop():
    m = {"last": None, "streak": 0, "told": None, "minute": None, "rounds": 0}
    while True:
        t0 = time.time()
        try:
            with valorant_lock:
                valorant_round()
            valorant_after_round(m)
        except Exception:
            log.exception("Valorant check failed")
        time.sleep(max(1.0, t0 + VALORANT_INTERVAL - time.time()))


def valorant_usual():
    """Per server, how often it was good to play at this hour of the week over the last
    4 weeks. Cached for the hour: it's a scan of ~240k rows."""
    lt = time.localtime()
    key = (lt.tm_yday, lt.tm_hour)
    if key not in _valorant_usual:
        rows = db.query(
            "SELECT region, AVG(playable) AS ready, COUNT(*) AS n, AVG(ping_ms) AS ping_ms FROM valorant_min "
            "WHERE ts > ? AND strftime('%w %H', ts, 'unixepoch', 'localtime') = ? GROUP BY region",
            (time.time() - 28 * 86400, f"{(lt.tm_wday + 1) % 7} {lt.tm_hour:02d}"))
        _valorant_usual.clear()
        _valorant_usual[key] = {r["region"]: r for r in rows if r["n"] >= 30}
    return _valorant_usual[key]


def valorant_payload():
    live = list(valorant_live)
    return {"ts": live[-1]["ts"] if live else None, "interval": VALORANT_INTERVAL,
            "max_ping_ms": OPTS["valorant_max_ping_ms"], "main": OPTS["valorant_region"],
            "regions": [valorant_summary(k, live) for k in VALORANT_REGIONS] if live else [],
            "usual": valorant_usual(),
            "live": [{"ts": r["ts"], **{k: v["ping_ms"] for k, v in r["regions"].items()}} for r in live]}


def valorant_refresh():
    with valorant_lock:
        valorant_round()
    return valorant_payload()


def _best_window(hours, width=3, worst=False):
    """The `width`-hour stretch of the day (wrapping midnight) that was most (or least)
    often good to play. hours: {hour: (ready, n)}."""
    best = None
    for h in range(24):
        span = [hours.get((h + i) % 24) for i in range(width)]
        if any(s is None or s[1] < 30 for s in span):
            continue
        ready = sum(s[0] for s in span) / sum(s[1] for s in span)
        if best is None or (ready < best[1] if worst else ready > best[1]):
            best = (h, ready)
    return {"start_hour": best[0], "end_hour": (best[0] + width) % 24, "ready_pct": 100 * best[1]} if best else None


def valorant_history(region, days):
    now = time.time()
    rows = db.query("SELECT ts, ping_ms, loss_pct, playable FROM valorant_min WHERE region=? AND ts > ? ORDER BY ts",
                    (region, now - days * 86400))
    heat, hours, buckets = {}, {}, {}
    bucket_s = 3600 if days <= 30 else 3 * 3600
    for r in rows:
        lt = time.localtime(r["ts"])
        for d, key in ((heat, (lt.tm_wday, lt.tm_hour)), (hours, lt.tm_hour), (buckets, int(r["ts"] // bucket_s * bucket_s))):
            c = d.setdefault(key, [0, 0, []])
            c[0] += r["playable"]
            c[1] += 1
            c[2].append(r["ping_ms"])
    # Bad stretches: runs of not-playable minutes (gaps up to 3 minutes bridged), 10+ minutes long.
    stretches, cur = [], None
    for r in rows:
        if not r["playable"]:
            if cur and r["ts"] - cur["end"] <= 180:
                cur["end"], cur["pings"] = r["ts"] + 60, cur["pings"] + [r["ping_ms"]]
            else:
                cur = {"start": r["ts"], "end": r["ts"] + 60, "pings": [r["ping_ms"]]}
                stretches.append(cur)
    stretches = [{"start": s["start"], "end": s["end"], "peak_ms": max((p for p in s["pings"] if p is not None), default=None),
                  "median_ms": _median(s["pings"])} for s in stretches if s["end"] - s["start"] >= 600]
    hour_counts = {h: (c[0], c[1]) for h, c in hours.items()}
    compare = db.query("SELECT region, COUNT(*) AS n, AVG(playable) AS ready, AVG(ping_ms) AS avg_ms "
                       "FROM valorant_min WHERE ts > ? GROUP BY region", (now - days * 86400,))
    return {
        "region": region, "region_name": VALORANT_REGIONS[region][0], "days": days,
        "max_ping_ms": OPTS["valorant_max_ping_ms"], "minutes": len(rows),
        "since": rows[0]["ts"] if rows else None,
        "ready_pct": 100 * sum(r["playable"] for r in rows) / len(rows) if rows else None,
        "median_ms": _median(r["ping_ms"] for r in rows),
        "best": _best_window(hour_counts), "worst": _best_window(hour_counts, worst=True),
        "heat": [{"wday": w, "hour": h, "ready_pct": 100 * c[0] / c[1], "median_ms": _median(c[2]), "n": c[1]}
                 for (w, h), c in sorted(heat.items())],
        "hours": [{"hour": h, "ready_pct": 100 * c[0] / c[1], "median_ms": _median(c[2]), "n": c[1]}
                  for h, c in sorted(hours.items())],
        "series": [{"ts": t, "ready_pct": 100 * c[0] / c[1], "median_ms": _median(c[2])} for t, c in sorted(buckets.items())],
        "stretches": stretches[::-1][:15],
        "compare": [{**r, "name": VALORANT_REGIONS[r["region"]][0], "ready_pct": 100 * r["ready"]}
                    for r in sorted(compare, key=lambda r: -r["ready"]) if r["region"] in VALORANT_REGIONS],
    }


# ----------------------------------------------------------------- settings

WINDOW_RE = r"^\d{1,2}:\d{2}-\d{1,2}:\d{2}$"
# Mirrors the schema in config.yaml, so the dashboard can reject bad values before
# the Supervisor does (it validates again when saving).
SETTINGS = {
    "speedtest_interval_minutes": ("int", 15, 1440),
    "server_ids": ("ints",),
    "check_interval_seconds": ("int", 10, 300),
    "check_targets": ("texts", r"^[A-Za-z0-9.\-]+:\d{1,5}$", "host:port", 1),
    "busy_threshold_mbps": ("float", 0, 10000),
    "busy_upload_mbps": ("float", 0, 10000),
    "busy_packets_per_second": ("int", 0, 100000),
    "busy_retry_minutes": ("int", 1, 60),
    "recovery_speedtest_min_outage_minutes": ("int", 0, 1440),
    "notify_service": ("text", False, None),
    "notify_min_outage_minutes": ("int", 0, 1440),
    "retention_days": ("int", 7, 3650),
    "plan_download_mbps": ("float", 1, 100000),
    "plan_upload_mbps": ("float", 1, 100000),
    "slow_alert_percent": ("int", 0, 100),
    "slow_alert_consecutive_tests": ("int", 1, 24),
    "weekly_report_enabled": ("bool",),
    "weekly_report_day": ("choice", WEEKDAYS),
    "weekly_report_hour": ("int", 0, 23),
    "quality_samples": ("int", 1, 10),
    "maintenance_windows": ("texts", WINDOW_RE, "HH:MM-HH:MM"),
    "alexa_entities": ("texts", r"^media_player\.[a-z0-9_]+$", "media_player.xxx"),
    "alexa_volume": ("int", 0, 100),
    "alexa_down_message": ("text", True, None),
    "alexa_up_message": ("text", True, None),
    "alexa_quiet_hours": ("texts", WINDOW_RE, "HH:MM-HH:MM"),
    "offline_tts_service": ("text", False, None),
    "whatsapp_to": ("text", False, r"^\+[1-9]\d{7,14}$"),
    "whatsapp_api_token": ("text", False, None),
    "whatsapp_bridge_url": ("text", False, r"^https?://\S+$"),
    "monthly_report_enabled": ("bool",),
    "monthly_report_hour": ("int", 0, 23),
    "plan_price": ("float", 0, 10000000),
    "plan_currency": ("text", True, None),
    "dns_check_server": ("text", False, r"^(auto|\d{1,3}(\.\d{1,3}){3})$"),
    "valorant_region": ("choice", list(VALORANT_REGIONS)),
    "valorant_max_ping_ms": ("int", 20, 500),
    "valorant_alerts": ("bool",),
}
RESTART_KEYS = {"speedtest_interval_minutes", "check_interval_seconds"}  # read once at startup
SECRET_KEYS = {"whatsapp_api_token"}


def _check(spec, value):
    """Returns the cleaned value or raises ValueError with a readable reason."""
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
    if kind == "text":
        v = str(value if value is not None else "").strip()
        if spec[1] and not v:
            raise ValueError("can't be empty")
        if v and spec[2] and not re.match(spec[2], v):
            raise ValueError("isn't in the right format")
        return v
    if kind == "ints":
        if not isinstance(value, list) or not value:
            raise ValueError("needs at least one entry")
        try:
            return [int(x) for x in value]
        except (TypeError, ValueError):
            raise ValueError("must be whole numbers") from None
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


def validate_settings(changes):
    clean, errors = {}, {}
    for key, value in changes.items():
        if key not in SETTINGS:
            errors[key] = "unknown setting"
            continue
        if key in SECRET_KEYS and not value:
            continue  # left blank = keep the saved secret
        try:
            clean[key] = _check(SETTINGS[key], value)
        except ValueError as e:
            errors[key] = str(e)
    return clean, errors


def save_settings(changes):
    """Validates, stores via the Supervisor (so the add-on's Configuration tab matches)
    and applies at once. Returns (http status, body)."""
    clean, errors = validate_settings(changes)
    if errors:
        return 400, {"errors": errors}
    clean = {k: v for k, v in clean.items() if v != OPTS.get(k)}
    if not clean:
        return 200, {"ok": True, "changed": [], "restart": False}
    if os.environ.get("SUPERVISOR_TOKEN"):
        status, info = _supervisor_call("GET", "/addons/self/info")
        current = ((info or {}).get("data") or {}).get("options") if status == 200 else None
        if current is None:
            return 502, {"error": "Couldn't read the current settings from Home Assistant"}
        status, body = _supervisor_call("POST", "/addons/self/options", {"options": {**current, **clean}})
        if status != 200:
            return 400 if status == 400 else 502, {
                "error": (body or {}).get("message") or f"Home Assistant didn't accept the settings ({status})"}
    else:  # local development: no Supervisor, write options.json directly
        try:
            with open(OPTIONS_PATH, encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError):
            stored = {}
        with open(OPTIONS_PATH + ".tmp", "w", encoding="utf-8") as f:
            json.dump({**stored, **clean}, f, indent=2, ensure_ascii=False)
        os.replace(OPTIONS_PATH + ".tmp", OPTIONS_PATH)
    restart = bool(RESTART_KEYS & clean.keys())
    OPTS.update(clean)
    log.info("Settings changed: %s", ", ".join(sorted(clean)))
    threading.Thread(target=publish_all, daemon=True).start()  # plan changes affect sensors
    if restart:
        threading.Timer(1.5, restart_self).start()
    return 200, {"ok": True, "changed": sorted(clean), "restart": restart}


def restart_self():
    if os.environ.get("SUPERVISOR_TOKEN"):
        log.info("Restarting to apply new check intervals")
        _supervisor_call("POST", "/addons/self/restart")
    else:
        log.info("New check intervals apply after a restart")


def settings_payload():
    values = {k: OPTS.get(k) for k in SETTINGS}
    for k in SECRET_KEYS:
        values[k] = ""
    states = _supervisor_call("GET", "/core/api/states", timeout=20)[1] or []
    players = {s["entity_id"]: (s.get("attributes") or {}).get("friendly_name") or s["entity_id"]
               for s in states if s.get("entity_id", "").startswith("media_player.")}
    for e in OPTS["alexa_entities"]:
        players.setdefault(e, e)
    services = _supervisor_call("GET", "/core/api/services", timeout=20)[1] or []
    notify = sorted(f"notify.{name}" for d in services if d.get("domain") == "notify"
                    for name in (d.get("services") or {}))
    return {"values": values, "secrets_set": {k: bool(OPTS.get(k)) for k in SECRET_KEYS},
            "media_players": [{"id": k, "name": v} for k, v in sorted(players.items(), key=lambda x: x[1].lower())],
            "notify_services": notify, "restart_keys": sorted(RESTART_KEYS)}


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
            if path == "/api/settings":
                return self._send(200, settings_payload())
            if path == "/api/months":
                return self._send(200, months_payload())
            if path == "/api/monthly_report":
                y, m = (int(x) for x in qs["month"][0].split("-"))
                return self._send(200, {"text": monthly_report_text(y, m)})
            if path == "/api/alerts":
                return self._send(200, alerts_payload())
            if path == "/valorant":
                return self._static("valorant.html")
            if path == "/api/valorant":
                return self._send(200, valorant_payload())
            if path == "/api/valorant/history":
                region = qs.get("region", [OPTS["valorant_region"]])[0]
                if region not in VALORANT_REGIONS:
                    raise ValueError("unknown region")
                return self._send(200, valorant_history(region, max(1, min(90, int(qs.get("days", [7])[0])))))
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
        if path == "/api/test/announce":
            kind, where = body.get("kind", "down"), body.get("device", "alexa")
            text = announce_message(kind, 27 * 60)
            if where == "phone":
                if not OPTS["offline_tts_service"]:
                    return self._send(400, {"error": "offline_tts_service is not set"})
                threading.Thread(target=phone_say, args=(text,), daemon=True).start()
            else:
                if not OPTS["alexa_entities"]:
                    return self._send(400, {"error": "alexa_entities is not set"})
                threading.Thread(target=alexa_say, args=(text,), daemon=True).start()
            return self._send(202, {"ok": True, "text": text})
        if path == "/api/test/whatsapp":
            if not (OPTS["whatsapp_to"] and OPTS["whatsapp_api_token"]):
                return self._send(400, {"error": "whatsapp_to / whatsapp_api_token are not set"})
            text, _ = latest_outage_report()
            ok = whatsapp_send("🧪 _Test message_\n\n" + text, f"netmon-test-{int(time.time())}", give_up_after=0)
            return self._send(200 if ok else 502, {"ok": ok} if ok else {"error": "Not sent, see the add-on log"})
        if path == "/api/settings":
            if not isinstance(body, dict):
                return self._send(400, {"error": "invalid settings"})
            return self._send(*save_settings(body))
        if path == "/api/test/monthly":
            if not (OPTS["whatsapp_to"] and OPTS["whatsapp_api_token"]):
                return self._send(400, {"error": "whatsapp_to / whatsapp_api_token are not set"})
            y, m = (int(x) for x in str(body.get("month", "")).split("-"))
            ok = whatsapp_send(monthly_report_text(y, m), f"netmon-monthly-test-{int(time.time())}", give_up_after=0)
            return self._send(200 if ok else 502, {"ok": ok} if ok else {"error": "Not sent, see the add-on log"})
        if path == "/api/valorant/refresh":
            return self._send(200, valorant_refresh())
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
    for target in (monitor_loop, scheduler_loop, retention_loop, weekly_report_loop, publish_loop, announcer_loop,
                   monthly_report_loop, valorant_loop):
        threading.Thread(target=target, daemon=True, name=target.__name__).start()
    threading.Timer(45, publish_all).start()  # after the first checks have run
    server = ThreadingHTTPServer((os.environ.get("NETMON_BIND", "0.0.0.0"), HTTP_PORT), Handler)
    log.info("Dashboard listening on port %s (Ingress)", HTTP_PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
