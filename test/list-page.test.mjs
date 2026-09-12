import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadWorker } from './load-worker.mjs';

const worker = (await loadWorker()).default;

const fixture = await readFile(new URL('./fixtures/proxies.csv', import.meta.url), 'utf8');

const baseEnv = {
	UUID: '00000000-0000-4000-8000-000000000001',
	ADMIN_USER: 'admin',
	ADMIN_PASS: 'secret',
};

/**
 * Installs a stub global fetch that always answers with the fixture CSV, so
 * the render never touches the real network.
 */
function stubFetch() {
	globalThis.fetch = async () => new Response(fixture, { status: 200 });
}

test('GET /list renders the repaired proxy browser', async () => {
	stubFetch();
	const request = new Request('https://edge.example.com/list', {
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${baseEnv.ADMIN_USER}:${baseEnv.ADMIN_PASS}`).toString('base64'),
		},
	});
	const response = await worker.fetch(request, { ...baseEnv }, {});
	assert.equal(response.status, 200);
	const html = await response.text();

	// Column headers: Country/Host/Port/ISP/Edge/Link present, Scan gone.
	assert.match(html, /Country/);
	assert.match(html, /Host/);
	assert.match(html, /Port/);
	assert.match(html, /ISP/);
	assert.match(html, /Edge/);
	assert.match(html, /Link/);
	assert.doesNotMatch(html, /Scan/);

	// The bootstrap JSON carries [cc, host, port, isp] rows, port as a number.
	const bootstrapMatch = /<script id="bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
	assert.ok(bootstrapMatch, 'the bootstrap script tag must be present');
	const bootstrap = JSON.parse(bootstrapMatch[1]);
	assert.ok(Array.isArray(bootstrap.rows) && bootstrap.rows.length > 0);
	bootstrap.rows.forEach((row) => {
		assert.equal(row.length, 4, 'each row is a 4-element [cc, host, port, isp] tuple');
		assert.equal(typeof row[2], 'number', 'the third element is the numeric port');
	});
});
