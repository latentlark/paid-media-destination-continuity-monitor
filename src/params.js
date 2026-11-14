/**
 * Tracking-parameter inspection for affiliate redirect chains.
 * A missing or consumed parameter is never an automatic failure.
 * Networks may drop or rename params; callers set severity and per-hop rules.
 */

export const DEFAULT_SEVERITY = 'warning';

export const DEFAULT_NETWORK_RULES = Object.freeze([
    {
        hostSuffix: 'awin1.com',
        mayDrop: ['ued', 'clickref', 'awinmid', 'awinaffid', 'mid', 'id', 'gid', 'linkid', 's', 'v', 'q', 'r', 'p', 'a', 'm'],
        mayRename: { awinaffid: 'awc', clickref: 'awc', id: 'awc' },
    },
    {
        hostSuffix: 'awin.com',
        mayDrop: ['ued', 'clickref', 'awinmid', 'awinaffid'],
        mayRename: { awinaffid: 'awc', clickref: 'awc' },
    },
    {
        hostSuffix: 'anrdoezrs.net',
        mayDrop: ['url', 'sid', 'SID'],
        mayRename: { sid: 'sid' },
    },
    {
        hostSuffix: 'dpbolvw.net',
        mayDrop: ['url', 'sid', 'SID'],
        mayRename: { sid: 'sid' },
    },
    {
        hostSuffix: 'jdoqocy.com',
        mayDrop: ['url', 'sid', 'SID'],
        mayRename: { sid: 'sid' },
    },
    {
        hostSuffix: 'tkqlhce.com',
        mayDrop: ['url', 'sid', 'SID'],
        mayRename: { sid: 'sid' },
    },
    {
        hostSuffix: 'kqzyfj.com',
        mayDrop: ['url', 'sid', 'SID'],
        mayRename: { sid: 'sid' },
    },
    {
        hostSuffix: 'sjv.io',
        mayDrop: ['subid', 'subid1', 'subid2', 'subid3', 'sharedid'],
        mayRename: { subid1: 'irclickid', sharedid: 'irclickid', subid: 'irclickid' },
    },
    {
        hostSuffix: 'pxf.io',
        mayDrop: ['subid', 'subid1', 'subid2', 'subid3', 'sharedid'],
        mayRename: { subid1: 'irclickid', sharedid: 'irclickid', subid: 'irclickid' },
    },
    {
        hostSuffix: 'evyy.net',
        mayDrop: ['subid', 'subid1', 'subid2', 'subid3', 'sharedid'],
        mayRename: { subid1: 'irclickid', sharedid: 'irclickid', subid: 'irclickid' },
    },
    {
        hostSuffix: '7eer.net',
        mayDrop: ['subid', 'subid1', 'sharedid'],
        mayRename: { subid1: 'irclickid' },
    },
    {
        hostSuffix: 'ojrq.net',
        mayDrop: ['subid', 'subid1', 'sharedid'],
        mayRename: { subid1: 'irclickid' },
    },
    {
        hostSuffix: 'amazon.com',
        mayDrop: [],
        mayRename: { tag: 'tag' },
    },
    {
        hostSuffix: 'amzn.to',
        mayDrop: ['tag'],
        mayRename: { tag: 'tag' },
    },
]);

export function paramsFromUrl(urlLike) {
    const out = {};
    try {
        const url = typeof urlLike === 'string' ? new URL(urlLike) : urlLike;
        for (const [key, value] of url.searchParams.entries()) {
            const existing = out[key];
            if (existing === undefined) out[key] = value;
            else if (Array.isArray(existing)) existing.push(value);
            else out[key] = [existing, value];
        }
    } catch {
        // ignore
    }
    return out;
}

export function hostnameOf(urlLike) {
    try {
        return new URL(typeof urlLike === 'string' ? urlLike : String(urlLike)).hostname.toLowerCase();
    } catch {
        return '';
    }
}

export function hostMatches(hostname, suffix) {
    if (!hostname || !suffix) return false;
    const host = hostname.toLowerCase();
    const want = String(suffix).toLowerCase().replace(/^\./, '');
    return host === want || host.endsWith(`.${want}`);
}

function firstValue(value) {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
}

/** Case-insensitive lookup of a name or one of its aliases in a param map. */
export function findParam(params, names) {
    if (!params || typeof params !== 'object') return { found: false, name: null, value: null };
    const wanted = names.map((n) => String(n).toLowerCase());
    for (const [key, value] of Object.entries(params)) {
        if (wanted.includes(String(key).toLowerCase())) {
            return { found: true, name: key, value: firstValue(value) };
        }
    }
    return { found: false, name: null, value: null };
}

export function normalizeRequiredParams(value, field = 'requiredParams') {
    if (value === undefined || value === null) return { list: [] };
    if (!Array.isArray(value)) return { error: `${field}_invalid` };
    if (value.length > 20) return { error: `${field}_too_many` };
    const list = [];
    for (const item of value) {
        if (typeof item === 'string') {
            const name = item.trim();
            if (!name || name.length > 80) return { error: `${field}_invalid` };
            list.push({
                name,
                expectedValue: null,
                aliases: [],
                severity: DEFAULT_SEVERITY,
            });
            continue;
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `${field}_invalid` };
        if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 80) {
            return { error: `${field}_invalid` };
        }
        const aliases = [];
        if (item.aliases !== undefined && item.aliases !== null) {
            if (!Array.isArray(item.aliases)) return { error: `${field}_invalid` };
            for (const alias of item.aliases) {
                if (typeof alias !== 'string' || !alias.trim() || alias.trim().length > 80) {
                    return { error: `${field}_invalid` };
                }
                aliases.push(alias.trim());
            }
        }
        let expectedValue = null;
        if (item.expectedValue !== undefined && item.expectedValue !== null && item.expectedValue !== '') {
            if (typeof item.expectedValue !== 'string' && typeof item.expectedValue !== 'number') {
                return { error: `${field}_invalid` };
            }
            expectedValue = String(item.expectedValue);
        }
        const severity = item.severity == null || item.severity === ''
            ? DEFAULT_SEVERITY
            : String(item.severity).toLowerCase();
        if (!['info', 'warning', 'error'].includes(severity)) return { error: `${field}_invalid` };
        list.push({
            name: item.name.trim(),
            expectedValue,
            aliases,
            severity,
        });
    }
    return { list };
}

export function normalizeParamRules(value) {
    if (value === undefined || value === null || value === '') {
        return { rules: { aliases: {}, perHop: [], useDefaultNetworkRules: true, defaultSeverity: DEFAULT_SEVERITY } };
    }
    if (typeof value !== 'object' || Array.isArray(value)) return { error: 'paramRules_invalid' };
    const aliases = {};
    if (value.aliases != null) {
        if (typeof value.aliases !== 'object' || Array.isArray(value.aliases)) return { error: 'paramRules_invalid' };
        for (const [key, val] of Object.entries(value.aliases)) {
            if (typeof key !== 'string' || !key.trim()) return { error: 'paramRules_invalid' };
            const list = Array.isArray(val) ? val : [val];
            aliases[key.trim()] = list.map((item) => {
                if (typeof item !== 'string' || !item.trim()) throw new Error('paramRules_invalid');
                return item.trim();
            });
        }
    }
    const perHop = [];
    if (value.perHop != null) {
        if (!Array.isArray(value.perHop)) return { error: 'paramRules_invalid' };
        for (const rule of value.perHop) {
            if (!rule || typeof rule !== 'object' || typeof rule.hostSuffix !== 'string' || !rule.hostSuffix.trim()) {
                return { error: 'paramRules_invalid' };
            }
            const mayDrop = Array.isArray(rule.mayDrop) ? rule.mayDrop.map(String) : [];
            const mayRename = rule.mayRename && typeof rule.mayRename === 'object' && !Array.isArray(rule.mayRename)
                ? Object.fromEntries(Object.entries(rule.mayRename).map(([k, v]) => [String(k), String(v)]))
                : {};
            perHop.push({ hostSuffix: rule.hostSuffix.trim().toLowerCase(), mayDrop, mayRename });
        }
    }
    const defaultSeverity = value.defaultSeverity
        ? String(value.defaultSeverity).toLowerCase()
        : DEFAULT_SEVERITY;
    if (!['info', 'warning', 'error'].includes(defaultSeverity)) return { error: 'paramRules_invalid' };
    return {
        rules: {
            aliases,
            perHop,
            useDefaultNetworkRules: value.useDefaultNetworkRules !== false,
            defaultSeverity,
        },
    };
}

function normalizeParamList(requiredParams) {
    const normalized = normalizeRequiredParams(requiredParams);
    if (normalized.error) return [];
    return normalized.list;
}

function namesFor(param, globalAliases) {
    const aliases = Array.isArray(param.aliases) ? param.aliases : [];
    const names = [param.name, ...aliases];
    const extra = globalAliases[param.name] || globalAliases[param.name.toLowerCase()] || [];
    return [...new Set([...names, ...extra].filter(Boolean))];
}

function canonicalNames(param) {
    return [param.name];
}

function rulesForHost(hostname, paramRules) {
    const list = [];
    if (paramRules.useDefaultNetworkRules !== false) {
        for (const rule of DEFAULT_NETWORK_RULES) {
            if (hostMatches(hostname, rule.hostSuffix)) list.push(rule);
        }
    }
    for (const rule of paramRules.perHop || []) {
        if (hostMatches(hostname, rule.hostSuffix)) list.push(rule);
    }
    return list;
}

function mayConsume(paramNames, hostname, paramRules) {
    const wanted = paramNames.map((n) => n.toLowerCase());
    for (const rule of rulesForHost(hostname, paramRules)) {
        const drop = (rule.mayDrop || []).map((n) => String(n).toLowerCase());
        const renamedTo = Object.keys(rule.mayRename || {}).map((n) => n.toLowerCase());
        if (wanted.some((n) => drop.includes(n) || renamedTo.includes(n))) return true;
    }
    return false;
}

function renamedTo(paramNames, nextParams, hostname, paramRules) {
    const wanted = paramNames.map((n) => n.toLowerCase());
    for (const rule of rulesForHost(hostname, paramRules)) {
        for (const [from, to] of Object.entries(rule.mayRename || {})) {
            if (wanted.includes(String(from).toLowerCase())) {
                const hit = findParam(nextParams, [to]);
                if (hit.found) return hit;
            }
        }
    }
    return { found: false, name: null, value: null };
}

/**
 * Inspect required params across a redirect chain.
 * Missing or consumed params default to warning, never an automatic error.
 */
export function evaluateParamChain({ hops = [], requiredParams = [], paramRules = {} }) {
    const rules = {
        aliases: paramRules.aliases || {},
        perHop: paramRules.perHop || [],
        useDefaultNetworkRules: paramRules.useDefaultNetworkRules !== false,
        defaultSeverity: paramRules.defaultSeverity || DEFAULT_SEVERITY,
    };
    const hopReports = hops.map((hop, index) => ({
        index,
        url: hop.url || null,
        status: hop.status ?? null,
        hostname: hostnameOf(hop.url || ''),
        params: hop.params || paramsFromUrl(hop.url || ''),
        kind: hop.kind || 'http',
        reason: hop.reason || null,
        location: hop.location || null,
    }));

    const issues = [];
    const params = normalizeParamList(requiredParams);
    if (!params.length) {
        return {
            trackingStatus: 'not_configured',
            issues,
            hopReports,
        };
    }

    for (const param of params) {
        const aliasNames = namesFor(param, rules.aliases);
        const selfNames = [param.name];
        const severity = param.severity || rules.defaultSeverity || DEFAULT_SEVERITY;
        const trail = hopReports.map((hop) => ({
            self: findParam(hop.params, selfNames),
            alias: findParam(hop.params, aliasNames.filter((name) => name.toLowerCase() !== param.name.toLowerCase())),
            index: hop.index,
            hostname: hop.hostname,
        }));
        const firstHit = trail.find((item) => item.self.found);

        if (!firstHit) {
            issues.push({
                param: param.name,
                type: 'missing',
                hopIndex: 0,
                fromValue: null,
                toValue: null,
                severity,
                message: `${param.name} was not present on the starting URL. This is not an automatic failure.`,
            });
            continue;
        }

        if (param.expectedValue != null && firstHit.self.value !== String(param.expectedValue)) {
            issues.push({
                param: param.name,
                type: 'value_changed',
                hopIndex: firstHit.index,
                fromValue: String(param.expectedValue),
                toValue: firstHit.self.value,
                severity,
                message: `${param.name} was ${firstHit.self.value} but expected ${param.expectedValue}.`,
            });
        }

        for (let i = firstHit.index + 1; i < trail.length; i += 1) {
            const previous = trail[i - 1];
            const current = trail[i];
            const prevHop = hopReports[i - 1];
            if (current.self.found) {
                if (previous.self.found && previous.self.value !== current.self.value) {
                    issues.push({
                        param: param.name,
                        type: 'value_changed',
                        hopIndex: i,
                        fromValue: previous.self.value,
                        toValue: current.self.value,
                        severity,
                        message: `${param.name} changed from ${previous.self.value} to ${current.self.value} at hop ${i} (${current.hostname}).`,
                    });
                }
                continue;
            }
            if (current.alias.found) {
                issues.push({
                    param: param.name,
                    type: 'renamed',
                    hopIndex: i,
                    fromValue: previous.self.found ? previous.self.value : (previous.alias.value ?? null),
                    toValue: current.alias.value,
                    severity: 'info',
                    message: `${param.name} was renamed to ${current.alias.name} at hop ${i} (${prevHop.hostname}). Allowed by alias or per-hop rule.`,
                });
                continue;
            }
            const renamed = renamedTo(aliasNames, hopReports[i].params, prevHop.hostname, rules);
            if (renamed.found) {
                issues.push({
                    param: param.name,
                    type: 'renamed',
                    hopIndex: i,
                    fromValue: previous.self.value,
                    toValue: renamed.value,
                    severity: 'info',
                    message: `${param.name} was renamed to ${renamed.name} at hop ${i} (${prevHop.hostname}). Allowed by alias or per-hop rule.`,
                });
                continue;
            }
            if (mayConsume(aliasNames, prevHop.hostname, rules)) {
                issues.push({
                    param: param.name,
                    type: 'consumed',
                    hopIndex: i,
                    fromValue: previous.self.value,
                    toValue: null,
                    severity: 'info',
                    message: `${param.name} disappeared after ${prevHop.hostname}. Treated as a legitimate network consume, not a failure.`,
                });
                break;
            }
            issues.push({
                param: param.name,
                type: 'dropped',
                hopIndex: i,
                fromValue: previous.self.value,
                toValue: null,
                severity,
                message: `${param.name} disappeared at hop ${i} (${hopReports[i].hostname}) with no matching alias or consume rule.`,
            });
            break;
        }
    }

    if (!params.length) {
        return {
            trackingStatus: 'not_configured',
            issues,
            hopReports,
        };
    }

    const trackingStatus = issues.some((issue) => issue.severity === 'error' && issue.type !== 'consumed' && issue.type !== 'renamed')
        ? 'error'
        : issues.some((issue) => issue.severity === 'warning' && issue.type !== 'consumed' && issue.type !== 'renamed')
            ? 'warning'
            : 'ok';

    return { trackingStatus, issues, hopReports };
}

export function extractClientRedirect(html, baseUrl) {
    if (typeof html !== 'string' || !html) return null;
    const meta = html.match(/<meta\b[^>]*http-equiv\s*=\s*['"]?refresh['"]?[^>]*>/i)
        || html.match(/<meta\b[^>]*content\s*=\s*['"][^'"]+['"][^>]*http-equiv\s*=\s*['"]?refresh['"]?[^>]*>/i);
    if (meta) {
        const content = meta[0].match(/content\s*=\s*['"]([^'"]+)['"]/i);
        if (content) {
            const urlMatch = content[1].match(/url\s*=\s*['"]?([^'";\s]+)/i);
            if (urlMatch) {
                try { return new URL(urlMatch[1].trim(), baseUrl); } catch { /* ignore */ }
            }
        }
    }
    const patterns = [
        /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i,
        /location\.href\s*=\s*['"]([^'"]+)['"]/i,
        /location\.replace\(\s*['"]([^'"]+)['"]\s*\)/i,
        /location\.assign\(\s*['"]([^'"]+)['"]\s*\)/i,
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
            try { return new URL(match[1].trim(), baseUrl); } catch { /* ignore */ }
        }
    }
    return null;
}
