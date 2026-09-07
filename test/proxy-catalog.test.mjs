import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadWorker } from './load-worker.mjs';

const { getProxyCatalog } = await loadWorker();

test('the catalog parses every data row and drops the comment header', async () => {
	const raw = await readFile(new URL('../data/proxies.tsv', import.meta.url), 'utf8');
	const dataLines = raw.split('\n')
		.map((line) => line.replace(/\r$/, ''))
		.filter((line) => line.length > 0 && !line.startsWith('#'));

	const catalog = getProxyCatalog();
	assert.equal(catalog.length, dataLines.length);
	assert.ok(catalog.length > 100, 'catalog looks suspiciously small');
});

test('every entry is well formed', () => {
	for (const entry of getProxyCatalog()) {
		assert.match(entry.cc, /^[A-Z]{2}$/, `bad country code: ${entry.cc}`);
		assert.ok(entry.host.length > 0, 'empty host');
		assert.ok(entry.isp.length > 0, `empty isp for ${entry.host}`);
		assert.ok(Number.isFinite(entry.latency), `non-numeric latency for ${entry.host}`);
		assert.ok(entry.kind === 'ip' || entry.kind === 'pool', `bad kind for ${entry.host}: ${entry.kind}`);
	}
});

test('hosts are unique', () => {
	const seen = new Set();
	for (const entry of getProxyCatalog()) {
		assert.ok(!seen.has(entry.host), `duplicate host: ${entry.host}`);
		seen.add(entry.host);
	}
});
