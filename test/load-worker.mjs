import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads _worker.js under plain Node. The module imports `cloudflare:sockets`,
 * which only exists inside the Workers runtime, so the import is swapped for a
 * stub that throws if anything actually tries to open a socket in a test.
 * @returns {Promise<Record<string, unknown>>} the worker module's exports
 */
export async function loadWorker() {
	const source = await readFile(path.join(here, '..', '_worker.js'), 'utf8');
	const withoutSockets = source.replace(
		"import { connect } from 'cloudflare:sockets';",
		"const connect = () => { throw new Error('ERR_TEST_SOCKET_UNAVAILABLE'); };",
	);
	if (withoutSockets === source) {
		throw new Error('ERR_TEST_SOCKET_IMPORT_NOT_FOUND: _worker.js no longer imports cloudflare:sockets');
	}
	// The catalog is fetched at runtime rather than bundled, so there is no
	// import to rewrite. The replace is kept while data/proxies.tsv still
	// exists so this loader works on either side of that change.
	let patched = withoutSockets;
	const tsvImport = "import proxyCatalogText from './data/proxies.tsv';";
	if (patched.includes(tsvImport)) {
		const catalog = await readFile(path.join(here, '..', 'data', 'proxies.tsv'), 'utf8');
		patched = patched.replace(tsvImport, `const proxyCatalogText = ${JSON.stringify(catalog)};`);
	}
	const generated = path.join(here, '.generated');
	await mkdir(generated, { recursive: true });
	// `node --test` runs each test file in its own process, in parallel. A
	// single shared filename let one process import the module while another
	// was still writing it, which surfaced as unrelated test files failing at
	// random. The pid gives every writer its own target.
	const target = path.join(generated, `worker.${process.pid}.mjs`);
	await writeFile(target, patched, 'utf8');
	return import(`file://${target.split(path.sep).join('/')}`);
}
