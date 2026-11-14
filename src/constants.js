/** Hard caps. Input may lower these. Input must not raise them. */
export const HARD_LIMITS = Object.freeze({
    maxAds: 10_000,
    maxUniqueUrls: 5_000,
    maxRequests: 20_000,
    maxShopifyProducts: 3,
    timeoutSeconds: 3_600,
    memoryMbytes: 256,
    rateLimitMs: 400,
    minRateLimitMs: 200,
    maxRateLimitMs: 10_000,
    maxConcurrency: 20,
    maxConcurrencyPerHost: 2,
    defaultConcurrency: 10,
    defaultConcurrencyPerHost: 2,
    maxRetries: 1,
    maxRedirects: 10,
    maxRetryAfterMs: 10_000,
    maxBodyBytes: 1_500_000,
    maxSnapshots: 50,
    minTimeoutSeconds: 5,
    maxCrawlDelayMs: 5_000,
    confirmFailures: 2,
    variantResponseCap: 250,
    flushMarginMs: 8_000,
});

export const RULE_VERSION = '0.2.1';
export const SCHEMA_VERSION = 1;
export const CHARGE_DESTINATION = 'destination-resolved';
export const CHARGE_SHOPIFY = 'shopify-product-check';
export const CHARGE_LINK = 'link-checked';
export const CHARGE_LINK_BROWSER = 'link-checked-browser';
export const CHARGE_DESTINATION_USD = 0.004;
export const CHARGE_SHOPIFY_USD = 0.005;
export const CHARGE_LINK_USD = 0.0015;
export const CHARGE_LINK_BROWSER_USD = 0.005;
export const SOURCE_LANDING = 'http_landing';
export const SOURCE_SHOPIFY = 'shopify_ajax_product';

export const SNAPSHOT_PREFIX = 'CONT_SNAPSHOT_';
export const LEDGER_KEY_PREFIX = 'CONT_CHARGE_LEDGER_';
export const PROGRESS_KEY_PREFIX = 'BULK_PROGRESS_';

export const USER_AGENT = 'LatentLarkDestinationContinuity/0.2 (+https://apify.com/latentlark; read-only; affiliate-link-qa)';
