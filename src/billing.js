import { LEDGER_KEY_PREFIX } from './constants.js';

export function createCharger({ chargeFn, store = null, runId, scope }) {
    const memory = new Set();
    const ledgerKey = `${LEDGER_KEY_PREFIX}${runId}`;

    async function chargeOnce(eventName, key) {
        const memKey = `${eventName}:${key}`;
        if (memory.has(memKey)) {
            return result(eventName, false, 'duplicate_suppressed', 0, false);
        }
        let ledger = null;
        if (store) {
            const existing = await store.get(ledgerKey);
            ledger = existing && existing.runId === runId && existing.scope === scope
                ? existing
                : { runId, scope, keys: {} };
            if (ledger.keys?.[memKey]) {
                memory.add(memKey);
                const status = ledger.keys[memKey];
                return result(eventName, status === 'charged', 'duplicate_suppressed', status === 'charged' ? 1 : 0, false);
            }
            ledger.keys[memKey] = 'pending';
            await store.set(ledgerKey, ledger);
        }
        memory.add(memKey);
        try {
            const response = await chargeFn({ eventName, count: 1 });
            if (response?.notOnPlatform) {
                if (ledger) {
                    ledger.keys[memKey] = 'not_on_platform';
                    await store.set(ledgerKey, ledger);
                }
                return result(eventName, false, 'not_on_platform', 0, false);
            }
            if (response?.pricingNotConfigured) {
                if (ledger) {
                    ledger.keys[memKey] = 'pricing_not_configured';
                    await store.set(ledgerKey, ledger);
                }
                return result(eventName, false, 'pricing_not_configured', 0, false);
            }
            const chargedCount = Number.isInteger(response?.chargedCount) ? response.chargedCount : 0;
            const eventChargeLimitReached = Boolean(response?.eventChargeLimitReached);
            const charged = chargedCount >= 1;
            if (ledger) {
                ledger.keys[memKey] = charged ? 'charged' : 'rejected';
                await store.set(ledgerKey, ledger);
            }
            return result(
                eventName,
                charged,
                charged ? 'charged' : (eventChargeLimitReached ? 'charge_limit_reached' : 'charge_not_accepted'),
                chargedCount,
                eventChargeLimitReached,
            );
        } catch (error) {
            if (ledger) {
                ledger.keys[memKey] = 'failed';
                await store.set(ledgerKey, ledger);
            }
            return { ...result(eventName, false, 'charge_failed', 0, false), error: error?.message || 'charge_failed' };
        }
    }

    return {
        async charge(eventName, key) {
            return chargeOnce(eventName, key);
        },
    };
}

function result(eventName, charged, reason, chargedCount, eventChargeLimitReached) {
    return { eventName, charged, reason, chargedCount, eventChargeLimitReached };
}
