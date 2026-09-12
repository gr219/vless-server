#!/usr/bin/env node
/**
 * Ensures the worker has a SOCKS5 login.
 *
 * The credentials are generated once and then left alone, because they are
 * baked into every socks5:// link handed out from /list - regenerating them on
 * each deploy would silently break everything already distributed. Rotation is
 * therefore a deliberate act: `npm run socks:rotate`.
 *
 * Usage:
 *   node scripts/socks-creds.mjs            ensure both secrets exist
 *   node scripts/socks-creds.mjs --rotate   replace them unconditionally
 */
import { randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** Unreserved URI characters only, so a credential never needs escaping in a link. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const USER_LENGTH = 12;
const PASS_LENGTH = 32;
const SECRET_NAMES = ['SOCKS_USER', 'SOCKS_PASS'];

/**
 * @param {number} length
 * @returns {string} a uniformly random string over ALPHABET
 */
function randomToken(length) {
	let out = '';
	// randomInt is rejection-sampled, so this has no modulo bias.
	for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
	return out;
}

/**
 * @returns {Set<string>} the names of secrets already set on the worker
 */
function existingSecrets() {
	try {
		const raw = execFileSync('npx', ['wrangler', 'secret', 'list'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: process.platform === 'win32',
		});
		const start = raw.indexOf('[');
		if (start < 0) return new Set();
		return new Set(JSON.parse(raw.slice(start)).map((secret) => secret.name));
	} catch (error) {
		// No account token, no deployed worker yet, offline - all reach here.
		// Treating that as "nothing is set" would overwrite live credentials, so
		// it has to stop instead.
		throw new Error(`ERR_SOCKS_SECRET_LIST_FAILED: could not read the worker's secrets: ${error.message}`);
	}
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {void}
 */
function putSecret(name, value) {
	execFileSync('npx', ['wrangler', 'secret', 'put', name], {
		input: value,
		stdio: ['pipe', 'inherit', 'inherit'],
		shell: process.platform === 'win32',
	});
}

const rotate = process.argv.includes('--rotate');
const present = existingSecrets();
const missing = SECRET_NAMES.filter((name) => !present.has(name));

if (!rotate && missing.length === 0) {
	console.log('SOCKS5 credentials already set; leaving them alone. Use --rotate to replace them.');
	process.exit(0);
}
if (!rotate && missing.length === 1) {
	throw new Error(`ERR_SOCKS_SECRETS_HALF_SET: ${missing[0]} is missing while its pair is set. `
		+ 'Run with --rotate to replace both.');
}

const user = randomToken(USER_LENGTH);
const pass = randomToken(PASS_LENGTH);
putSecret('SOCKS_USER', user);
putSecret('SOCKS_PASS', pass);

console.log('');
console.log(rotate
	? 'Rotated the SOCKS5 credentials. Every previously distributed socks5:// link is now dead.'
	: 'Generated the SOCKS5 credentials.');
console.log(`  SOCKS_USER  ${user}`);
console.log(`  SOCKS_PASS  ${pass}`);
console.log('');
console.log('They are shown here once. /list reads them from the worker, so there is');
console.log('nothing to write down unless you want them outside that page.');
