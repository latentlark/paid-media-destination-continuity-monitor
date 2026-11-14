import { RULE_VERSION, SCHEMA_VERSION, SNAPSHOT_PREFIX } from './constants.js';
import { isFailureStatus, isUnknownStatus } from './landing.js';
import { isShopifyFailure } from './shopify.js';

export function snapshotKey(runId) {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(runId)) {
        throw new Error('invalid run id for snapshot key');
    }
    return `${SNAPSHOT_PREFIX}${runId}`;
}

export function compareSnapshots(left, right) {
    if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
    if (left.completedAt !== right.completedAt) return left.completedAt < right.completedAt ? -1 : 1;
    if (left.runId === right.runId) return 0;
    return left.runId < right.runId ? -1 : 1;
}

export function snapshotRejection(snapshot, scope) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'invalid_snapshot';
    if (snapshot.schemaVersion !== SCHEMA_VERSION) return 'schema';
    if (snapshot.status !== 'complete') return 'incomplete';
    if (snapshot.scope !== scope) return 'scope_mismatch';
    if (typeof snapshot.runId !== 'string' || typeof snapshot.startedAt !== 'string' || typeof snapshot.completedAt !== 'string') {
        return 'invalid_snapshot';
    }
    if (!snapshot.destinations || typeof snapshot.destinations !== 'object' || Array.isArray(snapshot.destinations)) {
        return 'invalid_snapshot';
    }
    return null;
}

export function emptyDestinationState() {
    return {
        destinationStatus: null,
        contentHash: null,
        finalUrl: null,
        consecutiveFailures: 0,
        consecutiveOk: 0,
        confirmedFailure: false,
        confirmedOk: false,
        shopifyAvailability: null,
        consecutiveShopifyFailures: 0,
        confirmedShopifyFailure: false,
        observedAt: null,
        baselinePreserved: false,
    };
}

/**
 * Fold destination records. Unknown/timeout/blocked never increment failure strikes
 * and never clear a confirmed failure or last-good baseline.
 */
export function foldSnapshots(snapshots, confirmFailures = 2) {
    const state = new Map();
    for (const snapshot of snapshots) {
        for (const [key, record] of Object.entries(snapshot.destinations || {})) {
            if (!record || typeof record !== 'object') continue;
            const current = state.get(key) ?? emptyDestinationState();
            if (record.kind === 'unknown') {
                state.set(key, {
                    ...current,
                    baselinePreserved: true,
                    observedAt: record.observedAt ?? current.observedAt,
                });
                continue;
            }
            if (record.kind === 'observation') {
                const next = { ...current, observedAt: record.observedAt ?? null, baselinePreserved: false };
                if (isFailureStatus(record.destinationStatus)) {
                    next.destinationStatus = record.destinationStatus;
                    next.contentHash = record.contentHash ?? current.contentHash;
                    next.finalUrl = record.finalUrl ?? current.finalUrl;
                    next.consecutiveFailures = (current.destinationStatus === record.destinationStatus
                        ? current.consecutiveFailures
                        : 0) + 1;
                    // count consecutive failures of any failure type
                    next.consecutiveFailures = current.consecutiveFailures + 1;
                    if (current.destinationStatus && current.destinationStatus !== record.destinationStatus
                        && isFailureStatus(current.destinationStatus)) {
                        // still a failure streak across different failure flavors
                        next.consecutiveFailures = current.consecutiveFailures + 1;
                    } else if (!isFailureStatus(current.destinationStatus || '')) {
                        next.consecutiveFailures = 1;
                    }
                    next.consecutiveOk = 0;
                    next.confirmedOk = false;
                    if (next.consecutiveFailures >= confirmFailures) next.confirmedFailure = true;
                } else if (record.destinationStatus === 'ok') {
                    next.destinationStatus = 'ok';
                    next.contentHash = record.contentHash ?? null;
                    next.finalUrl = record.finalUrl ?? null;
                    next.consecutiveOk = (current.destinationStatus === 'ok' ? current.consecutiveOk : 0) + 1;
                    next.consecutiveFailures = 0;
                    if (next.consecutiveOk >= confirmFailures) {
                        next.confirmedFailure = false;
                        next.confirmedOk = true;
                    }
                } else {
                    next.destinationStatus = record.destinationStatus;
                }

                if (record.shopifyAvailability != null) {
                    if (isShopifyFailure(record.shopifyAvailability)) {
                        next.shopifyAvailability = record.shopifyAvailability;
                        next.consecutiveShopifyFailures = (current.shopifyAvailability === 'out_of_stock'
                            ? current.consecutiveShopifyFailures
                            : 0) + 1;
                        if (next.consecutiveShopifyFailures >= confirmFailures) {
                            next.confirmedShopifyFailure = true;
                        }
                    } else if (record.shopifyAvailability === 'in_stock') {
                        next.shopifyAvailability = 'in_stock';
                        next.consecutiveShopifyFailures = 0;
                        if ((current.shopifyAvailability === 'in_stock' ? 1 : 0) + 1 >= confirmFailures
                            || current.confirmedShopifyFailure) {
                            // clear confirmed OOS after confirmFailures consecutive in_stock
                        }
                        const okStreak = current.shopifyAvailability === 'in_stock'
                            ? (current._shopifyOkStreak || 0) + 1
                            : 1;
                        next._shopifyOkStreak = okStreak;
                        if (okStreak >= confirmFailures) next.confirmedShopifyFailure = false;
                    } else {
                        // unknown shopify — preserve
                        next.baselinePreserved = true;
                    }
                }
                state.set(key, next);
            }
        }
    }
    return state;
}

export function eligibleSnapshots(snapshots, { scope, startedAt }) {
    return snapshots
        .filter((snapshot) => snapshotRejection(snapshot, scope) === null && snapshot.startedAt < startedAt)
        .sort(compareSnapshots);
}

export function normalizePreviousInput(value, scope) {
    if (value == null) return { snapshots: [], rejections: [] };
    const list = Array.isArray(value) ? value : [value];
    const snapshots = [];
    const rejections = [];
    list.forEach((snapshot, index) => {
        const reason = snapshotRejection(snapshot, scope);
        if (reason) rejections.push({ index, reason });
        else snapshots.push(snapshot);
    });
    return { snapshots, rejections };
}

export async function loadSnapshotHistory(store, { scope, startedAt, previousSnapshot, maxSnapshots = 50, confirmFailures = 2 }) {
    const listed = store?.listKeys ? await store.listKeys() : [];
    const keys = (Array.isArray(listed) ? listed : listed?.keys || []).filter((key) => String(key).startsWith(SNAPSHOT_PREFIX));
    const explicit = normalizePreviousInput(previousSnapshot, scope);
    if (keys.length > maxSnapshots) {
        return {
            folded: foldSnapshots(eligibleSnapshots(explicit.snapshots, { scope, startedAt }), confirmFailures),
            trusted: explicit.snapshots.length > 0,
            truncated: true,
            rejections: explicit.rejections,
            usedStore: false,
        };
    }
    const stored = [];
    for (const key of keys) {
        const snapshot = await store.get(key);
        if (snapshot) stored.push(snapshot);
    }
    const byId = new Map();
    for (const snapshot of [...stored, ...explicit.snapshots]) {
        if (!byId.has(snapshot.runId)) byId.set(snapshot.runId, snapshot);
    }
    const combined = [...byId.values()];
    return {
        folded: foldSnapshots(eligibleSnapshots(combined, { scope, startedAt }), confirmFailures),
        trusted: true,
        truncated: false,
        rejections: explicit.rejections,
        usedStore: stored.length > 0,
    };
}

export async function appendSnapshot(store, snapshot) {
    const key = snapshotKey(snapshot.runId);
    const existing = await store.get(key);
    if (existing) return { written: false, reason: 'snapshot_already_exists', key };
    await store.set(key, snapshot);
    return { written: true, reason: 'appended', key };
}

export function buildSnapshot({ scope, runId, startedAt, completedAt, destinations }) {
    return {
        schemaVersion: SCHEMA_VERSION,
        ruleVersion: RULE_VERSION,
        recordType: 'run_snapshot',
        status: 'complete',
        scope,
        runId,
        startedAt,
        completedAt,
        destinations,
    };
}

export function applyTwoStrike({ previous, observation, confirmFailures = 2 }) {
    const prev = previous ?? emptyDestinationState();
    const unknown = isUnknownStatus(observation.destinationStatus);
    if (unknown) {
        return {
            ...prev,
            baselinePreserved: true,
            event: observation.event,
            destinationStatus: observation.destinationStatus,
            previousDestinationStatus: prev.destinationStatus,
            confirmedFailure: prev.confirmedFailure,
            consecutiveFailures: prev.consecutiveFailures,
            impactedTransition: null,
        };
    }

    let consecutiveFailures = prev.consecutiveFailures;
    let consecutiveOk = prev.consecutiveOk || 0;
    let confirmedFailure = prev.confirmedFailure;
    let confirmedOk = prev.confirmedOk;
    let impactedTransition = null;

    if (isFailureStatus(observation.destinationStatus)) {
        consecutiveFailures = isFailureStatus(prev.destinationStatus || '') ? consecutiveFailures + 1 : 1;
        consecutiveOk = 0;
        confirmedOk = false;
        if (consecutiveFailures >= confirmFailures && !prev.confirmedFailure) {
            confirmedFailure = true;
            impactedTransition = 'confirmed_failure';
        } else if (consecutiveFailures >= confirmFailures) {
            confirmedFailure = true;
            impactedTransition = 'still_confirmed_failure';
        } else {
            impactedTransition = 'failure_pending_confirmation';
        }
    } else if (observation.destinationStatus === 'ok') {
        consecutiveOk = prev.destinationStatus === 'ok' ? consecutiveOk + 1 : 1;
        consecutiveFailures = 0;
        if (consecutiveOk >= confirmFailures && prev.confirmedFailure) {
            confirmedFailure = false;
            confirmedOk = true;
            impactedTransition = 'confirmed_recovery';
        } else if (prev.confirmedFailure) {
            impactedTransition = 'recovery_pending_confirmation';
        } else {
            confirmedOk = consecutiveOk >= confirmFailures;
            impactedTransition = prev.destinationStatus === 'ok' ? 'unchanged_ok' : 'became_ok';
        }
    }

    // Shopify two-strike
    let shopifyAvailability = prev.shopifyAvailability;
    let consecutiveShopifyFailures = prev.consecutiveShopifyFailures || 0;
    let confirmedShopifyFailure = prev.confirmedShopifyFailure || false;
    let shopifyTransition = null;
    if (observation.shopifyAvailability === 'out_of_stock') {
        consecutiveShopifyFailures = prev.shopifyAvailability === 'out_of_stock' ? consecutiveShopifyFailures + 1 : 1;
        shopifyAvailability = 'out_of_stock';
        if (consecutiveShopifyFailures >= confirmFailures && !prev.confirmedShopifyFailure) {
            confirmedShopifyFailure = true;
            shopifyTransition = 'confirmed_oos';
        } else if (consecutiveShopifyFailures >= confirmFailures) {
            confirmedShopifyFailure = true;
            shopifyTransition = 'still_confirmed_oos';
        } else {
            shopifyTransition = 'oos_pending_confirmation';
        }
    } else if (observation.shopifyAvailability === 'in_stock') {
        const okStreak = prev.shopifyAvailability === 'in_stock' ? (prev._shopifyOkStreak || 0) + 1 : 1;
        shopifyAvailability = 'in_stock';
        consecutiveShopifyFailures = 0;
        if (okStreak >= confirmFailures && prev.confirmedShopifyFailure) {
            confirmedShopifyFailure = false;
            shopifyTransition = 'confirmed_restock';
        } else if (prev.confirmedShopifyFailure) {
            shopifyTransition = 'restock_pending_confirmation';
        } else {
            shopifyTransition = 'in_stock';
        }
        return {
            destinationStatus: observation.destinationStatus,
            previousDestinationStatus: prev.destinationStatus,
            contentHash: observation.contentHash ?? prev.contentHash,
            finalUrl: observation.finalUrl ?? prev.finalUrl,
            consecutiveFailures,
            consecutiveOk,
            confirmedFailure,
            confirmedOk,
            shopifyAvailability,
            consecutiveShopifyFailures,
            confirmedShopifyFailure,
            _shopifyOkStreak: okStreak,
            observedAt: observation.observedAt,
            baselinePreserved: false,
            event: observation.event,
            impactedTransition,
            shopifyTransition,
        };
    } else if (observation.shopifyAvailability != null) {
        // unknown — preserve shopify baseline
        shopifyTransition = 'shopify_unknown_preserved';
    }

    return {
        destinationStatus: observation.destinationStatus,
        previousDestinationStatus: prev.destinationStatus,
        contentHash: observation.contentHash ?? prev.contentHash,
        finalUrl: observation.finalUrl ?? prev.finalUrl,
        consecutiveFailures,
        consecutiveOk,
        confirmedFailure,
        confirmedOk,
        shopifyAvailability,
        consecutiveShopifyFailures,
        confirmedShopifyFailure,
        observedAt: observation.observedAt,
        baselinePreserved: false,
        event: observation.event,
        impactedTransition,
        shopifyTransition,
    };
}
