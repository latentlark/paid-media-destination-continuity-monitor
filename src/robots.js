import { HARD_LIMITS } from './constants.js';

function ruleToRegExp(rule) {
    let source = '^';
    for (let i = 0; i < rule.length; i += 1) {
        const char = rule[i];
        if (char === '*') source += '.*';
        else if (char === '$' && i === rule.length - 1) source += '$';
        else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
    if (!rule.endsWith('$')) source += '.*';
    return new RegExp(source);
}

export function parseRobots(text) {
    const groups = [];
    let current = null;
    const lines = String(text ?? '').split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.split('#')[0].trim();
        if (!line) continue;
        const index = line.indexOf(':');
        if (index === -1) continue;
        const field = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (field === 'user-agent') {
            if (!current || current.hasRules) {
                current = { agents: [], rules: [], crawlDelay: null, hasRules: false };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            continue;
        }
        if (!current) continue;
        if (field === 'allow' || field === 'disallow') {
            current.hasRules = true;
            current.rules.push({ type: field, value });
        } else if (field === 'crawl-delay') {
            current.hasRules = true;
            const seconds = Number(value);
            if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
        }
    }
    const star = groups.filter((group) => group.agents.includes('*'));
    const crawlDelaySeconds = star.reduce((max, group) => {
        if (group.crawlDelay == null) return max;
        return max == null ? group.crawlDelay : Math.max(max, group.crawlDelay);
    }, null);
    return {
        rules: star.flatMap((group) => group.rules),
        crawlDelayMs: crawlDelaySeconds == null ? null : Math.round(crawlDelaySeconds * 1000),
    };
}

function matches(rule, candidate) {
    if (rule === '') return false;
    return ruleToRegExp(rule).test(candidate);
}

export function pathAllowed(rules, pathname, search = '') {
    const target = `${pathname}${search || ''}`;
    let best = null;
    for (const rule of rules) {
        const candidate = rule.value.includes('?') ? target : pathname;
        if (!matches(rule.value, candidate)) continue;
        const length = rule.value.length;
        const allow = rule.type === 'allow';
        if (!best || length > best.length || (length === best.length && allow)) {
            best = { length, allow };
        }
    }
    return best ? best.allow : true;
}

export function crawlDelayBlocks(crawlDelayMs) {
    return crawlDelayMs != null && crawlDelayMs > HARD_LIMITS.maxCrawlDelayMs;
}
