import { HARD_LIMITS, SOURCE_SHOPIFY } from './constants.js';
import { normalizeVariantId } from './urls.js';

export function analyzeProductDocument(body) {
    let doc;
    try {
        doc = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
        return { ok: false, reason: 'invalid_json' };
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'invalid_json' };
    const variants = Array.isArray(doc.variants) ? doc.variants : null;
    if (!variants) return { ok: false, reason: 'no_variants' };
    const truncated = variants.length >= HARD_LIMITS.variantResponseCap;
    const byId = new Map();
    for (const variant of variants) {
        const id = normalizeVariantId(variant?.id);
        if (!id) continue;
        byId.set(id, {
            id,
            title: typeof variant.title === 'string' ? variant.title : null,
            available: variant.available === true,
            observedAvailable: variant.available === true ? true : variant.available === false ? false : null,
            priceMinor: Number.isFinite(Number(variant.price)) ? Math.round(Number(variant.price)) : null,
        });
    }
    return {
        ok: true,
        productId: doc.id != null ? String(doc.id) : null,
        handle: typeof doc.handle === 'string' ? doc.handle : null,
        returnedVariantCount: variants.length,
        truncated,
        byId,
        source: SOURCE_SHOPIFY,
    };
}

export function classifyShopifyVariant({ document, variantId, received, reason, blocked, status }) {
    const base = {
        source: SOURCE_SHOPIFY,
        httpStatus: status ?? null,
        availability: null,
        variantTitle: null,
        priceMinor: null,
        productId: null,
        returnedVariantCount: null,
        truncated: false,
        charged: false,
        chargeEvent: null,
        chargeReason: 'not_billable',
        billable: false,
    };
    if (blocked) {
        return { ...base, event: 'blocked', reason: reason || 'blocked', availability: 'unknown' };
    }
    if (!received) {
        return {
            ...base,
            event: reason === 'timeout' ? 'timeout' : 'unknown',
            reason: reason || 'network',
            availability: 'unknown',
        };
    }
    if (status === 404) {
        return { ...base, event: 'product_not_found', reason: 'http_404', availability: 'unknown', billable: false };
    }
    if (status !== 200) {
        return {
            ...base,
            event: 'unknown',
            reason: `http_${status}`,
            availability: 'unknown',
            billable: false,
        };
    }
    const analyzed = analyzeProductDocument(document ?? '');
    if (!analyzed.ok) {
        return { ...base, event: 'unknown', reason: analyzed.reason, availability: 'unknown' };
    }
    const variant = analyzed.byId.get(String(variantId));
    if (!variant) {
        return {
            ...base,
            event: 'variant_not_found',
            reason: 'variant_not_found',
            availability: 'unknown',
            productId: analyzed.productId,
            returnedVariantCount: analyzed.returnedVariantCount,
            truncated: analyzed.truncated,
            billable: true,
        };
    }
    if (variant.observedAvailable === null) {
        return {
            ...base,
            event: 'unknown',
            reason: 'available_field_missing',
            availability: 'unknown',
            productId: analyzed.productId,
            variantTitle: variant.title,
            priceMinor: variant.priceMinor,
            returnedVariantCount: analyzed.returnedVariantCount,
            truncated: analyzed.truncated,
            billable: false,
        };
    }
    const availability = variant.available ? 'in_stock' : 'out_of_stock';
    return {
        ...base,
        event: availability === 'in_stock' ? 'in_stock' : 'out_of_stock',
        reason: null,
        availability,
        productId: analyzed.productId,
        variantTitle: variant.title,
        priceMinor: variant.priceMinor,
        returnedVariantCount: analyzed.returnedVariantCount,
        truncated: analyzed.truncated,
        billable: true,
        observedAvailable: variant.observedAvailable,
    };
}

export function isShopifyFailure(availability) {
    return availability === 'out_of_stock';
}
