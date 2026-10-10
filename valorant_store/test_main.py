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


def test_sign_in_and_fetch():
    """The whole Riot round trip, with Riot faked: cookie -> token -> entitlements -> store."""
    from email.message import Message
    redirect = Message()
    redirect["Location"] = "https://playvalorant.com/opt_in#access_token=AT&id_token=IT&token_type=Bearer"
    redirect["Set-Cookie"] = "ssid=NEW; Path=/; Secure"
    ok = Message()
    answers = {
        "auth.riotgames.com/authorize": (303, redirect, b""),
        "entitlements": (200, ok, {"entitlements_token": "ENT"}),
        "userinfo": (200, ok, {"sub": "PUUID", "acct": {"game_name": "Sadik", "tag_line": "AP1"}}),
        "riot-geo": (200, ok, {"affinities": {"live": "ap"}}),
        "valorant-api.com/v1/version": (200, ok, {"data": {"riotClientVersion": "release-x"}}),
        "storefront": (200, ok, {"SkinsPanelLayout": {"SingleItemOffers": [KNIFE_LVL],
                                                      "SingleItemOffersRemainingDurationInSeconds": 60}}),
        "wallet": (200, ok, {"Balances": {main.VP: 5}}),
    }
    seen = []

    def fake_http(method, url, headers=None, body=None, timeout=30):
        seen.append(url)
        return next(v for k, v in answers.items() if k in url)

    main.http, main.save_auth = fake_http, lambda: None
    main.AUTH.update(cookies={"ssid": "OLD"})
    session = main.sign_in()
    assert main.AUTH["cookies"]["ssid"] == "NEW" and main.AUTH["name"] == "Sadik#AP1"
    assert session["shard"] == "ap" and session["headers"]["X-Riot-Entitlements-JWT"] == "ENT"
    store, wallet = main.fetch_store(session)
    assert any("pd.ap.a.pvp.net/store/v3/storefront/PUUID" in u for u in seen)
    assert main.wishlist_hits(main.resolve(store, wallet), [KNIFE])


def test_edge_cases():
    from email.message import Message
    # a bare ssid with base64 padding is still a bare value
    assert main.parse_cookie_input("eyJabc==") == {"ssid": "eyJabc=="}
    # a 401 from the game servers is retried, not treated as signed out
    try:
        main._check(401, None, {"errorCode": "BAD_CLAIMS"}, "Store")
        raise AssertionError("should raise")
    except main.RiotError as e:
        assert e.kind == "api"
    # Riot's sign-in page is what means signed out
    login = Message()
    login["Location"] = "https://authenticate.riotgames.com/login?client_id=x"
    main.http = lambda *a, **k: (303, login, b"")
    try:
        main.reauth({"ssid": "x"})
        raise AssertionError("should raise")
    except main.RiotError as e:
        assert e.kind == "expired"
    # scheduling around the reset
    now = 1_000_000
    assert main.next_check_at({"expires_at": now + 30}, now) == now + 120
    assert main.next_check_at({"expires_at": now}, now) == now + 600
    assert main.next_check_at(None, now) == now + 600
    # missing prices don't break messages
    snap = {"day": "2026-10-10", "expires_at": now + 3600, "wallet": {},
            "offers": [{"skin": KNIFE, "name": "Reaver Butterfly Knife", "cost": None}],
            "night": {"expires_at": now + 7200, "offers": [{"skin": KNIFE, "name": "Reaver Butterfly Knife"}]}}
    assert "price not shown" in main.alert_text("store", snap["offers"][0], snap)
    assert "price not shown" in main.alert_text("night", snap["night"]["offers"][0], snap)
    assert "Wallet" not in main.digest_text(snap)
    # a store saved before the catalog knew a skin gets its name later
    old = {"offers": [{"skin": KNIFE_LVL, "name": "Unknown item", "icon": "", "cost": 5350}], "night": None}
    filled = main._fill_names(old)["offers"][0]
    assert filled["name"] == "Reaver Butterfly Knife" and filled["skin"] == KNIFE and filled["cost"] == 5350


def test_alerts_once_per_store():
    main.db = main.DB(os.path.join(os.environ["VALSTORE_DATA_DIR"], "t.db"))
    sent, notified = [], []
    main.send_async = lambda text, key: sent.append(key)
    main.ha_notification = lambda *a: notified.append(a)
    main.SETTINGS.update(wishlist=[KNIFE], daily_digest=False, night_market_alerts=True)
    snap = {"day": "2026-10-10", "expires_at": 2e9, "wallet": {},
            "offers": [{"skin": KNIFE, "name": "Reaver Butterfly Knife", "cost": 5350}], "night": None}
    main.after_check(snap)
    main.after_check(snap)  # WhatsApp not delivered yet: try again, but notify HA only once
    assert sent == ["valstore-store-2026-10-10-" + KNIFE] * 2 and len(notified) == 1
    main.db.x("UPDATE alerts SET ok=1")
    main.after_check(snap)  # delivered: nothing more
    assert len(sent) == 2


def test_owned_skins_are_not_alerted():
    from email.message import Message
    main.db = main.DB(os.path.join(os.environ["VALSTORE_DATA_DIR"], "o.db"))
    main.http = lambda *a, **k: (200, Message(), {"Entitlements": [{"TypeID": main.SKIN_LEVEL_TYPE, "ItemID": KNIFE_LVL}]})
    main.fetch_owned({"shard": "ap", "puuid": "P", "headers": {}})
    assert main.owned_skins() == {KNIFE}
    sent = []
    main.send_async = lambda text, key: sent.append(key)
    main.ha_notification = lambda *a: None
    main.SETTINGS.update(wishlist=[KNIFE, VANDAL], daily_digest=False)
    snap = {"day": "2026-10-11", "expires_at": 2e9, "wallet": {}, "night": None,
            "offers": [{"skin": KNIFE, "name": "Reaver Butterfly Knife", "cost": 5350},
                       {"skin": VANDAL, "name": "Reaver Vandal", "cost": 1775}]}
    main.after_check(snap)
    assert sent == ["valstore-store-2026-10-11-" + VANDAL]  # the owned knife is skipped
    # a failed collection read keeps the last known one
    main.http = lambda *a, **k: (500, Message(), {})
    main.fetch_owned({"shard": "ap", "puuid": "P", "headers": {}})
    assert main.owned_skins() == {KNIFE}
    main.forget_collection()
    assert main.owned_skins() == set()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
