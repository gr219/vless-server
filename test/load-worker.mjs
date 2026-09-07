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
	// wrangler's Text rule inlines the catalog at bundle time; plain Node cannot
	// import a .tsv, so the same file is read and inlined here instead.
	const catalog = await readFile(path.join(here, '..', 'data', 'proxies.tsv'), 'utf8');
	const patched = withoutSockets.replace(
		"import proxyCatalogText from './data/proxies.tsv';",
		`const proxyCatalogText = ${JSON.stringify(catalog)};`,
	);
	if (patched === withoutSockets) {
		throw new Error('ERR_TEST_CATALOG_IMPORT_NOT_FOUND: _worker.js no longer imports data/proxies.tsv');
	}
	const generated = path.join(here, '.generated');
	await mkdir(generated, { recursive: true });
	const target = path.join(generated, 'worker.mjs');
	await writeFile(target, patched, 'utf8');
	return import(`file://${target.split(path.sep).join('/')}`);
}
