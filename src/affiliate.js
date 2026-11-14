import { createHash } from 'node:crypto';
import { destinationKey } from './urls.js';

export const AFFILIATE_SNAPSHOT_PREFIX = 'AFFIL_SNAP_';

export function canonicalWatchlist(input) {
    const ads = [];
    if (Array.isArray(input?.ads)) ads.push(...input.ads);
    if (Array.isArray(input?.links)) {
        for (const link of input.links) {
            if (!link || typeof link !== 'object') continue;
            ads.push({
                ...link,
                destinationUrl: link.destinationUrl || link.url,
            });
        }
    }
    const rows = ads.map((item, index) => ({
        url: String(item?.destinationUrl || item?.url || '').trim(),
        expectedDomain: item?.expectedDomain ?? null,
        requiredParams: item?.requiredParams ?? null,
        label: item?.label ?? null,
        adId: item?.adId ?? `ad-${index + 1}`,
    })).filter((item) => item.url);
    rows.sort((a, b) => a.url.localeCompare(b.url) || String(a.adId).localeCompare(String(b.adId)));
    return {
        rows,
        requiredParams: input?.requiredParams ?? null,
        paramRules: input?.paramRules ?? null,
        renderMode: input?.renderMode === 'browser' ? 'browser' : 'http',
    };
}

export function inputHash(input) {
    const canonical = JSON.stringify(canonicalWatchlist(input));
    return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 24);
}

export function affiliateSnapshotKey(hash) {
    return `${AFFILIATE_SNAPSHOT_PREFIX}${hash}`;
}

export function buildAffiliateSnapshot({ inputHashValue, runId, checkedAt, links }) {
    return {
        schemaVersion: 2,
        kind: 'affiliate_watchlist',
        inputHash: inputHashValue,
        runId,
        checkedAt,
        links,
    };
}

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function isBrokenStatus(status) {
    return status === 'broken' || status === 'redirect_domain_mismatch' || status === 'assertion_failed';
}

/**
 * Compare this run to the previous snapshot for the same input hash.
 * Alerts: newly broken, changed final destination, changed param outcome.
 */
export function compareAffiliateSnapshots(previous, currentLinks) {
    const alerts = [];
    const prevLinks = previous?.links && typeof previous.links === 'object' ? previous.links : {};
    for (const [key, current] of Object.entries(currentLinks || {})) {
        const prev = prevLinks[key];
        if (!prev) continue;
        if (!isBrokenStatus(prev.destinationStatus) && isBrokenStatus(current.destinationStatus)) {
            alerts.push({
                type: 'newly_broken',
                key,
                destinationUrl: current.destinationUrl,
                previous: prev.destinationStatus,
                current: current.destinationStatus,
                severity: 'error',
            });
        }
        const prevHost = hostOf(prev.finalUrl);
        const currentHost = hostOf(current.finalUrl);
        if (prevHost && currentHost && prevHost !== currentHost) {
            alerts.push({
                type: 'destination_changed',
                key,
                destinationUrl: current.destinationUrl,
                previous: prev.finalUrl,
                current: current.finalUrl,
                severity: 'error',
            });
        }
        const prevOutcome = `${prev.trackingStatus || 'not_configured'}|${(prev.trackingIssueTypes || []).join(',')}`;
        const currentOutcome = `${current.trackingStatus || 'not_configured'}|${(current.trackingIssueTypes || []).join(',')}`;
        if (prev.trackingStatus && prev.trackingStatus !== 'not_configured' && prevOutcome !== currentOutcome) {
            alerts.push({
                type: 'param_outcome_changed',
                key,
                destinationUrl: current.destinationUrl,
                previous: prevOutcome,
                current: currentOutcome,
                severity: 'warning',
            });
        }
    }
    return alerts;
}

export function linkSnapshotRecord(row) {
    return {
        destinationUrl: row.destinationUrl,
        finalUrl: row.finalUrl,
        destinationStatus: row.destinationStatus,
        trackingStatus: row.trackingStatus,
        trackingIssueTypes: (row.trackingIssues || []).map((issue) => issue.type).sort(),
        httpStatus: row.httpStatus ?? null,
    };
}

export function watchlistKey(url) {
    return destinationKey(url);
}
