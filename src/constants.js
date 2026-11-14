/** Hard caps. Input may lower these. Input must not raise them. */
export const HARD_LIMITS = Object.freeze({
    maxAds: 25,
    maxUniqueUrls: 10,
    maxRequests: 40,
    maxShopifyProducts: 3,
    timeoutSeconds: 90,
    memoryMbytes: 256,
    rateLimitMs: 1000,
    maxRetries: 1,
    maxRedirects: 3,
    maxRetryAfterMs: 10_000,
    maxBodyBytes: 1_500_000,
    maxSnapshots: 50,
    minTimeoutSeconds: 5,
    maxCrawlDelayMs: 5_000,
    confirmFailures: 2,
    variantResponseCap: 250,
});

export const RULE_VERSION = '0.1.0';
export const SCHEMA_VERSION = 1;
export const CHARGE_DESTINATION = 'destination-resolved';
export const CHARGE_SHOPIFY = 'shopify-product-check';
export const CHARGE_DESTINATION_USD = 0.004;
export const CHARGE_SHOPIFY_USD = 0.005;
export const SOURCE_LANDING = 'http_landing';
export const SOURCE_SHOPIFY = 'shopify_ajax_product';

export const SNAPSHOT_PREFIX = 'CONT_SNAPSHOT_';
export const LEDGER_KEY_PREFIX = 'CONT_CHARGE_LEDGER_';

export const USER_AGENT = 'LatentLarkDestinationContinuity/0.1 (+https://apify.com/latentlark; read-only)';
