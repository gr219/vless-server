# Remote Proxy Catalog, Per-Proxy Ports and SOCKS5 Inbound — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bundled, workflow-generated proxy catalog with a live CSV fetched at runtime, honour the per-proxy port that CSV carries, and accept SOCKS5 as a second inbound protocol alongside VLESS.

**Architecture:** `_worker.js` is a single-file Cloudflare Worker. The catalog stops being a build-time `Text` import and becomes an async fetch with a three-layer cache (module scope, `caches.default`, stale-on-error). SOCKS5 is added as an incremental, pure handshake parser plus a thin WebSocket handler that reuses the existing `planOutbound` / `handleTCPOutBound` / `remoteSocketToWS` outbound machinery. `/list` gains a protocol dropdown that switches link generation between `vless://` and `socks5://`.

**Tech Stack:** Cloudflare Workers (`cloudflare:sockets`, `caches.default`), wrangler 4, plain JavaScript with JSDoc types, `node --test` for unit tests, Tailwind CDN for the `/list` page.

**Spec:** `docs/superpowers/specs/2026-09-12-catalog-source-and-socks5-design.md`

## Global Constraints

- **No TypeScript.** The codebase is `.js`/`.mjs` with JSDoc type annotations. Add JSDoc `@param`/`@returns` to every new function.
- **Indentation is tabs**, matching the existing `_worker.js` and test files.
- **Errors are descriptive and coded.** Follow the existing `ERR_<SCOPE>_<REASON>` convention (`ERR_MEASURE_BAD_JSON`, `ERR_LIST_UNAUTHORIZED`). Never fail silently in a code path a user can observe; the one deliberate exception is a malformed catalog row, which is skipped by design.
- **No secrets in committed files.** `SOCKS_USER` and `SOCKS_PASS` are Workers secrets, exactly like the existing `UUID` and `ADMIN_PASS`. `wrangler.toml` may document them in a comment but must never contain a value.
- **Naming:** `camelCase` for variables and functions, `PascalCase` for types in JSDoc typedefs.
- **Catalog URL default:** `https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/country_proxies/02_proxies.csv`
- **Catalog TTL default:** `21600` seconds (6 hours).
- **Node version in CI:** `24`.
- **Every task ends with a commit.** Commit messages use Conventional Commits and end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Run the full suite before every commit:** `npm test`.

## File Structure

| File | Responsibility | Change |
| ---- | -------------- | ------ |
| `_worker.js` | The whole worker: routing, VLESS, SOCKS5, catalog, `/list` UI | Modified throughout |
| `scripts/socks-creds.mjs` | Generate and upload `SOCKS_USER` / `SOCKS_PASS` once | Create |
| `scripts/refresh-catalog.mjs` | Old catalog generator | Delete |
| `data/proxies.tsv` | Old bundled catalog | Delete |
| `wrangler.toml` | Vars and bundler rules | Modified |
| `package.json` | Scripts | Modified |
| `.github/workflows/ci.yml` | Node 24 | Modified |
| `.github/workflows/tunnel.yml` | Node 24 | Modified |
| `.github/workflows/refresh-proxy-catalog.yml` | Daily catalog PR | Delete |
| `test/load-worker.mjs` | Loads `_worker.js` under plain Node | Modified |
| `test/fixtures/proxies.csv` | Small hand-written CSV for catalog tests | Create |
| `test/proxy-catalog.test.mjs` | CSV parsing and caching | Rewrite |
| `test/socks5-handshake.test.mjs` | SOCKS5 handshake parser | Create |
| `test/refresh-catalog.test.mjs` | Old generator tests | Delete |
| `README.md` | Setup and operation docs | Modified |

`_worker.js` is already ~2,000 lines. The spec does not call for splitting it, and the Workers `Text`/module setup plus the single-file `main` in `wrangler.toml` make a split a larger change than this work justifies — so new code follows the existing sectioned-comment layout inside the same file.

---

### Task 1: Retire the refresh workflow and move CI to Node 24

Pure removal plus a version bump. `scripts/refresh-catalog.mjs` is not imported by `_worker.js`, so this is safe to land before the catalog rewrite.

**Files:**
- Delete: `.github/workflows/refresh-proxy-catalog.yml`
- Delete: `scripts/refresh-catalog.mjs`
- Delete: `test/refresh-catalog.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/tunnel.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: nothing. `data/proxies.tsv` still exists and `getProxyCatalog()` is untouched — that is Task 3.

- [ ] **Step 1: Confirm the suite is green before touching anything**

Run: `npm test`
Expected: PASS. Note the test file count; it drops by one in this task.

- [ ] **Step 2: Delete the refresh workflow, its script, and its test**

```bash
git rm .github/workflows/refresh-proxy-catalog.yml scripts/refresh-catalog.mjs test/refresh-catalog.test.mjs
```

- [ ] **Step 3: Bump the Node version in both remaining workflows**

In `.github/workflows/ci.yml`, change:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
```

to:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
```

Then open `.github/workflows/tunnel.yml`, find its `node-version:` line, and change the value to `'24'` the same way. Leave every other key in both files alone.

- [ ] **Step 4: Drop the catalog npm scripts**

In `package.json`, remove these two lines from `"scripts"`:

```json
    "catalog": "node scripts/refresh-catalog.mjs",
    "catalog:check": "node scripts/refresh-catalog.mjs --check"
```

Make sure the preceding line still ends with a comma only if another entry follows it — the object must stay valid JSON.

- [ ] **Step 5: Verify nothing else referenced the removed files**

Run: `grep -rn "refresh-catalog\|catalog:check" --exclude-dir=node_modules --exclude-dir=.git .`
Expected: matches only inside `docs/superpowers/`, which describe the removal. Any hit in `_worker.js`, `package.json` or a workflow means a reference was missed — fix it.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS, with one fewer test file than in Step 1.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: retire the proxy catalog refresh workflow and move CI to Node 24

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: CSV parser

A pure function, no network, no caching. Written and tested in isolation so Task 3 only has to deal with fetching and caching.

**Files:**
- Modify: `_worker.js` (the "Proxy catalog" section, around line 920)
- Create: `test/fixtures/proxies.csv`
- Rewrite: `test/proxy-catalog.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export function parseProxyCsv(text: string): ProxyEntry[]`
  - `@typedef {{ cc: string, host: string, port: number, isp: string }} ProxyEntry`

- [ ] **Step 1: Write the fixture**

Create `test/fixtures/proxies.csv` with exactly this content. It carries the real header, three good rows, and one row of each rejection case:

```csv
IP Address, Port, TLS, Data Center, Region, City, ASN, latency
172.86.77.145,443,true,AE,N/A,-,RouterHosting LLC,-
20.174.15.226,8443,true,DE,N/A,-,Microsoft Corporation,-
2001:db8::1,2053,true,SG,N/A,-,Example Networks,-
1.1.1.1,443,true,ZZZ,N/A,-,Bad Country,-
2.2.2.2,0,true,US,N/A,-,Bad Port Low,-
3.3.3.3,70000,true,US,N/A,-,Bad Port High,-
4.4.4.4,abc,true,US,N/A,-,Bad Port Text,-
5.5.5.5,443,true,US,N/A,-
,443,true,US,N/A,-,Empty Host,-
```

Row-by-row: three kept; `ZZZ` is not a two-letter code; ports `0`, `70000` and `abc` are out of range or unparseable; the `5.5.5.5` row has 7 fields instead of 8; the last row has an empty host.

- [ ] **Step 2: Write the failing test**

Replace the entire contents of `test/proxy-catalog.test.mjs` with:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/proxy-catalog.test.mjs`
Expected: FAIL. Because `loadWorker()` still inlines the `.tsv` and `parseProxyCsv` does not exist, the failure is either an import error or `TypeError: parseProxyCsv is not a function`. Either is the expected red state.

- [ ] **Step 4: Implement the parser**

In `_worker.js`, inside the `// Proxy catalog` section, replace the `@typedef` line:

```js
/** @typedef {{ cc: string, host: string, isp: string, latency: number, kind: string }} ProxyEntry */
```

with the new typedef and the parser:

```js
/** @typedef {{ cc: string, host: string, port: number, isp: string }} ProxyEntry */

/**
 * Column offsets in the upstream CSV:
 * IP Address, Port, TLS, Data Center, Region, City, ASN, latency
 *
 * TLS, Region, City and latency are read but discarded - every current row
 * carries `true`, `N/A`, `-` and `-` respectively, so none of them can drive
 * a column or a filter.
 */
const CSV_FIELD_COUNT = 8;
const CSV_HOST = 0;
const CSV_PORT = 1;
const CSV_CC = 3;
const CSV_ISP = 6;

/**
 * Parses the upstream proxy CSV into entries, skipping its header row.
 *
 * A row is kept only when it is completely well formed. Anything else is
 * dropped without comment: this file is fetched from a third-party repository
 * on a schedule we do not control, so a format change upstream has to shrink
 * the catalog rather than take the worker down with it.
 *
 * @param {string} text the raw CSV body
 * @returns {ProxyEntry[]} every row that parsed cleanly, in file order
 */
export function parseProxyCsv(text) {
	if (!text) return [];
	/** @type {ProxyEntry[]} */
	const entries = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, '').trim();
		if (line.length === 0) continue;
		const fields = line.split(',').map((field) => field.trim());
		if (fields.length !== CSV_FIELD_COUNT) continue;
		// The header names its first column "IP Address"; no data row can.
		if (fields[CSV_HOST] === 'IP Address') continue;
		const host = fields[CSV_HOST];
		if (host.length === 0) continue;
		const cc = fields[CSV_CC].toUpperCase();
		if (!/^[A-Z]{2}$/.test(cc)) continue;
		const port = Number(fields[CSV_PORT]);
		if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
		const isp = fields[CSV_ISP];
		if (isp.length === 0) continue;
		entries.push({ cc, host, port, isp });
	}
	return entries;
}
```

- [ ] **Step 5: Stop `loadWorker` from requiring the `.tsv`**

`test/load-worker.mjs` currently throws if the `.tsv` import is missing, and Task 3 removes that import. Make the inlining optional now so this task's tests can run. In `test/load-worker.mjs`, replace this block:

```js
	const catalog = await readFile(path.join(here, '..', 'data', 'proxies.tsv'), 'utf8');
	const patched = withoutSockets.replace(
		"import proxyCatalogText from './data/proxies.tsv';",
		`const proxyCatalogText = ${JSON.stringify(catalog)};`,
	);
	if (patched === withoutSockets) {
		throw new Error('ERR_TEST_CATALOG_IMPORT_NOT_FOUND: _worker.js no longer imports data/proxies.tsv');
	}
```

with:

```js
	// The catalog is fetched at runtime rather than bundled, so there is no
	// import to rewrite. The replace is kept while data/proxies.tsv still
	// exists so this loader works on either side of that change.
	let patched = withoutSockets;
	const tsvImport = "import proxyCatalogText from './data/proxies.tsv';";
	if (patched.includes(tsvImport)) {
		const catalog = await readFile(path.join(here, '..', 'data', 'proxies.tsv'), 'utf8');
		patched = patched.replace(tsvImport, `const proxyCatalogText = ${JSON.stringify(catalog)};`);
	}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/proxy-catalog.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. The old `getProxyCatalog()` still exists and still reads the `.tsv`; nothing else changed yet.

- [ ] **Step 8: Commit**

```bash
git add _worker.js test/load-worker.mjs test/proxy-catalog.test.mjs test/fixtures/proxies.csv
git commit -m "feat: parse the upstream proxy CSV into catalog entries

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fetch the catalog at runtime

Swap the bundled `.tsv` for a cached fetch, and delete the file and its bundler rule.

**Files:**
- Modify: `_worker.js` (imports at line 1-4; the "Proxy catalog" section; `handleMeasure`; `renderProxyListPage` callers)
- Modify: `wrangler.toml`
- Delete: `data/proxies.tsv`
- Modify: `test/load-worker.mjs`
- Modify: `test/proxy-catalog.test.mjs`

**Interfaces:**
- Consumes: `parseProxyCsv(text): ProxyEntry[]` from Task 2
- Produces:
  - `export async function fetchProxyCatalog(env: CatalogEnv): Promise<ProxyEntry[]>`
  - `export function __resetCatalogCacheForTests(): void`
  - `@typedef {{ CATALOG_URL?: string, CATALOG_TTL_SECONDS?: string }} CatalogEnv`
  - `getProxyCatalog()` is **gone**. Every caller becomes `await fetchProxyCatalog(env)`.

- [ ] **Step 1: Write the failing test**

Append to `test/proxy-catalog.test.mjs`:

```js
const { fetchProxyCatalog, __resetCatalogCacheForTests } = await loadWorker();

/**
 * Installs a stub global fetch that answers with `bodies[n]` on call n, and
 * records how many times it was called. A body of `null` means "reject".
 * @param {Array<string | null>} bodies
 * @param {number} [status]
 */
function stubFetch(bodies, status = 200) {
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
		if (body === null) throw new Error('network down');
		return new Response(body, { status });
	};
	return calls;
}

test('fetchProxyCatalog fetches, parses and caches the upstream CSV', async () => {
	__resetCatalogCacheForTests();
	const calls = stubFetch([fixture]);
	const first = await fetchProxyCatalog({});
	assert.equal(first.length, 3);
	assert.equal(first[1].port, 8443);

	// A second call inside the TTL must not touch the network again.
	const second = await fetchProxyCatalog({});
	assert.equal(calls.length, 1);
	assert.deepEqual(second, first);
});

test('fetchProxyCatalog uses CATALOG_URL when it is set', async () => {
	__resetCatalogCacheForTests();
	const calls = stubFetch([fixture]);
	await fetchProxyCatalog({ CATALOG_URL: 'https://example.test/other.csv' });
	assert.equal(calls[0], 'https://example.test/other.csv');
});

test('fetchProxyCatalog keeps the last good parse when a refetch fails', async () => {
	__resetCatalogCacheForTests();
	stubFetch([fixture]);
	const good = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	stubFetch([null]);
	const stale = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	assert.deepEqual(stale, good);
});

test('fetchProxyCatalog keeps the last good parse on a non-200 response', async () => {
	__resetCatalogCacheForTests();
	stubFetch([fixture]);
	const good = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	stubFetch(['not found'], 404);
	const stale = await fetchProxyCatalog({ CATALOG_TTL_SECONDS: '0' });
	assert.deepEqual(stale, good);
});

test('fetchProxyCatalog returns an empty catalog when the very first fetch fails', async () => {
	__resetCatalogCacheForTests();
	stubFetch([null]);
	assert.deepEqual(await fetchProxyCatalog({}), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/proxy-catalog.test.mjs`
Expected: FAIL with `TypeError: fetchProxyCatalog is not a function`.

- [ ] **Step 3: Implement the fetch and cache**

In `_worker.js`, delete lines 3-4 entirely:

```js
// Bundled as text by the [[rules]] entry in wrangler.toml.
import proxyCatalogText from './data/proxies.tsv';
```

Then in the "Proxy catalog" section, delete the `PROXY_CATALOG` const, its long comment block, `let cachedCatalog = null;` and the whole `getProxyCatalog()` function. Replace them with:

```js
/**
 * Where the catalog comes from. The upstream repository rescans and republishes
 * this file on its own schedule, so the worker reads it live instead of
 * bundling a snapshot that would need a redeploy to refresh.
 */
const DEFAULT_CATALOG_URL =
	'https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/country_proxies/02_proxies.csv';

/** Seconds a parsed catalog is reused before the upstream file is refetched. */
const DEFAULT_CATALOG_TTL_SECONDS = 21600;

/** @typedef {{ CATALOG_URL?: string, CATALOG_TTL_SECONDS?: string }} CatalogEnv */

/**
 * Parsed catalog for this isolate, with the wall-clock time it was parsed.
 * `entries` stays populated after a failed refetch: a stale catalog is a far
 * better answer than an empty one, because the alternative is a /list page
 * that shows nothing every time GitHub has a bad minute.
 * @type {{ entries: ProxyEntry[], fetchedAt: number } | null}
 */
let catalogCache = null;

/** Deduplicates concurrent refreshes within one isolate. @type {Promise<ProxyEntry[]> | null} */
let catalogInFlight = null;

/**
 * Drops the isolate-level cache. Tests only - the worker has no reason to
 * invalidate a cache whose entries expire on their own.
 * @returns {void}
 */
export function __resetCatalogCacheForTests() {
	catalogCache = null;
	catalogInFlight = null;
}

/**
 * The proxy catalog, fetched and parsed at most once per TTL per isolate.
 *
 * Three layers, cheapest first: the parsed array in module scope, then the
 * Cache API so a cold isolate in a warm PoP does not hit GitHub, then the
 * origin. A failure at any layer falls back to the last good parse.
 *
 * The tunnel data path never calls this. Routing depends on PROXYIP and on the
 * proxyip= parameter a client pins, so an upstream outage degrades /list and
 * /list/measure without touching anyone's traffic.
 *
 * @param {CatalogEnv} env
 * @returns {Promise<ProxyEntry[]>} the catalog, or an empty array when the
 *   first fetch of this isolate's life failed and there is nothing to serve
 */
export async function fetchProxyCatalog(env) {
	const ttlSeconds = Number(env.CATALOG_TTL_SECONDS) || DEFAULT_CATALOG_TTL_SECONDS;
	const fresh = catalogCache && (Date.now() - catalogCache.fetchedAt) < ttlSeconds * 1000;
	if (fresh) return catalogCache.entries;
	if (catalogInFlight) return catalogInFlight;

	const url = env.CATALOG_URL || DEFAULT_CATALOG_URL;
	catalogInFlight = (async () => {
		try {
			const response = await fetch(url, {
				cf: { cacheTtl: ttlSeconds, cacheEverything: true },
				headers: { 'Accept': 'text/csv, text/plain' },
			});
			if (!response.ok) {
				console.log(`ERR_CATALOG_HTTP_${response.status}: ${url}`);
				return catalogCache ? catalogCache.entries : [];
			}
			const entries = parseProxyCsv(await response.text());
			if (entries.length === 0) {
				// A parse that yields nothing means the format moved. Keeping the
				// previous catalog is strictly better than serving an empty page.
				console.log(`ERR_CATALOG_EMPTY: ${url} parsed to zero entries`);
				return catalogCache ? catalogCache.entries : [];
			}
			catalogCache = { entries, fetchedAt: Date.now() };
			return entries;
		} catch (error) {
			console.log(`ERR_CATALOG_FETCH_FAILED: ${url}: ${error && error.message}`);
			return catalogCache ? catalogCache.entries : [];
		} finally {
			catalogInFlight = null;
		}
	})();
	return catalogInFlight;
}
```

- [ ] **Step 4: Update the two call sites**

In `handleMeasure`, change the signature and the `known` line. Replace:

```js
async function handleMeasure(request) {
```

with:

```js
async function handleMeasure(request, env) {
```

and replace:

```js
	const known = new Set(getProxyCatalog().map((entry) => entry.host));
```

with:

```js
	const known = new Set((await fetchProxyCatalog(env)).map((entry) => entry.host));
```

In the `fetch` handler, change the `/list/measure` call from:

```js
						return await handleMeasure(request);
```

to:

```js
						return await handleMeasure(request, env);
```

Then make the page builders async. Change `renderProxyListPage` and `buildProxyListPage`:

```js
async function renderProxyListPage(userIDs, hostName, env) {
	const cacheKey = `${hostName}|${userIDs.join(',')}`;
	if (cachedListPage && cachedListPage.key === cacheKey) return cachedListPage.html;
	const html = await buildProxyListPage(userIDs, hostName, env);
	cachedListPage = { key: cacheKey, html };
	return html;
}
```

```js
async function buildProxyListPage(userIDs, hostName, env) {
	const catalog = await fetchProxyCatalog(env);
	const bootstrap = JSON.stringify({
		host: hostName || '',
		uuids: userIDs,
		names: COUNTRY_NAMES,
		probeSni: PROBE_SNI,
		rows: catalog.map((entry) => [entry.cc, entry.host, entry.port, entry.isp]),
	}).replace(/</g, '\\u003c');
```

and its caller:

```js
					return new Response(await renderProxyListPage(userIDs, request.headers.get('Host'), env), {
```

The `rows` tuple order changed from `[cc, host, isp, latency, kind]` to `[cc, host, port, isp]`. The client-side `DATA.rows.map` that reads it is updated in Task 5 — the page will be wrong until then, which is expected and caught by that task.

- [ ] **Step 5: Delete the data file and its bundler rule**

```bash
git rm data/proxies.tsv
```

In `wrangler.toml`, delete the trailing block:

```toml
# data/proxies.tsv is inlined into the bundle as a string at deploy time, so the
# proxy catalog lives in a data file instead of a 2,500-line source literal.
[[rules]]
type = "Text"
globs = ["**/*.tsv"]
fallthrough = true
```

and add to `[vars]`:

```toml
# The proxy catalog is fetched live from the upstream repository rather than
# bundled, so it stays current without a redeploy. Override the URL here to
# point at a fork or a mirror.
CATALOG_URL = "https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/country_proxies/02_proxies.csv"

# Seconds a fetched catalog is reused before the upstream file is read again.
CATALOG_TTL_SECONDS = "21600"
```

- [ ] **Step 6: Simplify the test loader now that the import is gone**

In `test/load-worker.mjs`, replace the conditional block added in Task 2 with a plain assignment, and drop the now-unused `readFile` of the catalog:

```js
	const patched = withoutSockets;
```

Confirm `readFile` is still imported and used for `_worker.js` itself — it is; only the catalog read goes away.

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: PASS. `test/proxy-catalog.test.mjs` now has 11 tests.

- [ ] **Step 8: Verify the bundle still builds without the Text rule**

Run: `npx wrangler deploy --dry-run`
Expected: succeeds. A failure mentioning `proxies.tsv` means an import or rule was missed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: fetch the proxy catalog from upstream at runtime

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Probe each proxy on its own port

**Files:**
- Modify: `_worker.js` (`measureHost`, `handleMeasure`)

**Interfaces:**
- Consumes: `fetchProxyCatalog(env)` from Task 3
- Produces: `measureHost(host: string, port: number)`. `/list/measure` now takes `{ targets: Array<{ host: string, port: number }> }` and answers `{ results: Record<string, ProbeResult | null> }` keyed on `"host:port"`. The client half is Task 5.

- [ ] **Step 1: Give `measureHost` a port**

Replace the signature and the `connect` call:

```js
/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<ProbeResult | null>} null if the host is unreachable
 */
async function measureHost(host, port) {
	const started = Date.now();
	let socket;
	try {
		socket = connect({ hostname: host, port });
```

In the JSDoc block above it, change the opening line `Probes host:443 from the Cloudflare edge` to `Probes host:port from the Cloudflare edge`.

- [ ] **Step 2: Accept host/port pairs in `handleMeasure`**

Replace the body from the `hosts` extraction through the `results` assignment with:

```js
	const targetsIn = Array.isArray(body && body.targets) ? body.targets : null;
	if (!targetsIn || targetsIn.length === 0) {
		return new Response(JSON.stringify({ error: 'ERR_MEASURE_NO_TARGETS' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json;charset=utf-8' },
		});
	}
	if (targetsIn.length > MEASURE_BATCH_LIMIT) {
		return new Response(JSON.stringify({ error: 'ERR_MEASURE_BATCH_TOO_LARGE', limit: MEASURE_BATCH_LIMIT }), {
			status: 400,
			headers: { 'Content-Type': 'application/json;charset=utf-8' },
		});
	}
	// Keyed on host:port, not host alone: a catalogued host must not become a
	// lever for probing arbitrary ports on that address from Cloudflare's edge.
	const known = new Set((await fetchProxyCatalog(env)).map((entry) => `${entry.host}:${entry.port}`));
	const targets = targetsIn
		.filter((target) => target && typeof target.host === 'string' && Number.isInteger(target.port))
		.filter((target) => known.has(`${target.host}:${target.port}`));
	const timings = await Promise.all(targets.map((target) => measureHost(target.host, target.port)));
	/** @type {Record<string, ProbeResult | null>} */
	const results = {};
	targets.forEach((target, index) => { results[`${target.host}:${target.port}`] = timings[index]; });
```

Leave the surrounding JSON parsing, the `MEASURE_BATCH_LIMIT` check order, and the final `Response` untouched. Update the JSDoc above `handleMeasure`:

```js
/**
 * Handles POST /list/measure. Body: { targets: Array<{ host: string, port: number }> }.
 * @param {import("@cloudflare/workers-types").Request} request
 * @param {CatalogEnv} env
 * @returns {Promise<Response>}
 */
```

- [ ] **Step 3: Confirm no stale references remain**

Run: `grep -n "ERR_MEASURE_NO_HOSTS\|measureHost(host)\|body.hosts" _worker.js`
Expected: no output. Any match is a call site left on the old shape.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. No existing test drives `handleMeasure`; this step confirms nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add _worker.js
git commit -m "feat: probe each catalog proxy on its own port

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `/list` columns and VLESS links carry the port

The page is broken between Task 3 and this task — the bootstrap tuple changed shape. This task makes it whole again.

**Files:**
- Modify: `_worker.js` (`COUNTRY_NAMES`, `buildProxyListPage`, the inline client script)

**Interfaces:**
- Consumes: the bootstrap `rows` tuple `[cc, host, port, isp]` from Task 3; the `/list/measure` request and response shapes from Task 4
- Produces: a client-side `row` object `{ id, cc, host, port, isp, live, measuring, country, score, haystack }`. Task 9 adds protocol switching to `linkFor(row)`.

- [ ] **Step 1: Add the country codes the new catalog introduces**

`COUNTRY_NAMES` is missing codes that appear in the upstream CSV, which would render as bare two-letter codes. Add these entries to the object literal, keeping it alphabetically ordered:

```
"AR": "Argentina", "AZ": "Azerbaijan", "CN": "China", "GE": "Georgia",
"GR": "Greece", "ID": "Indonesia", "KH": "Cambodia", "MK": "North Macedonia",
"MO": "Macao", "NG": "Nigeria", "NO": "Norway", "NZ": "New Zealand",
"PT": "Portugal", "SI": "Slovenia", "SK": "Slovakia"
```

Also replace the placeholder values that currently repeat their own code with real names: `"AL": "Albania"` is already correct; set `"BA": "Bosnia and Herzegovina"`, `"BD": "Bangladesh"`, `"BY": "Belarus"`, `"IS": "Iceland"`, `"KG": "Kyrgyzstan"`, `"SY": "Syria"`, `"AD": "Andorra"`, `"DO": "Dominican Republic"`.

- [ ] **Step 2: Rebuild the row objects from the new tuple**

In the inline client script, replace:

```js
	var rows = DATA.rows.map(function (r, i) {
		var name = DATA.names[r[0]] || r[0];
		return {
			id: i, cc: r[0], host: r[1], isp: r[2], latency: r[3], kind: r[4],
			live: undefined, measuring: false, country: name, score: 0,
			haystack: (r[0] + ' ' + name + ' ' + r[1] + ' ' + r[2] + ' ' + r[4]).toLowerCase()
		};
	});
```

with:

```js
	var rows = DATA.rows.map(function (r, i) {
		var name = DATA.names[r[0]] || r[0];
		return {
			id: i, cc: r[0], host: r[1], port: r[2], isp: r[3],
			live: undefined, measuring: false, country: name, score: 0,
			haystack: (r[0] + ' ' + name + ' ' + r[1] + ' ' + r[2] + ' ' + r[3]).toLowerCase()
		};
	});
```

- [ ] **Step 3: Replace the Scan and Kind columns with Port**

Replace the `COLUMNS` array with:

```js
	var COLUMNS = [
		{ key: 'cc', label: 'Country', filter: 'values', hint: '' },
		{ key: 'host', label: 'Host', filter: 'text', hint: '' },
		{ key: 'port', label: 'Port', filter: 'values', hint: '' },
		{ key: 'isp', label: 'ISP', filter: 'values', hint: '' },
		{ key: 'edge', label: 'Edge', filter: null,
			hint: 'Measured on demand from the Cloudflare edge: TCP handshake plus the time to relay a TLS ClientHello through the proxy. "no relay" means it accepts connections but forwards nothing' },
		{ key: 'link', label: 'Link', filter: null, hint: '' }
	];
```

- [ ] **Step 4: Drop the latency filter and re-point the default sort**

In the `state` initialiser, change:

```js
		sortKey: 'scan',
		...
		filters: { cc: null, isp: null, host: '', latencyMax: null },
```

to:

```js
		sortKey: 'cc',
		...
		filters: { cc: null, isp: null, port: null, host: '' },
```

In `sortValue`, replace the `scan` branch:

```js
	function sortValue(row, key) {
		if (key === 'edge') return edgeSortValue(row);
		if (key === 'cc') return row.country;
		if (key === 'link') return linkFor(row);
		return row[key];
	}
```

In `applyFilters`, replace the `latencyMax` line with a port filter:

```js
			if (f.port && !f.port[row.port]) continue;
```

and delete the line `if (f.latencyMax !== null && row.latency > f.latencyMax) continue;`.

- [ ] **Step 5: Remove the range-filter UI**

Search the client script for `'range'` and for `latencyMax`. The `range` filter kind was used only by the Scan column, which no longer exists. Delete the branch in the filter-popover builder that renders a range input, and delete any remaining `latencyMax` reference. After this step:

Run: `grep -n "latencyMax\|'range'\|row.latency\|entry.latency\|\.kind" _worker.js`
Expected: no output.

- [ ] **Step 6: Put the port in the link and in the measure request**

In `linkFor`, replace the `path` line:

```js
		var path = '/?ed=2048&proxyip=' + encodeURIComponent(row.host + ':' + row.port);
```

Find the measure fetch (it posts to `/list/measure`) and change the request body from a host array to target objects, and the response lookup from `host` to `host:port`. The body becomes:

```js
		body: JSON.stringify({ targets: batch.map(function (row) { return { host: row.host, port: row.port }; }) })
```

and the per-row result lookup becomes:

```js
			var live = data.results[row.host + ':' + row.port];
```

Match the surrounding variable names already in the file rather than renaming them.

- [ ] **Step 7: Render the port cell**

In `renderRows`, the cell loop builds one `<td>` per column by key. Add a `port` case that renders `row.port` as plain text in the same `<td>` classes the `isp` cell uses, and delete the `scan` and `kind` cases.

- [ ] **Step 8: Show a banner when the catalog came back empty**

In `buildProxyListPage`, immediately after `const catalog = await fetchProxyCatalog(env);`, build a banner string:

```js
	const catalogBanner = catalog.length === 0
		? '<div class="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">'
			+ 'ERR_CATALOG_UNAVAILABLE: the upstream proxy list could not be fetched and nothing is cached yet. Reload in a few minutes.'
			+ '</div>'
		: '';
```

and interpolate `${catalogBanner}` into the template immediately after the opening `<div class="flex h-full flex-col">`.

- [ ] **Step 9: Verify the page renders**

Run: `npm test`
Expected: PASS.

Then run: `npx wrangler dev --remote` in one terminal, and open `http://localhost:8787/list` with the `ADMIN_USER`/`ADMIN_PASS` from `.dev.vars`. Confirm: the table lists rows, Country/Host/Port/ISP/Edge/Link columns are present, no Scan column, sorting by Port works, and a generated link contains `proxyip=<host>%3A<port>`. Stop the dev server.

If `.dev.vars` does not exist, create it (it is gitignored) with a `UUID`, `ADMIN_USER` and `ADMIN_PASS` of your choosing for this check.

- [ ] **Step 10: Commit**

```bash
git add _worker.js
git commit -m "feat: show each proxy's port in /list and pin it in generated links

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SOCKS5 handshake parser

A pure, incremental parser with no sockets and no WebSocket. This is where the protocol correctness lives, so it gets the heaviest test coverage.

**Files:**
- Modify: `_worker.js` (new "SOCKS5 inbound" section, placed after the VLESS header parser and before the "Proxy catalog" section)
- Create: `test/socks5-handshake.test.mjs`

**Interfaces:**
- Consumes: `safeEqual(a, b)` — already in `_worker.js`
- Produces:
  - `export function createSocks5Parser(credentials: { user: string, pass: string } | null): { push(chunk: Uint8Array): void, next(): Socks5Step }`
  - `@typedef {{ state: 'need-more' } | { state: 'send', bytes: Uint8Array } | { state: 'connect', host: string, port: number, rest: Uint8Array } | { state: 'fail', bytes: Uint8Array | null, reason: string }} Socks5Step`
  - `export const SOCKS5_REPLY_OK: Uint8Array`

The caller contract: `push()` the bytes of each WebSocket message, then call `next()` repeatedly. `send` means write those bytes and call `next()` again. `need-more` means stop and wait for the next message. `connect` and `fail` are terminal.

- [ ] **Step 1: Write the failing test**

Create `test/socks5-handshake.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker } from './load-worker.mjs';

const { createSocks5Parser, SOCKS5_REPLY_OK } = await loadWorker();

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/socks5-handshake.test.mjs`
Expected: FAIL with `TypeError: createSocks5Parser is not a function`.

- [ ] **Step 3: Implement the parser**

Add a new section to `_worker.js`, after `processVlessHeader` and before the `// Proxy catalog` divider:

```js
// ---------------------------------------------------------------------------
// SOCKS5 inbound (RFC 1928, RFC 1929)
// ---------------------------------------------------------------------------

/** Reply sent once the outbound connection is up. Bound address 0.0.0.0:0 is
 * what a relay with no local address to advertise returns, and clients accept
 * it; there is nothing more truthful we could put there. */
export const SOCKS5_REPLY_OK = new Uint8Array([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

/** General failure: the outbound connection could not be established. */
const SOCKS5_REPLY_FAIL = new Uint8Array([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const SOCKS5_REPLY_BAD_COMMAND = new Uint8Array([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const SOCKS5_REPLY_BAD_ADDRESS = new Uint8Array([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const SOCKS5_NO_ACCEPTABLE_METHOD = new Uint8Array([0x05, 0xff]);

/**
 * @typedef {{ state: 'need-more' }
 *   | { state: 'send', bytes: Uint8Array }
 *   | { state: 'connect', host: string, port: number, rest: Uint8Array }
 *   | { state: 'fail', bytes: Uint8Array | null, reason: string }} Socks5Step
 */

/**
 * An incremental SOCKS5 server handshake.
 *
 * WebSocket message boundaries have nothing to do with SOCKS5 frame
 * boundaries: a client may split the greeting across two messages or send the
 * greeting, the auth frame and the CONNECT request in one. So the parser
 * buffers, and the caller drives it - push bytes, then call next() until it
 * stops asking for more.
 *
 * @param {{ user: string, pass: string } | null} credentials the configured
 *   SOCKS5 login, or null when the secrets are unset
 * @returns {{ push(chunk: Uint8Array): void, next(): Socks5Step }}
 */
export function createSocks5Parser(credentials) {
	/** @type {Uint8Array} */
	let buffer = new Uint8Array(0);
	/** @type {'greeting' | 'auth' | 'request' | 'done'} */
	let stage = 'greeting';

	/** @param {Uint8Array} chunk */
	function push(chunk) {
		if (chunk.length === 0) return;
		const merged = new Uint8Array(buffer.length + chunk.length);
		merged.set(buffer, 0);
		merged.set(chunk, buffer.length);
		buffer = merged;
	}

	/** @param {number} count drops `count` bytes from the front of the buffer */
	function consume(count) {
		buffer = buffer.slice(count);
	}

	/**
	 * @param {Uint8Array | null} bytes
	 * @param {string} reason
	 * @returns {Socks5Step}
	 */
	function fail(bytes, reason) {
		stage = 'done';
		return { state: 'fail', bytes, reason };
	}

	function readGreeting() {
		if (buffer.length < 2) return { state: 'need-more' };
		if (buffer[0] !== 0x05) return fail(null, 'bad-version');
		const methodCount = buffer[1];
		if (buffer.length < 2 + methodCount) return { state: 'need-more' };
		const methods = buffer.subarray(2, 2 + methodCount);
		consume(2 + methodCount);
		// Method 0x00 (no auth) is never selected. An unauthenticated SOCKS5
		// endpoint on a public hostname is an open proxy within minutes.
		if (!credentials) return fail(SOCKS5_NO_ACCEPTABLE_METHOD, 'unconfigured');
		if (!methods.includes(0x02)) return fail(SOCKS5_NO_ACCEPTABLE_METHOD, 'no-acceptable-method');
		stage = 'auth';
		return { state: 'send', bytes: new Uint8Array([0x05, 0x02]) };
	}

	function readAuth() {
		if (buffer.length < 2) return { state: 'need-more' };
		if (buffer[0] !== 0x01) return fail(null, 'bad-auth-version');
		const userLength = buffer[1];
		if (buffer.length < 2 + userLength + 1) return { state: 'need-more' };
		const passLength = buffer[2 + userLength];
		const total = 2 + userLength + 1 + passLength;
		if (buffer.length < total) return { state: 'need-more' };
		const decoder = new TextDecoder();
		const user = decoder.decode(buffer.subarray(2, 2 + userLength));
		const pass = decoder.decode(buffer.subarray(3 + userLength, total));
		consume(total);
		// Both comparisons always run, so a wrong username costs the same as a
		// wrong password.
		const userOk = safeEqual(user, credentials.user);
		const passOk = safeEqual(pass, credentials.pass);
		if (!userOk || !passOk) return fail(new Uint8Array([0x01, 0x01]), 'bad-credentials');
		stage = 'request';
		return { state: 'send', bytes: new Uint8Array([0x01, 0x00]) };
	}

	function readRequest() {
		if (buffer.length < 4) return { state: 'need-more' };
		if (buffer[0] !== 0x05) return fail(null, 'bad-version');
		const command = buffer[1];
		const addressType = buffer[3];

		let addressLength;
		let addressStart = 4;
		if (addressType === 0x01) {
			addressLength = 4;
		} else if (addressType === 0x03) {
			if (buffer.length < 5) return { state: 'need-more' };
			addressLength = buffer[4];
			addressStart = 5;
		} else if (addressType === 0x04) {
			addressLength = 16;
		} else {
			return fail(SOCKS5_REPLY_BAD_ADDRESS, 'bad-address-type');
		}

		const total = addressStart + addressLength + 2;
		if (buffer.length < total) return { state: 'need-more' };

		// The command is checked only once the whole request has arrived, so the
		// unsupported-command reply is not sent while bytes are still in flight.
		if (command !== 0x01) {
			consume(total);
			return fail(SOCKS5_REPLY_BAD_COMMAND, 'unsupported-command');
		}

		const raw = buffer.subarray(addressStart, addressStart + addressLength);
		let host;
		if (addressType === 0x01) {
			host = Array.from(raw).join('.');
		} else if (addressType === 0x03) {
			host = new TextDecoder().decode(raw);
		} else {
			// Unbracketed colon-hex, matching how processVlessHeader hands IPv6
			// to connect(); the Workers socket API accepts it in that form.
			const groups = [];
			for (let i = 0; i < 8; i++) groups.push(((raw[i * 2] << 8) | raw[i * 2 + 1]).toString(16));
			host = groups.join(':');
		}
		if (host.length === 0) return fail(SOCKS5_REPLY_BAD_ADDRESS, 'empty-address');

		const port = (buffer[total - 2] << 8) | buffer[total - 1];
		consume(total);
		const rest = buffer;
		buffer = new Uint8Array(0);
		stage = 'done';
		return { state: 'connect', host, port, rest };
	}

	/** @returns {Socks5Step} */
	function next() {
		if (stage === 'greeting') return readGreeting();
		if (stage === 'auth') return readAuth();
		if (stage === 'request') return readRequest();
		return { state: 'need-more' };
	}

	return { push, next };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/socks5-handshake.test.mjs`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add _worker.js test/socks5-handshake.test.mjs
git commit -m "feat: add an incremental SOCKS5 server handshake parser

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Wire SOCKS5 into the WebSocket route

**Files:**
- Modify: `_worker.js` (the `fetch` handler's WebSocket branch; new `socks5OverWSHandler`)
- Modify: `test/proxy-ip.test.mjs`

**Interfaces:**
- Consumes: `createSocks5Parser`, `SOCKS5_REPLY_OK` (Task 6); `selectProxyIP`, `parseRequestedProxyIP`, `planOutbound`, `handleTCPOutBound`, `makeReadableWebSocketStream`, `safeCloseWebSocket` (existing)
- Produces:
  - `export function parseRequestedProtocol(requestUrl: string): 'vless' | 'socks5'`
  - `export function readSocksCredentials(env): { user: string, pass: string } | null`
  - `async function socks5OverWSHandler(request, proxyIPPool, env): Promise<Response>`

- [ ] **Step 1: Write the failing test**

Append to `test/proxy-ip.test.mjs`:

```js
const { parseRequestedProtocol, readSocksCredentials } = await loadWorker();

test('parseRequestedProtocol defaults to vless', () => {
	assert.equal(parseRequestedProtocol(url('?ed=2048')), 'vless');
	assert.equal(parseRequestedProtocol(url('')), 'vless');
	assert.equal(parseRequestedProtocol('not a url'), 'vless');
});

test('parseRequestedProtocol reads an explicit socks5 request', () => {
	assert.equal(parseRequestedProtocol(url('?proto=socks5')), 'socks5');
	assert.equal(parseRequestedProtocol(url('?ed=2048&proxyip=1.2.3.4:443&proto=socks5')), 'socks5');
});

test('parseRequestedProtocol treats an unknown protocol as vless', () => {
	assert.equal(parseRequestedProtocol(url('?proto=trojan')), 'vless');
	assert.equal(parseRequestedProtocol(url('?proto=SOCKS5')), 'vless');
});

test('readSocksCredentials returns null unless both secrets are set', () => {
	assert.equal(readSocksCredentials({}), null);
	assert.equal(readSocksCredentials({ SOCKS_USER: 'a' }), null);
	assert.equal(readSocksCredentials({ SOCKS_PASS: 'b' }), null);
	assert.equal(readSocksCredentials({ SOCKS_USER: '', SOCKS_PASS: 'b' }), null);
	assert.deepEqual(readSocksCredentials({ SOCKS_USER: 'a', SOCKS_PASS: 'b' }), { user: 'a', pass: 'b' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/proxy-ip.test.mjs`
Expected: FAIL with `TypeError: parseRequestedProtocol is not a function`.

- [ ] **Step 3: Implement the two helpers**

Add near `parseRequestedProxyIP` in `_worker.js`:

```js
/**
 * Reads the inbound protocol a client asked for in its WebSocket path
 * (`path=/?ed=2048&proxyip=<host>&proto=socks5`).
 *
 * The choice is explicit rather than sniffed from the first byte, so the two
 * protocol paths never have to agree about what a leading byte means, and so
 * routing can be tested without constructing a handshake. Anything other than
 * the exact string `socks5` is VLESS - an unrecognised value must not silently
 * become a different protocol.
 *
 * @param {string} requestUrl the full request URL
 * @returns {'vless' | 'socks5'}
 */
export function parseRequestedProtocol(requestUrl) {
	try {
		return new URL(requestUrl).searchParams.get('proto') === 'socks5' ? 'socks5' : 'vless';
	} catch (error) {
		return 'vless';
	}
}

/**
 * Reads the SOCKS5 login from the environment. Both halves must be present:
 * a half-configured login would otherwise authenticate against an empty
 * string.
 * @param {{ SOCKS_USER?: string, SOCKS_PASS?: string }} env
 * @returns {{ user: string, pass: string } | null}
 */
export function readSocksCredentials(env) {
	const user = env && env.SOCKS_USER;
	const pass = env && env.SOCKS_PASS;
	if (!user || !pass) return null;
	return { user, pass };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/proxy-ip.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement the handler**

Add after `vlessOverWSHandler` in `_worker.js`:

```js
/**
 * Handles SOCKS5 over WebSocket.
 *
 * The handshake is parsed by createSocks5Parser; everything after it is the
 * same outbound machinery VLESS uses. The one structural difference is when
 * the reply goes out: a VLESS client sends its payload with the header and the
 * response rides back on the first downstream chunk, whereas a SOCKS5 client
 * waits for the reply before sending anything. So the reply is written as soon
 * as the outbound socket opens, and remoteSocketToWS gets a null header.
 *
 * @param {import("@cloudflare/workers-types").Request} request
 * @param {string[]} proxyIPPool The configured proxy hosts to fall back to.
 * @param {{ SOCKS_USER?: string, SOCKS_PASS?: string }} env
 * @returns {Promise<Response>}
 */
async function socks5OverWSHandler(request, proxyIPPool, env) {
	const proxyTarget = selectProxyIP(parseRequestedProxyIP(request.url), proxyIPPool);
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();

	const log = debugLogging
		? (/** @type {string} */ info) => console.log(`[socks5] ${info}`)
		: noopLog;
	const stats = { up: 0, down: 0, started: Date.now(), logged: false };
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	const parser = createSocks5Parser(readSocksCredentials(env));
	const remoteSocketWrapper = { value: null };
	let handshakeDone = false;

	/** @param {Uint8Array} bytes */
	const send = (bytes) => {
		if (webSocket.readyState === WS_READY_STATE_OPEN) webSocket.send(bytes);
	};

	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk) {
			stats.up += chunk.byteLength || 0;

			// Past the handshake this is a plain byte pipe to the remote socket.
			if (handshakeDone) {
				if (!remoteSocketWrapper.value) return;
				const writer = remoteSocketWrapper.value.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			parser.push(new Uint8Array(chunk));
			for (;;) {
				const step = parser.next();
				if (step.state === 'need-more') return;
				if (step.state === 'send') {
					send(step.bytes);
					continue;
				}
				if (step.state === 'fail') {
					log(`handshake rejected: ${step.reason}`);
					if (step.bytes) send(step.bytes);
					safeCloseWebSocket(webSocket);
					return;
				}
				// step.state === 'connect'
				handshakeDone = true;
				log(`connect ${step.host}:${step.port}`);
				try {
					await handleTCPOutBound(
						remoteSocketWrapper, step.host, step.port, step.rest,
						webSocket, null, log, stats, proxyTarget,
					);
				} catch (error) {
					log(`outbound failed: ${error && error.message}`);
					send(SOCKS5_REPLY_FAIL_PUBLIC);
					safeCloseWebSocket(webSocket);
				}
				return;
			}
		},
		close() {
			log('client stream closed');
		},
		abort(reason) {
			log(`client stream aborted: ${reason}`);
		},
	})).catch((error) => {
		log(`pipeTo failed: ${error && error.stack}`);
		safeCloseWebSocket(webSocket);
	});

	return new Response(null, { status: 101, webSocket: client });
}
```

- [ ] **Step 6: Send the SOCKS5 reply at the right moment**

The handler above needs `handleTCPOutBound` to announce success before relaying. Rather than teach that function about SOCKS5, give it an optional callback. In `handleTCPOutBound`, change the signature line and `connectAndWrite`:

```js
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, stats, proxyTarget, onConnected) {
```

and inside `connectAndWrite`, after `remoteSocket.value = tcpSocket;` and the existing `log(...)` line, add:

```js
		if (onConnected) onConnected();
```

Add to its JSDoc:

```js
 * @param {(() => void) | null} [onConnected] Called once the outbound socket is
 *   open, before any client data is relayed. SOCKS5 needs to answer its CONNECT
 *   request at exactly this point; VLESS carries its response on the first
 *   downstream chunk instead and passes nothing here.
```

Then in `socks5OverWSHandler`, pass the callback and drop the placeholder constant. Replace the `handleTCPOutBound(...)` call with:

```js
					await handleTCPOutBound(
						remoteSocketWrapper, step.host, step.port, step.rest,
						webSocket, null, log, stats, proxyTarget,
						() => send(SOCKS5_REPLY_OK),
					);
```

and replace `send(SOCKS5_REPLY_FAIL_PUBLIC);` in the catch with `send(SOCKS5_REPLY_FAIL);`.

Finally, `SOCKS5_REPLY_FAIL` is declared `const` inside the SOCKS5 section — confirm it is in module scope (it is, alongside `SOCKS5_REPLY_OK`) so the handler can see it.

Note that `rawClientData` here is `step.rest`, which is normally empty: a SOCKS5 client sends nothing until it sees the reply. Writing a zero-length chunk is a no-op, and when a client does pipeline payload behind its CONNECT, `rest` carries it and it is written in the same first write.

- [ ] **Step 7: Route on the protocol**

In the `fetch` handler, find the WebSocket branch — the `else` after the `if (!upgradeHeader || upgradeHeader !== 'websocket')` block, which currently ends in `return await vlessOverWSHandler(request, activeProxyIPs);`. Replace that call with:

```js
				return parseRequestedProtocol(request.url) === 'socks5'
					? await socks5OverWSHandler(request, activeProxyIPs, env)
					: await vlessOverWSHandler(request, activeProxyIPs);
```

- [ ] **Step 8: Run the tests and build**

Run: `npm test`
Expected: PASS.

Run: `npx wrangler deploy --dry-run`
Expected: succeeds. A `SOCKS5_REPLY_FAIL is not defined` error means Step 6's cleanup was incomplete.

- [ ] **Step 9: Commit**

```bash
git add _worker.js test/proxy-ip.test.mjs
git commit -m "feat: accept SOCKS5 over WebSocket alongside VLESS

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Generate the SOCKS5 credentials once

**Files:**
- Create: `scripts/socks-creds.mjs`
- Modify: `package.json`
- Modify: `wrangler.toml` (documentation comment only)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: the `SOCKS_USER` and `SOCKS_PASS` secrets that `readSocksCredentials(env)` reads. `npm run deploy` runs this first; `npm run socks:rotate` forces new values.

- [ ] **Step 1: Write the script**

Create `scripts/socks-creds.mjs`:

```js
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
```

- [ ] **Step 2: Wire it into the npm scripts**

In `package.json`, add to `"scripts"`:

```json
    "predeploy": "node scripts/socks-creds.mjs",
    "socks:rotate": "node scripts/socks-creds.mjs --rotate"
```

`predeploy` runs automatically before `npm run deploy`. It deliberately does not hang off `build`, which is `wrangler deploy --dry-run` and must keep working in CI with no account token.

- [ ] **Step 3: Document the secrets in `wrangler.toml`**

Add to `[vars]`, as a comment only — never a value:

```toml
# SOCKS5 inbound credentials. Like UUID and ADMIN_PASS these are secrets, not
# vars: `npm run deploy` generates them once via scripts/socks-creds.mjs, and
# `npm run socks:rotate` replaces them. The worker answers every SOCKS5
# handshake with "no acceptable method" while either is unset.
```

- [ ] **Step 4: Verify the generator half without touching Cloudflare**

Run:

```bash
node -e "const a='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';const{randomInt}=require('node:crypto');let s='';for(let i=0;i<32;i++)s+=a[randomInt(a.length)];console.log(s,s.length,encodeURIComponent(s)===s)"
```

Expected: a 32-character string, `32`, and `true` — confirming the alphabet needs no URI escaping.

- [ ] **Step 5: Verify the script refuses to run blind**

Run: `node scripts/socks-creds.mjs`
Expected: either it reports the secrets already exist, or it generates and prints them, or it throws `ERR_SOCKS_SECRET_LIST_FAILED` when there is no Cloudflare auth. All three are correct outcomes; the one thing that must not happen is silently overwriting existing secrets. If it throws, that is the expected result on a machine without a deployed worker — note it and move on.

- [ ] **Step 6: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/socks-creds.mjs package.json wrangler.toml
git commit -m "feat: generate the SOCKS5 credentials once at deploy time

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Protocol dropdown in `/list`

**Files:**
- Modify: `_worker.js` (`buildProxyListPage` bootstrap and markup, the inline client script)

**Interfaces:**
- Consumes: the row shape from Task 5; `readSocksCredentials(env)` from Task 7
- Produces: nothing downstream. This is the last functional task.

- [ ] **Step 1: Put the credentials in the bootstrap**

In `buildProxyListPage`, add to the `JSON.stringify({...})` object, after `probeSni`:

```js
		socks: readSocksCredentials(env),
```

`/list` is already behind HTTP Basic auth, so this reaches exactly the people meant to hand the links out. When the secrets are unset this is `null`, which the next step uses to disable the option.

- [ ] **Step 2: Add the dropdown to the header**

Immediately after the UUID `<label>` block in the header markup, add:

```html
			<label class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">Protocol
				<select id="proto" class="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
					<option value="vless">VLESS</option>
					<option value="socks5">SOCKS5</option>
				</select>
			</label>
```

- [ ] **Step 3: Wire the dropdown up**

In the client script, add `proto: pick('proto'),` to the `el` object, and add next to the existing `THEME_KEY` declaration:

```js
	var PROTO_KEY = 'proxy-list-proto';
```

Then, after the `el` object is built, restore the persisted choice and disable SOCKS5 when there are no credentials:

```js
	if (!DATA.socks) {
		el.proto.querySelector('option[value="socks5"]').disabled = true;
		el.proto.title = 'SOCKS5 is unavailable: SOCKS_USER and SOCKS_PASS are not set on the worker';
	} else {
		var storedProto = null;
		try { storedProto = localStorage.getItem(PROTO_KEY); } catch (error) { /* storage may be blocked */ }
		if (storedProto === 'socks5') el.proto.value = 'socks5';
	}

	el.proto.addEventListener('change', function () {
		try { localStorage.setItem(PROTO_KEY, el.proto.value); } catch (error) { /* storage may be blocked */ }
		renderRows();
	});
```

- [ ] **Step 4: Branch the link builder**

Replace `linkFor` with:

```js
	function linkFor(row) {
		var sni = DATA.host;
		// The client always connects to the worker's own edge; the row picks the
		// proxy the worker leaves through, pinned in the WebSocket path. Without
		// that parameter the worker would fall back to a random pool member and
		// the row selection would mean nothing.
		var address = el.vinaphone.checked ? VINAPHONE_ADDRESS : sni + ':443';
		var pin = row.host + ':' + row.port;
		var label = encodeURIComponent(row.cc + '-' + row.host);

		if (el.proto.value === 'socks5' && DATA.socks) {
			// No standard socks5:// URI encodes a WebSocket transport, so these
			// query parameters are not decoration: they spell out the path the
			// client must be configured with, /?proxyip=...&proto=socks5.
			return 'socks5://' + DATA.socks.user + ':' + DATA.socks.pass + '@' + address
				+ '?proxyip=' + encodeURIComponent(pin) + '&proto=socks5#' + label;
		}

		var path = '/?ed=2048&proxyip=' + encodeURIComponent(pin);
		return 'vless://' + el.uuid.value + '@' + address
			+ '?encryption=none&security=tls&sni=' + sni + '&fp=chrome&type=ws&host=' + sni
			+ '&path=' + encodeURIComponent(path) + '#' + label;
	}
```

- [ ] **Step 5: Note the limitation in the copy modal**

Find `openModal(title, note, text)` and the calls that open it for "Copy links" and the subscription copy. At each call site, choose the note based on the protocol:

```js
	function linkNote() {
		return el.proto.value === 'socks5' && DATA.socks
			? 'SOCKS5: no share-URI format carries a WebSocket transport, so these links do not import as-is. '
				+ 'Configure the client with a socks outbound over ws, host ' + DATA.host
				+ ', and the path shown in each link\'s query string.'
			: '';
	}
```

and pass `linkNote()` where those call sites currently pass their note argument, appending it to an existing note rather than replacing one if the site already has something to say.

- [ ] **Step 6: Verify in the browser**

Run: `npx wrangler dev --remote`, open `/list`, and check:
- The Protocol dropdown defaults to VLESS and the links start `vless://`.
- Switching to SOCKS5 changes every visible Link cell to `socks5://<user>:<pass>@<host>:443?proxyip=...&proto=socks5#...`.
- Reloading the page keeps SOCKS5 selected.
- With `SOCKS_USER`/`SOCKS_PASS` removed from `.dev.vars`, the SOCKS5 option is disabled and carries the explanatory tooltip.
- "Copy links" in SOCKS5 mode shows the note about configuring the transport by hand.

Stop the dev server.

- [ ] **Step 7: Run the tests and build**

Run: `npm test && npx wrangler deploy --dry-run`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add _worker.js
git commit -m "feat: pick VLESS or SOCKS5 per link from /list

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Find what the README now says wrongly**

Run: `grep -n "proxies.tsv\|refresh-catalog\|catalog\|Scan\|node-version\|22" README.md`
Expected: a list of stale references. Every one needs to go or change.

- [ ] **Step 2: Rewrite the affected sections**

Make these changes, matching the README's existing tone and heading style:

- Replace any description of the daily catalog refresh workflow with: the catalog is fetched live from `CATALOG_URL` on a 6-hour TTL, cached per isolate and in the Cache API, and a failed fetch serves the last good copy.
- Remove `npm run catalog` and `npm run catalog:check` from any command list.
- Document `CATALOG_URL` and `CATALOG_TTL_SECONDS` alongside the existing `PROXYIP` / `DNS_RESOLVER_URL` / `DEBUG` vars.
- Document `SOCKS_USER` / `SOCKS_PASS` alongside `UUID` and `ADMIN_PASS` as secrets, and mention `npm run socks:rotate`.
- Add a short "Protocols" section: VLESS is the default; SOCKS5 is selected with `proto=socks5` in the WebSocket path and requires username/password auth. State plainly that the `socks5://` link `/list` emits carries no WebSocket transport and needs the client configured by hand.
- Update the `/list` column list: Country, Host, Port, ISP, Edge, Link. Say that the upstream CSV no longer carries a latency figure, so Edge is the only timing shown.

- [ ] **Step 3: Verify no stale references survive**

Run: `grep -rn "proxies.tsv\|refresh-catalog\|catalog:check" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=docs .`
Expected: no output.

- [ ] **Step 4: Final full verification**

Run: `npm test && npx wrangler deploy --dry-run`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: describe the live catalog, per-proxy ports and SOCKS5

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| ------------ | ---- |
| 1. Catalog source and column mapping | 2 |
| 1. Caching, stale-on-error, TTL/URL vars | 3 |
| 1. Blast radius (tunnel independent of catalog) | 3 (comment + design; no code depends on it) |
| 1. Removals | 1 (workflow, script, test), 3 (tsv, rule, import), 2-3 (loader hack) |
| 2. Per-proxy ports — `linkFor` | 5 |
| 2. Per-proxy ports — `measureHost`, `/measure` validation | 4 |
| 3. `/list` columns: Scan out, Port in, Edge tooltip | 5 |
| 3. Default sort moves to `cc` | 5 |
| 4. Protocol selection via `proto=socks5` | 7 |
| 4. Handshake: greeting, auth, request, replies | 6 |
| 4. Credentials generated once, `--rotate` | 8 |
| 4. Link format and its accepted limitation | 9 |
| 4. Out of scope: `/sub`, `/bestip` stay VLESS | not touched by any task — correct |
| 5. CI Node 24, workflow deleted | 1 |
| 6. Testing matrix | 2, 3, 6, 7 |

**Type consistency**

- `ProxyEntry` is `{ cc, host, port, isp }` from Task 2 onward; Tasks 3, 4 and 5 all use exactly those names.
- The bootstrap tuple is `[cc, host, port, isp]`, written in Task 3 and read in Task 5.
- `/list/measure` takes `{ targets: [{ host, port }] }` and keys results on `"host:port"` — written in Task 4, consumed in Task 5.
- `Socks5Step` states are `need-more` / `send` / `connect` / `fail` in Task 6 and in the Task 7 handler loop.
- `handleTCPOutBound`'s new tenth parameter is `onConnected` in both Task 7 steps that touch it.

**Known rough edge**

Task 3 leaves `/list` broken until Task 5 — the bootstrap tuple changes shape in one task and the reader changes in another. The alternative was one large task spanning the fetch rewrite and the whole UI, which is worse to review. Tasks 3 and 5 must land together before any deploy; do not deploy between them.
