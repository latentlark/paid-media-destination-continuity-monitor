import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runMonitor } from '../src/monitor.js';
import { memoryStore, clock } from './harness.js';

/**
 * Local HTTP fixture server. The Actor transport is stubbed to talk to this
 * server while resolve() returns a public address so SSRF prep still runs.
 */
describe('local HTTP fixture server', () => {
    let server;
    let port;
    const routes = new Map();

    before(async () => {
        server = http.createServer((req, res) => {
            const key = req.url.split('?')[0];
            const handler = routes.get(key);
            if (!handler) {
                res.writeHead(404);
                res.end('no route');
                return;
            }
            const out = typeof handler === 'function' ? handler(req) : handler;
            if (out.delayMs) {
                setTimeout(() => {
                    res.writeHead(out.status || 200, out.headers || { 'content-type': 'text/html' });
                    res.end(out.body || '');
                }, out.delayMs);
                return;
            }
            if (out.redirect) {
                res.writeHead(out.status || 301, { location: out.redirect });
                res.end();
                return;
            }
            res.writeHead(out.status || 200, out.headers || { 'content-type': 'text/html' });
            res.end(out.body || '');
        });
        await new Promise((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });
        port = server.address().port;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    function transport() {
        return ({ hostname, path, timeoutMs }) => new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port,
                path,
                method: 'GET',
                timeout: timeoutMs,
                headers: { Host: hostname, Accept: '*/*' },
            }, (response) => {
                const chunks = [];
                response.on('data', (c) => chunks.push(c));
                response.on('end', () => {
                    resolve({
                        status: response.statusCode,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            });
            req.on('timeout', () => {
                req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' }));
            });
            req.on('error', reject);
            req.end();
        });
    }

    async function runCase(ads, routeMap) {
        routes.clear();
        for (const [k, v] of Object.entries(routeMap)) routes.set(k, v);
        const time = clock();
        return runMonitor({ ads, stateScope: 'local-server' }, {
            env: { APIFY_ACTOR_RUN_ID: 'local-srv', APIFY_USER_ID: 'u' },
            now: time.now,
            sleep: time.sleep,
            resolve: async () => [{ address: '1.1.1.1', family: 4 }],
            transport: transport(),
            store: memoryStore(),
            chargeFn: async () => ({ chargedCount: 1 }),
            log: { info() {}, warn() {} },
            runId: `srv-${Date.now()}`,
        });
    }

    it('200 ok', async () => {
        const { rows } = await runCase(
            [{ adId: '1', destinationUrl: 'https://fixture.test/', expectedDomain: 'fixture.test', requiredText: ['OK'] }],
            {
                '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
                '/': { status: 200, body: '<html>OK</html>' },
            },
        );
        assert.equal(rows[0].destinationStatus, 'ok');
    });

    it('301 redirect to same domain then 200', async () => {
        const { rows } = await runCase(
            [{ adId: '1', destinationUrl: 'https://fixture.test/old', expectedDomain: 'fixture.test', requiredText: ['NEW'] }],
            {
                '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
                '/old': { status: 301, redirect: 'https://fixture.test/new' },
                '/new': { status: 200, body: '<html>NEW</html>' },
            },
        );
        assert.equal(rows[0].destinationStatus, 'ok');
        assert.match(rows[0].finalUrl, /\/new$/);
    });

    it('404 broken', async () => {
        const { rows } = await runCase(
            [{ adId: '1', destinationUrl: 'https://fixture.test/missing', expectedDomain: 'fixture.test' }],
            {
                '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
                '/missing': { status: 404, body: 'gone' },
            },
        );
        assert.equal(rows[0].destinationStatus, 'broken');
    });

    it('required text missing', async () => {
        const { rows } = await runCase(
            [{ adId: '1', destinationUrl: 'https://fixture.test/', expectedDomain: 'fixture.test', requiredText: ['Buy now'] }],
            {
                '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
                '/': { status: 200, body: '<html>Hello</html>' },
            },
        );
        assert.equal(rows[0].event, 'required_text_missing');
    });

    it('timeout', async () => {
        const { rows } = await runCase(
            [{ adId: '1', destinationUrl: 'https://fixture.test/slow', expectedDomain: 'fixture.test', requiredText: ['x'] }],
            {
                '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
                '/slow': { status: 200, body: 'late', delayMs: 20_000 },
            },
        );
        // request timeout is capped by remaining deadline; expect timeout or unknown
        assert.ok(['timeout', 'unknown'].includes(rows[0].destinationStatus));
    });

    it('sold-out via Shopify .js', async () => {
        const { rows } = await runCase(
            [{
                adId: '1',
                destinationUrl: 'https://fixture.test/products/coat',
                expectedDomain: 'fixture.test',
                shopifyProductUrl: 'https://fixture.test/products/coat',
                variantId: '111',
            }],
            {
                '/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
                '/products/coat': { status: 200, body: '<html>Product</html>' },
                '/products/coat.js': {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        id: 9,
                        handle: 'coat',
                        variants: [{ id: 111, title: 'S', available: false, price: 1000 }],
                    }),
                },
            },
        );
        assert.equal(rows[0].shopifyAvailability, 'out_of_stock');
        assert.equal(rows[0].chargedShopify, true);
    });
});
