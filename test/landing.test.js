import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLanding } from '../src/landing.js';

describe('classifyLanding', () => {
    it('marks 200 with required text as ok and billable', () => {
        const r = classifyLanding({
            received: true,
            status: 200,
            body: '<html>Buy now</html>',
            finalUrl: 'https://shop.test/landing',
            expectedDomain: 'shop.test',
            requiredText: ['Buy now'],
        });
        assert.equal(r.destinationStatus, 'ok');
        assert.equal(r.billable, true);
    });

    it('marks 404 as broken and billable', () => {
        const r = classifyLanding({
            received: true,
            status: 404,
            body: 'missing',
            finalUrl: 'https://shop.test/gone',
            expectedDomain: 'shop.test',
        });
        assert.equal(r.destinationStatus, 'broken');
        assert.equal(r.billable, true);
    });

    it('marks 403 as unknown and free', () => {
        const r = classifyLanding({
            received: true,
            status: 403,
            body: 'nope',
            finalUrl: 'https://shop.test/x',
            expectedDomain: 'shop.test',
        });
        assert.equal(r.destinationStatus, 'unknown');
        assert.equal(r.billable, false);
    });

    it('fails when required text missing', () => {
        const r = classifyLanding({
            received: true,
            status: 200,
            body: '<html>Hello</html>',
            finalUrl: 'https://shop.test/x',
            expectedDomain: 'shop.test',
            requiredText: ['Buy now'],
        });
        assert.equal(r.destinationStatus, 'assertion_failed');
        assert.equal(r.event, 'required_text_missing');
        assert.equal(r.billable, true);
    });

    it('fails when forbidden text present', () => {
        const r = classifyLanding({
            received: true,
            status: 200,
            body: '<html>Sold out</html>',
            finalUrl: 'https://shop.test/x',
            expectedDomain: 'shop.test',
            forbiddenText: ['Sold out'],
        });
        assert.equal(r.event, 'forbidden_text_present');
        assert.equal(r.billable, true);
    });

    it('fails domain mismatch', () => {
        const r = classifyLanding({
            received: true,
            status: 200,
            body: 'ok',
            finalUrl: 'https://evil.test/x',
            expectedDomain: 'shop.test',
        });
        assert.equal(r.destinationStatus, 'redirect_domain_mismatch');
        assert.equal(r.billable, true);
    });

    it('timeout is unknown/free', () => {
        const r = classifyLanding({
            received: false,
            reason: 'timeout',
            blocked: false,
            status: null,
            body: '',
            finalUrl: null,
            expectedDomain: 'shop.test',
        });
        assert.equal(r.destinationStatus, 'timeout');
        assert.equal(r.billable, false);
    });
});
