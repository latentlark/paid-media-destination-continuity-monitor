import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateParamChain,
    extractClientRedirect,
    normalizeRequiredParams,
    paramsFromUrl,
} from '../src/params.js';

function hop(url, status = 302) {
    return { url, status, params: paramsFromUrl(url), kind: 'http' };
}

describe('evaluateParamChain', () => {
    it('does not treat a consumed Awin param as a failure', () => {
        const hops = [
            hop('https://www.awin1.com/cread.php?awinmid=1234&awinaffid=9999&ued=https%3A%2F%2Fmerchant.example%2F'),
            hop('https://merchant.example/?awc=abc123', 200),
        ];
        const result = evaluateParamChain({
            hops,
            requiredParams: [{ name: 'awinaffid', aliases: ['awc'], expectedValue: '9999', severity: 'warning' }],
        });
        assert.equal(result.trackingStatus, 'ok');
        assert.ok(result.issues.some((issue) => issue.type === 'renamed' || issue.type === 'consumed'));
        assert.equal(result.issues.some((issue) => issue.severity === 'error'), false);
    });

    it('records a dropped param as a warning by default, not an automatic error', () => {
        const hops = [
            hop('https://start.example/?aff_id=111&subid=abc'),
            hop('https://other.example/', 200),
        ];
        const result = evaluateParamChain({
            hops,
            requiredParams: [{ name: 'aff_id', expectedValue: '111', severity: 'warning' }],
            paramRules: { useDefaultNetworkRules: false },
        });
        assert.equal(result.trackingStatus, 'warning');
        assert.equal(result.issues[0].type, 'dropped');
        assert.equal(result.issues[0].severity, 'warning');
    });

    it('can raise a dropped param to error when the user sets severity', () => {
        const hops = [
            hop('https://start.example/?aff_id=111'),
            hop('https://other.example/', 200),
        ];
        const result = evaluateParamChain({
            hops,
            requiredParams: [{ name: 'aff_id', severity: 'error' }],
            paramRules: { useDefaultNetworkRules: false },
        });
        assert.equal(result.trackingStatus, 'error');
        assert.equal(result.issues[0].type, 'dropped');
    });

    it('honours a per-hop consume rule on a custom host', () => {
        const hops = [
            hop('https://go.partner.test/?clickref=zz'),
            hop('https://shop.test/', 200),
        ];
        const result = evaluateParamChain({
            hops,
            requiredParams: [{ name: 'clickref', severity: 'error' }],
            paramRules: {
                useDefaultNetworkRules: false,
                perHop: [{ hostSuffix: 'go.partner.test', mayDrop: ['clickref'] }],
            },
        });
        assert.equal(result.trackingStatus, 'ok');
        assert.equal(result.issues[0].type, 'consumed');
    });

    it('flags a missing start param as warning, not automatic failure', () => {
        const hops = [hop('https://start.example/', 200)];
        const result = evaluateParamChain({
            hops,
            requiredParams: ['subid'],
        });
        assert.equal(result.trackingStatus, 'warning');
        assert.equal(result.issues[0].type, 'missing');
    });
});

describe('extractClientRedirect', () => {
    it('parses meta refresh and simple location.assign', () => {
        const meta = extractClientRedirect('<meta http-equiv="refresh" content="0; url=https://example.com/next">', 'https://start.example/');
        assert.equal(meta.href, 'https://example.com/next');
        const js = extractClientRedirect('location.assign("https://example.com/js")', 'https://start.example/');
        assert.equal(js.href, 'https://example.com/js');
    });
});

describe('normalizeRequiredParams', () => {
    it('accepts names and objects', () => {
        const result = normalizeRequiredParams(['aff_id', { name: 'subid', expectedValue: 'x', aliases: ['sid'], severity: 'info' }]);
        assert.equal(result.list.length, 2);
        assert.equal(result.list[0].severity, 'warning');
        assert.equal(result.list[1].aliases[0], 'sid');
    });
});
