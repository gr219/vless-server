import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const { createSocks5Parser, SOCKS5_REPLY_OK, SOCKS5_REPLY_FAIL } = await loadWorker();

const CREDS = { user: 'alice', pass: 'hunter2' };

const bytes = (...values) => new Uint8Array(values);

/** Encodes an RFC 1929 username/password auth frame. */
function authFrame(user, pass) {
	const u = new TextEncoder().encode(user);
	const p = new TextEncoder().encode(pass);
	return new Uint8Array([0x01, u.length, ...u, p.length, ...p]);
}

/** Drives a parser through one chunk and collects every step it yields. */
function drive(parser, chunk) {
	parser.push(chunk);
	const steps = [];
	for (;;) {
		const step = parser.next();
		steps.push(step);
		if (step.state !== 'send') return steps;
	}
}

test('selects username/password when the client offers it', () => {
	const parser = createSocks5Parser(CREDS);
	const steps = drive(parser, bytes(0x05, 0x02, 0x00, 0x02));
	assert.deepEqual(steps[0], { state: 'send', bytes: bytes(0x05, 0x02) });
	assert.equal(steps[1].state, 'need-more');
});

test('refuses a client that offers only no-auth', () => {
	const parser = createSocks5Parser(CREDS);
	const [step] = drive(parser, bytes(0x05, 0x01, 0x00));
	assert.equal(step.state, 'fail');
	assert.deepEqual(step.bytes, bytes(0x05, 0xff));
	assert.equal(step.reason, 'no-acceptable-method');
});

test('refuses every client when no credentials are configured', () => {
	const parser = createSocks5Parser(null);
	const [step] = drive(parser, bytes(0x05, 0x02, 0x00, 0x02));
	assert.equal(step.state, 'fail');
	assert.deepEqual(step.bytes, bytes(0x05, 0xff));
	assert.equal(step.reason, 'unconfigured');
});

test('rejects a greeting that is not SOCKS5', () => {
	const parser = createSocks5Parser(CREDS);
	const [step] = drive(parser, bytes(0x04, 0x01, 0x00));
	assert.equal(step.state, 'fail');
	assert.equal(step.bytes, null);
	assert.equal(step.reason, 'bad-version');
});

test('accepts the configured credentials', () => {
	const parser = createSocks5Parser(CREDS);
	drive(parser, bytes(0x05, 0x01, 0x02));
	const steps = drive(parser, authFrame('alice', 'hunter2'));
	assert.deepEqual(steps[0], { state: 'send', bytes: bytes(0x01, 0x00) });
	assert.equal(steps[1].state, 'need-more');
});

test('rejects a wrong password and a wrong username alike', () => {
	for (const frame of [authFrame('alice', 'wrong'), authFrame('mallory', 'hunter2')]) {
		const parser = createSocks5Parser(CREDS);
		drive(parser, bytes(0x05, 0x01, 0x02));
		const [step] = drive(parser, frame);
		assert.equal(step.state, 'fail');
		assert.deepEqual(step.bytes, bytes(0x01, 0x01));
		assert.equal(step.reason, 'bad-credentials');
	}
});

/** Greets and authenticates a fresh parser, leaving it at the request stage. */
function authenticated() {
	const parser = createSocks5Parser(CREDS);
	drive(parser, bytes(0x05, 0x01, 0x02));
	drive(parser, authFrame('alice', 'hunter2'));
	return parser;
}

test('parses a CONNECT to an IPv4 address', () => {
	const [step] = drive(authenticated(), bytes(0x05, 0x01, 0x00, 0x01, 93, 184, 216, 34, 0x01, 0xbb));
	assert.equal(step.state, 'connect');
	assert.equal(step.host, '93.184.216.34');
	assert.equal(step.port, 443);
	assert.equal(step.rest.length, 0);
});

test('parses a CONNECT to a domain name', () => {
	const host = new TextEncoder().encode('example.com');
	const [step] = drive(authenticated(), bytes(0x05, 0x01, 0x00, 0x03, host.length, ...host, 0x00, 0x50));
	assert.equal(step.state, 'connect');
	assert.equal(step.host, 'example.com');
	assert.equal(step.port, 80);
});

test('parses a CONNECT to an IPv6 address, unbracketed like the VLESS path', () => {
	const addr = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01];
	const [step] = drive(authenticated(), bytes(0x05, 0x01, 0x00, 0x04, ...addr, 0x01, 0xbb));
	assert.equal(step.state, 'connect');
	assert.equal(step.host, '2001:db8:0:0:0:0:0:1');
	assert.equal(step.port, 443);
});

test('returns payload that arrived alongside the CONNECT as rest', () => {
	const [step] = drive(authenticated(),
		bytes(0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x01, 0xbb, 0xde, 0xad));
	assert.equal(step.state, 'connect');
	assert.deepEqual(step.rest, bytes(0xde, 0xad));
});

test('rejects BIND and UDP ASSOCIATE as unsupported commands', () => {
	for (const command of [0x02, 0x03]) {
		const [step] = drive(authenticated(), bytes(0x05, command, 0x00, 0x01, 1, 2, 3, 4, 0x01, 0xbb));
		assert.equal(step.state, 'fail');
		assert.deepEqual(step.bytes, bytes(0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
		assert.equal(step.reason, 'unsupported-command');
	}
});

test('rejects an unknown address type', () => {
	const [step] = drive(authenticated(), bytes(0x05, 0x01, 0x00, 0x09, 1, 2, 3, 4, 0x01, 0xbb));
	assert.equal(step.state, 'fail');
	assert.deepEqual(step.bytes, bytes(0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
	assert.equal(step.reason, 'bad-address-type');
});

test('completes a handshake delivered one byte at a time', () => {
	const whole = new Uint8Array([
		0x05, 0x01, 0x02,
		...authFrame('alice', 'hunter2'),
		0x05, 0x01, 0x00, 0x01, 93, 184, 216, 34, 0x01, 0xbb,
	]);
	const parser = createSocks5Parser(CREDS);
	let final = null;
	for (const byte of whole) {
		for (const step of drive(parser, bytes(byte))) {
			if (step.state === 'connect' || step.state === 'fail') final = step;
		}
	}
	assert.equal(final.state, 'connect');
	assert.equal(final.host, '93.184.216.34');
});

test('completes a handshake delivered as one coalesced chunk', () => {
	const whole = new Uint8Array([
		0x05, 0x01, 0x02,
		...authFrame('alice', 'hunter2'),
		0x05, 0x01, 0x00, 0x01, 93, 184, 216, 34, 0x01, 0xbb,
	]);
	const steps = drive(createSocks5Parser(CREDS), whole);
	assert.deepEqual(steps[0], { state: 'send', bytes: bytes(0x05, 0x02) });
	assert.deepEqual(steps[1], { state: 'send', bytes: bytes(0x01, 0x00) });
	assert.equal(steps[2].state, 'connect');
	assert.equal(steps[2].host, '93.184.216.34');
});

test('the success reply is a well-formed SOCKS5 reply with a null bound address', () => {
	assert.deepEqual(SOCKS5_REPLY_OK, bytes(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
});

// Pins the reply socks5OverWSHandler sends on the pinned-proxy failure path
// (Correction B / Task 7): when the first hop throws and there is no retry,
// handleTCPOutBound returns normally instead of rethrowing, so the handler
// must recognise "no onConnected call happened" and send this byte sequence
// itself. The `replied` branch that decides *when* to send it lives inside
// the unexported socks5OverWSHandler and isn't reachable without a real
// socket, so this only pins the reply's bytes, not that branch.
test('the failure reply is a well-formed SOCKS5 reply with a null bound address', () => {
	assert.deepEqual(SOCKS5_REPLY_FAIL, bytes(0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
});
