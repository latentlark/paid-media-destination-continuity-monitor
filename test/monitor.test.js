import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHARGE_DESTINATION, CHARGE_SHOPIFY } from '../src/constants.js';
import { ad, htmlResponse, jsonResponse, ROBOTS_ALLOW, run, scriptedSite } from './harness.js';

function productDoc({ available = true, id = '39576998346841' } = {}) {
    return {
        id: 1,
        handle: 'coat',
        variants: [
            { id: Number(id), title: 'Black / 35', available, price: 38500 },
        ],
    };
}

describe('runMonitor', () => {
    it('checks landing 200 and charges destination-resolved', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Buy now</html>'),
        });
        const { rows, charges, summary } = await run({ ads: [ad()] }, { site });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].destinationStatus, 'ok');
        assert.equal(rows[0].chargedDestination, true);
        assert.equal(rows[0].adIds[0], 'ad-1');
        assert.ok(charges.some((c) => c.eventName === CHARGE_DESTINATION));
        assert.equal(summary.destinationsCharged, 1);
    });

    it('fans out multiple ads sharing one URL', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Buy now</html>'),
        });
        const { rows } = await run({
            ads: [
                ad({ adId: 'a' }),
                ad({ adId: 'b' }),
            ],
        }, { site });
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].adIds.sort(), ['a', 'b']);
    });

    it('marks 404 broken and does not confirm until second run', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('gone', 404),
        });
        const { clock } = await import('./harness.js');
        const time = clock();
        const first = await run({ ads: [ad()], stateScope: 's1' }, {
            site, runId: 'run-a', clock: time,
            env: { APIFY_ACTOR_RUN_ID: 'run-a', APIFY_USER_ID: 'u1' },
        });
        assert.equal(first.rows[0].confirmedFailure, false);
        assert.equal(first.rows[0].impactedTransition, 'failure_pending_confirmation');

        time.advance(60_000);
        const second = await run({
            ads: [ad()],
            stateScope: 's1',
            previousSnapshot: first.summary.snapshot,
        }, {
            site, runId: 'run-b', store: first.store, clock: time,
            env: { APIFY_ACTOR_RUN_ID: 'run-b', APIFY_USER_ID: 'u1' },
        });
        assert.equal(second.rows[0].confirmedFailure, true);
        assert.equal(second.rows[0].impactedTransition, 'confirmed_failure');
        assert.deepEqual(second.summary.impactedAdIds, ['ad-1']);
    });

    it('required text missing is assertion_failed', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Hello</html>'),
        });
        const { rows } = await run({ ads: [ad({ requiredText: ['Buy now'] })] }, { site });
        assert.equal(rows[0].destinationStatus, 'assertion_failed');
        assert.equal(rows[0].event, 'required_text_missing');
    });

    it('timeout does not charge and preserves baseline', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': { error: 'timeout' },
        });
        const { rows, charges } = await run({ ads: [ad()] }, { site });
        assert.equal(rows[0].destinationStatus, 'timeout');
        assert.equal(rows[0].chargedDestination, false);
        assert.equal(charges.length, 0);
    });

    it('optional Shopify OOS check charges shopify-product-check', async () => {
        const site = scriptedSite({
            'shop.test/robots.txt': ROBOTS_ALLOW,
            'shop.test/landing': htmlResponse('<html>Buy now</html>'),
            'shop.test/products/coat.js': jsonResponse(productDoc({ available: false })),
        });
        const { rows, charges } = await run({
            ads: [ad({
                shopifyProductUrl: 'https://shop.test/products/coat',
                variantId: '39576998346841',
            })],
        }, { site });
        assert.equal(rows[0].shopifyAvailability, 'out_of_stock');
        assert.equal(rows[0].chargedShopify, true);
        assert.ok(charges.some((c) => c.eventName === CHARGE_SHOPIFY));
    });

    it('rejects private hosts', async () => {
        await assert.rejects(
            () => run({ ads: [ad({ destinationUrl: 'https://localhost/x' })] }, {
                site: scriptedSite({}),
            }),
            /ads has invalid items|blocked_host|hostname|single_label/,
        );
    });

    it('rejects raising caps', async () => {
        await assert.rejects(
            () => run({ ads: [ad()], maxAds: 26 }, { site: scriptedSite({}) }),
            /cannot exceed/,
        );
    });
});
