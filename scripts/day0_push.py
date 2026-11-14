"""Create PRIVATE paid-media-destination-continuity-monitor, set PPE, build. Never sets isPublic."""
import json, sys, pathlib
sys.path.insert(0, "/workspace/apify")
import safe_apify as s

NAME = "paid-media-destination-continuity-monitor"
root = pathlib.Path("/workspace/apify/destination-continuity-monitor")
SKIP_TOP = {"node_modules", "storage", ".git"}
files = []
for p in sorted(root.rglob("*")):
    rel = p.relative_to(root).as_posix()
    if p.is_dir() or rel.split("/")[0] in SKIP_TOP:
        continue
    if p.suffix in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".gz", ".zip"}:
        continue
    try:
        content = p.read_text()
    except UnicodeDecodeError:
        continue
    files.append({"name": rel, "format": "TEXT", "content": content})
print("files", len(files), sum(len(f["content"]) for f in files), "bytes")

ex = {
    "ads": [
        {
            "adId": "demo-example",
            "platform": "other",
            "destinationUrl": "https://example.com/",
            "expectedDomain": "example.com",
            "requiredText": ["Example Domain"],
            "label": "landing-ok",
        },
        {
            "adId": "demo-dawn",
            "platform": "other",
            "destinationUrl": "https://theme-dawn-demo.myshopify.com/products/thelma-sandal",
            "expectedDomain": "theme-dawn-demo.myshopify.com",
            "shopifyProductUrl": "https://theme-dawn-demo.myshopify.com/products/thelma-sandal",
            "variantId": "39576998346841",
            "label": "dawn-demo-variant",
        },
    ],
    "maxAds": 5,
    "maxUniqueUrls": 5,
    "maxRequests": 20,
    "maxShopifyProducts": 1,
    "timeoutSeconds": 90,
}

ev = {
    "destination-resolved": {
        "eventTitle": "Destination resolved",
        "eventDescription": "One charge when a unique destination URL is fully classified (ok/broken/assertion/domain mismatch). Not charged for blocked, unknown, timeout, or budget exhaustion. All linked ad IDs are included.",
        "eventPriceUsd": 0.004,
        "isPrimaryEvent": True,
    },
    "shopify-product-check": {
        "eventTitle": "Shopify product check",
        "eventDescription": "One charge after a successful Ajax product document classification for a watched product. Not charged when blocked, unknown, or unavailable field missing.",
        "eventPriceUsd": 0.005,
        "isPrimaryEvent": False,
    },
}

actor_meta = json.loads((root / ".actor/actor.json").read_text())
body = {
    "name": NAME,
    "title": actor_meta["title"],
    "description": actor_meta["description"][:400],
    "isPublic": False,
    "versions": [{"versionNumber": "0.1", "sourceType": "SOURCE_FILES", "buildTag": "latest", "sourceFiles": files}],
    "defaultRunOptions": {"build": "latest", "timeoutSecs": 90, "memoryMbytes": 256},
    "exampleRunInput": {"body": json.dumps(ex, indent=2), "contentType": "application/json; charset=utf-8"},
    "seoTitle": "Paid Media Destination Continuity Monitor",
    "seoDescription": "Check ad landing pages and optional Shopify variant buyability. Two-strike confirmed failures with impacted-ad fan-out.",
}
assert body["isPublic"] is False
assert len(body["seoTitle"]) <= 60 and len(body["seoDescription"]) <= 160

# create or update
try:
    existing = s.call("GET", f"/acts/latentlark~{NAME}")["data"]
    aid = existing["id"]
    assert existing.get("isPublic") is False, "must stay private"
    s.call("PUT", f"/acts/{aid}/versions/0.1", body["versions"][0])
    print("updated", aid, "isPublic", existing.get("isPublic"))
except RuntimeError:
    d = s.call("POST", "/acts", body)["data"]
    aid = d["id"]
    print("created", aid, "isPublic", d["isPublic"])
    assert d["isPublic"] is False

# PPE already set at create; avoid re-PUT pricingInfos (createdAt required on update).
d = s.call("PUT", f"/acts/{aid}", {
    "defaultRunOptions": body["defaultRunOptions"],
    "exampleRunInput": body["exampleRunInput"],
    "seoTitle": body["seoTitle"],
    "seoDescription": body["seoDescription"],
    "description": body["description"],
    "title": body["title"],
})["data"]
assert d.get("isPublic") is False
pi = (d.get("pricingInfos") or [{}])[-1]
print("pricing", pi.get("pricingModel"), list(((pi.get("pricingPerEvent") or {}).get("actorChargeEvents") or {}).keys()), "startedAt", pi.get("startedAt"))

state = {"actId": aid, "name": f"latentlark/{NAME}", "isPublic": d.get("isPublic")}
json.dump(state, open("/workspace/apify/destination-continuity-monitor/scripts/state.json", "w"), indent=2)

b = s.call("POST", f"/acts/{aid}/builds?version=0.1&tag=latest&waitForFinish=300")["data"]
print("build", b["id"], b["status"], b.get("buildNumber"), "usageTotalUsd", b.get("usageTotalUsd"))
state["buildId"] = b["id"]
state["buildStatus"] = b["status"]
state["buildUsd"] = b.get("usageTotalUsd")
json.dump(state, open("/workspace/apify/destination-continuity-monitor/scripts/state.json", "w"), indent=2)
if b["status"] != "SUCCEEDED":
    # fetch log snippet
    try:
        log = s.call("GET", f"/actor-builds/{b['id']}/log")
        text = log if isinstance(log, str) else json.dumps(log)[:4000]
        print("LOG_SNIP", s.redact(str(text)[-2500:]))
    except Exception as e:
        print("log err", s.redact(str(e)[:300]))
    sys.exit(1)
print("OK", aid)
