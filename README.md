# Paid Media Destination Continuity Monitor: Affiliate Link QA

Check whether the **landing pages your ads point to** still work, and, for Shopify products, whether the **advertised variant is still buyable**. Optionally inspect **affiliate redirect chains** and tracking parameters. Paste destination URLs (and optional Shopify variant IDs), click Start, and get one clear row per destination with the impacted ad IDs fanned out. *Sold out* and *broken* stay separate from *blocked*, *timeout* and *unknown*.

**Promise: detect broken affiliate redirects and unexpected tracking changes.** This Actor does not claim commission attribution.

*No login, no cookies, no proxy, no campaign edits.* Default mode is a fast HTTPS GET. Optional Shopify checks use the documented public Ajax product endpoint. Set `renderMode` to `browser` only when you need a headless Chromium render for JavaScript or meta-refresh redirects (use 1024 MB for those runs).

*Built and maintained by LatentLark.* Pair with [Shopify Variant Availability & Price Evidence Monitor](https://apify.com/latentlark/shopify-variant-availability-price-monitor) for deeper variant watchlists, or send rows to Sheets with [Google Sheets Export & Import (No OAuth)](https://apify.com/latentlark/sheets-export).

## Who it's for
- **PPC / paid-social operators** who waste spend when a live ad lands on a 404, a wrong domain, or a sold-out product.
- **Small agencies** watching several clients' Meta, TikTok, Google or LinkedIn destinations on a schedule.
- **DTC / Shopify brands** who want a cheap Apify/n8n-friendly continuity check without connecting ad accounts to a SaaS.

## Quick start (first run in under a minute)
1. Click **Try for free** (or **Start** in Console). The form is prefilled with:
   - `https://example.com/` expects domain `example.com` and the text `Example Domain`
   - Shopify's public **Dawn theme demo** product *Thelma sandal*, variant `39576998346841` (`Black / 35`), for the optional stock check
2. Click **Start**. The demo run takes a few seconds, writes **2 rows**, and lists about **$0.013** in events (2 × $0.004 destinations + 1 × $0.005 Shopify) plus a few tenths of a cent of platform usage.
3. Replace the destinations with your own ad URLs. Label each row with your `adId`. Cap: **25 ads, 15 unique URLs, 3 Shopify products, 80 requests** per run (timeout cap 180 seconds; the Store example stays at 90).
4. To confirm failures across runs (two-strike), **Save as task** and add a **Schedule** (for example, hourly or daily), or pass `previousSnapshot` from an earlier `OUTPUT`.

## What you can do with it
- **Landing health:** HTTP status, redirect chain (each hop revalidated), final URL, expected-domain match.
- **Assertion checks:** require offer text (`Add to cart`, a promo string) or forbid sold-out copy.
- **Shopify buyability:** optional `/products/{handle}.js` check for a selected variant, using the same read-only source as our Shopify monitor.
- **Two-strike confirmed failures:** a destination becomes `confirmedFailure` only after **two consecutive** failure observations. Timeouts, 403s and other unknowns never count as a strike and never overwrite the last good baseline.
- **Impacted-ad fan-out:** several ads can share one URL; one check updates every linked `adId`.

## Example: the prefilled demo
Input (this is the form prefill):

```json
{
  "ads": [
    {
      "adId": "demo-example",
      "platform": "other",
      "destinationUrl": "https://example.com/",
      "expectedDomain": "example.com",
      "requiredText": ["Example Domain"],
      "label": "landing-ok"
    },
    {
      "adId": "demo-dawn",
      "platform": "other",
      "destinationUrl": "https://theme-dawn-demo.myshopify.com/products/thelma-sandal",
      "expectedDomain": "theme-dawn-demo.myshopify.com",
      "shopifyProductUrl": "https://theme-dawn-demo.myshopify.com/products/thelma-sandal",
      "variantId": "39576998346841",
      "label": "dawn-demo-variant"
    }
  ]
}
```

Real output from a private platform run on 9 November 2026 (fields shortened):

| adIds | destinationStatus | httpStatus | shopifyAvailability | chargedDestination | chargedShopify |
|---|---|---:|---|---|---|
| demo-example | ok | 200 |  | true | false |
| demo-dawn | ok | 200 | out_of_stock | true | true |

The Dawn *Black / 35* variant was sold out on that demo store when the run was taken; other variants of the same product can still be in stock. Live demos can change. The first OOS observation is `oos_pending_confirmation`. A second consecutive OOS on a scheduled task sets `confirmedShopifyFailure`.


## Affiliate redirect and parameter QA
Use this when you need to check tracking links as well as landing pages.

- **Redirect-chain inspection:** every hop is recorded (status, URL, query parameters present). You can see where a required parameter disappears, is renamed, or changes value.
- **Configurable validation:** pass `requiredParams` globally or per link (`name`, optional `expectedValue`, `aliases`, `severity`). `paramRules` supports per-hop `mayDrop` / `mayRename` rules and aliases. Built-in rules cover common Awin, Impact, CJ and Amazon-style hosts.
- **Missing is not an automatic failure.** Default severity is `warning`. Networks legitimately consume or swap parameters (for example Awin `awinaffid` may become `awc`). Mark a rule `severity: "error"` only when a drop should fail the tracking check. Landing status and tracking status are separate fields.
- **Expected destination:** `expectedDomain` still flags a final host outside the merchant domain you named.
- **Change alerts:** the Actor stores a snapshot keyed by an input hash and, on the next run of the same watchlist, reports newly broken links, a changed final destination, or a changed parameter outcome.
- **Render modes:** `http` (default, fast) follows `Location` headers, and can follow meta-refresh plus simple `location.href` / `location.replace` assignments. `browser` uses a full headless render. The Store prefill stays on `http` and should finish in well under 2 minutes.
- You can pass the same URLs as `ads` (existing input, fully backward compatible) or as `links` with a `url` field. Classic ads-only runs keep the previous behaviour, including robots.txt checks. Set `respectRobots: false` when you are inspecting specific tracking URLs you own and a network robots.txt would otherwise block the check.

### Example: one Awin-style link (not the Store prefill)

```json
{
  "links": [
    {
      "url": "https://www.awin1.com/cread.php?awinmid=1234&awinaffid=9999&ued=https%3A%2F%2Fexample.com%2F",
      "expectedDomain": "example.com",
      "requiredParams": [
        { "name": "awinaffid", "expectedValue": "9999", "aliases": ["awc"], "severity": "warning" }
      ],
      "label": "awin-example"
    }
  ],
  "respectRobots": false,
  "renderMode": "http"
}
```

## Pricing (pay per event)
| Event | Price | When it is charged |
|---|---|---|
| Destination resolved (`destination-resolved`) | **$0.004** per unique URL | Classic ads-only landing classification (`ok`, `broken`, `assertion_failed`, or `redirect_domain_mismatch`) |
| Shopify product check (`shopify-product-check`) | **$0.005** per successful product classification | Ajax product document classifies the selected variant |
| HTTP link check (`link-checked`) | **$0.0015** per unique URL | Affiliate / tracking-link HTTP checks that reach a full classification |
| Browser link check (`link-checked-browser`) | **$0.005** per unique URL | The same classification after a full browser render |
| Actor start | none | Not charged |

A unique URL is never charged for both `destination-resolved` and a link-check event. `link-checked` and `link-checked-browser` are new paid events. If Apify places them on a notice period, they start on the platform effective date; until then a billable landing still uses `destination-resolved` at $0.004. Blocked, timeout, unknown, rate-limited, invalid-input and request-budget rows stay free.

- **Shopify free:** blocked, unknown, missing `available` field, or product 404.
- **Cheap to run:** the Store prefill (2 destinations + 1 Shopify check) lists about **$0.013** in events plus a few tenths of a cent of platform usage, and finishes in well under 2 minutes at 256 MB. Example: 10 classic destinations daily for 30 days ≈ 300 × $0.004 = **$1.20** in destination events.

## Two-strike semantics
| Observation | Effect on strikes |
|---|---|
| `broken`, `assertion_failed`, `redirect_domain_mismatch` | +1 failure strike |
| `out_of_stock` (Shopify) | +1 Shopify OOS strike |
| `ok` / `in_stock` | +1 recovery strike; clears confirmed failure after 2 consecutive oks |
| `unknown`, `timeout`, `blocked`, `rate_limited` | **No strike.** Last good baseline is preserved. |

`confirmedFailure` / `confirmedShopifyFailure` flip only at strike count ≥ 2 (default `confirmFailures`). Use a saved **task** or `previousSnapshot` so history persists across runs.

## Input
| Field | Required | What it does |
|---|---|---|
| `ads` | yes | List of destinations. Duplicate URLs are merged; `adId`s fan out. |
| `ads[].destinationUrl` | yes | HTTPS landing URL (read-only GET). |
| `ads[].adId` | no | Your ad / campaign id (max 120 chars). Auto-generated if omitted. |
| `ads[].platform` | no | Label such as `meta`, `tiktok`, `google`, `linkedin`, `other`. |
| `ads[].expectedDomain` | no | Final host must match this domain (or a subdomain of it). |
| `ads[].requiredText` | no | All substrings must appear in the final HTML body. |
| `ads[].forbiddenText` | no | Any substring present fails the assertion (e.g. `Sold out`). |
| `ads[].shopifyProductUrl` + `variantId` | no | Together enable the Ajax product check for that variant. |
| `ads[].label` | no | Your own name for the row. Never sent to the destination. |
| `enableShopifyChecks` | no | Default `true`. Set `false` to ignore Shopify fields. |
| `previousSnapshot` | no | Paste `OUTPUT.snapshot` from an earlier run. |
| `stateScope` | no | Snapshot scope for local / non-task runs. A task ID always wins. |
| `maxAds` / `maxUniqueUrls` / `maxRequests` / `maxShopifyProducts` / `timeoutSeconds` / `confirmFailures` | no | Lower the hard caps (cannot raise them). |

## Output
**Dataset:** one row per unique destination. Main fields:

| Field | Meaning |
|---|---|
| `destinationStatus` | `ok`, `broken`, `assertion_failed`, `redirect_domain_mismatch`, `unknown`, `timeout`, `blocked`, … |
| `event`, `reason`, `httpStatus`, `finalUrl` | What happened and where |
| `expectedDomainOk`, `requiredTextOk`, `forbiddenTextOk`, `contentHash` | Assertion and evidence |
| `adIds`, `ads` | Every ad linked to this URL |
| `consecutiveFailures`, `confirmedFailure`, `impactedTransition` | Two-strike landing state |
| `shopifyAvailability`, `confirmedShopifyFailure`, `shopifyTransition` | Optional Shopify state |
| `chargedDestination`, `chargedShopify`, charge reasons | Whether each event was billed |
| `checkedAt`, `ruleVersion`, `stateScope`, `requestsUsed` | Run metadata |

**Key-value store `OUTPUT`:** run summary with charge counts, `impactedAdIds` for confirmed failures, and `snapshot` for the next run.

## Limits
| Cap | Maximum |
|---|---|
| Ads per run | 25 |
| Unique destination URLs | 10 |
| Shopify products | 3 |
| HTTP requests (robots, landing, Shopify, redirects, one retry) | 40 |
| Run time | 90 seconds |
| Memory | 256 MB |

Inputs over a cap stop **before** any request and nothing is charged. One request per host per second. Proxies and notifications are refused.

## How it works / read-only & ToS notes
- Landing checks are plain HTTPS GETs. Redirects are followed with the same SSRF and public-host rules on every hop.
- Shopify checks call only `GET /{locale}/products/{handle}.js` ([Shopify Ajax Product API](https://shopify.dev/docs/api/ajax/reference/product)) and respect `robots.txt`.
- Private / link-local targets, credentials in URLs, and non-HTTPS schemes are blocked.
- This Actor does **not** log into Meta, TikTok, Google or LinkedIn, does not edit campaigns, and does not estimate spend.
- Only monitor destinations and stores you are allowed to check. Public access is not blanket legal permission.

## Limitations
- **No JavaScript rendering.** Bot walls and client-only pages return `unknown` (free), not `broken`.
- **No proxies.** Residential or Apify Proxy input is rejected.
- **Shopify currency** may be unknown on Ajax product responses (same as our Shopify monitor).
- **History needs a task or `previousSnapshot`.** A one-off run cannot confirm a two-strike failure by itself.
- Password-protected Shopify stores and non-Shopify “Shopify-looking” sites are unsupported for the product step.

## FAQ
**I got `unknown` or `timeout`. Was I charged?**
No for that destination. Only fully classified destinations and successful Shopify classifications are charged.

**Why isn't `confirmedFailure` true after one 404?**
Two consecutive failure observations are required (default). Save as a task and run again, or pass `previousSnapshot`.

**Can it pause my ads?**
No. It only reports. Wire Slack/Sheets yourself (for example via n8n) and decide manually.

**Do I need the Shopify fields?**
No. Leave them empty for plain landing QA. Set `enableShopifyChecks` to `false` to ignore them entirely.

**How is this different from the Shopify Variant Monitor?**
That Actor is a dedicated variant watchlist with richer price/availability events. This Actor is **ad-destination continuity**: landing health first, optional Shopify buyability second, with ad-ID fan-out and two-strike confirmation across both layers.

## More LatentLark Actors
- [Shopify Variant Availability & Price Evidence Monitor](https://apify.com/latentlark/shopify-variant-availability-price-monitor): deep restock / sell-out watch on selected variants.
- [TikTok Ads Library Scraper](https://apify.com/latentlark/tiktok-ads-library): competitor TikTok ads (feed landing URLs into this Actor).
- [Google Ads Transparency & LinkedIn Ad Library Scraper](https://apify.com/latentlark/competitor-ads-monitor): Google and LinkedIn ad creatives.
- [Google Sheets Export & Import (No OAuth)](https://apify.com/latentlark/sheets-export): send every run's rows to a Sheet.
