import { CHARGE_DESTINATION, CHARGE_SHOPIFY } from './constants.js';
import { FatalInputError } from './errors.js';

export function assertChargeEventsConfigured(pricing) {
    const prices = pricing?.perEventPrices;
    const ok = pricing?.isPayPerEvent === true
        && prices
        && typeof prices === 'object'
        && typeof prices[CHARGE_DESTINATION] === 'number'
        && Number.isFinite(prices[CHARGE_DESTINATION])
        && prices[CHARGE_DESTINATION] >= 0
        && typeof prices[CHARGE_SHOPIFY] === 'number'
        && Number.isFinite(prices[CHARGE_SHOPIFY])
        && prices[CHARGE_SHOPIFY] >= 0;
    if (!ok) {
        throw new FatalInputError(
            `Pay-per-event events ${CHARGE_DESTINATION} and ${CHARGE_SHOPIFY} must be configured before any request. Proposed prices: $0.004 and $0.005. Blocked/unknown stay free.`,
        );
    }
    return {
        destination: { eventName: CHARGE_DESTINATION, configuredPriceUsd: prices[CHARGE_DESTINATION] },
        shopify: { eventName: CHARGE_SHOPIFY, configuredPriceUsd: prices[CHARGE_SHOPIFY] },
    };
}
