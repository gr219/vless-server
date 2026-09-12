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

test('the inline client script the browser receives is syntactically valid', async () => {
	// buildProxyListPage returns the whole page - script included - as one
	// template literal. A string that needs escaping inside that literal (an
	// apostrophe in a JS string, say) is invisible to every other check here:
	// the bootstrap JSON parses fine, the column headers are all present, and
	// the page still renders 200. The bug only exists in the text the browser
	// is handed to parse as JavaScript, so this is the one check that reads
	// the served output the same way a browser does - by trying to parse it.
	stubFetch();
	const request = new Request('https://edge.example.com/list', {
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${baseEnv.ADMIN_USER}:${baseEnv.ADMIN_PASS}`).toString('base64'),
		},
	});
	const response = await worker.fetch(request, { ...baseEnv }, {});
	const html = await response.text();

	// Every <script> tag with no src and no type is executed by the browser as
	// plain JavaScript. Grab each one and confirm it parses - this is the same
	// bug class as "Function is not defined": a syntax error anywhere in one
	// of these blocks aborts that whole script, silently, with no visible
	// error on the page itself.
	const scriptTagPattern = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
	const executableScripts = [];
	let match;
	while ((match = scriptTagPattern.exec(html))) {
		const attrs = match[1] || '';
		if (/\bsrc=/.test(attrs) || /\btype=/.test(attrs)) continue;
		executableScripts.push(match[2]);
	}
	assert.ok(executableScripts.length >= 2, 'expected at least the theme-init script and the main client script');

	executableScripts.forEach((source, index) => {
		assert.doesNotThrow(
			() => new Function(source),
			(error) => {
				throw new Error(`inline <script> #${index} failed to parse: ${error.message}`);
			},
		);
	});
});
