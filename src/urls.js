import { assertPublicHostname, SsrfError } from './ssrf.js';

const HANDLE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const VARIANT_ID = /^[1-9][0-9]{0,24}$/;

export function normalizeVariantId(value) {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value <= 0) return null;
        return String(value);
    }
    if (typeof value === 'string' && VARIANT_ID.test(value.trim())) return value.trim();
    return null;
}

export function normalizeLabel(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return { error: 'label_invalid' };
    const label = value.trim();
    if (label.length === 0 || label.length > 120) return { error: 'label_invalid' };
    if (/[\u0000-\u001f\u007f]/.test(label)) return { error: 'label_invalid' };
    return { label };
}

export function normalizeTextList(value, field) {
    if (value === undefined || value === null) return { list: [] };
    if (!Array.isArray(value)) return { error: `${field}_invalid` };
    const list = [];
    for (const item of value) {
        if (typeof item !== 'string' || item.length === 0 || item.length > 200) return { error: `${field}_invalid` };
        list.push(item);
    }
    if (list.length > 20) return { error: `${field}_too_many` };
    return { list };
}

export function normalizeDomain(value) {
    if (value === undefined || value === null || value === '') return { domain: null };
    if (typeof value !== 'string') return { error: 'expected_domain_invalid' };
    try {
        const host = assertPublicHostname(value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]);
        return { domain: host };
    } catch (error) {
        return { error: error.reason || 'expected_domain_invalid' };
    }
}

function rejectUrl(reason) {
    return { error: reason instanceof SsrfError ? reason.reason : reason };
}

export function parseHttpsUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return rejectUrl('url');
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        return rejectUrl('url');
    }
    if (url.username || url.password) return rejectUrl('credentials');
    if (url.protocol !== 'https:') return rejectUrl('protocol');
    if (url.port && url.port !== '443') return rejectUrl('port');
    let hostname;
    try {
        hostname = assertPublicHostname(url.hostname);
    } catch (error) {
        return rejectUrl(error.reason || 'hostname');
    }
    if (url.pathname.includes('\\') || url.pathname.includes('..')) return rejectUrl('path');
    const pathname = url.pathname || '/';
    return {
        hostname,
        origin: `https://${hostname}`,
        pathname,
        search: url.search || '',
        href: `https://${hostname}${pathname}${url.search || ''}`,
        url,
    };
}

export function parseProductUrl(raw) {
    const base = parseHttpsUrl(raw);
    if (base.error) return base;
    const path = base.pathname.replace(/\/+$/, '') || '/';
    const match = path.match(/^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?products\/([^/]+?)(?:\.js)?$/i);
    if (!match) return rejectUrl('path');
    const locale = match[1] ? match[1].toLowerCase() : null;
    const handle = match[2].toLowerCase();
    if (!HANDLE.test(handle)) return rejectUrl('handle');
    return {
        hostname: base.hostname,
        origin: base.origin,
        locale,
        handle,
        productUrl: `https://${base.hostname}${locale ? `/${locale}` : ''}/products/${handle}`,
        productPath: `${locale ? `/${locale}` : ''}/products/${handle}.js`,
    };
}

export function destinationKey(href) {
    return href.toLowerCase();
}

export function productIdentity(product) {
    return `${product.origin}|${product.locale || ''}|${product.handle}`;
}
