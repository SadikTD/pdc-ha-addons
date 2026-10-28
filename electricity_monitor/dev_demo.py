"""Local preview: fills a database with 30 days of made-up breaker readings, run through
the real tracker, then serves the dashboard.
Run: python electricity_monitor/dev_demo.py   (then open http://localhost:38767)"""

import math
import os
import random
import sys
import tempfile
import time

os.environ.setdefault("EMON_DATA_DIR", tempfile.mkdtemp())
os.environ["EMON_ALLOW_ALL"] = "1"
os.environ["EMON_DEMO"] = "1"
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
import main as m  # noqa: E402

random.seed(7)
m.db = m.DB(m.DB_PATH)
m.tracker = tr = m.Tracker()
E = m.ENT
now = time.time()
t = now - 30 * 86400
energy = 3000.0


def feed(ts, key, state, ctx=None):
    tr.handle(ts, E[key], state, {}, ctx, live=False)


for k, v in (("low_v", 180), ("over_v", 270), ("over_a", 0), ("over_kw", 0), ("over_t", 50), ("over_kwh", 0)):
    feed(t, k, str(v))
feed(t, "relay", "on")

# Power cuts: mostly late morning and evening, as in the real history.
cuts = []
d = m.day_start(t)
while d < now:
    for hour, p in ((10.5, 0.55), (19.8, 0.5), (0.5, 0.2), (14, 0.15)):
        if random.random() < p:
            s = d + hour * 3600 + random.uniform(-2400, 2400)
            cuts.append((s, s + random.uniform(4, 70) * 60))
    cuts.append((d + 4 * 3600 + 61, d + 4 * 3600 + 61 + 28))  # the router's daily reboot
    d += 86400
trip_at = now - 5 * 86400 + 3600 * 3      # an over-voltage trip
stayed = [c for c in cuts if now - 3 * 86400 < c[0] < now - 2 * 86400 and c[1] - c[0] > 600][:1]
ac_on = False
avail = True
while t < now:
    lt = time.localtime(t)
    h = lt.tm_hour + lt.tm_min / 60
    in_cut = next((c for c in cuts if c[0] <= t < c[1]), None)
    if in_cut and avail:
        feed(in_cut[0], "relay", "unavailable")
        avail = False
    if not in_cut and not avail:
        prev = next(c for c in cuts if c[1] <= t and c[1] > t - 120)
        feed(prev[1], "relay", "off" if prev in stayed else "on")
        feed(prev[1] + 1, "energy", f"{energy:.3f}")
        avail = True
        if prev in stayed:
            t2 = prev[1] + 50 * 60
            feed(t2, "relay", "on")
    if avail and tr.relay == "on":
        v = 236 + 12 * math.sin((h - 15) / 24 * 2 * math.pi) + random.gauss(0, 2.5)
        if abs(t - trip_at) < 120:
            v = 272.5
        if 13 <= h < 16 or 21 <= h < 24.0:
            ac_on = (lt.tm_min // 20) % 3 != 2
        else:
            ac_on = False
        w = 140 + random.gauss(0, 15) + (120 if (lt.tm_min // 10) % 2 else 0) + (3300 if ac_on else 0) \
            + (450 if 7 <= h < 7.5 or 19 <= h < 19.4 else 0) + (900 if 8 <= h < 8.2 else 0)
        energy += w / 1000 * 60 / 3600
        feed(t, "voltage", f"{v:.1f}")
        feed(t + 1, "power", f"{w:.1f}")
        feed(t + 2, "current", f"{w / v:.3f}")
        feed(t + 3, "pf", str(int(88 + random.random() * 9)))
        feed(t + 4, "hz", "50" if random.random() > 0.08 else "49")
        feed(t + 5, "temp", str(int(33 + (4 if ac_on else 0) + random.random() * 2)))
        feed(t + 6, "energy", f"{energy:.3f}")
        if abs(t - trip_at) < 60 and t >= trip_at:
            feed(t + 10, "relay", "off")
            feed(t + 1500, "relay", "on")
            t += 1500
    elif avail and tr.relay == "off":
        feed(t, "voltage", "232.0")
    t += 60
tr.advance(now, live=False)
tr.save()
m.db.execute("INSERT INTO prepaid(ts, kind, amount, note) VALUES(?, 'sync', 820, NULL)", (now - 9 * 86400,))
m.db.execute("INSERT INTO prepaid(ts, kind, amount, note) VALUES(?, 'recharge', 1000, NULL)", (now - 4 * 86400,))
m.db.execute("INSERT INTO alerts(key, ts, kind, text, channels) VALUES('demo1', ?, 'trip', ?, 'alexa,phone,whatsapp')",
             (trip_at, "Breaker switched OFF. Over-voltage protection: Voltage reached 272 V (limit 270 V)."))
for i, (name, w) in enumerate((("Air conditioner", 3300), (None, 900), ("Water pump", 450))):
    m.db.execute("UPDATE appliances SET name=? WHERE id=(SELECT id FROM appliances ORDER BY ABS(watts - ?) LIMIT 1)", (name, w))
print("Demo data in", m.DB_PATH)
m.main()
