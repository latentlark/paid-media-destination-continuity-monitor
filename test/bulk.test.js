import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { destinationKey } from '../src/urls.js';
import { HARD_LIMITS, PROGRESS_KEY_PREFIX } from '../src/constants.js';
import { ad, htmlResponse, memoryStore, ROBOTS_ALLOW, run, scriptedSite } from './harness.js';

const realClock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

describe('bulk caps', () => {
    it('rejects raising the new hard caps', async () => {
        await assert.rejects(
            () => run({ ads: [ad()], maxUniqueUrls: HARD_LIMITS.maxUniqueUrls + 1 }, { site: scriptedSite({}) }),
            /cannot exceed/,
        );
        await assert.rejects(
            () => run({ ads: [ad()], maxConcurrency: HARD_LIMITS.maxConcurrency + 1 }, { site: scriptedSite({}) }),
            /cannot exceed/,
        );
        await assert.rejects(
            () => run({ ads: [ad()], rateLimitMs: HARD_LIMITS.minRateLimitMs - 1 }, { site: scriptedSite({}) }),
            /at least/,
        );
    });

    it('persists each row before later URLs finish', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const site = scriptedSite({
            'a.test/': htmlResponse('<html>A</html>'),
            'b.test/': async () => {
                await gate;
                return htmlResponse('<html>B</html>');
            },
        });
        const pushed = [];
        const pending = run({
            links: [
                { url: 'https://a.test/', adId: 'a' },
                { url: 'https://b.test/', adId: 'b' },
            ],
            respectRobots: false,
            maxConcurrency: 2,
            timeoutSeconds: 30,
            rateLimitMs: 200,
        }, {
            site,
            clock: realClock,
            onRow: async (row) => { pushed.push(row.destinationUrl); },
        });
        const started = Date.now();
        while (pushed.length === 0 && Date.now() - started < 2000) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.deepEqual(pushed, ['https://a.test/']);
        release();
        const { rows, summary } = await pending;
        assert.equal(rows.length, 2);
        assert.equal(summary.uniqueUrls, 2);
        assert.ok(pushed.includes('https://b.test/'));
    });

    it('resumes a migrated run and skips completed URLs', async () => {
        const aKey = destinationKey('https://a.test/');
        const store = memoryStore({
            [`${PROGRESS_KEY_PREFIX}run-resume`]: {
                runId: 'run-resume',
                inputHash: null,
                completedKeys: [aKey],
            },
        });
        const site = scriptedSite({
            'a.test/': htmlResponse('<html>A</html>'),
            'b.test/': htmlResponse('<html>B</html>'),
        });
        // inputHash must match saved progress; set after we can compute it, or skip hash check
        // The monitor requires priorProgress.inputHash === hash. Seed after first dry compute is awkward.
        // Instead run once to completion on a store, then delete the b row progress and re-run? 
        // Simpler: first run only A by completing A and saving hash... we'll do a two-step below.
        const first = await run({
            links: [
                { url: 'https://a.test/', adId: 'a' },
                { url: 'https://b.test/', adId: 'b' },
            ],
            respectRobots: false,
            maxConcurrency: 1,
            timeoutSeconds: 30,
            rateLimitMs: 200,
        }, { site: scriptedSite({ 'a.test/': htmlResponse('<html>A</html>'), 'b.test/': htmlResponse('<html>B</html>') }), runId: 'run-resume', store });
        assert.equal(first.rows.length, 2);
        // Progress is cleared when all keys complete. Re-seed as if only A finished, then rerun.
        const hash = first.summary.inputHash;
        await store.set(`${PROGRESS_KEY_PREFIX}run-resume`, {
            runId: 'run-resume',
            inputHash: hash,
            completedKeys: [aKey],
        });
        const callsBefore = site.calls.length;
        const second = await run({
            links: [
                { url: 'https://a.test/', adId: 'a' },
                { url: 'https://b.test/', adId: 'b' },
            ],
            respectRobots: false,
            maxConcurrency: 1,
            timeoutSeconds: 30,
            rateLimitMs: 200,
        }, { site, runId: 'run-resume', store });
        assert.equal(second.summary.resumedCount, 1);
        assert.equal(second.rows.length, 1);
        assert.equal(second.rows[0].destinationUrl, 'https://b.test/');
        const fetchedHosts = site.calls.map((c) => c.hostname);
        assert.ok(!fetchedHosts.includes('a.test'), fetchedHosts);
        assert.ok(fetchedHosts.includes('b.test'));
        assert.equal(callsBefore, 0);
    });

    it('writes timeout rows for leftovers inside the flush margin', async () => {
        const site = scriptedSite({
            'a.test/': htmlResponse('<html>A</html>'),
            'b.test/': htmlResponse('<html>B</html>'),
        });
        const pushed = [];
        const { rows } = await run({
            links: [
                { url: 'https://a.test/', adId: 'a' },
                { url: 'https://b.test/', adId: 'b' },
            ],
            respectRobots: false,
            maxConcurrency: 1,
            timeoutSeconds: 5,
            rateLimitMs: 200,
        }, {
            site,
            clock: {
                now: (() => {
                    let t = Date.UTC(2026, 10, 14, 12, 0, 0);
                    return () => t;
                })(),
                async sleep() {},
            },
            onRow: async (row) => { pushed.push(row.destinationStatus); },
        });
        // deadline is startedAt + 5s, flush margin is 8s, so budget is already expired
        assert.equal(rows.length, 2);
        assert.ok(rows.every((row) => row.destinationStatus === 'timeout'));
        assert.deepEqual(pushed, ['timeout', 'timeout']);
    });
});
