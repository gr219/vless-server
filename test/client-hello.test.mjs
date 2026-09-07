import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const { buildClientHello } = await loadWorker();

const SNI = 'speed.cloudflare.com';
const hello = buildClientHello(SNI);

const read16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const read24 = (bytes, at) => (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];

test('the record is a well formed TLS handshake record', () => {
	assert.ok(hello instanceof Uint8Array);
	assert.equal(hello[0], 0x16, 'record type must be handshake');
	assert.equal(read16(hello, 1), 0x0301, 'record version must be TLS 1.0 for compatibility');
	assert.equal(read16(hello, 3), hello.length - 5, 'record length must cover the rest of the buffer');
});

test('the handshake body is a ClientHello whose length matches', () => {
	assert.equal(hello[5], 0x01, 'handshake type must be ClientHello');
	assert.equal(read24(hello, 6), hello.length - 9, 'ClientHello length must cover the rest of the buffer');
	assert.equal(read16(hello, 9), 0x0303, 'legacy_version must be TLS 1.2');
});

/** Walks the record and returns its extensions as a Map of type to body. */
function extensionsOf(bytes) {
	let at = 9 + 2 + 32; // legacy_version, client random
	at += 1 + bytes[at]; // legacy session id
	at += 2 + read16(bytes, at); // cipher suites
	at += 1 + bytes[at]; // compression methods
	const end = at + 2 + read16(bytes, at);
	at += 2;
	const found = new Map();
	while (at < end) {
		const type = read16(bytes, at);
		const length = read16(bytes, at + 2);
		found.set(type, bytes.slice(at + 4, at + 4 + length));
		at += 4 + length;
	}
	assert.equal(at, end, 'extensions must consume exactly their declared length');
	return found;
}

test('the SNI extension names the probe target', () => {
	const sni = extensionsOf(hello).get(0x0000);
	assert.ok(sni, 'server_name extension missing');
	assert.equal(read16(sni, 0), sni.length - 2, 'server_name list length must match');
	assert.equal(sni[2], 0x00, 'name type must be host_name');
	assert.equal(read16(sni, 3), sni.length - 5, 'host_name length must match');
	assert.equal(new TextDecoder().decode(sni.slice(5)), SNI);
});

test('the extensions a modern server needs are present', () => {
	const found = extensionsOf(hello);
	for (const [type, name] of [[0x000a, 'supported_groups'], [0x000d, 'signature_algorithms'],
		[0x002b, 'supported_versions'], [0x0033, 'key_share']]) {
		assert.ok(found.has(type), `${name} extension missing`);
	}
});

test('each call uses fresh randomness', () => {
	const other = buildClientHello(SNI);
	assert.equal(other.length, hello.length);
	assert.notDeepEqual(other.slice(11, 43), hello.slice(11, 43), 'client random was reused');
});

test('a longer name still produces a consistent record', () => {
	const long = buildClientHello('a-much-longer-hostname.example.test');
	assert.equal(read16(long, 3), long.length - 5);
	assert.equal(read24(long, 6), long.length - 9);
	assert.equal(new TextDecoder().decode(extensionsOf(long).get(0x0000).slice(5)), 'a-much-longer-hostname.example.test');
});
