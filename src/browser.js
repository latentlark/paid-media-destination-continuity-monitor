import { HARD_LIMITS } from './constants.js';
import { extractClientRedirect, paramsFromUrl } from './params.js';
import { assertPublicHostname } from './ssrf.js';

export async function loadPlaywright() {
    const tried = [];
    const specs = ['playwright', 'playwright-core'];
    for (const spec of specs) {
        try {
            const mod = await import(spec);
            if (mod?.chromium || mod?.default?.chromium) return mod.chromium ? mod : mod.default;
            tried.push(`${spec}: no chromium export`);
        } catch (error) {
            tried.push(`${spec}: ${error?.message || error}`);
        }
    }
    try {
        const { createRequire } = await import('node:module');
        const { pathToFileURL } = await import('node:url');
        const require = createRequire(import.meta.url);
        const paths = [
            require.resolve('playwright'),
            '/home/myuser/node_modules/playwright/index.js',
            '/usr/src/app/node_modules/playwright/index.js',
        ];
        for (const file of paths) {
            try {
                const mod = await import(pathToFileURL(file).href);
                if (mod?.chromium || mod?.default?.chromium) return mod.chromium ? mod : mod.default;
            } catch (error) {
                tried.push(`${file}: ${error?.message || error}`);
            }
        }
    } catch (error) {
        tried.push(`resolve: ${error?.message || error}`);
    }
    console.warn(`Playwright not available (${tried.join('; ')})`);
    return null;
}

export async function isBrowserAvailable() {
    return Boolean(await loadPlaywright());
}

function safeHop(url, status, kind, reason = null, location = null) {
    return {
        url,
        status,
        location,
        params: paramsFromUrl(url),
        reason,
        received: status != null,
        kind,
    };
}

/**
 * Follow a URL with a headless browser so JS and meta-refresh redirects are recorded.
 * Images, fonts and media are aborted to keep the run small and cheap.
 */
export async function followWithBrowser(startUrl, {
    deadlineMs,
    now = () => Date.now(),
    maxRedirects = HARD_LIMITS.maxRedirects,
    timeoutMs = 15_000,
} = {}) {
    const playwright = await loadPlaywright();
    if (!playwright) {
        return {
            received: false,
            reason: 'browser_unavailable',
            blocked: false,
            status: null,
            body: '',
            finalUrl: startUrl,
            redirectChain: [safeHop(startUrl, null, 'browser', 'browser_unavailable')],
        };
    }
    const remaining = Math.max(1, Math.min(timeoutMs, deadlineMs ? deadlineMs - now() : timeoutMs));
    if (remaining < 500) {
        return {
            received: false,
            reason: 'timeout',
            blocked: false,
            status: null,
            body: '',
            finalUrl: startUrl,
            redirectChain: [safeHop(startUrl, null, 'browser', 'timeout')],
        };
    }
    try {
        assertPublicHostname(new URL(startUrl).hostname);
    } catch (error) {
        return {
            received: false,
            reason: error.reason || 'hostname',
            blocked: true,
            status: null,
            body: '',
            finalUrl: startUrl,
            redirectChain: [safeHop(startUrl, null, 'browser', error.reason || 'hostname')],
        };
    }

    let browser;
    const hops = [];
    const seen = new Set();
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox'],
        });
        const context = await browser.newContext({
            userAgent: 'LatentLarkDestinationContinuity/0.2 (+https://apify.com/latentlark; read-only; affiliate-link-qa)',
            javaScriptEnabled: true,
            ignoreHTTPSErrors: false,
        });
        const page = await context.newPage();
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
            return route.continue();
        });
        page.on('request', (request) => {
            if (!request.isNavigationRequest()) return;
            const url = request.url();
            if (!url.startsWith('https://') && !url.startsWith('http://')) return;
            if (seen.has(`req:${url}`)) return;
            seen.add(`req:${url}`);
            hops.push(safeHop(url, null, 'browser'));
        });
        page.on('response', (response) => {
            const request = response.request();
            if (!request.isNavigationRequest()) return;
            const url = response.url();
            const hop = [...hops].reverse().find((item) => item.url === url && item.status == null);
            if (hop) {
                hop.status = response.status();
                hop.received = true;
                const headers = response.headers();
                hop.location = headers.location || null;
            } else if (!seen.has(`res:${url}`)) {
                seen.add(`res:${url}`);
                hops.push(safeHop(url, response.status(), 'browser', null, response.headers().location || null));
            }
        });
        const response = await page.goto(startUrl, {
            waitUntil: 'domcontentloaded',
            timeout: remaining,
        });
        const settle = Math.min(2000, Math.max(200, (deadlineMs ? deadlineMs - now() : 2000)));
        if (settle > 0) {
            await page.waitForTimeout(settle);
        }
        const finalUrl = page.url();
        let body = '';
        try {
            body = await page.content();
        } catch {
            body = '';
        }
        if (hops.length === 0) {
            hops.push(safeHop(finalUrl, response?.status() ?? null, 'browser'));
        }
        if (hops.length > maxRedirects + 1) {
            return {
                received: false,
                reason: 'too_many_redirects',
                blocked: false,
                status: hops[hops.length - 1]?.status ?? null,
                body: null,
                finalUrl,
                redirectChain: hops.slice(0, maxRedirects + 1),
            };
        }
        const last = hops[hops.length - 1];
        return {
            received: true,
            reason: null,
            blocked: false,
            status: last?.status ?? response?.status() ?? 200,
            headers: {},
            body: body.length > HARD_LIMITS.maxBodyBytes ? body.slice(0, HARD_LIMITS.maxBodyBytes) : body,
            finalUrl,
            redirectChain: hops,
        };
    } catch (error) {
        const message = error?.message || String(error);
        const timedOut = /timeout/i.test(message) || error?.name === 'TimeoutError';
        return {
            received: false,
            reason: timedOut ? 'timeout' : 'network',
            blocked: false,
            status: null,
            body: '',
            finalUrl: hops[hops.length - 1]?.url || startUrl,
            redirectChain: hops.length ? hops : [safeHop(startUrl, null, 'browser', timedOut ? 'timeout' : 'network')],
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch { /* ignore */ }
        }
    }
}

// Re-export so HTTP mode can share the same parser.
export { extractClientRedirect };
