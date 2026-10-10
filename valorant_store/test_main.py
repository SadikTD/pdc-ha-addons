"""Self-check for the parts that decide what gets alerted. Run: python test_main.py"""
import os
import sys
import tempfile

os.environ["VALSTORE_DATA_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
import main  # noqa: E402

KNIFE, KNIFE_LVL = main.REAVER_BUTTERFLY_KNIFE, "f3ca2221-4c3a-75bc-8526-a1a0ff38493b"
VANDAL, VANDAL_LVL = "30388628-42f0-606c-82c0-73ad43de997f", "ba42fe63-457a-78ce-4499-47950a698129"
main.catalog.data = {
    "items": {KNIFE: {"u": KNIFE, "n": "Reaver Butterfly Knife", "i": "k.png", "k": "skin", "t": "ex"},
              VANDAL: {"u": VANDAL, "n": "Reaver Vandal", "i": "v.png", "k": "skin", "t": "pr"}},
    "levels": {KNIFE_LVL: KNIFE, VANDAL_LVL: VANDAL}, "bundles": {}, "tiers": {}}


def test_cookie_input():
    assert main.parse_cookie_input("  eyJabc  ") == {"ssid": "eyJabc"}
    assert main.parse_cookie_input("ssid=eyJabc") == {"ssid": "eyJabc"}
    assert main.parse_cookie_input("Cookie: tdid=1; ssid=eyJ=x; clid=ec1") == {"tdid": "1", "ssid": "eyJ=x", "clid": "ec1"}
    assert main.parse_cookie_input("") == {}


def test_store_day():
    # 00:00 UTC Oct 11 reset (give or take a few seconds) => the Oct 10 store
    assert main.store_day(1791676800) == "2026-10-10"
    assert main.store_day(1791676800 - 5) == "2026-10-10"
    assert main.store_day(1791676800 + 5) == "2026-10-10"


def test_resolve_and_hits():
    now = 1791676800 - 3600
    store = {
        "SkinsPanelLayout": {"SingleItemOffers": [VANDAL_LVL, KNIFE_LVL],
                             "SingleItemStoreOffers": [{"OfferID": VANDAL_LVL, "Cost": {main.VP: 2175}},
                                                       {"OfferID": KNIFE_LVL, "Cost": {main.VP: 5350}}],
                             "SingleItemOffersRemainingDurationInSeconds": 3600},
        "BonusStore": {"BonusStoreRemainingDurationInSeconds": 86400, "BonusStoreOffers": [
            {"Offer": {"OfferID": VANDAL_LVL, "Cost": {main.VP: 2175}}, "DiscountPercent": 30,
             "DiscountCosts": {main.VP: 1522}, "IsSeen": False}]},
    }
    snap = main.resolve(store, {"Balances": {main.VP: 120}}, now)
    assert snap["day"] == "2026-10-10"
    assert [o["name"] for o in snap["offers"]] == ["Reaver Vandal", "Reaver Butterfly Knife"]
    assert snap["offers"][1]["cost"] == 5350 and snap["wallet"]["vp"] == 120
    assert snap["night"]["offers"][0]["percent"] == 30
    hits = main.wishlist_hits(snap, [KNIFE])
    assert [(p, o["skin"]) for p, o in hits] == [("store", KNIFE)]
    assert [p for p, _ in main.wishlist_hits(snap, [VANDAL])] == ["store", "night"]
    assert main.wishlist_hits(snap, []) == []
    assert "5,350 VP" in main.alert_text("store", hits[0][1], snap)
    # next check: right after the reset when it's sooner than the regular interval
    assert main.next_check_at(snap, now) == snap["expires_at"] + 90


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
