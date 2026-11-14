import {
    affiliateSnapshotKey,
    buildAffiliateSnapshot,
    compareAffiliateSnapshots,
    inputHash,
    linkSnapshotRecord,
} from './affiliate.js';
import { createCharger } from './billing.js';
import { followWithBrowser } from './browser.js';
import {
    CHARGE_DESTINATION,
    CHARGE_LINK,
    CHARGE_LINK_BROWSER,
    CHARGE_SHOPIFY,
    HARD_LIMITS,
    RULE_VERSION,
    SOURCE_LANDING,
    SOURCE_SHOPIFY,
} from './constants.js';
import { FatalInputError } from './errors.js';
import { createBudget, createPinnedFetcher } from './http.js';
import { classifyLanding, isUnknownStatus } from './landing.js';
import { evaluateParamChain, normalizeParamRules, normalizeRequiredParams } from './params.js';
import { crawlDelayBlocks, parseRobots, pathAllowed } from './robots.js';
import { classifyShopifyVariant } from './shopify.js';
import {
    appendSnapshot,
    applyTwoStrike,
    buildSnapshot,
    loadSnapshotHistory,
} from './state.js';
import {
    destinationKey,
    normalizeDomain,
    normalizeLabel,
    normalizeTextList,
    normalizeVariantId,
    parseHttpsUrl,
    parseProductUrl,
    productIdentity,
} from './urls.js';

export function resolveScope(env, input) {
    const taskId = env?.APIFY_ACTOR_TASK_ID;
    const userId = env?.APIFY_USER_ID;
    const runId = env?.APIFY_ACTOR_RUN_ID;
    if (typeof taskId === 'string' && taskId.trim()) {
        return { scope: `task:${taskId.trim()}`, persistent: true };
    }
    if (input?.stateScope) {
        if (typeof userId === 'string' && userId.trim()) {
            return { scope: `user:${userId.trim()}:scope:${input.stateScope}`, persistent: true };
        }
        return { scope: `local:${input.stateScope}`, persistent: true, local: true };
    }
    return { scope: `run:${runId || 'local'}`, persistent: false };
}

export function resolveLimits(input) {
    const limits = {
        maxAds: HARD_LIMITS.maxAds,
        maxUniqueUrls: HARD_LIMITS.maxUniqueUrls,
        maxRequests: HARD_LIMITS.maxRequests,
        maxShopifyProducts: HARD_LIMITS.maxShopifyProducts,
        timeoutSeconds: HARD_LIMITS.timeoutSeconds,
        confirmFailures: HARD_LIMITS.confirmFailures,
    };
    for (const key of Object.keys(limits)) {
        if (input?.[key] === undefined || input?.[key] === null) continue;
        const value = input[key];
        const min = key === 'timeoutSeconds' ? HARD_LIMITS.minTimeoutSeconds : 1;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
            throw new FatalInputError(`${key} must be an integer of at least ${min}`);
        }
        if (value > HARD_LIMITS[key]) {
            throw new FatalInputError(`${key} cannot exceed ${HARD_LIMITS[key]}`);
        }
        limits[key] = value;
    }
    return limits;
}

export function assertNoForbiddenFeatures(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new FatalInputError('input must be an object');
    }
    if (input.notifications === true) throw new FatalInputError('notifications are not supported');
    const proxy = input.proxyConfiguration;
    if (proxy && typeof proxy === 'object') {
        if (proxy.useApifyProxy === true) throw new FatalInputError('proxies are not supported');
        if (Array.isArray(proxy.proxyUrls) && proxy.proxyUrls.length > 0) throw new FatalInputError('proxies are not supported');
    }
}


export function landingChargeEvent(affiliate, configuredEvents) {
    const configured = configuredEvents instanceof Set
        ? configuredEvents
        : new Set(configuredEvents || []);
    if (affiliate?.renderMode === 'browser' && configured.has(CHARGE_LINK_BROWSER)) {
        return CHARGE_LINK_BROWSER;
    }
    if (affiliate?.affiliateMode && configured.has(CHARGE_LINK)) {
        return CHARGE_LINK;
    }
    return CHARGE_DESTINATION;
}

export function collectWatchlist(input) {
    const ads = [];
    if (Array.isArray(input?.ads)) ads.push(...input.ads);
    if (Array.isArray(input?.links)) {
        for (const link of input.links) {
            if (!link || typeof link !== 'object' || Array.isArray(link)) {
                ads.push(link);
                continue;
            }
            ads.push({
                ...link,
                destinationUrl: link.destinationUrl || link.url,
            });
        }
    }
    return ads;
}

export function resolveAffiliateOptions(input) {
    const affiliateMode = Boolean(
        (Array.isArray(input?.links) && input.links.length > 0)
        || (Array.isArray(input?.requiredParams) && input.requiredParams.length > 0)
        || (input?.paramRules && typeof input.paramRules === 'object')
        || input?.renderMode === 'browser'
        || input?.followClientRedirects === true,
    );
    const renderMode = input?.renderMode === 'browser' ? 'browser' : 'http';
    const followClientRedirects = input?.followClientRedirects == null
        ? affiliateMode
        : input.followClientRedirects === true;
    const respectRobots = input?.respectRobots == null ? true : input.respectRobots === true;
    const required = normalizeRequiredParams(input?.requiredParams, 'requiredParams');
    if (required.error) throw new FatalInputError(required.error);
    const rules = normalizeParamRules(input?.paramRules);
    if (rules.error) throw new FatalInputError(rules.error);
    return {
        affiliateMode,
        renderMode,
        followClientRedirects,
        respectRobots,
        requiredParams: required.list,
        paramRules: rules.rules,
        inputHashValue: inputHash(input),
    };
}

export function normalizeAds(ads, limits) {
    if (!Array.isArray(ads) || ads.length === 0) {
        throw new FatalInputError('ads must contain at least one destination URL');
    }
    if (ads.length > limits.maxAds) {
        throw new FatalInputError(`ads ${ads.length} exceed cap ${limits.maxAds}`);
    }
    const errors = [];
    const byUrl = new Map();
    ads.forEach((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push({ index, error: 'item_invalid' });
            return;
        }
        const dest = parseHttpsUrl(item.destinationUrl || item.url);
        if (dest.error) {
            errors.push({ index, error: dest.error });
            return;
        }
        const itemParams = normalizeRequiredParams(item.requiredParams, 'requiredParams');
        if (itemParams.error) {
            errors.push({ index, error: itemParams.error });
            return;
        }
        const expected = normalizeDomain(item.expectedDomain);
        if (expected.error) {
            errors.push({ index, error: expected.error });
            return;
        }
        const required = normalizeTextList(item.requiredText, 'requiredText');
        if (required.error) {
            errors.push({ index, error: required.error });
            return;
        }
        const forbidden = normalizeTextList(item.forbiddenText, 'forbiddenText');
        if (forbidden.error) {
            errors.push({ index, error: forbidden.error });
            return;
        }
        const labelResult = normalizeLabel(item.label);
        if (labelResult?.error) {
            errors.push({ index, error: labelResult.error });
            return;
        }
        let shopify = null;
        if (item.shopifyProductUrl || item.variantId) {
            if (!item.shopifyProductUrl || !item.variantId) {
                errors.push({ index, error: 'shopify_requires_url_and_variant' });
                return;
            }
            const product = parseProductUrl(item.shopifyProductUrl);
            if (product.error) {
                errors.push({ index, error: `shopify_${product.error}` });
                return;
            }
            const variantId = normalizeVariantId(item.variantId);
            if (!variantId) {
                errors.push({ index, error: 'variant_id_invalid' });
                return;
            }
            shopify = { product, variantId, productKey: productIdentity(product) };
        }
        const adId = typeof item.adId === 'string' && item.adId.trim()
            ? item.adId.trim().slice(0, 120)
            : `ad-${index + 1}`;
        const platform = typeof item.platform === 'string' ? item.platform.trim().slice(0, 40) : 'other';
        const key = destinationKey(dest.href);
        let group = byUrl.get(key);
        if (!group) {
            group = {
                key,
                destinationUrl: dest.href,
                hostname: dest.hostname,
                pathname: dest.pathname,
                search: dest.search,
                expectedDomain: expected.domain,
                requiredText: required.list,
                forbiddenText: forbidden.list,
                requiredParams: itemParams.list,
                shopify,
                ads: [],
            };
            byUrl.set(key, group);
        } else {
            // merge text asserts (union) and keep first shopify config
            group.requiredText = [...new Set([...group.requiredText, ...required.list])];
            group.forbiddenText = [...new Set([...group.forbiddenText, ...forbidden.list])];
            const seenParams = new Set(group.requiredParams.map((param) => param.name.toLowerCase()));
            for (const param of itemParams.list) {
                if (!seenParams.has(param.name.toLowerCase())) {
                    group.requiredParams.push(param);
                    seenParams.add(param.name.toLowerCase());
                }
            }
            if (!group.expectedDomain && expected.domain) group.expectedDomain = expected.domain;
            if (!group.shopify && shopify) group.shopify = shopify;
        }
        group.ads.push({
            adId,
            platform,
            label: labelResult?.label ?? null,
        });
    });
    if (errors.length > 0) throw new FatalInputError('ads has invalid items', errors);
    const groups = [...byUrl.values()];
    if (groups.length > limits.maxUniqueUrls) {
        throw new FatalInputError(`unique destinations ${groups.length} exceed cap ${limits.maxUniqueUrls}`);
    }
    const shopifyKeys = new Set(groups.filter((g) => g.shopify).map((g) => g.shopify.productKey));
    if (shopifyKeys.size > limits.maxShopifyProducts) {
        throw new FatalInputError(`shopify products ${shopifyKeys.size} exceed cap ${limits.maxShopifyProducts}`);
    }
    return { groups, adCount: ads.length, uniqueUrls: groups.length, shopifyProductCount: shopifyKeys.size };
}

export async function runMonitor(input, deps) {
    assertNoForbiddenFeatures(input);
    const limits = resolveLimits(input ?? {});
    const enableShopifyChecks = input?.enableShopifyChecks !== false;
    const affiliate = resolveAffiliateOptions(input ?? {});
    const watchlist = collectWatchlist(input ?? {});
    const normalized = normalizeAds(watchlist, limits);
    const scopeInfo = resolveScope(deps.env ?? {}, input);
    const startedAtMs = deps.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const deadlineMs = startedAtMs + (limits.timeoutSeconds * 1000);
    const budget = createBudget(limits.maxRequests);
    const robotsCache = new Map();

    const allow = async (url) => {
        if (!affiliate.respectRobots) return true;
        const host = url.hostname.toLowerCase();
        let robots = robotsCache.get(host);
        if (!robots) {
            // fetch robots once per host. Counted in the shared request budget.
            robots = { rules: [], crawlDelayMs: null, loaded: false };
            robotsCache.set(host, robots);
        }
        if (crawlDelayBlocks(robots.crawlDelayMs)) return false;
        if (!robots.loaded) return true;
        return pathAllowed(robots.rules, url.pathname, url.search);
    };

    const fetcher = createPinnedFetcher({
        resolve: deps.resolve,
        transport: deps.transport,
        now: deps.now,
        sleep: deps.sleep,
        budget,
        deadlineMs,
        allow,
        rateLimitMs: HARD_LIMITS.rateLimitMs,
        maxRetries: HARD_LIMITS.maxRetries,
        maxRedirects: HARD_LIMITS.maxRedirects,
        followClientRedirects: affiliate.followClientRedirects,
    });

    async function ensureRobots(hostname) {
        if (!affiliate.respectRobots) {
            const skip = { rules: [], crawlDelayMs: null, loaded: true };
            robotsCache.set(hostname, skip);
            return skip;
        }
        let robots = robotsCache.get(hostname);
        if (robots?.loaded) return robots;
        const result = await fetcher.fetch(`https://${hostname}/robots.txt`);
        if (!result.received || result.status !== 200) {
            robots = { rules: [], crawlDelayMs: null, loaded: true };
        } else {
            const parsed = parseRobots(result.body);
            robots = { ...parsed, loaded: true };
        }
        robotsCache.set(hostname, robots);
        return robots;
    }

    const history = await loadSnapshotHistory(deps.store, {
        scope: scopeInfo.scope,
        startedAt,
        previousSnapshot: input.previousSnapshot,
        maxSnapshots: HARD_LIMITS.maxSnapshots,
        confirmFailures: limits.confirmFailures,
    });

    const charger = createCharger({
        chargeFn: deps.chargeFn,
        store: deps.store,
        runId: deps.runId,
        scope: scopeInfo.scope,
    });

    const rows = [];
    const snapshotDestinations = {};
    const shopifyDone = new Map();
    const affiliateLinks = {};
    let destinationsCharged = 0;
    let shopifyCharged = 0;
    let linksCharged = 0;
    let linksBrowserCharged = 0;
    const hash = affiliate.inputHashValue;
    const affilKey = affiliateSnapshotKey(hash);
    const previousAffil = deps.affiliateStore ? await deps.affiliateStore.get(affilKey) : null;

    const flushMarginMs = 8000;
    for (let groupIndex = 0; groupIndex < normalized.groups.length; groupIndex += 1) {
        const group = normalized.groups[groupIndex];
        if (deps.now() + flushMarginMs > deadlineMs && groupIndex < normalized.groups.length) {
            const remaining = normalized.groups.slice(groupIndex);
            for (const leftover of remaining) {
                const classified = classifyLanding({
                    received: false,
                    reason: 'timeout',
                    blocked: false,
                    status: null,
                    body: '',
                    finalUrl: leftover.destinationUrl,
                    expectedDomain: leftover.expectedDomain,
                    requiredText: leftover.requiredText,
                    forbiddenText: leftover.forbiddenText,
                    redirectChain: [],
                });
                await pushResult(leftover, classified, null, history.folded.get(leftover.key), []);
            }
            break;
        }
        await ensureRobots(group.hostname);
        const robots = robotsCache.get(group.hostname);
        if (crawlDelayBlocks(robots?.crawlDelayMs)) {
            const classified = classifyLanding({
                received: false,
                reason: 'crawl_delay_too_high',
                blocked: true,
                status: null,
                body: '',
                finalUrl: group.destinationUrl,
                expectedDomain: group.expectedDomain,
                requiredText: group.requiredText,
                forbiddenText: group.forbiddenText,
            });
            await pushResult(group, classified, null, history.folded.get(group.key), []);
            continue;
        }

        let landingResult;
        if (affiliate.renderMode === 'browser') {
            const browserFn = deps.browserFollow || followWithBrowser;
            landingResult = await browserFn(group.destinationUrl, {
                deadlineMs,
                now: deps.now,
                maxRedirects: HARD_LIMITS.maxRedirects,
            });
        } else {
            landingResult = await fetcher.fetch(group.destinationUrl);
        }
        const redirectChain = landingResult.redirectChain || [];
        const classified = classifyLanding({
            ...landingResult,
            body: landingResult.body,
            finalUrl: landingResult.finalUrl || group.destinationUrl,
            expectedDomain: group.expectedDomain,
            requiredText: group.requiredText,
            forbiddenText: group.forbiddenText,
            redirectChain,
        });
        const tracking = evaluateParamChain({
            hops: redirectChain,
            requiredParams: [...affiliate.requiredParams, ...(group.requiredParams || [])],
            paramRules: affiliate.paramRules,
        });

        let shopifyClassified = null;
        if (enableShopifyChecks && group.shopify) {
            const pk = group.shopify.productKey;
            if (shopifyDone.has(pk)) {
                shopifyClassified = shopifyDone.get(pk);
            } else {
                const productUrl = `https://${group.shopify.product.hostname}${group.shopify.product.productPath}`;
                const shopifyFetch = await fetcher.fetch(productUrl);
                shopifyClassified = classifyShopifyVariant({
                    document: shopifyFetch.body,
                    variantId: group.shopify.variantId,
                    received: shopifyFetch.received,
                    reason: shopifyFetch.reason,
                    blocked: shopifyFetch.blocked,
                    status: shopifyFetch.status,
                });
                shopifyDone.set(pk, shopifyClassified);
            }
        }

        await pushResult(group, classified, shopifyClassified, history.folded.get(group.key), redirectChain, tracking);
    }

    async function pushResult(group, classified, shopifyClassified, previous, redirectChain = [], tracking = null) {
        const observedAt = new Date(deps.now()).toISOString();
        const observation = {
            destinationStatus: classified.destinationStatus,
            event: classified.event,
            contentHash: classified.contentHash,
            finalUrl: classified.finalUrl,
            observedAt,
            shopifyAvailability: shopifyClassified?.availability ?? null,
        };
        const struck = applyTwoStrike({
            previous,
            observation,
            confirmFailures: limits.confirmFailures,
        });

        snapshotDestinations[group.key] = {
            kind: isUnknownStatus(classified.destinationStatus) ? 'unknown' : 'observation',
            destinationStatus: classified.destinationStatus,
            contentHash: classified.contentHash,
            finalUrl: classified.finalUrl,
            observedAt,
            shopifyAvailability: shopifyClassified?.availability ?? null,
            observedAvailable: shopifyClassified?.observedAvailable,
        };

        // billing
        let destCharge = { charged: false, reason: 'not_billable', eventName: CHARGE_DESTINATION };
        let shopCharge = { charged: false, reason: 'not_billable', eventName: CHARGE_SHOPIFY };

        const rowBase = {
            destinationUrl: group.destinationUrl,
            finalUrl: classified.finalUrl,
            destinationStatus: classified.destinationStatus,
            previousDestinationStatus: struck.previousDestinationStatus,
            event: classified.event,
            reason: classified.reason,
            expectedDomain: group.expectedDomain,
            expectedDomainOk: classified.expectedDomainOk,
            requiredTextOk: classified.requiredTextOk,
            forbiddenTextOk: classified.forbiddenTextOk,
            contentHash: classified.contentHash,
            httpStatus: classified.httpStatus,
            consecutiveFailures: struck.consecutiveFailures,
            confirmedFailure: struck.confirmedFailure,
            confirmedOk: struck.confirmedOk,
            impactedTransition: struck.impactedTransition,
            baselinePreserved: struck.baselinePreserved,
            adIds: group.ads.map((a) => a.adId),
            ads: group.ads,
            shopifyAvailability: shopifyClassified?.availability ?? null,
            previousShopifyAvailability: previous?.shopifyAvailability ?? null,
            shopifyEvent: shopifyClassified?.event ?? null,
            shopifyHttpStatus: shopifyClassified?.httpStatus ?? null,
            shopifyVariantTitle: shopifyClassified?.variantTitle ?? null,
            shopifyPriceMinor: shopifyClassified?.priceMinor ?? null,
            confirmedShopifyFailure: struck.confirmedShopifyFailure,
            shopifyTransition: struck.shopifyTransition,
            shopifyProductUrl: group.shopify?.product.productUrl ?? null,
            shopifyVariantId: group.shopify?.variantId ?? null,
            sourceLanding: SOURCE_LANDING,
            sourceShopify: group.shopify ? SOURCE_SHOPIFY : null,
            ruleVersion: RULE_VERSION,
            stateScope: scopeInfo.scope,
            checkedAt: observedAt,
            requestsUsed: budget.used,
            requestLimit: budget.limit,
            renderMode: affiliate.renderMode,
            redirectChain: redirectChain,
            trackingStatus: tracking?.trackingStatus ?? 'not_configured',
            trackingIssues: tracking?.issues ?? [],
            changeAlerts: [],
            inputHash: hash,
            promise: 'Detect broken affiliate redirects and unexpected tracking changes.',
            chargeLandingEvent: null,
            chargedDestination: false,
            chargedShopify: false,
            chargeDestinationReason: 'not_billable',
            chargeShopifyReason: 'not_billable',
        };

        // deferred charge — applied after we create the async wrapper
        rows.push({ rowBase, classified, shopifyClassified, group });
    }

    // Apply charges (async) for billable rows, then persist each row immediately.
    const finalRows = [];
    for (const pending of rows) {
        const { rowBase, classified, shopifyClassified, group } = pending;
        if (classified.billable) {
            const eventName = landingChargeEvent(affiliate, deps.configuredChargeEvents);
            const charge = await charger.charge(eventName, group.key);
            rowBase.chargeLandingEvent = eventName;
            rowBase.chargedDestination = charge.charged;
            rowBase.chargeDestinationReason = charge.reason;
            if (charge.charged) {
                if (eventName === CHARGE_LINK_BROWSER) linksBrowserCharged += 1;
                else if (eventName === CHARGE_LINK) linksCharged += 1;
                else destinationsCharged += 1;
            }
        }
        if (shopifyClassified?.billable) {
            const charge = await charger.charge(CHARGE_SHOPIFY, group.shopify.productKey);
            rowBase.chargedShopify = charge.charged;
            rowBase.chargeShopifyReason = charge.reason;
            if (charge.charged) shopifyCharged += 1;
        }
        const record = linkSnapshotRecord(rowBase);
        affiliateLinks[group.key] = record;
        rowBase.changeAlerts = compareAffiliateSnapshots(
            previousAffil && previousAffil.links && previousAffil.links[group.key]
                ? { links: { [group.key]: previousAffil.links[group.key] } }
                : null,
            { [group.key]: record },
        );
        finalRows.push(rowBase);
        if (typeof deps.onRow === 'function') {
            await deps.onRow(rowBase);
        }
    }

    const completedAt = new Date(deps.now()).toISOString();
    const snapshot = buildSnapshot({
        scope: scopeInfo.scope,
        runId: deps.runId,
        startedAt,
        completedAt,
        destinations: snapshotDestinations,
    });
    let baselineWrite = { written: false, reason: 'skipped' };
    if (scopeInfo.persistent || input?.previousSnapshot != null || input?.stateScope) {
        baselineWrite = await appendSnapshot(deps.store, snapshot);
    } else {
        // still write for run-scoped local tests when store provided
        baselineWrite = await appendSnapshot(deps.store, snapshot);
    }

    const changeAlerts = compareAffiliateSnapshots(previousAffil, affiliateLinks);
    let affiliateWrite = { written: false, reason: 'skipped' };
    if (deps.affiliateStore) {
        const affilSnap = buildAffiliateSnapshot({
            inputHashValue: hash,
            runId: deps.runId,
            checkedAt: completedAt,
            links: affiliateLinks,
        });
        await deps.affiliateStore.set(affilKey, affilSnap);
        affiliateWrite = { written: true, reason: 'ok', key: affilKey };
    }

    const confirmedFailures = finalRows.filter((r) => r.confirmedFailure);
    const summary = {
        fatal: false,
        ruleVersion: RULE_VERSION,
        scope: scopeInfo.scope,
        startedAt,
        completedAt,
        ads: normalized.adCount,
        uniqueUrls: normalized.uniqueUrls,
        shopifyProducts: normalized.shopifyProductCount,
        destinationsCharged,
        shopifyCharged,
        linksCharged,
        linksBrowserCharged,
        confirmedFailureCount: confirmedFailures.length,
        impactedAdIds: [...new Set(confirmedFailures.flatMap((r) => r.adIds))],
        requestsUsed: budget.used,
        requestLimit: budget.limit,
        baselineWrite,
        snapshot,
        proxyUsed: false,
        notificationsSent: false,
        countryEmulation: false,
        renderMode: affiliate.renderMode,
        inputHash: hash,
        changeAlerts,
        affiliateWrite,
        promise: 'Detect broken affiliate redirects and unexpected tracking changes.',
        chargeEvents: {
            [CHARGE_DESTINATION]: CHARGE_DESTINATION,
            [CHARGE_SHOPIFY]: CHARGE_SHOPIFY,
            [CHARGE_LINK]: CHARGE_LINK,
            [CHARGE_LINK_BROWSER]: CHARGE_LINK_BROWSER,
        },
    };

    return { rows: finalRows, summary };
}
