import { LEDGER_KEY_PREFIX } from './constants.js';

export function createCharger({ chargeFn, store = null, runId, scope }) {
    const memory = new Set();
    const ledgerKey = `${LEDGER_KEY_PREFIX}${runId}`;
    let ledger = null;
    let dirty = false;
    let unsynced = 0;
    let loaded = false;

    async function loadLedger() {
        if (loaded || !store) return;
        const existing = await store.get(ledgerKey);
        ledger = existing && existing.runId === runId && existing.scope === scope
            ? existing
            : { runId, scope, keys: {} };
        loaded = true;
        for (const [memKey, status] of Object.entries(ledger.keys || {})) {
            memory.add(memKey);
        }
    }

    async function flush() {
        if (!store || !dirty || !ledger) return;
        await store.set(ledgerKey, ledger);
        dirty = false;
        unsynced = 0;
    }

    function mark(memKey, status) {
        if (!ledger) {
            ledger = { runId, scope, keys: {} };
        }
        ledger.keys[memKey] = status;
        dirty = true;
        unsynced += 1;
    }

    async function maybeFlush() {
        if (unsynced >= 25) await flush();
    }

    async function chargeOnce(eventName, key) {
        const memKey = `${eventName}:${key}`;
        if (memory.has(memKey)) {
            const status = ledger?.keys?.[memKey];
            if (status === 'charged') {
                return result(eventName, true, 'duplicate_suppressed', 1, false);
            }
            return result(eventName, false, 'duplicate_suppressed', 0, false);
        }
        await loadLedger();
        if (ledger?.keys?.[memKey]) {
            memory.add(memKey);
            const status = ledger.keys[memKey];
            return result(eventName, status === 'charged', 'duplicate_suppressed', status === 'charged' ? 1 : 0, false);
        }
        memory.add(memKey);
        mark(memKey, 'pending');
        try {
            const response = await chargeFn({ eventName, count: 1 });
            if (response?.notOnPlatform) {
                mark(memKey, 'not_on_platform');
                await maybeFlush();
                return result(eventName, false, 'not_on_platform', 0, false);
            }
            if (response?.pricingNotConfigured) {
                mark(memKey, 'pricing_not_configured');
                await maybeFlush();
                return result(eventName, false, 'pricing_not_configured', 0, false);
            }
            const chargedCount = Number.isInteger(response?.chargedCount) ? response.chargedCount : 0;
            const eventChargeLimitReached = Boolean(response?.eventChargeLimitReached);
            const charged = chargedCount >= 1;
            mark(memKey, charged ? 'charged' : 'rejected');
            await maybeFlush();
            return result(
                eventName,
                charged,
                charged ? 'charged' : (eventChargeLimitReached ? 'charge_limit_reached' : 'charge_not_accepted'),
                chargedCount,
                eventChargeLimitReached,
            );
        } catch (error) {
            mark(memKey, 'failed');
            await maybeFlush();
            return { ...result(eventName, false, 'charge_failed', 0, false), error: error?.message || 'charge_failed' };
        }
    }

    return {
        async charge(eventName, key) {
            return chargeOnce(eventName, key);
        },
        flush,
    };
}

function result(eventName, charged, reason, chargedCount, eventChargeLimitReached) {
    return { eventName, charged, reason, chargedCount, eventChargeLimitReached };
}
