import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadWorker } from './load-worker.mjs';

const { parseProxyCsv } = await loadWorker();

const fixture = await readFile(new URL('./fixtures/proxies.csv', import.meta.url), 'utf8');

test('parseProxyCsv keeps only well-formed rows and drops the header', () => {
	const catalog = parseProxyCsv(fixture);
	assert.deepEqual(catalog, [
		{ cc: 'AE', host: '172.86.77.145', port: 443, isp: 'RouterHosting LLC' },
		{ cc: 'DE', host: '20.174.15.226', port: 8443, isp: 'Microsoft Corporation' },
		{ cc: 'SG', host: '2001:db8::1', port: 2053, isp: 'Example Networks' },
	]);
});

test('parseProxyCsv parses the port as a number, not a string', () => {
	const [first] = parseProxyCsv(fixture);
	assert.equal(typeof first.port, 'number');
});

test('parseProxyCsv tolerates CRLF line endings and a trailing newline', () => {
	const crlf = fixture.replace(/\n/g, '\r\n') + '\r\n';
	assert.equal(parseProxyCsv(crlf).length, 3);
});

test('parseProxyCsv trims surrounding whitespace in every field', () => {
	const spaced = 'IP Address, Port, TLS, Data Center, Region, City, ASN, latency\n'
		+ ' 9.9.9.9 , 443 , true , NL , N/A , - , Spaced ISP , - \n';
	assert.deepEqual(parseProxyCsv(spaced), [
		{ cc: 'NL', host: '9.9.9.9', port: 443, isp: 'Spaced ISP' },
	]);
});

test('parseProxyCsv returns an empty array for empty or header-only input', () => {
	assert.deepEqual(parseProxyCsv(''), []);
	assert.deepEqual(parseProxyCsv('IP Address, Port, TLS, Data Center, Region, City, ASN, latency\n'), []);
});

test('parseProxyCsv accepts a lowercase country code by upper-casing it', () => {
	const lower = 'IP Address, Port, TLS, Data Center, Region, City, ASN, latency\n'
		+ '8.8.8.8,443,true,jp,N/A,-,Google,-\n';
	assert.equal(parseProxyCsv(lower)[0].cc, 'JP');
});

const { fetchProxyCatalog, __resetCatalogCacheForTests } = await loadWorker();

/**
 * Installs a stub global fetch that answers with `bodies[n]` on call n, and
 * records how many times it was called. A body of `null` means "reject".
 * @param {Array<string | null>} bodies
 * @param {number} [status]
 */
function stubFetch(bodies, status = 200) {
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
		if (body === null) throw new Error('network down');
		return new Response(body, { status });
	};
	return calls;
}

test('fetchProxyCatalog fetches, parses and caches the upstream CSV', async () => {
	__resetCatalogCacheForTests();
	const calls = stubFetch([fixture]);
	const first = await fetchProxyCatalog({});
	assert.equal(first.length, 3);
	assert.equal(first[1].port, 8443);

	// A second call inside the TTL must not touch the network again.
	const second = await fetchProxyCatalog({});
	assert.equal(calls.length, 1);
	assert.deepEqual(second, first);
});

test('fetchProxyCatalog uses CATALOG_URL when it is set', async () => {
	__resetCatalogCacheForTests();
	const calls = stubFetch([fixture]);
	await fetchProxyCatalog({ CATALOG_URL: 'https://example.test/other.csv' });
	assert.equal(calls[0], 'https://example.test/other.csv');
});

test('fetchProxyCatalog keeps the last good parse when a refetch fails', async () => {
	__resetCatalogCacheForTests();
	stubFetch([fixture]);
	const good = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	stubFetch([null]);
	const stale = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	assert.deepEqual(stale, good);
});

test('fetchProxyCatalog keeps the last good parse on a non-200 response', async () => {
	__resetCatalogCacheForTests();
	stubFetch([fixture]);
	const good = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	stubFetch(['not found'], 404);
	const stale = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	assert.deepEqual(stale, good);
});

test('fetchProxyCatalog returns an empty catalog when the very first fetch fails', async () => {
	__resetCatalogCacheForTests();
	stubFetch([null]);
	assert.deepEqual(await fetchProxyCatalog({}), []);
});
