import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareAffiliateSnapshots, inputHash, linkSnapshotRecord } from '../src/affiliate.js';
import { ad, htmlResponse, ROBOTS_ALLOW, run, scriptedSite } from './harness.js';

describe('compareAffiliateSnapshots', () => {
    it('alerts on newly broken, destination change and param outcome change', () => {
        const previous = {
            links: {
                'https://a.example/': {
                    destinationUrl: 'https://a.example/',
                    finalUrl: 'https://merchant.example/',
                    destinationStatus: 'ok',
                    trackingStatus: 'ok',
                    trackingIssueTypes: [],
                },
            },
        };
        const current = {
            'https://a.example/': {
                destinationUrl: 'https://a.example/',
                finalUrl: 'https://other.example/',
                destinationStatus: 'broken',
                trackingStatus: 'warning',
                trackingIssueTypes: ['dropped'],
            },
        };
        const alerts = compareAffiliateSnapshots(previous, current);
        const types = alerts.map((item) => item.type).sort();
        assert.deepEqual(types, ['destination_changed', 'newly_broken', 'param_outcome_changed']);
    });

    it('is stable for the same watchlist', () => {
        const input = { ads: [{ destinationUrl: 'https://example.com/', expectedDomain: 'example.com' }], renderMode: 'http' };
        assert.equal(inputHash(input), inputHash({ ...input, timeoutSeconds: 30 }));
    });
});

describe('runMonitor affiliate paths', () => {
    it('records redirect hops and treats a network consume as ok', async () => {
        const site = scriptedSite({
            'go.awin1.com/robots.txt': ROBOTS_ALLOW,
            'merchant.test/robots.txt': ROBOTS_ALLOW,
            'go.awin1.com/cread.php?awinaffid=9999&ued=https%3A%2F%2Fmerchant.test%2F': {
                status: 302,
                headers: { location: 'https://merchant.test/?awc=from-network' },
                body: '',
            },
            'merchant.test/?awc=from-network': htmlResponse('<html>OK store</html>'),
        });
        const { rows, summary } = await run({
            links: [{
                url: 'https://go.awin1.com/cread.php?awinaffid=9999&ued=https%3A%2F%2Fmerchant.test%2F',
                expectedDomain: 'merchant.test',
                requiredParams: [{ name: 'awinaffid', aliases: ['awc'], expectedValue: '9999' }],
                label: 'awin-demo',
            }],
            respectRobots: false,
        }, { site });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].destinationStatus, 'ok');
        assert.ok(rows[0].redirectChain.length >= 2);
        assert.equal(rows[0].trackingStatus, 'ok');
        assert.equal(summary.promise.includes('commission'), false);
    });

    it('writes a change alert on a second run when the destination breaks', async () => {
        const okSite = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Buy now</html>'),
        });
        const first = await run({
            ads: [ad()],
            requiredParams: ['aff_id'],
            stateScope: 'affil-1',
        }, {
            site: okSite,
            runId: 'aff-a',
            env: { APIFY_ACTOR_RUN_ID: 'aff-a', APIFY_USER_ID: 'u1' },
        });
        const broken = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('gone', 404),
        });
        const second = await run({
            ads: [ad()],
            requiredParams: ['aff_id'],
            stateScope: 'affil-1',
        }, {
            site: broken,
            runId: 'aff-b',
            store: first.store,
            affiliateStore: first.store,
            env: { APIFY_ACTOR_RUN_ID: 'aff-b', APIFY_USER_ID: 'u1' },
        });
        const types = [
            ...second.rows[0].changeAlerts.map((item) => item.type),
            ...second.summary.changeAlerts.map((item) => item.type),
        ];
        assert.ok(types.includes('newly_broken'), types);
    });

    it('accepts classic ads-only input unchanged', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Buy now</html>'),
        });
        const { rows } = await run({ ads: [ad()] }, { site });
        assert.equal(rows[0].destinationStatus, 'ok');
        assert.equal(rows[0].trackingStatus, 'not_configured');
        assert.equal(rows[0].renderMode, 'http');
    });
});

void linkSnapshotRecord;

describe('failure paths stay as classified rows', () => {
    it('returns timeout without throwing', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': { error: 'timeout' },
        });
        const { rows } = await run({ ads: [ad()], respectRobots: false }, { site });
        assert.equal(rows[0].destinationStatus, 'timeout');
        assert.equal(rows[0].chargedDestination, false);
    });

    it('returns unknown on dns failure', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Buy now</html>'),
        }, { 'shop.test': 'throw' });
        const { rows } = await run({ ads: [ad()], respectRobots: false }, { site });
        assert.equal(rows[0].destinationStatus, 'unknown');
    });

    it('rejects empty watchlist as FatalInputError at runMonitor', async () => {
        const { FatalInputError } = await import('../src/errors.js');
        const { runMonitor } = await import('../src/monitor.js');
        await assert.rejects(
            () => runMonitor({}, { env: {}, now: () => 0, sleep: async () => {}, resolve: async () => [], transport: async () => ({}), store: null, chargeFn: async () => ({ chargedCount: 0 }), runId: 'x' }),
            FatalInputError,
        );
    });
});

describe('landingChargeEvent', () => {
    it('uses link-checked for affiliate HTTP when that event is configured', async () => {
        const { landingChargeEvent } = await import('../src/monitor.js');
        const { CHARGE_DESTINATION, CHARGE_LINK, CHARGE_LINK_BROWSER } = await import('../src/constants.js');
        const affiliate = { affiliateMode: true, renderMode: 'http' };
        assert.equal(landingChargeEvent(affiliate, new Set()), CHARGE_DESTINATION);
        assert.equal(landingChargeEvent(affiliate, new Set([CHARGE_LINK])), CHARGE_LINK);
        assert.equal(
            landingChargeEvent({ affiliateMode: true, renderMode: 'browser' }, new Set([CHARGE_LINK, CHARGE_LINK_BROWSER])),
            CHARGE_LINK_BROWSER,
        );
        assert.equal(landingChargeEvent({ affiliateMode: false, renderMode: 'http' }, new Set([CHARGE_LINK])), CHARGE_DESTINATION);
    });
});
