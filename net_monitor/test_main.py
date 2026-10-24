"""Checks the online/offline decision. Run: python net_monitor/test_main.py"""

import os
import socket
import sys
import tempfile
import threading

os.environ["NETMON_DATA_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
import main as m  # noqa: E402

m.db = m.DB(":memory:")
m.announce = lambda *a, **k: None
m.after_outage = lambda *a, **k: None
m.publish_connectivity = lambda: None

B = 1_791_734_400.0
T = ["a:443", "b:443", "c:443", "d:443"]

# In-country / intercepted answers don't count; two international ones are needed.
assert m.international([("x:1", 2.5), ("y:1", 50.0), ("z:1", None)]) == [("y:1", 50.0)]
assert m.round_verdict(list(zip(T, [2.5, None, None, None])), None, False)[0] is False  # the 22:10 outage
assert m.round_verdict(list(zip(T, [2.5, 48.0, None, None])), None, False)[0] is False
assert m.round_verdict(list(zip(T, [2.5, 48.0, 60.0, None])), None, False) == (True, None)
assert m.round_verdict([("a:443", 48.0)], None, False) == (True, None)  # a single target needs just itself

# DNS: a failure counts only once the server has been seen answering.
up4 = list(zip(T, [48.0, 50.0, 60.0, 90.0]))
assert m.round_verdict(up4, False, False)[0] is True
assert m.round_verdict(up4, False, True)[0] is False
assert m.round_verdict(up4, True, True)[0] is True

# dns_query reads the response code and ignores replies with the wrong id.
srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
srv.bind(("127.0.0.1", 0))


def fake_dns(rcode):
    data, addr = srv.recvfrom(512)
    srv.sendto(b"\xff\xff\x81\x80" + bytes(8), addr)  # wrong id: must be skipped
    srv.sendto(data[:2] + bytes([0x81, 0x80 | rcode]) + bytes(8), addr)


for rcode in (0, 3, 2):
    threading.Thread(target=fake_dns, args=(rcode,), daemon=True).start()
    assert m.dns_query("127.0.0.1", "x.google.com", 2, srv.getsockname()[1]) == rcode
m.OPTS["dns_check_server"] = ""
assert m.dns_check() is None
m.OPTS["dns_check_server"] = "auto"


# Going down takes 2 bad rounds, coming back 2 good ones, dated from the first good one.
def run(verdicts):
    it = iter(verdicts)
    m.check_once = lambda: (True, 50.0, 1.0, 0.0) if next(it) else (False, None, None, None)
    st = {"fails": 0, "first_fail_ts": None, "oks": 0, "first_ok_ts": None, "prev_ts": None,
          "planned": False, "down_announced": False}
    seen = []
    for i in range(len(verdicts)):
        m.monitor_step(st, B + 30 * i, 30)
        st["prev_ts"] = B + 30 * i
        seen.append(m.state.online)
    return seen


assert run([1, 0, 1]) == [True, True, True]  # one blip isn't an outage
assert run([1, 0, 0, 1, 0, 1, 1]) == [True, True, False, False, False, False, True]  # flapping stays down
ev = m.db.one("SELECT start, end FROM events WHERE kind='internet_down' ORDER BY id DESC LIMIT 1")
assert (ev["start"], ev["end"]) == (B + 30, B + 150), ev  # first bad round .. first of the 2 good ones
print("ok")

# Valorant: playable only with ping under the limit, little loss and a steady line.
assert m.valorant_verdict(45.0, 3.0, 0.0, 80) == (True, [])
assert m.valorant_verdict(177.0, 3.0, 0.0, 80) == (False, ["ping around 177 ms (limit 80)"])
assert m.valorant_verdict(45.0, 25.0, 5.0, 80)[1] == ["5% packet loss", "ping jumping ±25 ms"]
assert m.valorant_verdict(None, None, 100.0, 80)[0] is False
print("valorant ok")

# Best time to play: the 3-hour stretch most often good, wrapping past midnight.
hrs = {h: (10, 60) for h in range(24)}
hrs.update({23: (60, 60), 0: (60, 60), 1: (60, 60)})
assert m._best_window(hrs) == {"start_hour": 23, "end_hour": 2, "ready_pct": 100.0}
assert m._best_window(hrs, worst=True)["ready_pct"] < 20
assert m._best_window({0: (5, 5)}) is None  # too little data
# A silent minute on every server while online = the ping format changed, not an outage.
silent = [{"regions": {k: {"ping_ms": None} for k in m.VALORANT_REGIONS}}] * m.VALORANT_HOLD
m.state.online = True
assert m.valorant_stale(silent) is True
assert m.valorant_stale(silent[1:]) is False  # not a full minute yet
assert m.valorant_stale(silent[:-1] + [{"regions": {**silent[0]["regions"], "singapore": {"ping_ms": 48.0}}}]) is False
m.state.online = False
assert m.valorant_stale(silent) is False  # the internet is down: that has its own alerts
print("valorant history ok")
