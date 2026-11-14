import net from 'node:net';

const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata.goog',
]);

const BLOCKED_SUFFIXES = [
    '.localhost',
    '.local',
    '.localdomain',
    '.internal',
    '.intranet',
    '.lan',
    '.home',
    '.corp',
    '.home.arpa',
    '.alt',
];

const V4_BLOCKS = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

export class SsrfError extends Error {
    constructor(reason) {
        super(`target_not_allowed:${reason}`);
        this.name = 'SsrfError';
        this.reason = reason;
    }
}

function ipv4ToInt(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (!Number.isInteger(n) || n > 255) return null;
        value = (value * 256) + n;
    }
    return value >>> 0;
}

function inCidr(value, base, bits) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
}

export function ipv6ToBytes(input) {
    if (typeof input !== 'string' || input.length === 0) return null;
    let ip = input.toLowerCase();
    const zone = ip.indexOf('%');
    if (zone !== -1) ip = ip.slice(0, zone);
    if (ip.includes('.')) {
        const lastColon = ip.lastIndexOf(':');
        const v4 = ip.slice(lastColon + 1);
        const v4int = ipv4ToInt(v4);
        if (v4int == null) return null;
        const hi = ((v4int >>> 16) & 0xffff).toString(16);
        const lo = (v4int & 0xffff).toString(16);
        ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const parseGroups = (text) => (text ? text.split(':') : []);
    const left = parseGroups(halves[0]);
    const right = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (left.some((g) => g === '') || right.some((g) => g === '')) return null;
    const missing = 8 - (left.length + right.length);
    if (halves.length === 1 && missing !== 0) return null;
    if (halves.length === 2 && missing < 0) return null;
    const groups = halves.length === 2
        ? [...left, ...Array(missing).fill('0'), ...right]
        : left;
    if (groups.length !== 8) return null;
    const bytes = [];
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        const n = Number.parseInt(group, 16);
        bytes.push((n >> 8) & 255, n & 255);
    }
    return bytes;
}

export function isPublicAddress(address) {
    if (typeof address !== 'string') return false;
    const ip = address.trim().toLowerCase();
    if (ip.startsWith('[') && ip.endsWith(']')) return isPublicAddress(ip.slice(1, -1));
    if (net.isIPv4(ip)) return isPublicV4(ip);
    if (!net.isIPv6(ip) && !ip.includes(':')) return false;
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return false;
    const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) {
        return isPublicV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    const nat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b
        && bytes.slice(4, 12).every((b) => b === 0);
    if (nat64) {
        return isPublicV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    if (bytes.every((b) => b === 0)) return false;
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return false;
    if ((bytes[0] & 0xfe) === 0xfc) return false;
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return false;
    if (bytes[0] === 0xff) return false;
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
    if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((b) => b === 0)) return false;
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02
        && bytes[4] === 0x00 && bytes[5] === 0x00) return false;
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false;
    return true;
}

function isPublicV4(ip) {
    const value = ipv4ToInt(ip);
    if (value == null) return false;
    for (const [base, bits] of V4_BLOCKS) {
        if (inCidr(value, ipv4ToInt(base), bits)) return false;
    }
    return true;
}

export function assertPublicHostname(hostname) {
    if (typeof hostname !== 'string') throw new SsrfError('hostname');
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253) throw new SsrfError('hostname');
    if (net.isIP(host)) throw new SsrfError('ip_literal');
    if (/^\d+$/.test(host)) throw new SsrfError('numeric_host');
    if (host.includes('%') || host.includes(' ')) throw new SsrfError('hostname');
    if (BLOCKED_HOSTS.has(host)) throw new SsrfError('blocked_host');
    if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new SsrfError('blocked_suffix');
    if (!host.includes('.')) throw new SsrfError('single_label');
    const labels = host.split('.');
    if (labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9-]+$/.test(label))) {
        throw new SsrfError('hostname');
    }
    return host;
}

export function assertPublicResolution(records) {
    if (!Array.isArray(records) || records.length === 0) throw new SsrfError('dns_empty');
    const clean = [];
    for (const record of records) {
        const address = record?.address;
        if (!isPublicAddress(address)) throw new SsrfError('private_address');
        clean.push({ address, family: net.isIPv6(address) ? 6 : 4 });
    }
    return clean;
}
