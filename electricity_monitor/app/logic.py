"""Pure logic for Electricity Monitor: tariff and prepaid maths, telling power cuts from
Wi-Fi drops, guessing why the breaker switched off, appliance steps, outage odds, and a
tiny WebSocket frame codec. No I/O here, so test_logic.py can check all of it."""

import os
import re
import struct

# ------------------------------------------------------------------- tariff

SLAB_RE = r"^\d{1,5}:\d{1,3}(\.\d{1,3})?$"


def parse_slabs(specs):
    """["75:5.26", "200:8.50", ..., "0:17.35"] -> [(75, 5.26), (200, 8.5), ..., (None, 17.35)].
    "0:rate" is the rate for everything above the last limit."""
    slabs, top = [], None
    for spec in specs:
        upto, rate = spec.split(":")
        upto, rate = int(upto), float(rate)
        if upto == 0:
            top = rate
        else:
            slabs.append((upto, rate))
    slabs.sort()
    slabs.append((None, top if top is not None else (slabs[-1][1] if slabs else 0)))
    return slabs


def energy_cost(units, slabs, lifeline_units=0, lifeline_rate=0):
    """Energy charge (before VAT) for a month's units, stepped: each unit pays its own
    slab's rate. Lifeline: at or under lifeline_units, every unit pays lifeline_rate.
    Returns (cost, [(label, units, rate, cost), ...])."""
    units = max(0.0, units)
    if lifeline_units and units <= lifeline_units:
        return units * lifeline_rate, [(f"Lifeline (up to {lifeline_units})", units, lifeline_rate, units * lifeline_rate)]
    total, rows, prev = 0.0, [], 0
    for upto, rate in slabs:
        if units <= prev:
            break
        take = (min(units, upto) if upto else units) - prev
        label = f"{prev + 1}-{upto}" if upto else f"{prev + 1}+"
        rows.append((label, take, rate, take * rate))
        total += take * rate
        prev = upto or units
    return total, rows


def slab_position(units, slabs, lifeline_units=0, lifeline_rate=0):
    """(current rate, next limit or None, rate after that limit)."""
    if lifeline_units and units < lifeline_units:
        return lifeline_rate, lifeline_units, slabs[0][1]
    for i, (upto, rate) in enumerate(slabs):
        if upto is None or units < upto:
            nxt = slabs[i + 1][1] if upto is not None and i + 1 < len(slabs) else None
            return rate, upto, nxt
    return slabs[-1][1], None, None


# How a BREB prepaid recharge splits (checked against real token SMS): VAT is 5 % *inside*
# the amount paid; meter rent and the demand charge come off the month's first recharge;
# the 0.5 % rebate is worked out on (amount - VAT - rent); what's left is energy credit,
# which the meter then spends at the plain slab rates (no VAT on top).
#   3000 Tk, first of the month: VAT 142.86, rent 40, demand 168, rebate 14.02 -> 2663.16
#   3000 Tk, later that month:   VAT 142.86,                     rebate 14.21 -> 2871.35

def _fixed(cfg):
    return cfg["sanctioned_load_kw"] * cfg["demand_charge_per_kw"], cfg["meter_rent"]


def recharge_breakdown(amount, first_of_month, cfg):
    """What a recharge of `amount` puts on the meter, line by line, like the token SMS."""
    vat = amount * cfg["vat_percent"] / (100 + cfg["vat_percent"])
    demand, rent = _fixed(cfg) if first_of_month else (0.0, 0.0)
    r = cfg["prepaid_rebate_percent"]
    rebate = (amount - vat - rent) * r / (100 + r)
    return {"amount": amount, "vat": vat, "meter_rent": rent, "demand": demand, "rebate": rebate,
            "energy": amount - vat - rent - demand + rebate}


def recharge_for(energy, first_of_month, cfg):
    """The recharge amount that buys `energy` taka of credit (inverse of recharge_breakdown)."""
    demand, rent = _fixed(cfg) if first_of_month else (0.0, 0.0)
    r = cfg["prepaid_rebate_percent"] / (100 + cfg["prepaid_rebate_percent"])
    k = 100 / (100 + cfg["vat_percent"])
    return ((energy + demand) / (1 + r) + rent) / k


def cash_factor(cfg):
    """Taka you pay per taka of energy the meter spends (VAT in, rebate back): ~1.045."""
    return recharge_for(1.0, False, cfg)


def month_bill(units, cfg):
    """A month's real cost: the recharge needed for its energy plus the month's fixed
    charges, split into the SMS lines. cfg keys as in the add-on options."""
    slabs = parse_slabs(cfg["tariff_slabs"])
    energy, rows = energy_cost(units, slabs, cfg["lifeline_units"], cfg["lifeline_rate"])
    total = recharge_for(energy, True, cfg)
    b = recharge_breakdown(total, True, cfg)
    return {"units": units, "energy": energy, "rows": rows, "demand": b["demand"], "meter_rent": b["meter_rent"],
            "vat": b["vat"], "rebate": b["rebate"], "total": total}


def usage_cost(units_before, units_after, cfg):
    """What the meter takes off the prepaid balance for the units used between two points of
    the same month: plain slab rates, VAT and rebate were settled at the recharge."""
    slabs = parse_slabs(cfg["tariff_slabs"])
    a = energy_cost(units_before, slabs, cfg["lifeline_units"], cfg["lifeline_rate"])[0]
    b = energy_cost(units_after, slabs, cfg["lifeline_units"], cfg["lifeline_rate"])[0]
    return b - a


def parse_token_sms(text):
    """Fields from BREB / Palli Bidyut recharge SMS (one or both messages pasted).
    Returns {} if it doesn't look like one."""
    def money(label):
        m = re.search(label + r"\s*:?\s*(?:Tk\.?\s*)?(-?[\d,]+(?:\.\d+)?)", text, re.I)
        return abs(float(m.group(1).replace(",", ""))) if m else None

    out = {"amount": money(r"Vending Amount") or money(r"Bill payment of Tk\.?"),
           "energy": money(r"Energy Cost"), "meter_rent": money(r"Meter Rent"), "demand": money(r"Demand Charge"),
           "vat": money(r"VAT"), "rebate": money(r"Rebate"), "arrear": money(r"Arrear Amount")}
    m = re.search(r"Sequence\s*:?\s*(\d+)", text, re.I)
    out["sequence"] = int(m.group(1)) if m else None
    m = re.search(r"Token(?:\(s\))?\s*:?\s*((?:\d{4}-){4}\d{4})", text, re.I)
    out["token"] = m.group(1) if m else None
    m = re.search(r"Meter (?:No|Number)\s*:?\s*(\d{6,})", text, re.I)
    out["meter"] = m.group(1) if m else None
    m = re.search(r"Trx\s*ID\s*:?\s*([A-Z0-9]+)", text, re.I)
    out["trx"] = m.group(1) if m else None
    m = re.search(r"at\s+(\d{2})/(\d{2})/(\d{4})\s+(\d{1,2}):(\d{2})", text)
    out["when"] = [int(m.group(i)) for i in (3, 2, 1, 4, 5)] if m else None  # y, m, d, H, M (local)
    if out["amount"] is None or (out["energy"] is None and out["token"] is None):
        return {}
    return {k: v for k, v in out.items() if v is not None}


# ---------------------------------------------------------- power cut or Wi-Fi

def classify_gap(duration_s, kwh_delta, avg_w_before, min_outage_s):
    """The breaker stopped reporting for duration_s. It meters on its own, so if its
    energy counter moved by about what the load would have used, it had power and only
    lost Wi-Fi. A frozen counter (or one a few Wh back: unsaved readings lost when power
    dies) means a power cut. Returns "wifi_drop", "blip" (too short to call) or "outage"."""
    expected = max(0.0, avg_w_before) / 1000 * duration_s / 3600
    if kwh_delta is not None and expected >= 0.004 and kwh_delta >= max(0.003, 0.3 * expected):
        return "wifi_drop"
    if duration_s < min_outage_s:
        return "blip"
    return "outage"


def gap_estimate(duration_s, kwh_delta, avg_w_before):
    """While Home Assistant was offline: how many minutes the power was probably out,
    from the energy the counter didn't record. None if it can't tell (light load)."""
    expected = max(0.0, avg_w_before) / 1000 * duration_s / 3600
    if expected < 0.02 or kwh_delta is None:
        return None
    missing = max(0.0, min(1.0, 1 - max(0.0, kwh_delta) / expected))
    return duration_s * missing if missing >= 0.15 else 0.0


# ---------------------------------------------------- why did the breaker trip?

FAULT_BITS = {  # Tuya breaker fault bitfield (DP10), bit -> cause
    0: "short_circuit", 1: "surge", 2: "over_load", 3: "leakage", 4: "over_temperature",
    5: "fire", 6: "high_power", 7: "self_test", 8: "over_current", 9: "unbalance",
    10: "over_voltage", 11: "under_voltage", 12: "phase_loss", 13: "outage", 14: "magnetism",
    15: "credit", 16: "no_balance",
}

CAUSE_TEXT = {
    "over_voltage": "Over-voltage protection",
    "under_voltage": "Low-voltage protection",
    "over_current": "Over-current protection",
    "over_power": "Over-power protection",
    "over_temperature": "Over-temperature protection",
    "over_energy": "Energy limit reached",
    "short_circuit": "Short circuit protection",
    "surge": "Surge protection",
    "over_load": "Overload protection",
    "leakage": "Leakage (earth fault) protection",
    "high_power": "Over-power protection",
    "timer": "The breaker's timer or schedule",
    "ha_user": "Switched off in Home Assistant",
    "automation": "Switched off by a Home Assistant automation",
    "addon": "Switched off from this dashboard",
    "outside_ha": "Switched off outside Home Assistant",
    "stayed_off": "Stayed off when the power came back",
    "unknown": "Unknown reason",
}


def fault_causes(code):
    """DP10 value (int bitfield) -> list of causes."""
    try:
        code = int(code)
    except (TypeError, ValueError):
        return []
    return [name for bit, name in FAULT_BITS.items() if code >> bit & 1]


def infer_off_reason(window, limits, context=None, fault_code=None, timer_ended=False):
    """Why the relay switched off. window: readings around the moment (dicts with v, a, w,
    t; None where unknown), limits: the breaker's protection settings (0 = off).
    Returns (cause, confidence: certain|likely|guess, detail)."""
    context = context or {}
    if fault_code:
        causes = fault_causes(fault_code)
        if causes:
            return causes[0], "certain", "The breaker reported a fault: " + ", ".join(CAUSE_TEXT.get(c, c) for c in causes)
    if context.get("addon"):
        return "addon", "certain", "You switched it off from Electricity Monitor"
    if context.get("user_id"):
        return "ha_user", "certain", f"Switched off by {context.get('user_name') or 'a Home Assistant user'}"
    if context.get("parent_id"):
        return "automation", "certain", "Switched off by an automation or script"

    def peak(key, fn):
        vals = [r[key] for r in window if r.get(key) is not None]
        return fn(vals) if vals else None

    v_hi, v_lo = peak("v", max), peak("v", min)
    a_hi, w_hi, t_hi = peak("a", max), peak("w", max), peak("t", max)
    hits = []
    if limits.get("over_v") and v_hi is not None and v_hi >= limits["over_v"] - 3:
        hits.append(("over_voltage", v_hi - limits["over_v"], f"voltage reached {v_hi:.0f} V (limit {limits['over_v']:.0f} V)"))
    if limits.get("low_v") and v_lo is not None and 0 < v_lo <= limits["low_v"] + 3:
        hits.append(("under_voltage", limits["low_v"] - v_lo, f"voltage fell to {v_lo:.0f} V (limit {limits['low_v']:.0f} V)"))
    if limits.get("over_a") and a_hi is not None and a_hi >= limits["over_a"] * 0.9:
        hits.append(("over_current", (a_hi - limits["over_a"]) / limits["over_a"] * 50, f"current reached {a_hi:.1f} A (limit {limits['over_a']:.1f} A)"))
    if limits.get("over_kw") and w_hi is not None and w_hi >= limits["over_kw"] * 1000 * 0.9:
        hits.append(("over_power", (w_hi / 1000 - limits["over_kw"]) / limits["over_kw"] * 50, f"power reached {w_hi / 1000:.2f} kW (limit {limits['over_kw']:.2f} kW)"))
    if limits.get("over_t") and t_hi is not None and t_hi >= limits["over_t"] - 2:
        hits.append(("over_temperature", t_hi - limits["over_t"], f"breaker temperature reached {t_hi:.0f} °C (limit {limits['over_t']:.0f} °C)"))
    if limits.get("over_kwh") and limits.get("kwh") is not None and limits["kwh"] >= limits["over_kwh"]:
        hits.append(("over_energy", 0, f"energy {limits['kwh']:.1f} kWh passed the {limits['over_kwh']:.1f} kWh limit"))
    if hits:
        cause, margin, detail = max(hits, key=lambda h: h[1])
        return cause, "certain" if margin >= 0 else "likely", detail[0].upper() + detail[1:]
    if timer_ended:
        return "timer", "likely", "The breaker's countdown timer or schedule ran out"
    return "outside_ha", "guess", ("No protection limit was near, so it was most likely switched off in the "
                                   "Smart Life app or at the breaker itself")


# ------------------------------------------------------------- appliances

class StepDetector:
    """Spots appliances switching on and off as steps in the total power.
    ponytail: naive step matching (one step = one appliance); real NILM would separate
    overlapping or variable loads (inverter ACs ramp, so their size is approximate)."""

    def __init__(self, min_w=300, hold_s=20, tol=0.35):
        self.min_w, self.hold_s, self.tol = min_w, hold_s, tol
        self.level = None          # last stable power
        self.cand = None           # (since_ts, values) of a possible new level
        self.open = []             # [start_ts, watts]

    def feed(self, ts, w):
        """Returns finished runs [(start, end, watts)]; feed(ts, None) = power lost."""
        if w is None:
            done = [(s, ts, size) for s, size in self.open]
            self.open, self.level, self.cand = [], None, None
            return done
        if self.level is None:
            self.level = w
            return []
        if abs(w - self.level) < max(60, 0.06 * self.level):
            self.cand = None
            return []
        if self.cand is None or abs(w - self.cand[1][-1]) > max(60, 0.06 * w):
            self.cand = (ts, [w])
            return []
        self.cand[1].append(w)
        if ts - self.cand[0] < self.hold_s:
            return []
        since, vals = self.cand
        new = sum(vals) / len(vals)
        delta, self.level, self.cand = new - self.level, new, None
        if delta >= self.min_w:
            self.open.append([since, delta])
            return []
        done = []
        if -delta >= self.min_w * 0.6 and self.open:
            best = min(self.open, key=lambda r: abs(r[1] + delta))
            if abs(best[1] + delta) <= self.tol * best[1]:
                self.open.remove(best)
                done.append((best[0], since, best[1]))
        if new < self.min_w * 0.8:  # back near the base load: everything big is off
            done += [(s, since, size) for s, size in self.open]
            self.open = []
        return done


def match_appliance(watts, appliances, tol=0.18):
    """appliances: [{id, watts}] -> id of the closest within tol, or None."""
    best = min(appliances, key=lambda a: abs(a["watts"] - watts), default=None)
    return best["id"] if best and abs(best["watts"] - watts) <= tol * best["watts"] else None


# --------------------------------------------------------------- outage odds

def hourly_odds(outages, days, day_starts):
    """Share of the monitored days with a power cut in each hour of the day.
    outages: [(start, end)], day_starts: local-midnight timestamps of monitored days."""
    hits = [set() for _ in range(24)]
    for d in day_starts:
        for h in range(24):
            lo, hi = d + h * 3600, d + (h + 1) * 3600
            if any(s < hi and e > lo for s, e in outages):
                hits[h].add(d)
    n = max(1, days)
    return [len(x) / n for x in hits]


def next_likely(odds, now_hour, threshold=0.3):
    """(hours from now, hour of day, chance) of the next hour whose odds pass threshold."""
    for k in range(1, 25):
        h = (now_hour + k) % 24
        if odds[h] >= threshold:
            return k, h, odds[h]
    return None


# --------------------------------------------------------------- voltage

def voltage_band(v, nominal=230):
    """good within ±6 % of nominal, fair within ±10 %, else bad."""
    dev = abs(v - nominal) / nominal
    return "good" if dev <= 0.06 else "fair" if dev <= 0.10 else "bad"


def grade(good_pct, bad_pct):
    if good_pct >= 95 and bad_pct < 0.5:
        return "A"
    if good_pct >= 85 and bad_pct < 2:
        return "B"
    if good_pct >= 70 and bad_pct < 5:
        return "C"
    if good_pct >= 50:
        return "D"
    return "F"


# --------------------------------------------------------------- websocket

def ws_frame(payload, opcode=0x1, mask=None):
    """A client->server frame (always masked, as RFC 6455 requires)."""
    mask = mask if mask is not None else os.urandom(4)
    n = len(payload)
    head = bytes([0x80 | opcode])
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack(">H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", n)
    return head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


def ws_read_frame(read):
    """Reads one frame with read(n) -> bytes. Returns (fin, opcode, payload)."""
    b1, b2 = read(2)
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack(">H", read(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", read(8))[0]
    mask = read(4) if b2 & 0x80 else None
    data = read(n) if n else b""
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return bool(b1 & 0x80), b1 & 0x0F, data
