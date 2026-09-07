import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const { parseRequestedProxyIP, selectProxyIP, parseProxyIPs } = await loadWorker();

const url = (query) => `https://edge.example.com/${query}`;

test('parseRequestedProxyIP reads a hostname pinned in the path', () => {
	assert.deepEqual(parseRequestedProxyIP(url('?ed=2048&proxyip=ProxyIP.SG.CMLiussss.net')),
		{ host: 'ProxyIP.SG.CMLiussss.net', port: null });
});

test('parseRequestedProxyIP reads a bare IPv4 literal', () => {
	assert.deepEqual(parseRequestedProxyIP(url('?proxyip=138.2.108.213')),
		{ host: '138.2.108.213', port: null });
});

test('parseRequestedProxyIP keeps an explicit port', () => {
	assert.deepEqual(parseRequestedProxyIP(url('?proxyip=138.2.108.213:8443')),
		{ host: '138.2.108.213', port: 8443 });
});

test('parseRequestedProxyIP keeps bracketed IPv6 colons out of the port split', () => {
	assert.deepEqual(parseRequestedProxyIP(url('?proxyip=%5B2a01%3A4f8%3Ac2c%3A123f%3A64%3A5%3A6810%3Ac55a%5D')),
		{ host: '[2a01:4f8:c2c:123f:64:5:6810:c55a]', port: null });
	assert.deepEqual(parseRequestedProxyIP(url('?proxyip=%5B2a01%3A4f8%3A%3A1%5D%3A443')),
		{ host: '[2a01:4f8::1]', port: 443 });
});

test('parseRequestedProxyIP returns null when the parameter is absent or empty', () => {
	assert.equal(parseRequestedProxyIP(url('?ed=2048')), null);
	assert.equal(parseRequestedProxyIP(url('?proxyip=')), null);
});

test('parseRequestedProxyIP rejects malformed values', () => {
	for (const bad of ['a b', 'host/../x', 'http://host', 'host:99999', 'host:0', 'host:abc', '-host', '']) {
		assert.equal(parseRequestedProxyIP(url(`?proxyip=${encodeURIComponent(bad)}`)), null, bad);
	}
});

test('parseRequestedProxyIP returns null for an unparseable URL', () => {
	assert.equal(parseRequestedProxyIP('not a url'), null);
});

test('selectProxyIP honours the pinned choice over the pool', () => {
	assert.deepEqual(selectProxyIP({ host: '1.2.3.4', port: null }, ['pool.example.com']),
		{ host: '1.2.3.4', port: null, pinned: true });
});

test('selectProxyIP falls back to a pool member when nothing is pinned', () => {
	assert.deepEqual(selectProxyIP(null, ['only.example.com']),
		{ host: 'only.example.com', port: null, pinned: false });
});

test('selectProxyIP returns null when nothing is pinned and the pool is empty', () => {
	assert.equal(selectProxyIP(null, []), null);
	assert.equal(selectProxyIP(null, undefined), null);
});

test('parseProxyIPs splits and trims the PROXYIP environment variable', () => {
	assert.deepEqual(parseProxyIPs(' a.example.com , b.example.com ,, '), ['a.example.com', 'b.example.com']);
	assert.deepEqual(parseProxyIPs(undefined), []);
});
