import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const { selectProxyIP, planOutbound } = await loadWorker();

const DEST = { host: 'example.com', port: 443 };

test('selectProxyIP marks a client-pinned choice as pinned', () => {
	const chosen = selectProxyIP({ host: '1.2.3.4', port: null }, ['pool.example.com']);
	assert.deepEqual(chosen, { host: '1.2.3.4', port: null, pinned: true });
});

test('selectProxyIP marks a pool choice as not pinned', () => {
	const chosen = selectProxyIP(null, ['only.example.com']);
	assert.deepEqual(chosen, { host: 'only.example.com', port: null, pinned: false });
});

test('a pinned proxy carries the traffic instead of being a fallback', () => {
	const plan = planOutbound({ host: '1.2.3.4', port: null, pinned: true }, DEST.host, DEST.port);
	assert.deepEqual(plan.first, { host: '1.2.3.4', port: 443 },
		'the pinned proxy must be the first and only hop');
	assert.equal(plan.retry, null,
		'a pinned proxy must never fall back to direct: that would leak the host IP');
});

test('a pinned proxy keeps its own port when it carries one', () => {
	const plan = planOutbound({ host: '1.2.3.4', port: 8443, pinned: true }, DEST.host, DEST.port);
	assert.deepEqual(plan.first, { host: '1.2.3.4', port: 8443 });
});

test('a pool proxy carries the traffic but may fall back to direct', () => {
	const plan = planOutbound({ host: 'pool.example.com', port: null, pinned: false }, DEST.host, DEST.port);
	assert.deepEqual(plan.first, { host: 'pool.example.com', port: 443 });
	assert.deepEqual(plan.retry, { host: 'example.com', port: 443 });
});

test('with no proxy at all the connection goes direct and does not retry', () => {
	const plan = planOutbound(null, DEST.host, DEST.port);
	assert.deepEqual(plan.first, { host: 'example.com', port: 443 });
	assert.equal(plan.retry, null);
});

test('planOutbound never returns the destination as the first hop while a proxy is selected', () => {
	for (const pinned of [true, false]) {
		const plan = planOutbound({ host: 'relay.example.com', port: null, pinned }, DEST.host, DEST.port);
		assert.notEqual(plan.first.host, DEST.host,
			'connecting direct first is what made proxyip inert on an unrestricted host');
	}
});
