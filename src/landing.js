import { createHash } from 'node:crypto';

const BROKEN_STATUSES = new Set([404, 410, 451]);
const UNKNOWN_STATUSES = new Set([401, 403, 407, 429, 500, 502, 503, 504]);

export function contentHash(body) {
    return createHash('sha256').update(String(body ?? ''), 'utf8').digest('hex').slice(0, 16);
}

export function extractRedirectChain(hops) {
    return hops.map((hop) => ({
        url: hop.url,
        status: hop.status,
    }));
}

/**
 * Classify a completed landing fetch (after redirects already followed by fetcher).
 * The fetcher returns the final response; redirectChain is optional metadata.
 */
export function classifyLanding({
    received,
    reason,
    blocked,
    status,
    body,
    finalUrl,
    expectedDomain,
    requiredText = [],
    forbiddenText = [],
    redirectChain = [],
}) {
    const base = {
        source: 'http_landing',
        httpStatus: status ?? null,
        finalUrl: finalUrl ?? null,
        redirectChain,
        contentHash: null,
        requiredTextOk: null,
        forbiddenTextOk: null,
        expectedDomainOk: null,
        charged: false,
        chargeEvent: null,
        chargeReason: 'not_billable',
    };

    if (blocked) {
        return {
            ...base,
            destinationStatus: 'blocked',
            event: 'blocked',
            reason: reason || 'blocked',
            billable: false,
        };
    }
    if (!received) {
        const statusName = reason === 'timeout' ? 'timeout'
            : reason === 'request_budget_exhausted' ? 'budget_exhausted'
                : reason === 'too_many_redirects' ? 'too_many_redirects'
                    : reason === 'rate_limited' ? 'rate_limited'
                        : 'unknown';
        return {
            ...base,
            destinationStatus: statusName === 'timeout' ? 'timeout' : 'unknown',
            event: statusName === 'timeout' ? 'timeout' : 'unknown',
            reason: reason || 'network',
            billable: false,
        };
    }

    let finalHost = null;
    try {
        finalHost = new URL(finalUrl).hostname.toLowerCase();
    } catch {
        finalHost = null;
    }
    const expectedDomainOk = expectedDomain
        ? (finalHost === expectedDomain || (finalHost && finalHost.endsWith(`.${expectedDomain}`)))
        : null;
    if (expectedDomain && expectedDomainOk === false) {
        return {
            ...base,
            destinationStatus: 'redirect_domain_mismatch',
            event: 'redirect_domain_mismatch',
            reason: 'expected_domain_mismatch',
            expectedDomainOk: false,
            contentHash: contentHash(body),
            billable: true,
        };
    }

    if (BROKEN_STATUSES.has(status)) {
        return {
            ...base,
            destinationStatus: 'broken',
            event: 'broken',
            reason: `http_${status}`,
            expectedDomainOk,
            contentHash: contentHash(body),
            billable: true,
        };
    }
    if (UNKNOWN_STATUSES.has(status) || status < 200 || status >= 400) {
        return {
            ...base,
            destinationStatus: 'unknown',
            event: 'unknown',
            reason: `http_${status}`,
            expectedDomainOk,
            contentHash: contentHash(body),
            billable: false,
        };
    }

    const text = typeof body === 'string' ? body : '';
    const hash = contentHash(text);
    let requiredTextOk = true;
    for (const needle of requiredText) {
        if (!text.includes(needle)) {
            requiredTextOk = false;
            break;
        }
    }
    let forbiddenTextOk = true;
    for (const needle of forbiddenText) {
        if (text.includes(needle)) {
            forbiddenTextOk = false;
            break;
        }
    }

    if (!requiredTextOk) {
        return {
            ...base,
            destinationStatus: 'assertion_failed',
            event: 'required_text_missing',
            reason: 'required_text_missing',
            expectedDomainOk,
            requiredTextOk: false,
            forbiddenTextOk,
            contentHash: hash,
            billable: true,
        };
    }
    if (!forbiddenTextOk) {
        return {
            ...base,
            destinationStatus: 'assertion_failed',
            event: 'forbidden_text_present',
            reason: 'forbidden_text_present',
            expectedDomainOk,
            requiredTextOk: true,
            forbiddenTextOk: false,
            contentHash: hash,
            billable: true,
        };
    }

    return {
        ...base,
        destinationStatus: 'ok',
        event: 'ok',
        reason: null,
        expectedDomainOk: expectedDomainOk ?? true,
        requiredTextOk: true,
        forbiddenTextOk: true,
        contentHash: hash,
        billable: true,
    };
}

/** Failure statuses that participate in two-strike confirmation. */
export function isFailureStatus(destinationStatus) {
    return destinationStatus === 'broken'
        || destinationStatus === 'redirect_domain_mismatch'
        || destinationStatus === 'assertion_failed';
}

export function isUnknownStatus(destinationStatus) {
    return destinationStatus === 'unknown'
        || destinationStatus === 'timeout'
        || destinationStatus === 'blocked'
        || destinationStatus === 'budget_exhausted'
        || destinationStatus === 'rate_limited'
        || destinationStatus === 'too_many_redirects';
}
