#!/usr/bin/env node
/**
 * Regenerates data/proxies.tsv from the upstream NiREvil/vless lists.
 *
 * Two sources, two shapes:
 *   ProxyIP.md        rotating hostnames ("pool" rows), introduced by a bold
 *                     flag-prefixed label with the hosts in fenced code blocks.
 *   ProxyIP-Daily.md  individual addresses ("ip" rows), in markdown tables
 *                     under `## <flag> <Country> (N proxies)` headings.
 *
 * Every candidate is TCP-probed on 443 before it is written, so a dead entry
 * never reaches the catalog and the round trip becomes the `latencyMs` ranking
 * hint. Probing happens from wherever this runs - a GitHub runner, not the
 * Cloudflare edge - which is why /list offers "Re-measure selected" for numbers
 * that reflect the real path.
 *
 * Usage:
 *   node scripts/refresh-catalog.mjs            # rewrite data/proxies.tsv
 *   node scripts/refresh-catalog.mjs --check    # exit 1 if the file is stale
 */
import net from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const POOL_URL = 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/ProxyIP.md';
const DAILY_URL = 'https://raw.githubusercontent.com/NiREvil/vless/main/sub/ProxyIP-Daily.md';
const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'proxies.tsv');

const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_CONCURRENCY = 120;
/** A catalog this small means an upstream format change, not a bad proxy day. */
const MIN_EXPECTED_ENTRIES = 200;

/**
 * Turns a regional-indicator flag emoji into its ISO country code. Globe emoji
 * and anything unrecognised fall back to ZZ, the catalog's "worldwide" code.
 * @param {string} text any string that may start with a flag emoji
 * @returns {string} a two-letter uppercase country code
 */
export function flagToCountryCode(text) {
	const points = [...text.trim()].slice(0, 2).map((char) => char.codePointAt(0));
	if (points.length < 2) return 'ZZ';
	const isIndicator = points.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff);
	if (!isIndicator) return 'ZZ';
	return points.map((point) => String.fromCharCode(point - 0x1f1e6 + 65)).join('');
}

/**
 * Collapses whitespace and strips markdown emphasis, footnote and tag noise, so
 * a table cell becomes the plain ISP string the catalog stores.
 * @param {string} value
 * @returns {string}
 */
export function cleanText(value) {
	return value
		.replace(/<[^>]*>/g, ' ')
		.replace(/\[\^\d+\]/g, ' ')
		.replace(/[*_`]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Parses the rotating-hostname sections of ProxyIP.md.
 * @param {string} markdown
 * @returns {{ cc: string, host: string, isp: string, kind: 'pool' }[]}
 */
export function parsePoolMarkdown(markdown) {
	const entries = [];
	const seen = new Set();
	let cc = 'ZZ';
	let isp = 'Rotating pool';
	let inFence = false;

	for (const rawLine of markdown.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (line.startsWith('```')) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			const host = line.trim();
			// Hostnames only: fenced blocks elsewhere in the file hold config
			// snippets, which never look like a bare domain.
			if (!host.includes('.') || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) continue;
			if (seen.has(host)) continue;
			seen.add(host);
			// The CMLiussss hosts share one label but name their region in the
			// hostname (ProxyIP.HK.CMLiussss.net), which beats the label's code.
			const region = host.match(/^[^.]+\.([A-Za-z]{2})\./);
			entries.push({ cc: region ? region[1].toUpperCase() : cc, host, isp, kind: 'pool' });
			continue;
		}
		// A bold, flag-prefixed line introduces the block(s) that follow it.
		const label = line.match(/^\s*(\P{L}*?)\*\*(.+?)\*\*/u);
		if (label) {
			cc = flagToCountryCode(label[1]);
			isp = cleanText(label[2]) || 'Rotating pool';
		}
	}
	return entries;
}

/**
 * Parses the per-country tables of ProxyIP-Daily.md.
 * @param {string} markdown
 * @returns {{ cc: string, host: string, isp: string, kind: 'ip' }[]}
 */
export function parseDailyMarkdown(markdown) {
	const entries = [];
	const seen = new Set();
	let cc = null;

	for (const rawLine of markdown.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		const heading = line.match(/^##\s+(.*)$/);
		if (heading) {
			// Provider headings (Google, Amazon, ...) carry no flag, and their rows
			// repeat under the country headings, so they are skipped entirely.
			const code = flagToCountryCode(heading[1]);
			cc = code === 'ZZ' ? null : code;
			continue;
		}
		if (cc === null || !line.startsWith('|')) continue;
		const cells = line.split('|').slice(1, -1);
		if (cells.length < 2) continue;
		const host = cleanText(cells[0]);
		if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) continue;
		if (seen.has(host)) continue;
		seen.add(host);
		entries.push({ cc, host, isp: cleanText(cells[1]) || 'Unknown', kind: 'ip' });
	}
	return entries;
}

/**
 * Opens a TCP connection and reports how long it took.
 * @param {string} host
 * @returns {Promise<number | null>} round trip in milliseconds, or null if the
 *   host refused, errored or timed out
 */
function probe(host) {
	return new Promise((resolve) => {
		const started = Date.now();
		const socket = net.connect({ host, port: PROBE_PORT });
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS);
		socket.once('connect', () => finish(Date.now() - started));
		socket.once('timeout', () => finish(null));
		socket.once('error', () => finish(null));
	});
}

/**
 * Probes every entry with a bounded number of sockets in flight, keeping the
 * ones that answered.
 * @template {{ host: string }} T
 * @param {T[]} entries
 * @returns {Promise<(T & { latency: number })[]>}
 */
async function probeAll(entries) {
	const alive = [];
	let next = 0;
	const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, entries.length) }, async () => {
		while (next < entries.length) {
			const entry = entries[next++];
			const latency = await probe(entry.host);
			if (latency !== null) alive.push({ ...entry, latency });
		}
	});
	await Promise.all(workers);
	return alive;
}

/**
 * Renders the TSV, header included. Pools sort ahead of individual addresses
 * because they stay healthy without a redeploy; each group sorts by latency.
 * @param {{ cc: string, host: string, isp: string, latency: number, kind: string }[]} entries
 * @returns {string}
 */
export function renderCatalog(entries) {
	const sorted = [...entries].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'pool' ? -1 : 1;
		if (a.latency !== b.latency) return a.latency - b.latency;
		return a.host.localeCompare(b.host);
	});
	const header = [
		'# Verified-alive proxy endpoints, one per line, tab separated as:',
		'#   countryCode <TAB> host <TAB> isp <TAB> latencyMs <TAB> kind',
		'#',
		'# "pool" rows are hostnames that resolve to a continuously refreshed set of',
		'# working IPs; "ip" rows are individual addresses. The latency figure is a rough',
		'# ranking hint measured from outside the Cloudflare network - use the',
		'# "Re-measure selected" button on /list for timings from the edge itself.',
		'#',
		'# Regenerated by scripts/refresh-catalog.mjs (npm run catalog) from:',
		'#   https://github.com/NiREvil/vless/blob/main/sub/ProxyIP.md',
		'#   https://github.com/NiREvil/vless/blob/main/sub/ProxyIP-Daily.md',
		'# Lines starting with # and blank lines are ignored by the parser.',
	];
	const rows = sorted.map((entry) => [entry.cc, entry.host, entry.isp, entry.latency, entry.kind].join('\t'));
	return [...header, ...rows].join('\n') + '\n';
}

/** Strips the comment header so two catalogs compare on their data alone. */
function dataOnly(text) {
	return text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#')).join('\n');
}

async function fetchText(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`ERR_CATALOG_FETCH_FAILED: ${url} returned ${response.status}`);
	}
	return response.text();
}

async function main() {
	const checkOnly = process.argv.includes('--check');
	const [poolMarkdown, dailyMarkdown] = await Promise.all([fetchText(POOL_URL), fetchText(DAILY_URL)]);

	const pools = parsePoolMarkdown(poolMarkdown);
	const ips = parseDailyMarkdown(dailyMarkdown);
	console.log(`parsed ${pools.length} pool hosts and ${ips.length} addresses`);
	if (pools.length === 0 || ips.length === 0) {
		throw new Error('ERR_CATALOG_PARSE_EMPTY: upstream layout changed, refusing to write an empty catalog');
	}

	// A host listed in both files is the same endpoint; the pool entry wins.
	const poolHosts = new Set(pools.map((entry) => entry.host));
	const candidates = [...pools, ...ips.filter((entry) => !poolHosts.has(entry.host))];

	const started = Date.now();
	const alive = await probeAll(candidates);
	console.log(`${alive.length}/${candidates.length} answered on ${PROBE_PORT} in ${Date.now() - started}ms`);
	if (alive.length < MIN_EXPECTED_ENTRIES) {
		throw new Error(`ERR_CATALOG_TOO_SMALL: only ${alive.length} live entries, expected at least ${MIN_EXPECTED_ENTRIES}`);
	}

	const rendered = renderCatalog(alive);
	const current = await readFile(CATALOG_PATH, 'utf8').catch(() => '');
	if (dataOnly(current) === dataOnly(rendered)) {
		console.log('catalog already up to date');
		return;
	}
	if (checkOnly) {
		console.error('ERR_CATALOG_STALE: data/proxies.tsv differs from upstream; run `npm run catalog`');
		process.exitCode = 1;
		return;
	}
	await writeFile(CATALOG_PATH, rendered, 'utf8');
	console.log(`wrote ${alive.length} entries to data/proxies.tsv`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
