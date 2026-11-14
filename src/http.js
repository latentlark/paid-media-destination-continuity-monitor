import { HARD_LIMITS, USER_AGENT } from './constants.js';
import { extractClientRedirect, paramsFromUrl } from './params.js';
import { assertPublicHostname, assertPublicResolution } from './ssrf.js';

export function createBudget(limit) {
    let used = 0;
    return {
        get used() {
            return used;
        },
        get limit() {
            return limit;
        },
        remaining() {
            return Math.max(0, limit - used);
        },
        tryTake() {
            if (used >= limit) return false;
            used += 1;
            return true;
        },
    };
}

export function createRateLimiter({ now, sleep, intervalMs }) {
    const last = new Map();
    return async function wait(hostname, deadlineMs) {
        const previous = last.get(hostname);
        const time = now();
        if (previous != null && time - previous < intervalMs) {
            const delay = intervalMs - (time - previous);
            if (time + delay > deadlineMs) return false;
            await sleep(delay);
        }
        if (now() > deadlineMs) return false;
        last.set(hostname, now());
        return true;
    };
}

/**
 * Per-host start spacing plus a cap on in-flight requests to the same host.
 * enter() resolves true when a slot is reserved, false if the deadline would be missed.
 * Call leave() once for every successful enter(), including after errors.
 */
export function createHostScheduler({ now, sleep, intervalMs, perHostConcurrency = 1 }) {
    const hosts = new Map();
    const limit = Math.max(1, perHostConcurrency);

    function get(hostname) {
        let state = hosts.get(hostname);
        if (!state) {
            state = { active: 0, lastStart: null, queue: [], pumping: false };
            hosts.set(hostname, state);
        }
        return state;
    }

    async function pump(state) {
        if (state.pumping) return;
        state.pumping = true;
        try {
            while (state.queue.length > 0) {
                if (state.active >= limit) return;
                const job = state.queue[0];
                const time = now();
                if (time > job.deadlineMs) {
                    state.queue.shift();
                    job.resolve(false);
                    continue;
                }
                const wait = state.lastStart == null ? 0 : Math.max(0, intervalMs - (time - state.lastStart));
                if (wait > 0) {
                    if (time + wait > job.deadlineMs) {
                        state.queue.shift();
                        job.resolve(false);
                        continue;
                    }
                    await sleep(wait);
                    continue;
                }
                state.queue.shift();
                state.active += 1;
                state.lastStart = now();
                job.resolve(true);
            }
        } finally {
            state.pumping = false;
            if (state.queue.length > 0 && state.active < limit) {
                const time = now();
                const wait = state.lastStart == null ? 0 : Math.max(0, intervalMs - (time - state.lastStart));
                if (wait <= 0) {
                    queueMicrotask(() => { pump(state); });
                }
            }
        }
    }

    return {
        async enter(hostname, deadlineMs) {
            if (now() > deadlineMs) return false;
            const state = get(hostname);
            return await new Promise((resolve) => {
                state.queue.push({ resolve, deadlineMs });
                pump(state);
            });
        },
        leave(hostname) {
            const state = get(hostname);
            state.active = Math.max(0, state.active - 1);
            pump(state);
        },
    };
}

export function parseRetryAfter(value, nowMs) {
    if (value == null || value === '') return null;
    const text = Array.isArray(value) ? String(value[0] ?? '') : String(value);
    const trimmed = text.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return Math.max(0, parsed - nowMs);
    return null;
}

function safeHeaders(headers) {
    const out = {};
    if (!headers || typeof headers !== 'object') return out;
    for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (lower === 'set-cookie' || lower === 'cookie' || lower === 'authorization' || lower === 'proxy-authorization') {
            continue;
        }
        out[lower] = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    }
    return out;
}

function header(headers, name) {
    return headers?.[name] ?? null;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NO_RETRY_REASONS = new Set([
    'private_address',
    'ip_literal',
    'numeric_host',
    'blocked_host',
    'blocked_suffix',
    'single_label',
    'hostname',
    'credentials',
    'protocol',
    'port',
    'path',
    'not_allowed',
    'request_budget_exhausted',
    'body_too_large',
]);

/**
 * One pinned HTTPS GET. Redirects are not followed by the runtime; each hop is
 * revalidated. At most one retry, and only when Retry-After fits the deadline
 * and the configured bound.
 */
export function createPinnedFetcher({
    resolve,
    transport,
    now,
    sleep,
    budget,
    deadlineMs,
    allow,
    rateLimitMs = HARD_LIMITS.rateLimitMs,
    perHostConcurrency = HARD_LIMITS.defaultConcurrencyPerHost,
    maxRetries = HARD_LIMITS.maxRetries,
    maxRedirects = HARD_LIMITS.maxRedirects,
    maxRetryAfterMs = HARD_LIMITS.maxRetryAfterMs,
    accept = 'text/html,application/xhtml+xml,application/json,text/javascript;q=0.9,*/*;q=0.8',
    followClientRedirects = false,
}) {
    const scheduler = createHostScheduler({
        now,
        sleep,
        intervalMs: rateLimitMs,
        perHostConcurrency,
    });

    async function prepare(url) {
        if (url.protocol !== 'https:') return { ok: false, reason: 'protocol', blocked: true };
        if (url.username || url.password) return { ok: false, reason: 'credentials', blocked: true };
        if (url.port && url.port !== '443') return { ok: false, reason: 'port', blocked: true };
        let hostname;
        try {
            hostname = assertPublicHostname(url.hostname);
        } catch (error) {
            return { ok: false, reason: error.reason || 'hostname', blocked: true };
        }
        const permitted = await allow(new URL(url.toString()));
        if (!permitted) return { ok: false, reason: 'not_allowed', blocked: true };
        let records;
        try {
            records = await resolve(hostname);
        } catch {
            return { ok: false, reason: 'dns_failure', blocked: false };
        }
        try {
            const clean = assertPublicResolution(records);
            return { ok: true, hostname, address: clean[0].address, family: clean[0].family };
        } catch (error) {
            return { ok: false, reason: error.reason || 'private_address', blocked: true };
        }
    }

    async function requestOnce(url) {
        if (now() > deadlineMs) return { received: false, reason: 'timeout', blocked: false };
        const prepared = await prepare(url);
        if (!prepared.ok) {
            return { received: false, reason: prepared.reason, blocked: Boolean(prepared.blocked), status: null };
        }
        const turned = await scheduler.enter(prepared.hostname, deadlineMs);
        if (!turned) return { received: false, reason: 'timeout', blocked: false, status: null };
        try {
            if (now() > deadlineMs) return { received: false, reason: 'timeout', blocked: false, status: null };
            if (!budget.tryTake()) return { received: false, reason: 'request_budget_exhausted', blocked: false, status: null };
            const timeoutMs = Math.max(1, Math.min(15_000, deadlineMs - now()));
            const response = await transport({
                hostname: prepared.hostname,
                address: prepared.address,
                family: prepared.family,
                path: `${url.pathname}${url.search}`,
                timeoutMs,
                headers: {
                    Host: prepared.hostname,
                    'User-Agent': USER_AGENT,
                    Accept: accept,
                    'Accept-Encoding': 'identity',
                },
            });
            const headers = safeHeaders(response?.headers);
            const body = typeof response?.body === 'string' ? response.body : '';
            if (body.length > HARD_LIMITS.maxBodyBytes) {
                return { received: false, reason: 'body_too_large', blocked: false, status: response?.status ?? null, headers };
            }
            return {
                received: true,
                status: Number(response?.status ?? 0),
                headers,
                body,
                finalUrl: `https://${prepared.hostname}${url.pathname}${url.search}`,
                reason: null,
                blocked: false,
            };
        } catch (error) {
            const code = error?.code === 'body_too_large' || error?.message === 'body_too_large'
                ? 'body_too_large'
                : error?.code === 'timeout' || error?.message === 'timeout'
                    ? 'timeout'
                    : 'network';
            return { received: false, reason: code, blocked: false, status: null };
        } finally {
            scheduler.leave(prepared.hostname);
        }
    }

    function recordHop(hops, url, result, kind = 'http') {
        hops.push({
            url: url.toString(),
            status: result.status ?? null,
            location: result.received ? (header(result.headers, 'location') || null) : null,
            params: paramsFromUrl(url),
            reason: result.reason || null,
            received: Boolean(result.received),
            kind,
        });
    }

    async function fetchOnceChain(startUrl, retriesLeft, hops = [], redirects = 0) {
        let url = startUrl;
        while (true) {
            const result = await requestOnce(url);
            recordHop(hops, url, result, 'http');
            if (!result.received) {
                if (retriesLeft > 0 && !NO_RETRY_REASONS.has(result.reason) && result.reason !== 'timeout' && now() <= deadlineMs) {
                    hops.pop();
                    return fetchOnceChain(url, retriesLeft - 1, hops, redirects);
                }
                return { ...result, redirectChain: hops };
            }
            if (REDIRECT_STATUSES.has(result.status)) {
                if (redirects >= maxRedirects) {
                    return { ...result, received: false, reason: 'too_many_redirects', body: null, redirectChain: hops };
                }
                const location = header(result.headers, 'location');
                if (!location) return { ...result, received: false, reason: 'redirect_missing_location', body: null, redirectChain: hops };
                let next;
                try {
                    next = new URL(location, url);
                } catch {
                    return { ...result, received: false, reason: 'redirect_invalid', blocked: true, body: null, redirectChain: hops };
                }
                redirects += 1;
                url = next;
                continue;
            }
            if (RETRY_STATUSES.has(result.status) && retriesLeft > 0) {
                const retryAfter = parseRetryAfter(header(result.headers, 'retry-after'), now());
                const delay = retryAfter == null ? 0 : retryAfter;
                if (delay > maxRetryAfterMs || now() + Math.max(delay, 0) > deadlineMs) {
                    return {
                        ...result,
                        reason: result.status === 429 ? 'rate_limited' : 'http_error',
                        redirectChain: hops,
                    };
                }
                if (delay > 0) await sleep(delay);
                hops.pop();
                return fetchOnceChain(url, retriesLeft - 1, hops, redirects);
            }
            if (result.status === 429) result.reason = 'rate_limited';
            if (followClientRedirects && result.body && redirects < maxRedirects) {
                const next = extractClientRedirect(result.body, url);
                if (next && next.toString() !== url.toString()) {
                    hops[hops.length - 1].location = next.toString();
                    hops[hops.length - 1].kind = 'client';
                    redirects += 1;
                    url = next;
                    continue;
                }
            }
            return { ...result, redirectChain: hops };
        }
    }

    return {
        async fetch(urlString) {
            let url;
            try {
                url = new URL(urlString);
            } catch {
                return { received: false, reason: 'url', blocked: true, status: null, redirectChain: [] };
            }
            return fetchOnceChain(url, maxRetries);
        },
    };
}
