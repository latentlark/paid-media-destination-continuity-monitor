import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTwoStrike, emptyDestinationState } from '../src/state.js';

describe('two-strike confirmed failure', () => {
    it('does not confirm on first failure', () => {
        const struck = applyTwoStrike({
            previous: emptyDestinationState(),
            observation: { destinationStatus: 'broken', event: 'broken', contentHash: 'a', finalUrl: 'https://x.test/', observedAt: 't1' },
            confirmFailures: 2,
        });
        assert.equal(struck.confirmedFailure, false);
        assert.equal(struck.consecutiveFailures, 1);
        assert.equal(struck.impactedTransition, 'failure_pending_confirmation');
    });

    it('confirms on second consecutive failure', () => {
        const first = applyTwoStrike({
            previous: emptyDestinationState(),
            observation: { destinationStatus: 'broken', event: 'broken', observedAt: 't1' },
        });
        const second = applyTwoStrike({
            previous: first,
            observation: { destinationStatus: 'broken', event: 'broken', observedAt: 't2' },
        });
        assert.equal(second.confirmedFailure, true);
        assert.equal(second.consecutiveFailures, 2);
        assert.equal(second.impactedTransition, 'confirmed_failure');
    });

    it('preserves baseline on unknown/timeout', () => {
        const prev = applyTwoStrike({
            previous: emptyDestinationState(),
            observation: { destinationStatus: 'broken', event: 'broken', observedAt: 't1' },
        });
        const struck = applyTwoStrike({
            previous: prev,
            observation: { destinationStatus: 'timeout', event: 'timeout', observedAt: 't2' },
        });
        assert.equal(struck.baselinePreserved, true);
        assert.equal(struck.consecutiveFailures, 1);
        assert.equal(struck.confirmedFailure, false);
    });

    it('requires two oks to clear confirmed failure', () => {
        let state = emptyDestinationState();
        state = applyTwoStrike({ previous: state, observation: { destinationStatus: 'broken', event: 'broken', observedAt: 't1' } });
        state = applyTwoStrike({ previous: state, observation: { destinationStatus: 'broken', event: 'broken', observedAt: 't2' } });
        assert.equal(state.confirmedFailure, true);
        state = applyTwoStrike({ previous: state, observation: { destinationStatus: 'ok', event: 'ok', observedAt: 't3' } });
        assert.equal(state.confirmedFailure, true);
        assert.equal(state.impactedTransition, 'recovery_pending_confirmation');
        state = applyTwoStrike({ previous: state, observation: { destinationStatus: 'ok', event: 'ok', observedAt: 't4' } });
        assert.equal(state.confirmedFailure, false);
        assert.equal(state.impactedTransition, 'confirmed_recovery');
    });

    it('two-strike for shopify OOS', () => {
        let state = emptyDestinationState();
        state = applyTwoStrike({
            previous: state,
            observation: { destinationStatus: 'ok', event: 'ok', shopifyAvailability: 'out_of_stock', observedAt: 't1' },
        });
        assert.equal(state.confirmedShopifyFailure, false);
        state = applyTwoStrike({
            previous: state,
            observation: { destinationStatus: 'ok', event: 'ok', shopifyAvailability: 'out_of_stock', observedAt: 't2' },
        });
        assert.equal(state.confirmedShopifyFailure, true);
        assert.equal(state.shopifyTransition, 'confirmed_oos');
    });
});
