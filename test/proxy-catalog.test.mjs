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
