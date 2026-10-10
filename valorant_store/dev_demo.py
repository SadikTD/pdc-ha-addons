"""Runs the dashboard locally on fake store data (real skin catalog), for UI work.
python dev_demo.py [found]  ->  http://localhost:38766   ('found' puts the knife in today's store)"""
import os
import random
import sys
import time

os.environ.setdefault("VALSTORE_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".demo-data"))
os.environ["VALSTORE_DEV"] = "1"
os.makedirs(os.environ["VALSTORE_DATA_DIR"], exist_ok=True)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "app"))
import main  # noqa: E402

random.seed(7)
main.db = main.DB(main.DB_PATH)
main.catalog.ensure()
items = main.catalog.data["items"]
skins = [i for i in items.values() if i["k"] == "skin" and i["i"] and "Standard" not in i["n"] and i["n"] != "Melee"]
price = {"12683d76-48d7-84a3-4e09-6985794f0445": 875, "0cebb8be-46d7-c12a-d306-e9907bfc5a25": 1275,
         "60bca009-4182-7998-dee7-b8a2558dc369": 1775, "e046854e-406c-37f4-6607-19a9ba8426fc": 2175,
         "411e4a55-4e59-7757-41f0-86a53f101bb5": 2475}
knife = items[main.REAVER_BUTTERFLY_KNIFE]
reset = (int(time.time()) // 86400 + 1) * 86400


def offer(s, **kw):
    return {"skin": s["u"], "name": s["n"], "icon": s["i"], "tier": s.get("t"), "video": False,
            "cost": price.get(s.get("t"), 1775) if "Knife" not in s["n"] else 5350, **kw}


main.db.x("DELETE FROM snapshots")
for back in range(45, -1, -1):
    picks = random.sample(skins, 4)
    if back in (31,) or (back == 0 and "found" in sys.argv):
        picks[2] = knife
    snap = {"day": main.store_day(reset - back * 86400), "fetched_at": reset - back * 86400 - 80000,
            "expires_at": reset - back * 86400, "offers": [offer(s) for s in picks], "bundles": [], "night": None,
            "wallet": {"vp": 1240, "rad": 30, "kc": 5650}}
    if back == 0:
        bundle_uuid, meta = next((u, b) for u, b in main.catalog.data["bundles"].items() if b["n"] == "Reaver")
        reaver = [s for s in skins if s["n"].startswith("Reaver ") and s["n"] != "Reaver Knife"][:6]
        snap["bundles"] = [{"uuid": bundle_uuid, "name": "Reaver", "icon": meta["i"], "price": 8720, "base": 10900,
                            "expires_at": reset + 5 * 86400,
                            "items": [{"name": s["n"], "icon": s["i"], "kind": "skin", "tier": s.get("t"), "skin": s["u"],
                                       "amount": 1, "price": offer(s)["cost"], "base": offer(s)["cost"]} for s in reaver]}]
        snap["night"] = {"expires_at": reset + 9 * 86400, "offers": [
            offer(s, was=offer(s)["cost"], percent=p, cost=round(offer(s)["cost"] * (100 - p) / 100), seen=True)
            for s, p in zip(random.sample(skins, 6), (14, 22, 31, 18, 40, 27))]}
    main.save_snapshot(snap)

main.AUTH.update(cookies={"ssid": "demo"}, puuid="demo", name="Sadik#AP1", region="ap", state="ok",
                 saved_at=time.time() - 86400 * 3, refreshed_at=time.time() - 1800)
main.STATUS.update(last_ok=time.time() - 1800, next_check=reset + 90)
main.event("signed_in", "Signed in with a new session cookie")
main.OWNED.update(at=time.time() - 1800, levels=[lv for lv, sk in list(main.catalog.data["levels"].items())[::40]][:60]
                 + [next(lv for lv, sk in main.catalog.data["levels"].items()
                         if sk == snap["offers"][0]["skin"])])  # includes one of today's skins
main.write_json = lambda *a: None
main.checker_loop = lambda: None  # no Riot calls in the demo
main.save_auth = lambda: None
main.main()
