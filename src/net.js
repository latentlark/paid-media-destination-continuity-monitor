import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { HARD_LIMITS } from './constants.js';

export function createRealResolver() {
    return async function resolve(hostname) {
        return lookup(hostname, { all: true, verbatim: true });
    };
}

export function createRealTransport() {
    return function transport({ hostname, address, family, path, timeoutMs, headers }) {
        return new Promise((resolve, reject) => {
            const request = https.request({
                protocol: 'https:',
                host: address,
                servername: hostname,
                method: 'GET',
                path,
                headers,
                timeout: timeoutMs,
                rejectUnauthorized: true,
                family,
            }, (response) => {
                const chunks = [];
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > HARD_LIMITS.maxBodyBytes) {
                        response.destroy();
                        reject(Object.assign(new Error('body_too_large'), { code: 'body_too_large' }));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            });
            request.on('timeout', () => {
                request.destroy(Object.assign(new Error('timeout'), { code: 'timeout' }));
            });
            request.on('error', reject);
            request.end();
        });
    };
}
