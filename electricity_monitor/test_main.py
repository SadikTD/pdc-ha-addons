"""Checks the tariff maths, cut/Wi-Fi/trip decisions and the tracker end to end.
Run: python electricity_monitor/test_main.py"""

import io
import os
import sys
import tempfile
import time

os.environ["EMON_DATA_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
import logic  # noqa: E402
import main as m  # noqa: E402

near = lambda a, b, tol=0.01: abs(a - b) <= tol

# ------------------------------------------------------------ tariff
slabs = logic.parse_slabs(m.OPTS["tariff_slabs"])
assert slabs[0] == (75, 5.26) and slabs[-1] == (None, 17.35)
cost, rows = logic.energy_cost(396, slabs, 50, 4.63)
assert near(cost, 75 * 5.26 + 125 * 8.5 + 100 * 9.10 + 96 * 9.62), cost
assert near(logic.energy_cost(50, slabs, 50, 4.63)[0], 50 * 4.63)      # lifeline
assert near(logic.energy_cost(51, slabs, 50, 4.63)[0], 51 * 5.26)      # one unit more loses it
assert near(logic.energy_cost(700, slabs)[0], 75 * 5.26 + 125 * 8.5 + 100 * 9.1 + 100 * 9.62 + 200 * 15.01 + 100 * 17.35)
assert logic.slab_position(396, slabs) == (9.62, 400, 15.01)
assert logic.slab_position(650, slabs) == (17.35, None, None)
cfg = m.bill_cfg()
assert cfg["sanctioned_load_kw"] == 4
# The real BREB token SMS: 3000 Tk on 5 Oct (first of the month), 3000 on 21 Oct, 2000 on 13 Aug.
r = logic.recharge_breakdown(3000, True, cfg)
assert near(r["vat"], 142.86) and r["demand"] == 168 and r["meter_rent"] == 40 and near(r["rebate"], 14.02) and near(r["energy"], 2663.16)
r = logic.recharge_breakdown(3000, False, cfg)
assert near(r["vat"], 142.86) and r["demand"] == 0 and near(r["rebate"], 14.21) and near(r["energy"], 2871.35, 0.011)
assert near(logic.recharge_breakdown(2000, True, cfg)["energy"], 1706.04)
assert near(logic.recharge_for(2663.16, True, cfg), 3000) and near(logic.recharge_for(2871.355, False, cfg), 3000)
b = logic.month_bill(396, cfg)
assert near(b["total"], logic.recharge_for(cost, True, cfg)) and near(b["energy"] + b["demand"] + b["meter_rent"] + b["vat"] - b["rebate"], b["total"])
assert near(logic.usage_cost(396, 404, cfg), 4 * 9.62 + 4 * 15.01)   # the meter spends plain slab rates
sms = """BREB Token Purchase Successful.
Meter No: 40610705060
Sequence: 19
Energy Cost: 2871.35 Tk
Meter Rent: 0 Tk
Demand Charge: 0 Tk
VAT: 142.86 Tk
Rebate: -14.21 Tk
Arrear Amount: 0 Tk
Vending Amount: 3000.0 Tk
Token(s):
4677-8591-1208-6465-3212
Trx ID: 01M5ED8J3M
Bill payment of Tk.3000.00 to Palli Bidyut Prepaid is successful, Meter Number: 40610705060. Token 4677-8591-1208-6465-3212. Charge-0.00. Balance Tk.2000.00. TrxID 01M5ED8J3M at 21/10/2026 10:59"""
p = logic.parse_token_sms(sms)
assert p["amount"] == 3000 and p["energy"] == 2871.35 and p["rebate"] == 14.21 and p["demand"] == 0
assert p["token"] == "4677-8591-1208-6465-3212" and p["sequence"] == 19 and p["when"] == [2026, 10, 21, 10, 59]
p = logic.parse_token_sms(sms.split("Bill payment")[0])          # the token SMS alone
assert p["energy"] == 2871.35 and "when" not in p
p = logic.parse_token_sms("Bill payment" + sms.split("Bill payment")[1])  # the payment SMS alone
assert p["amount"] == 3000 and "energy" not in p and p["token"]
assert logic.parse_token_sms("hello") == {}

# ------------------------------------------------------ cut or Wi-Fi
assert logic.classify_gap(1800, 0.0, 800, 90) == "outage"
assert logic.classify_gap(1800, -0.002, 800, 90) == "outage"          # a few Wh lost at the cut
assert logic.classify_gap(200, 0.040, 800, 90) == "wifi_drop"         # kept metering: had power
assert logic.classify_gap(40, None, 800, 90) == "blip"                # the daily 04:01 drop
assert logic.classify_gap(300, 0.0, 30, 90) == "outage"               # too light a load to tell: duration decides
assert logic.gap_estimate(3600, 0.4, 800) == 1800                     # half the expected energy missing
assert logic.gap_estimate(3600, 0.8, 800) == 0.0
assert logic.gap_estimate(3600, 0.0, 10) is None

# ------------------------------------------------------ trip reasons
lim = {"low_v": 180, "over_v": 270, "over_a": 0, "over_kw": 0, "over_t": 50, "over_kwh": 0}
w = lambda **k: [{"v": 230, "a": 5, "w": 1000, "t": 35, **k}]
assert logic.infer_off_reason(w(v=272), lim)[:2] == ("over_voltage", "certain")
assert logic.infer_off_reason(w(v=268.5), lim)[:2] == ("over_voltage", "likely")
assert logic.infer_off_reason(w(v=181), lim)[0] == "under_voltage"
assert logic.infer_off_reason(w(t=51), lim)[0] == "over_temperature"
assert logic.infer_off_reason(w(a=40), {**lim, "over_a": 32})[0] == "over_current"
assert logic.infer_off_reason(w(a=40), lim)[0] == "outside_ha"        # over-current off: not a candidate
assert logic.infer_off_reason(w(), lim, {"user_id": "u1", "user_name": "Sadik"})[:2] == ("ha_user", "certain")
assert logic.infer_off_reason(w(), lim, {"parent_id": "x"})[0] == "automation"
assert logic.infer_off_reason(w(), lim, timer_ended=True)[0] == "timer"
assert logic.infer_off_reason(w(), lim, fault_code=1 << 10)[:2] == ("over_voltage", "certain")
assert logic.fault_causes(0b101) == ["short_circuit", "over_load"]

# ------------------------------------------------------ appliances
d = logic.StepDetector(min_w=300, hold_s=20)
runs, t = [], 0
for w_ in [200] * 12 + [3500] * 60 + [200] * 12:
    runs += d.feed(t, w_)
    t += 5
assert len(runs) == 1 and near(runs[0][2], 3300, 1) and near(runs[0][1] - runs[0][0], 300, 6), runs
assert logic.match_appliance(3200, [{"id": 1, "watts": 3300}, {"id": 2, "watts": 1200}]) == 1
assert logic.match_appliance(2000, [{"id": 1, "watts": 3300}]) is None

# ------------------------------------------------------ outage odds
day0 = 1_790_000_000 - 1_790_000_000 % 86400
days = [day0 + i * 86400 for i in range(4)]
outs = [(day0 + 10 * 3600 + 600, day0 + 10 * 3600 + 3000), (day0 + 86400 + 10 * 3600, day0 + 86400 + 11 * 3600)]
odds = logic.hourly_odds(outs, 4, days)
assert odds[10] == 0.5 and odds[11] == 0 and odds[3] == 0
assert logic.next_likely(odds, 8, 0.3) == (2, 10, 0.5)

# ------------------------------------------------------ websocket codec
payload = b'{"type":"ping"}' * 20
frame = logic.ws_frame(payload, mask=b"\x01\x02\x03\x04")
assert logic.ws_read_frame(io.BytesIO(frame).read) == (True, 1, payload)
big = b"x" * 70000
assert logic.ws_read_frame(io.BytesIO(logic.ws_frame(big)).read)[2] == big

# ------------------------------------------------------ tracker, end to end
m.db = m.DB(":memory:")
m.tracker = tr = m.Tracker()
tr.ha_connected = tr.caught_up = True
E = m.ENT
now = time.time() - 300  # recent enough for alerts to count as fresh


def feed(t, key, state, ctx=None, attrs=None):
    with tr.lock:
        tr.handle(now + t, E[key], state, attrs, ctx, live=True)


def tick(t):
    with tr.lock:
        tr.advance(now + t)


def alerts():
    return [r["key"].split(":")[0] for r in m.db.query("SELECT key FROM alerts ORDER BY id")]


def kinds():
    return [(r["kind"], r["cause"]) for r in m.db.query("SELECT kind, cause FROM events ORDER BY id")]


for k, v in (("low_v", "180"), ("over_v", "270"), ("over_a", "0"), ("over_kw", "0"), ("over_t", "50")):
    feed(0, k, v)
feed(0, "relay", "on")
feed(1, "energy", "100.000")
for i in range(0, 600, 10):
    feed(2 + i, "voltage", "230")
    feed(3 + i, "power", "800")
feed(600, "energy", "100.133")
assert near(m.db.scalar("SELECT SUM(kwh) FROM energy_hourly"), 0.133, 1e-6)

# 1. Load shedding: the breaker goes silent, its counter frozen.
feed(700, "relay", "unavailable")
tick(760)
assert tr.outage_id is None                    # not yet: could be the 04:01 Wi-Fi drop
tick(800)
assert tr.outage_id and alerts() == ["cut"]
feed(2500, "relay", "on")
feed(2502, "energy", "100.131")                # a couple of Wh lost when the power died
assert kinds() == [("outage", None)] and alerts() == ["cut", "back"]
ev = m.db.one("SELECT * FROM events WHERE kind='outage'")
assert near(ev["end"] - ev["start"], 1800, 0.01)

# 2. Wi-Fi drop: silent for 3 minutes but it kept metering.
for i in range(0, 600, 10):
    feed(2600 + i, "power", "800")
feed(3300, "relay", "unavailable")
tick(3400)
feed(3480, "relay", "on")
feed(3481, "energy", "100.171")
assert kinds()[-1] == ("wifi", "wifi") and alerts()[-1] == "wifi"   # the false alarm is corrected

# 3. Over-voltage trip, nobody in HA touched it.
feed(3600, "voltage", "271.5")
feed(3602, "relay", "off")
tick(3615)
assert kinds()[-1] == ("off", "over_voltage") and alerts()[-1] == "trip"
assert m.live_state()[0] == "trip"
feed(3700, "relay", "on")                      # turned on from the Smart Life app
assert alerts()[-1] == "on"
assert "outside Home Assistant" in m.get_event(m.db.scalar("SELECT MAX(id) FROM events WHERE kind='off'"))["data"]["restored_by"]

# 4. Power cut, and the breaker stays off when the power returns (27 Oct).
feed(3800, "voltage", "230")
feed(4000, "relay", "unavailable")
tick(4200)
feed(6500, "relay", "off")
feed(6501, "voltage", "253.8")
feed(6502, "energy", "100.171")
assert kinds()[-2:] == [("outage", None), ("off", "stayed_off")] and alerts()[-2:] == ["back", "stayed"]
assert m.live_state()[0] == "trip"
tick(6500 + 601)
with tr.lock:
    tr._repeats(now + 6500 + 601)
assert alerts()[-1] == "repeat"
feed(7000, "relay", "on")

# 5. Switched off by a person in Home Assistant: recorded, no alarm.
n = len(alerts())
feed(7100, "relay", "off", ctx={"user_id": "abc"})
tick(7110)
assert kinds()[-1] == ("off", "ha_user") and len(alerts()) == n
feed(7200, "relay", "on", ctx={"user_id": "abc"})
assert len(alerts()) == n

# 6. HA restarting: its own short "unavailable" isn't a power cut or a Wi-Fi drop.
n = len(kinds())
tr.artifact = (now + 7300, now + 7500)
feed(7400, "relay", "unavailable")
feed(7430, "relay", "on")
feed(7431, "energy", "100.171")
assert len(kinds()) == n

# 7. Restart in the middle of a power cut: the open outage carries over.
feed(8000, "relay", "unavailable")
tick(8200)
tr.save()
tr2 = m.Tracker()
assert tr2.outage_id == tr.outage_id and tr2.avail is False and tr2.unavail_since == now + 8000

# Prepaid: balance = last check + energy credited since - what the meter spent since.
real_now = time.time()
m.db.execute("DELETE FROM energy_hourly")
m.db.execute("INSERT INTO energy_hourly(hour, kwh, source) VALUES(?, 2.0, 'test')", (int(real_now // 3600 * 3600 - 3600),))
m.db.execute("INSERT INTO prepaid(ts, kind, amount) VALUES(?, 'sync', 500)", (real_now - 3 * 3600,))
assert m.prepaid_post("/api/prepaid/recharge", {"sms": sms, "ts": real_now - 2 * 3600})[0] == 200
assert m.prepaid_post("/api/prepaid/recharge", {"sms": sms})[0] == 409            # same token twice
p = m.prepaid_status()
spent = m.ecost(2.0)
assert p["configured"] and near(p["balance"], 500 + 2871.35 - spent), (p["balance"], spent)
rc = m.recharges()
assert rc[0]["breakdown"]["source"] == "sms" and rc[0]["breakdown"]["energy"] == 2871.35
c = m.recharge_calc(1000)
assert c["energy"] < 1000 and c["units"] > 0

# Usage buckets and statements.
u = m.usage(real_now - 86400, real_now, "auto")
assert u["period"] == "hour" and near(u["total"], 2.0) and len(u["buckets"]) >= 24
assert near(u["cost"], spent * m.cash())
lt = time.localtime(real_now)
bp = m.bill_payload(lt.tm_year, lt.tm_mon)
assert near(bp["units"], 2.0) and bp["current"] and bp["recharges"] and bp["coverage"] is not None
assert m.months_list()[0]["month"] == time.strftime("%Y-%m", lt)

print("all electricity monitor checks passed")
