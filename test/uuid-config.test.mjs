import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const worker = (await loadWorker()).default;

const baseEnv = {
	PROXYIP: 'proxyip.example.net',
	DNS_RESOLVER_URL: 'https://cloudflare-dns.com/dns-query',
	DEBUG: 'false',
};

// Arbitrary and not a real credential: the tests only need a well-formed UUID.
const CONFIGURED_UUID = '00000000-0000-4000-8000-000000000001';

/**
 * @param {string} path request path
 * @returns {Request} a plain GET, i.e. not a WebSocket upgrade
 */
const get = (path) => new Request(`https://edge.example.com${path}`);

test('fetch refuses every route while UUID is unset', async () => {
	for (const path of ['/', '/cf', '/sub/anything', '/list']) {
		const response = await worker.fetch(get(path), { ...baseEnv }, {});
		assert.equal(response.status, 503, `${path} should be 503 without UUID`);
		assert.match(await response.text(), /^ERR_UUID_UNCONFIGURED/);
	}
});

test('fetch refuses when UUID is present but holds no usable value', async () => {
	for (const UUID of ['', '   ', ',,', 'not-a-uuid']) {
		const response = await worker.fetch(get('/cf'), { ...baseEnv, UUID }, {});
		assert.equal(response.status, 503, `UUID ${JSON.stringify(UUID)} should be rejected`);
	}
});

test('fetch serves once UUID is configured', async () => {
	const response = await worker.fetch(get('/cf'), { ...baseEnv, UUID: CONFIGURED_UUID }, {});
	assert.equal(response.status, 200);
});

test('a configured UUID does not leak into the next request', async () => {
	await worker.fetch(get('/cf'), { ...baseEnv, UUID: CONFIGURED_UUID }, {});
	const response = await worker.fetch(get('/cf'), { ...baseEnv }, {});
	assert.equal(response.status, 503, 'the previous request must not leave its UUID behind');
});

test('the module carries no built-in UUID to fall back on', async () => {
	const { readFile } = await import('node:fs/promises');
	const source = await readFile(new URL('../_worker.js', import.meta.url), 'utf8');
	const defaultUserID = /^let userID = '([^']*)';$/m.exec(source);
	assert.ok(defaultUserID, 'the module-level userID declaration moved; update this test');
	assert.equal(defaultUserID[1], '', 'a hardcoded UUID would authenticate on any deploy that forgets to set UUID');
});
