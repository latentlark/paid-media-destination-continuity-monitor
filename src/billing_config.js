import { CHARGE_DESTINATION, CHARGE_LINK, CHARGE_LINK_BROWSER, CHARGE_SHOPIFY } from './constants.js';
import { FatalInputError } from './errors.js';

function priceOk(prices, name) {
    return prices
        && typeof prices === 'object'
        && typeof prices[name] === 'number'
        && Number.isFinite(prices[name])
        && prices[name] >= 0;
}

export function isPayPerEventConfigured(pricing) {
    const prices = pricing?.perEventPrices;
    return pricing?.isPayPerEvent === true
        && priceOk(prices, CHARGE_DESTINATION)
        && priceOk(prices, CHARGE_SHOPIFY);
}

export function assertChargeEventsConfigured(pricing) {
    if (!isPayPerEventConfigured(pricing)) {
        throw new FatalInputError(
            `Pay-per-event events ${CHARGE_DESTINATION} and ${CHARGE_SHOPIFY} must be configured before any request. Prices: $0.004 and $0.005. Blocked/unknown stay free.`,
        );
    }
    const prices = pricing.perEventPrices;
    return {
        destination: { eventName: CHARGE_DESTINATION, configuredPriceUsd: prices[CHARGE_DESTINATION] },
        shopify: { eventName: CHARGE_SHOPIFY, configuredPriceUsd: prices[CHARGE_SHOPIFY] },
    };
}

function optionalEvent(prices, name) {
    if (!priceOk(prices, name)) return null;
    return { eventName: name, configuredPriceUsd: prices[name] };
}

/** Private or free Actors can run without PPE. Charges then report not_on_platform. */
export function resolvePricingMode(pricing) {
    if (!isPayPerEventConfigured(pricing)) {
        return { mode: 'free', ready: true, destination: null, shopify: null, link: null, linkBrowser: null, configuredEvents: new Set() };
    }
    const prices = pricing.perEventPrices;
    const configuredEvents = new Set([CHARGE_DESTINATION, CHARGE_SHOPIFY]);
    const link = optionalEvent(prices, CHARGE_LINK);
    const linkBrowser = optionalEvent(prices, CHARGE_LINK_BROWSER);
    if (link) configuredEvents.add(CHARGE_LINK);
    if (linkBrowser) configuredEvents.add(CHARGE_LINK_BROWSER);
    return {
        mode: 'ppe',
        ready: true,
        ...assertChargeEventsConfigured(pricing),
        link,
        linkBrowser,
        configuredEvents,
    };
}
