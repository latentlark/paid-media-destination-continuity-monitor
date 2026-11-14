import { runMonitor } from '../src/monitor.js';

export function memoryStore(seed = {}) {
    const data = new Map(Object.entries(structuredClone(seed)));
    return {
        async get(key) {
            const value = data.get(key);
            return value === undefined ? null : structuredClone(value);
        },
        async set(key, value) {
            data.set(key, structuredClone(value));
        },
        async listKeys() {
            return [...data.keys()];
        },
        dump() {
            return structuredClone(Object.fromEntries(data));
        },
    };
}

export function clock(start = Date.UTC(2026, 10, 9, 20, 0, 0)) {
    let time = start;
    return {
        now: () => time,
        async sleep(ms) {
            time += ms;
        },
        advance(ms) {
            time += ms;
        },
    };
}

export const ROBOTS_ALLOW = {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: 'User-agent: *\nAllow: /\n',
};

export function htmlResponse(body, status = 200, headers = {}) {
    return {
        status,
        headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
        body,
    };
}

export function jsonResponse(body, status = 200) {
    return {
        status,
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    };
}

export function scriptedSite(routes, dns = {}) {
    const calls = [];
    return {
        calls,
        async resolve(hostname) {
            const answer = dns[hostname];
            if (typeof answer === 'function') return answer(hostname);
            if (answer === 'throw') {
                const error = new Error('ENOTFOUND');
                error.code = 'ENOTFOUND';
                throw error;
            }
            if (answer) return answer;
            return [{ address: '1.1.1.1', family: 4 }];
        },
        async transport(args) {
            calls.push(args);
            const key = `${args.hostname}${args.path}`;
            const handler = routes[key] ?? routes[args.path];
            if (!handler) throw Object.assign(new Error(`no fixture for ${key}`), { code: 'network' });
            const response = typeof handler === 'function' ? await handler(args, calls) : handler;
            if (response?.error === 'timeout') {
                throw Object.assign(new Error('timeout'), { code: 'timeout' });
            }
            return response;
        },
    };
}

export async function run(input, extra = {}) {
    const store = extra.store ?? memoryStore();
    const time = extra.clock ?? clock();
    const site = extra.site;
    const charges = [];
    const result = await runMonitor(input, {
        env: extra.env ?? { APIFY_ACTOR_TASK_ID: 'task-1', APIFY_ACTOR_RUN_ID: extra.runId ?? 'run-1' },
        now: time.now,
        sleep: time.sleep,
        resolve: extra.resolve ?? site.resolve,
        transport: extra.transport ?? site.transport,
        store,
        chargeFn: extra.chargeFn ?? (async (options) => {
            charges.push(options);
            return { chargedCount: 1, eventChargeLimitReached: false };
        }),
        log: { info() {}, warn() {} },
        runId: extra.runId ?? 'run-1',
    });
    return { ...result, store, charges, calls: site?.calls ?? [], time };
}

export function ad(overrides = {}) {
    return {
        adId: 'ad-1',
        platform: 'meta',
        destinationUrl: 'https://shop.test/landing',
        expectedDomain: 'shop.test',
        requiredText: ['Buy now'],
        ...overrides,
    };
}
