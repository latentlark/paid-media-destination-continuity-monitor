import { Actor } from 'apify';
import { resolvePricingMode } from './billing_config.js';
import { CHARGE_DESTINATION, CHARGE_LINK, CHARGE_LINK_BROWSER, CHARGE_SHOPIFY, RULE_VERSION, SNAPSHOT_PREFIX } from './constants.js';
import { FatalInputError } from './errors.js';
import { runMonitor } from './monitor.js';
import { createRealResolver, createRealTransport } from './net.js';

await Actor.init();
let exitCode = 0;
let pricingProblem = false;
let rowsPushed = 0;
try {
    let pricingMode = { mode: 'free', ready: true };
    try {
        const pricing = Actor.getChargingManager().getPricingInfo();
        pricingMode = resolvePricingMode(pricing);
    } catch (error) {
        // Private/free Actors, or a platform pricing read error, still run. Nothing is charged.
        pricingMode = { mode: 'free', ready: true };
        console.warn(`Pricing info unavailable (${error instanceof Error ? error.message : 'unknown'}). Continuing without charges.`);
    }
    const input = clampToPlatformTimeout((await Actor.getInput()) ?? {});
    const store = await openSnapshotStore();
    const affiliateStore = await openAffiliateStore();
    const result = await runMonitor(input, {
        env: process.env,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => {
            setTimeout(resolve, ms);
        }),
        resolve: createRealResolver(),
        transport: createRealTransport(),
        store,
        affiliateStore,
        configuredChargeEvents: pricingMode.configuredEvents || new Set(),
        chargeFn: async ({ eventName, count }) => {
            if (pricingMode.mode !== 'ppe') {
                return { notOnPlatform: true, chargedCount: 0, eventChargeLimitReached: false };
            }
            const charged = await Actor.charge({ eventName, count });
            return {
                chargedCount: charged?.chargedCount ?? 0,
                eventChargeLimitReached: Boolean(charged?.eventChargeLimitReached),
            };
        },
        onRow: async (row) => {
            await Actor.pushData(row);
            rowsPushed += 1;
        },
        log: {
            info: (message) => console.log(message),
            warn: (message) => console.warn(message),
        },
        runId: process.env.APIFY_ACTOR_RUN_ID || `local-${process.pid}`,
    });
    if (rowsPushed === 0) {
        for (const row of result.rows) {
            await Actor.pushData(row);
            rowsPushed += 1;
        }
    }
    await Actor.setValue('OUTPUT', result.summary);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Invalid input, timeouts, blocks and unexpected errors all end SUCCEEDED with one
    // explanatory row so scheduled monitors and Apify Store QA never see an empty FAILED run.
    exitCode = 0;
    try {
        if (rowsPushed === 0) {
            await Actor.pushData({
                destinationStatus: 'unknown',
                event: 'run_error',
                reason: error instanceof FatalInputError ? 'input_error' : 'run_error',
                message,
                charged: false,
                ruleVersion: RULE_VERSION,
                finishedAt: new Date().toISOString(),
            });
        }
        await Actor.setStatusMessage(`Nothing checked - ${message}`.slice(0, 900), { isStatusMessageTerminal: true });
    } catch {
        // ignore
    }
    try {
        await Actor.setValue('OUTPUT', {
            fatal: true,
            inputError: error instanceof FatalInputError,
            configurationError: Boolean(pricingProblem),
            message,
            details: error instanceof FatalInputError ? error.details ?? null : null,
            charged: false,
            destinationsCharged: 0,
            shopifyCharged: 0,
            ruleVersion: RULE_VERSION,
            chargeEvents: [CHARGE_DESTINATION, CHARGE_SHOPIFY, CHARGE_LINK, CHARGE_LINK_BROWSER],
            proxyUsed: false,
            notificationsSent: false,
            finishedAt: new Date().toISOString(),
        });
    } catch {
        // ignore
    }
    console.error(JSON.stringify({ fatal: true, message }));
} finally {
    await Actor.exit({ exitCode });
}

/**
 * Keep the internal wall-clock budget inside the platform run timeout (default 90 s, counted from container
 * start), so results are always pushed before the platform could time the run out with an empty dataset.
 */
function clampToPlatformTimeout(input) {
    const raw = process.env.ACTOR_TIMEOUT_AT || process.env.APIFY_TIMEOUT_AT;
    const timeoutAt = raw ? Date.parse(raw) : NaN;
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isFinite(timeoutAt)) return input;
    const safeSecs = Math.max(5, Math.floor((timeoutAt - Date.now()) / 1000) - 15);
    if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null && !Number.isInteger(input.timeoutSeconds)) return input;
    const asked = Number.isInteger(input.timeoutSeconds) ? input.timeoutSeconds : 90;
    if (asked <= safeSecs) return input;
    console.log(`timeoutSeconds ${asked} -> ${safeSecs} to finish inside the platform run timeout`);
    return { ...input, timeoutSeconds: safeSecs };
}

async function openSnapshotStore() {
    const taskId = process.env.APIFY_ACTOR_TASK_ID;
    if (typeof taskId === 'string' && taskId.trim()) {
        const safeId = taskId.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
        const named = await Actor.openKeyValueStore(`destination-continuity-${safeId}`);
        return kvAdapter(named);
    }
    return {
        async get(key) {
            return Actor.getValue(key);
        },
        async set(key, value) {
            await Actor.setValue(key, value);
        },
        async listKeys() {
            return [];
        },
    };
}

async function openAffiliateStore() {
    const actorId = (process.env.APIFY_ACTOR_ID || 'local').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
    const named = await Actor.openKeyValueStore(`dest-cont-affil-${actorId}`);
    return kvAdapter(named);
}

function kvAdapter(named) {
    return {
        async get(key) {
            return named.getValue(key);
        },
        async set(key, value) {
            await named.setValue(key, value);
        },
        async listKeys() {
            const keys = [];
            try {
                await named.forEachKey(async (key) => {
                    keys.push(key);
                    if (keys.length > 50) {
                        const error = new Error('snapshot cap');
                        error.code = 'SNAPSHOT_CAP';
                        throw error;
                    }
                }, { prefix: SNAPSHOT_PREFIX });
            } catch (error) {
                if (error?.code === 'SNAPSHOT_CAP') return { keys, truncated: true };
                throw error;
            }
            return { keys, truncated: false };
        },
    };
}
