import test from 'node:test';
import assert from 'node:assert/strict';
import {
	flagToCountryCode,
	cleanText,
	parsePoolMarkdown,
	parseDailyMarkdown,
	renderCatalog,
} from '../scripts/refresh-catalog.mjs';

test('flagToCountryCode reads regional indicator pairs', () => {
	assert.equal(flagToCountryCode('\u{1F1E9}\u{1F1EA} Germany (387 proxies)'), 'DE');
	assert.equal(flagToCountryCode('\u{1F1ED}\u{1F1F0} Hong Kong'), 'HK');
});

test('flagToCountryCode falls back to ZZ for non-flag headings', () => {
	assert.equal(flagToCountryCode('\u{1F30E} Worldwide IPs'), 'ZZ');
	assert.equal(flagToCountryCode('<img alt="Google" /> Google (9)'), 'ZZ');
	assert.equal(flagToCountryCode(''), 'ZZ');
});

test('cleanText strips tags, footnotes and emphasis', () => {
	assert.equal(cleanText(' <pre><code>1.2.3.4</code></pre> '), '1.2.3.4');
	assert.equal(cleanText('**Turkey, Istanbul** [^1]'), 'Turkey, Istanbul');
});

const POOL_MARKDOWN = [
	'## Dynamic & Multi-Location Proxies',
	'',
	'\u{1F1F9}\u{1F1F7} **Turkey, Istanbul, Stark Industries** [^1]',
	'',
	'```yaml',
	'tr.diam4.ggff.net',
	'```',
	'',
	'\u{1F30E} **Worldwide IPs**',
	'',
	'```yaml',
	'proxyip.cmliussss.net',
	'ProxyIP.HK.CMLiussss.net',
	'proxyip.cmliussss.net',
	'```',
	'',
	'## How to Test ProxyIPs',
	'',
	'```bash',
	'curl -s https://example.com/test',
	'```',
].join('\n');

test('parsePoolMarkdown reads hosts and carries the label down', () => {
	const entries = parsePoolMarkdown(POOL_MARKDOWN);
	assert.deepEqual(entries, [
		{ cc: 'TR', host: 'tr.diam4.ggff.net', isp: 'Turkey, Istanbul, Stark Industries', kind: 'pool' },
		{ cc: 'ZZ', host: 'proxyip.cmliussss.net', isp: 'Worldwide IPs', kind: 'pool' },
		{ cc: 'HK', host: 'ProxyIP.HK.CMLiussss.net', isp: 'Worldwide IPs', kind: 'pool' },
	]);
});

test('parsePoolMarkdown ignores fenced blocks that are not hostnames', () => {
	const hosts = parsePoolMarkdown(POOL_MARKDOWN).map((entry) => entry.host);
	assert.ok(!hosts.some((host) => host.includes('curl')), 'a shell snippet leaked into the catalog');
});

const DAILY_MARKDOWN = [
	'## <img alt="Google" src="x" /> Google (9)',
	'| <pre><code>35.241.172.224</code></pre> | Google LLC | Brussels | <img src="badge" /> |',
	'',
	'## \u{1F1E6}\u{1F1E9} AD (1 proxies)',
	'|   IP   |   ISP   |   Location   |  Risk Score  |',
	'|:-------|:--------|:------------:|:------------:|',
	'| <pre><code>91.187.93.166</code></pre> | Andorra Telecom | Andorra la Vella | <img src="badge" /> |',
	'',
	'## \u{1F1E9}\u{1F1EA} Germany (2 proxies)',
	'| <pre><code>5.181.187.58</code></pre> | freakhosting.com | Frankfurt | <img src="badge" /> |',
	'| <pre><code>5.181.187.58</code></pre> | freakhosting.com | Frankfurt | <img src="badge" /> |',
].join('\n');

test('parseDailyMarkdown reads country tables and skips provider sections', () => {
	assert.deepEqual(parseDailyMarkdown(DAILY_MARKDOWN), [
		{ cc: 'AD', host: '91.187.93.166', isp: 'Andorra Telecom', kind: 'ip' },
		{ cc: 'DE', host: '5.181.187.58', isp: 'freakhosting.com', kind: 'ip' },
	]);
});

test('parseDailyMarkdown skips header and separator rows', () => {
	const hosts = parseDailyMarkdown(DAILY_MARKDOWN).map((entry) => entry.host);
	assert.deepEqual(hosts, ['91.187.93.166', '5.181.187.58']);
});

test('renderCatalog puts pools first, then sorts by latency', () => {
	const rendered = renderCatalog([
		{ cc: 'DE', host: 'b.example', isp: 'ISP B', latency: 50, kind: 'ip' },
		{ cc: 'HK', host: 'slow.pool', isp: 'ISP C', latency: 900, kind: 'pool' },
		{ cc: 'US', host: 'a.example', isp: 'ISP A', latency: 10, kind: 'ip' },
	]);
	const rows = rendered.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
	assert.deepEqual(rows, [
		'HK\tslow.pool\tISP C\t900\tpool',
		'US\ta.example\tISP A\t10\tip',
		'DE\tb.example\tISP B\t50\tip',
	]);
	assert.ok(rendered.endsWith('\n'), 'catalog must end with a newline');
});
