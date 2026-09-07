/**
 * Front proxy for the GitHub Actions tunnel session.
 *
 * `wrangler dev` mounts an unauthenticated control API at /cdn-cgi/local/ on
 * the same port as the worker, and offers no flag to turn it off. Exposing that
 * through a public tunnel would hand out the worker's bindings, including
 * ADMIN_PASS and the UUID list. This proxy is what cloudflared points at: it
 * refuses that prefix and forwards everything else, WebSocket upgrades
 * included, to wrangler on the upstream port.
 */
import http from 'node:http';
import net from 'node:net';

const BLOCKED_PREFIX = '/cdn-cgi/local/';
const UPSTREAM_HOST = '127.0.0.1';

/**
 * Reads a whole-number port from the environment.
 * @param {string} name environment variable to read
 * @param {number} fallback value used when the variable is unset
 * @returns {number} the resolved port
 */
function readPort(name, fallback) {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`ERR_PROXY_PORT_INVALID: ${name} must be a port number 1-65535, got '${raw}'`);
	}
	return parsed;
}

const listenPort = readPort('PROXY_PORT', 3000);
const upstreamPort = readPort('UPSTREAM_PORT', 8787);

/**
 * @param {string | undefined} url request target
 * @returns {boolean} whether the target hits wrangler's local control API
 */
function isBlocked(url) {
	return typeof url === 'string' && url.startsWith(BLOCKED_PREFIX);
}

const server = http.createServer((req, res) => {
	if (isBlocked(req.url)) {
		res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8' });
		res.end('Not found');
		return;
	}
	const upstream = http.request(
		{ host: UPSTREAM_HOST, port: upstreamPort, method: req.method, path: req.url, headers: req.headers },
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on('error', (error) => {
		if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain;charset=utf-8' });
		res.end(`ERR_PROXY_UPSTREAM: ${error.message}`);
	});
	req.pipe(upstream);
});

// VLESS rides a WebSocket, so the upgrade handshake has to be relayed verbatim
// rather than parsed and rebuilt by an HTTP client.
server.on('upgrade', (req, socket, head) => {
	if (isBlocked(req.url)) {
		socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
		return;
	}
	const upstream = net.connect(upstreamPort, UPSTREAM_HOST, () => {
		const headerLines = [];
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
		}
		upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
		if (head && head.length > 0) upstream.write(head);
		socket.pipe(upstream).pipe(socket);
	});
	const close = () => { socket.destroy(); upstream.destroy(); };
	upstream.on('error', close);
	socket.on('error', close);
});

server.on('error', (error) => {
	console.error(`ERR_PROXY_LISTEN: ${error.message}`);
	process.exit(1);
});

server.listen(listenPort, '0.0.0.0', () => {
	console.log(`Front proxy on :${listenPort} -> ${UPSTREAM_HOST}:${upstreamPort}, blocking ${BLOCKED_PREFIX}`);
});
