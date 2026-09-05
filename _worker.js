// @ts-ignore
import { connect } from 'cloudflare:sockets';
// Bundled as text by the [[rules]] entry in wrangler.toml.
import proxyCatalogText from './data/proxies.tsv';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

// Rotating proxyIP endpoints. Each hostname resolves to a large, continuously
// refreshed pool of working proxy IPs, so they stay healthy without code changes.
// Source: https://github.com/NiREvil/vless/blob/main/sub/ProxyIP.md
// Last verified alive: 2026-09-05 (TLS+HTTP probe against speed.cloudflare.com).
let proxyIPs = [
	'proxyip.cmliussss.net',            // worldwide
	'ProxyIP.DE.CMLiussss.net',         // Germany
	'ProxyIP.US.CMLiussss.net',         // United States
	'ProxyIP.SG.CMLiussss.net',         // Singapore
	'ProxyIP.JP.CMLiussss.net',         // Japan
	'ProxyIP.KR.CMLiussss.net',         // South Korea
	'ProxyIP.HK.CMLiussss.net',         // Hong Kong
	'di.nscl.ir',                       // US / Google / Amazon / Hetzner
	'proxy.farel.is-a.dev',             // mixed
	'bpb.yousef.isegaro.com',           // BPB LTD
	'tr.diam4.ggff.net',                // Turkey
	'proxyip.oracle.fxxk.dedyn.io',     // Oracle Cloud
	'proxyip.leilaomi.cc.cd',           // mixed
];

// Verified-alive static fallbacks (2026-09-05) if the hostnames above ever go dark.
// Two lowest-risk IPs per region from https://github.com/NiREvil/vless/blob/main/sub/ProxyIP-Daily.md
// NL 103.102.228.10, 103.102.228.113   | DE 103.228.168.182, 103.228.168.80
// US 103.3.26.26, 117.55.228.179       | FR 109.61.110.151, 147.90.14.132
// GB 138.249.138.5, 140.235.74.26      | FI 109.107.171.147, 109.120.185.29
// CH 132.243.174.185, 176.10.125.114   | SE 130.49.190.27, 158.179.206.143
// JP 103.201.131.215, 103.245.235.254  | SG 124.156.202.172, 139.180.159.133
// KR 130.94.29.155, 20.41.123.20       | HK 103.101.0.73, 103.118.40.94
// CA 172.98.207.58, 45.133.16.41       | AU 125.7.24.251, 137.23.29.90
// IN 20.235.105.146, 20.235.220.189    | TR 138.124.107.35, 141.98.118.80
// PL 138.124.104.104, 139.28.97.231    | LV 151.242.43.135, 151.242.43.187

// A single pinned proxy host, for deployments that do not want the rotating
// pool above. Set PROXYIP in the environment to a one-element list instead of
// editing this file - e.g. PROXYIP = 'proxyip.cmliussss.net' or, for IPv6,
// PROXYIP = '[2a01:4f8:c2c:123f:64:5:6810:c55a]'.

/**
 * Parses the PROXYIP environment variable, which may hold a single host or a
 * comma-separated list, and returns a trimmed, non-empty list of hosts.
 * @param {string | undefined} rawProxyIP
 * @returns {string[]} the configured proxy hosts, or an empty array if unset
 */
// Maximum number of proxy hosts included in a generated subscription.
const SUB_PROXY_IP_LIMIT = 4;

export function parseProxyIPs(rawProxyIP) {
	if (!rawProxyIP) return [];
	return rawProxyIP.split(',').map((host) => host.trim()).filter((host) => host.length > 0);
}

/**
 * Hostnames, IPv4 literals and bracketed IPv6 literals, with an optional port.
 * Anything else is rejected outright: the value arrives from an untrusted
 * client-supplied WebSocket path and is fed straight into connect().
 */
const PROXY_IP_PATTERN = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::\d{1,5})?$/;

/**
 * Reads the per-connection proxy override a client pins in its WebSocket path
 * (`path=/?ed=2048&proxyip=<host>`), so the proxy a user picked in /list is the
 * proxy their traffic actually leaves through.
 * @param {string} requestUrl the full request URL
 * @returns {{ host: string, port: number | null } | null} the pinned proxy, or
 *   null when none was requested or the value failed validation
 */
export function parseRequestedProxyIP(requestUrl) {
	let raw;
	try {
		raw = new URL(requestUrl).searchParams.get('proxyip');
	} catch (error) {
		return null;
	}
	if (!raw) return null;
	const candidate = raw.trim();
	if (!PROXY_IP_PATTERN.test(candidate)) return null;
	// Split on the last colon so bracketed IPv6 literals keep their own colons.
	const portSeparator = candidate.lastIndexOf(':');
	const hasPort = portSeparator > candidate.lastIndexOf(']');
	if (!hasPort) return { host: candidate, port: null };
	const port = Number(candidate.slice(portSeparator + 1));
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host: candidate.slice(0, portSeparator), port };
}

/**
 * Picks the outbound proxy for one connection: the client's pinned choice when
 * it passed validation, otherwise a random host from the configured pool.
 * @param {{ host: string, port: number | null } | null} requested
 * @param {string[]} pool
 * @returns {{ host: string, port: number | null } | null} null when neither a
 *   pinned choice nor a pool is available, meaning "connect direct"
 */
export function selectProxyIP(requested, pool) {
	if (requested) return requested;
	if (!pool || pool.length === 0) return null;
	return { host: pool[Math.floor(Math.random() * pool.length)], port: null };
}

/**
 * Per-connection tunnel logging. Off by default: on the Workers free tier the
 * whole WebSocket session shares one 10 ms CPU budget, and building a log line
 * per stream event is real work even when nothing reads it. Set DEBUG=true to
 * turn it back on while diagnosing.
 * @type {boolean}
 */
let debugLogging = false;

/** Shared no-op so the hot path allocates nothing when DEBUG is off. */
const noopLog = () => {};

let dohURL = 'https://freedns.controld.com/p0'; // https://github.com/serverless-dns/serverless-dns OR xxx.xxx.workers.dev [README.md]

if (!isValidUUID(userID)) {
	throw new Error('uuid is invalid');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, DNS_RESOLVER_URL: string, NODE_ID: int, API_HOST: string, API_TOKEN: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		// uuid_validator(request);
		try {
			userID = env.UUID || userID;
			// Request-local: a Worker isolate serves many concurrent requests, so
			// overwriting the module-level pool would leak one request's config
			// into another's connections.
			const envProxyIPs = parseProxyIPs(env.PROXYIP);
			const activeProxyIPs = envProxyIPs.length > 0 ? envProxyIPs : proxyIPs;
			dohURL = env.DNS_RESOLVER_URL || dohURL;
			debugLogging = env.DEBUG === 'true';
			const userIDs = userID.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				// Every configured UUID gets its own set of routes, not just the first one.
				const requestedUserID = userIDs.find((id) => url.pathname === `/sub/${id}`
					|| url.pathname === `/bestip/${id}`);
				const userID_Path = requestedUserID || userIDs[0];

				if (url.pathname === '/list' || url.pathname === '/list/measure') {
					const authFailure = requireBasicAuth(request, env);
					if (authFailure) return authFailure;
					if (url.pathname === '/list/measure') {
						if (request.method !== 'POST') {
							return new Response('ERR_LIST_METHOD_NOT_ALLOWED: use POST.', {
								status: 405,
								headers: { 'Allow': 'POST', 'Content-Type': 'text/plain;charset=utf-8' },
							});
						}
						return await handleMeasure(request);
					}
					return new Response(renderProxyListPage(userIDs, request.headers.get('Host')), {
						status: 200,
						headers: {
							'Content-Type': 'text/html; charset=utf-8',
							'Cache-Control': 'no-store',
						},
					});
				}
				switch (url.pathname) {
					case `/cf`: {
						return new Response(JSON.stringify(request.cf, null, 4), {
							status: 200,
							headers: {
								"Content-Type": "application/json;charset=utf-8",
							},
						});
					}
					case `/sub/${userID_Path}`: {
						const url = new URL(request.url);
						const searchParams = url.searchParams;
						const vlessSubConfig = createVlessSub(userID, request.headers.get('Host'), activeProxyIPs);
						// Construct and return response object
						return new Response(btoa(vlessSubConfig), {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					};
					case `/bestip/${userID_Path}`: {
						const headers = request.headers;
						const url = `https://sub.xf.free.hr/auto?host=${request.headers.get('Host')}&uuid=${userID_Path}&path=/`;
						const bestSubConfig = await fetch(url, { headers: headers });
						return bestSubConfig;
					};
					default:
						// return new Response('Not found', { status: 404 });
						// For any other path, reverse proxy to 'ramdom website' and return the original response, caching it in the process
						const randomHostname = cn_hostnames[Math.floor(Math.random() * cn_hostnames.length)];
						const newHeaders = new Headers(request.headers);
						newHeaders.set('cf-connecting-ip', '1.2.3.4');
						newHeaders.set('x-forwarded-for', '1.2.3.4');
						newHeaders.set('x-real-ip', '1.2.3.4');
						newHeaders.set('referer', 'https://www.google.com/');
						// Use fetch to proxy the request to 15 different domains
						const proxyUrl = 'https://' + randomHostname + url.pathname + url.search;
						let modifiedRequest = new Request(proxyUrl, {
							method: request.method,
							headers: newHeaders,
							body: request.body,
							redirect: 'manual',
						});
						const proxyResponse = await fetch(modifiedRequest, { redirect: 'manual' });
						// Check for 302 or 301 redirect status and return an error response
						if ([301, 302].includes(proxyResponse.status)) {
							return new Response(`Redirects to ${randomHostname} are not allowed.`, {
								status: 403,
								statusText: 'Forbidden',
							});
						}
						// Return the response from the proxy server
						return proxyResponse;
				}
			} else {
				return await vlessOverWSHandler(request, activeProxyIPs);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};

export async function uuid_validator(request) {
	const hostname = request.headers.get('Host');
	const currentDate = new Date();

	const subdomain = hostname.split('.')[0];
	const year = currentDate.getFullYear();
	const month = String(currentDate.getMonth() + 1).padStart(2, '0');
	const day = String(currentDate.getDate()).padStart(2, '0');

	const formattedDate = `${year}-${month}-${day}`;

	// const daliy_sub = formattedDate + subdomain
	const hashHex = await hashHex_f(subdomain);
	// subdomain string contains timestamps utc and uuid string TODO.
	console.log(hashHex, subdomain, formattedDate);
}

export async function hashHex_f(string) {
	const encoder = new TextEncoder();
	const data = encoder.encode(string);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(byte => byte.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

/**
 * Handles VLESS over WebSocket requests by creating a WebSocket pair, accepting the WebSocket connection, and processing the VLESS header.
 * @param {import("@cloudflare/workers-types").Request} request The incoming request object.
 * @param {string[]} proxyIPPool The configured proxy hosts to fall back to.
 * @returns {Promise<Response>} A Promise that resolves to a WebSocket response object.
 */
async function vlessOverWSHandler(request, proxyIPPool) {
	// The client pins its proxy in the WebSocket path; an absent or malformed
	// value falls back to a random host from the pool.
	const proxyTarget = selectProxyIP(parseRequestedProxyIP(request.url), proxyIPPool);
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	let currentDate = new Date();
	/**
	 * Per-connection totals. The free tier spends one 10 ms CPU budget on the
	 * whole WebSocket session, so the useful question is how many bytes a
	 * connection carried before it died. One log line per connection at close.
	 */
	const stats = { up: 0, down: 0, started: Date.now(), logged: false };
	const logConnectionStats = (/** @type {string} */ outcome) => {
		if (stats.logged) return;
		stats.logged = true;
		console.log('conn', JSON.stringify({
			outcome,
			target: `${address}:${portWithRandomLog}`.trim(),
			upBytes: stats.up,
			downBytes: stats.down,
			totalBytes: stats.up + stats.down,
			ms: Date.now() - stats.started,
		}));
	};
	const log = debugLogging
		? (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
			console.log(`[${currentDate} ${address}:${portWithRandomLog}] ${info}`, event || '');
		}
		: noopLog;
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			stats.up += chunk.byteLength || 0;
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID);
			address = addressRemote;
			portWithRandomLog = `${portRemote} ${isUDP ? 'udp' : 'tcp'} `;
			if (hasError) {
				// controller.error(message);
				throw new Error(message); // cf seems has bug, controller.error will not end stream
			}

			// If UDP and not DNS port, close it
			if (isUDP && portRemote !== 53) {
				throw new Error('UDP proxy only enabled for DNS which is port 53');
				// cf seems has bug, controller.error will not end stream
			}

			if (isUDP && portRemote === 53) {
				isDns = true;
			}

			// ["version", "additional info length N"]
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			// TODO: support udp here when cf runtime has udp support
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, stats, proxyTarget);
		},
		close() {
			logConnectionStats('close');
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			logConnectionStats('abort');
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		logConnectionStats('error');
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @param {{ up: number, down: number, started: number, logged: boolean }} stats Per-connection byte counters.
 * @param {{ host: string, port: number | null } | null} proxyTarget The proxy to fall back to, or null to retry direct.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, stats, proxyTarget) {

	/**
	 * Connects to a given address and port and writes data to the socket.
	 * @param {string} address The address to connect to.
	 * @param {number} port The port to connect to.
	 * @returns {Promise<import("@cloudflare/workers-types").Socket>} A Promise that resolves to the connected socket.
	 */
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	/**
	 * Retries connecting to the remote address and port if the Cloudflare socket has no incoming data.
	 * @returns {Promise<void>} A Promise that resolves when the retry is complete.
	 */
	async function retry() {
		// A pinned proxy may carry its own port; without one the original
		// destination port is preserved, as the proxy forwards transparently.
		const retryAddress = proxyTarget ? proxyTarget.host : addressRemote;
		const retryPort = proxyTarget && proxyTarget.port ? proxyTarget.port : portRemote;
		const tcpSocket = await connectAndWrite(retryAddress, retryPort)
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log, stats);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log, stats);
}

/**
 * Creates a readable stream from a WebSocket server, allowing for data to be read from the WebSocket.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer The WebSocket server to create the readable stream from.
 * @param {string} earlyDataHeader The header containing early data for WebSocket 0-RTT.
 * @param {(info: string)=> void} log The logging function.
 * @returns {ReadableStream} A readable stream that can be used to read data from the WebSocket.
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				const message = event.data;
				controller.enqueue(message);
			});

			webSocketServer.addEventListener('close', () => {
				safeCloseWebSocket(webSocketServer);
				controller.close();
			});

			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			});
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},

		cancel(reason) {
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});

	return stream;
}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 * Processes the VLESS header buffer and returns an object with the relevant information.
 * @param {ArrayBuffer} vlessBuffer The VLESS header buffer to process.
 * @param {string} userID The user ID to validate against the UUID in the VLESS header.
 * @returns {{
 *  hasError: boolean,
 *  message?: string,
 *  addressRemote?: string,
 *  addressType?: number,
 *  portRemote?: number,
 *  rawDataIndex?: number,
 *  vlessVersion?: Uint8Array,
 *  isUDP?: boolean
 * }} An object with the relevant information extracted from the VLESS header buffer.
 */
function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}

	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
	const slicedBufferString = stringify(slicedBuffer);
	// check if userID is valid uuid or uuids split by , and contains userID in it otherwise return error message to console
	const uuids = userID.includes(',') ? userID.split(",") : [userID];
	// uuid_validator(hostName, slicedBufferString);


	// isValidUser = uuids.some(userUuid => slicedBufferString === userUuid.trim());
	isValidUser = uuids.some(userUuid => slicedBufferString === userUuid.trim()) || uuids.length === 1 && slicedBufferString === uuids[0].trim();


	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	//skip opt for now

	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
		isUDP = false;
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}


/**
 * Converts a remote socket to a WebSocket connection.
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket The remote socket to convert.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to connect to.
 * @param {ArrayBuffer | null} vlessResponseHeader The VLESS response header.
 * @param {(() => Promise<void>) | null} retry The function to retry the connection if it fails.
 * @param {(info: string) => void} log The logging function.
 * @returns {Promise<void>} A Promise that resolves when the conversion is complete.
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log, stats) {
	// remote--> ws
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				/**
				 * 
				 * @param {Uint8Array} chunk 
				 * @param {*} controller 
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					remoteChunkCount++;
					if (stats) stats.down += chunk.byteLength || 0;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						// console.log(`remoteSocketToWS send chunk ${chunk.byteLength}`);
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

/**
 * Decodes a base64 string into an ArrayBuffer.
 * @param {string} base64Str The base64 string to decode.
 * @returns {{earlyData: ArrayBuffer|null, error: Error|null}} An object containing the decoded ArrayBuffer or null if there was an error, and any error that occurred during decoding or null if there was no error.
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { earlyData: null, error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { earlyData: null, error };
	}
}

/**
 * Checks if a given string is a valid UUID.
 * Note: This is not a real UUID validation.
 * @param {string} uuid The string to validate as a UUID.
 * @returns {boolean} True if the string is a valid UUID, false otherwise.
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Closes a WebSocket connection safely without throwing exceptions.
 * @param {import("@cloudflare/workers-types").WebSocket} socket The WebSocket connection to close.
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];

for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}


/**
 * Handles outbound UDP traffic by transforming the data into DNS queries and sending them over a WebSocket connection.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket connection to send the DNS queries over.
 * @param {ArrayBuffer} vlessResponseHeader The VLESS response header.
 * @param {(string) => void} log The logging function.
 * @returns {{write: (chunk: Uint8Array) => void}} An object with a write method that accepts a Uint8Array chunk to write to the transform stream.
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {

	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {

		},
		transform(chunk, controller) {
			// udp message 2 byte is the the length of udp data
			// TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {
		}
	});

	// only handle dns udp for now
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch(dohURL, // dns server url
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			// console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				log(`doh success and dns message length is ${udpSize}`);
				if (isVlessHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isVlessHeaderSent = true;
				}
			}
		}
	})).catch((error) => {
		log('dns udp has error' + error)
	});

	const writer = transformStream.writable.getWriter();

	return {
		/**
		 * 
		 * @param {Uint8Array} chunk 
		 */
		write(chunk) {
			writer.write(chunk);
		}
	};
}

const at = 'QA==';
const pt = 'dmxlc3M=';
const ed = 'Vmxlc3M=';

// ---------------------------------------------------------------------------
// Proxy catalog
// ---------------------------------------------------------------------------

/**
 * The proxy catalog, inlined at bundle time by the `Text` rule in
 * wrangler.toml. Keeping it in data/proxies.tsv means the daily refresh is a
 * data diff instead of a 2,500-line churn through source, and hosts never have
 * to be escaped for a JavaScript string literal.
 *
 * Format and provenance are documented in the header of that file.
 */
const PROXY_CATALOG = proxyCatalogText;

/** @typedef {{ cc: string, host: string, isp: string, latency: number, kind: string }} ProxyEntry */

/** @type {ProxyEntry[] | null} */
let cachedCatalog = null;

/**
 * Parses PROXY_CATALOG once per isolate.
 * @returns {ProxyEntry[]}
 */
export function getProxyCatalog() {
	if (cachedCatalog) return cachedCatalog;
	cachedCatalog = PROXY_CATALOG.split('\n')
		// The file carries a `#` header, and may reach the bundler with CRLF
		// line endings depending on how the repository was checked out.
		.map((line) => line.replace(/\r$/, ''))
		.filter((line) => line.length > 0 && !line.startsWith('#'))
		.map((line) => {
			const [cc, host, isp, latency, kind] = line.split('\t');
			return { cc, host, isp, latency: Number(latency), kind };
		});
	return cachedCatalog;
}

// ---------------------------------------------------------------------------
// /list authentication
// ---------------------------------------------------------------------------

/**
 * Compares two strings without leaking their contents through timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Enforces HTTP Basic authentication on the /list routes using the ADMIN_USER
 * and ADMIN_PASS environment variables.
 * @param {import("@cloudflare/workers-types").Request} request
 * @param {{ ADMIN_USER?: string, ADMIN_PASS?: string }} env
 * @returns {Response | null} a response to return immediately, or null when authorised
 */
function requireBasicAuth(request, env) {
	const expectedUser = env.ADMIN_USER;
	const expectedPass = env.ADMIN_PASS;
	if (!expectedUser || !expectedPass) {
		return new Response('ERR_LIST_AUTH_UNCONFIGURED: set ADMIN_USER and ADMIN_PASS to enable /list.', {
			status: 503,
			headers: { 'Content-Type': 'text/plain;charset=utf-8' },
		});
	}
	const unauthorized = new Response('ERR_LIST_UNAUTHORIZED: valid credentials required.', {
		status: 401,
		headers: {
			'WWW-Authenticate': 'Basic realm="proxy list", charset="UTF-8"',
			'Content-Type': 'text/plain;charset=utf-8',
		},
	});
	const header = request.headers.get('Authorization') || '';
	if (!header.startsWith('Basic ')) return unauthorized;
	let decoded;
	try {
		decoded = atob(header.slice(6).trim());
	} catch (error) {
		return unauthorized;
	}
	const separator = decoded.indexOf(':');
	if (separator < 0) return unauthorized;
	const user = decoded.slice(0, separator);
	const pass = decoded.slice(separator + 1);
	// Both comparisons always run so a wrong username costs the same as a wrong password.
	const userOk = safeEqual(user, expectedUser);
	const passOk = safeEqual(pass, expectedPass);
	return userOk && passOk ? null : unauthorized;
}

// ---------------------------------------------------------------------------
// /list/measure - live latency probing from the Cloudflare edge
// ---------------------------------------------------------------------------

/** Maximum hosts accepted in a single /list/measure request. */
const MEASURE_BATCH_LIMIT = 50;
/** Milliseconds after which a probe is treated as unreachable. */
const MEASURE_TIMEOUT_MS = 5000;
/**
 * The name the probe asks the proxy to reach. These proxies route on the SNI
 * carried in the relayed ClientHello, so the probe has to name a real
 * destination to learn whether the proxy forwards at all.
 */
const PROBE_SNI = 'speed.cloudflare.com';

/**
 * Rejects once `promise` outruns `ms`. The abandoned promise is left to settle
 * on its own; the caller closes the socket, which unblocks it.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error('ERR_MEASURE_TIMEOUT')), ms)),
	]);
}

/**
 * Builds a TLS ClientHello naming `serverName` in its SNI extension.
 *
 * The probe never completes a handshake - it only needs the first record the
 * far side sends back - so the key share is random bytes rather than a real
 * X25519 public key. That is enough for a server to answer with a ServerHello
 * or an alert, which is the signal the probe is after.
 *
 * @param {string} serverName the SNI to request
 * @returns {Uint8Array} a complete TLS record ready to write to the socket
 */
export function buildClientHello(serverName) {
	/** @type {number[]} */
	const out = [];
	const u8 = (value) => out.push(value & 0xff);
	const u16 = (value) => { out.push((value >> 8) & 0xff, value & 0xff); };
	/** Writes `body` prefixed with its length, `size` bytes wide. */
	const withLength = (size, body) => {
		const start = out.length;
		for (let i = 0; i < size; i += 1) out.push(0);
		body();
		const length = out.length - start - size;
		for (let i = 0; i < size; i += 1) out[start + i] = (length >> ((size - 1 - i) * 8)) & 0xff;
	};
	const random = (count) => {
		const bytes = new Uint8Array(count);
		crypto.getRandomValues(bytes);
		bytes.forEach((byte) => out.push(byte));
	};
	const extension = (type, body) => { u16(type); withLength(2, body); };

	u8(0x16); u16(0x0301); // handshake record, TLS 1.0 for maximum compatibility
	withLength(2, () => {
		u8(0x01); // ClientHello
		withLength(3, () => {
			u16(0x0303); // legacy_version: TLS 1.2
			random(32); // client random
			withLength(1, () => random(32)); // legacy session id
			withLength(2, () => {
				// TLS 1.3 suites first, then two widely accepted TLS 1.2 suites.
				[0x1301, 0x1302, 0x1303, 0xc02f, 0xc02b].forEach(u16);
			});
			withLength(1, () => u8(0x00)); // compression: null only
			withLength(2, () => {
				extension(0x0000, () => withLength(2, () => { // server_name
					u8(0x00); // host_name
					withLength(2, () => {
						for (const byte of new TextEncoder().encode(serverName)) u8(byte);
					});
				}));
				extension(0x000b, () => withLength(1, () => u8(0x00))); // ec_point_formats: uncompressed
				extension(0x000a, () => withLength(2, () => { [0x001d, 0x0017, 0x0018].forEach(u16); })); // supported_groups
				extension(0x000d, () => withLength(2, () => { [0x0804, 0x0403, 0x0401].forEach(u16); })); // signature_algorithms
				extension(0x002b, () => withLength(1, () => { [0x0304, 0x0303].forEach(u16); })); // supported_versions
				extension(0x0033, () => withLength(2, () => { // key_share
					u16(0x001d); // x25519
					withLength(2, () => random(32));
				}));
			});
		});
	});
	return new Uint8Array(out);
}

/**
 * @typedef {object} ProbeResult
 * @property {number} connect milliseconds to complete the TCP handshake
 * @property {number | null} relay milliseconds from ClientHello to the first
 *   response record, or null when nothing usable came back
 * @property {boolean} ok whether the proxy relayed to PROBE_SNI
 * @property {string} reason machine-readable outcome, for the tooltip
 */

/**
 * Probes host:443 from the Cloudflare edge: TCP handshake, then a ClientHello
 * for PROBE_SNI to see whether the host actually relays.
 *
 * A bare TCP handshake is not enough to call a proxy healthy - plenty of dead
 * entries still accept connections and then forward nothing - so the probe goes
 * one step further and waits for the far side's first TLS record.
 *
 * It stops there. Measuring throughput would mean completing the handshake, and
 * the Workers socket API ties the TLS SNI to the connect hostname, so the edge
 * cannot open a TLS session *through* an SNI-routed proxy. Throughput has to be
 * measured by a client that speaks the tunnel end to end.
 *
 * This is deliberately NOT the same measurement as the catalog's latency
 * figure, which is a round trip from a GitHub runner rather than a Cloudflare
 * PoP close to the proxy. /list keeps them in separate columns for that reason.
 *
 * @param {string} host
 * @returns {Promise<ProbeResult | null>} null if the host is unreachable
 */
async function measureHost(host) {
	const started = Date.now();
	let socket;
	try {
		socket = connect({ hostname: host, port: 443 });
		await withTimeout(socket.opened, MEASURE_TIMEOUT_MS);
		const connectMs = Date.now() - started;

		const writer = socket.writable.getWriter();
		await writer.write(buildClientHello(PROBE_SNI));
		writer.releaseLock();

		const relayStarted = Date.now();
		const reader = socket.readable.getReader();
		let first;
		try {
			first = await withTimeout(reader.read(), MEASURE_TIMEOUT_MS);
		} finally {
			try { reader.releaseLock(); } catch (error) { /* still locked by an abandoned read */ }
		}
		const relayMs = Date.now() - relayStarted;
		const bytes = first && first.value;
		if (first.done || !bytes || bytes.length < 6) {
			return { connect: connectMs, relay: null, ok: false, reason: 'no-response' };
		}
		if (bytes[0] === 0x15) { // TLS alert: it answered, but refused to relay
			return { connect: connectMs, relay: relayMs, ok: false, reason: 'tls-alert' };
		}
		if (bytes[0] !== 0x16 || bytes[5] !== 0x02) { // not a ServerHello
			return { connect: connectMs, relay: relayMs, ok: false, reason: 'not-tls' };
		}
		return { connect: connectMs, relay: relayMs, ok: true, reason: 'ok' };
	} catch (error) {
		// A timeout after the TCP handshake still means the proxy is useless, so
		// it is reported the same way as a refused connection.
		return null;
	} finally {
		try {
			if (socket) await socket.close();
		} catch (error) {
			// A socket that never opened cannot be closed; nothing to recover from.
		}
	}
}

/**
 * Handles POST /list/measure. Body: { hosts: string[] }.
 * @param {import("@cloudflare/workers-types").Request} request
 * @returns {Promise<Response>}
 */
async function handleMeasure(request) {
	let body;
	try {
		body = await request.json();
	} catch (error) {
		return new Response(JSON.stringify({ error: 'ERR_MEASURE_BAD_JSON' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json;charset=utf-8' },
		});
	}
	const hosts = Array.isArray(body && body.hosts) ? body.hosts : null;
	if (!hosts || hosts.length === 0) {
		return new Response(JSON.stringify({ error: 'ERR_MEASURE_NO_HOSTS' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json;charset=utf-8' },
		});
	}
	if (hosts.length > MEASURE_BATCH_LIMIT) {
		return new Response(JSON.stringify({ error: 'ERR_MEASURE_BATCH_TOO_LARGE', limit: MEASURE_BATCH_LIMIT }), {
			status: 400,
			headers: { 'Content-Type': 'application/json;charset=utf-8' },
		});
	}
	const known = new Set(getProxyCatalog().map((entry) => entry.host));
	const targets = hosts.filter((host) => known.has(host));
	const timings = await Promise.all(targets.map((host) => measureHost(host)));
	/** @type {Record<string, number | null>} */
	const results = {};
	targets.forEach((host, index) => { results[host] = timings[index]; });
	return new Response(JSON.stringify({ results }), {
		status: 200,
		headers: { 'Content-Type': 'application/json;charset=utf-8' },
	});
}

// ---------------------------------------------------------------------------
// /list - proxy browser UI
// ---------------------------------------------------------------------------

/** ISO country code to display name, for the country column and its filter. */
const COUNTRY_NAMES = {"AD": "AD", "AE": "United Arab Emirates", "AL": "Albania", "AM": "Armenia", "AT": "Austria", "AU": "Australia", "BA": "BA", "BD": "BD", "BE": "Belgium", "BG": "Bulgaria", "BR": "Brazil", "BY": "BY", "CA": "Canada", "CH": "Switzerland", "CL": "Chile", "CO": "Colombia", "CY": "Cyprus", "CZ": "Czech Republic", "DE": "Germany", "DK": "Denmark", "DO": "DO", "EE": "Estonia", "EG": "Egypt", "ES": "Spain", "FI": "Finland", "FR": "France", "GB": "United Kingdom", "HK": "Hong Kong", "HU": "Hungary", "IE": "Ireland", "IL": "Israel", "IN": "India", "IS": "IS", "IT": "Italy", "JP": "Japan", "KG": "KG", "KR": "South Korea", "KZ": "Kazakhstan", "LT": "Lithuania", "LV": "Latvia", "MD": "Moldova", "MU": "Mauritius", "MX": "Mexico", "MY": "Malaysia", "NL": "Netherlands", "PH": "Philippines", "PL": "Poland", "RO": "Romania", "RS": "Serbia", "RU": "Russia", "SA": "Saudi Arabia", "SE": "Sweden", "SG": "Singapore", "SY": "SY", "TH": "Thailand", "TR": "Turkey", "TW": "Taiwan", "UA": "Ukraine", "US": "United States", "UZ": "Uzbekistan", "VN": "Vietnam", "ZA": "South Africa", "ZZ": "Worldwide"};

/**
 * Renders the authenticated proxy browser served at /list.
 * @param {string[]} userIDs every configured UUID, used to populate the UUID picker
 * @param {string | null} hostName the worker hostname, used as SNI and Host in generated links
 * @returns {string} a complete HTML document
 */
/**
 * Memoised /list document. The page only varies by hostname and UUID list, so
 * an isolate serialises the ~2,500 row catalog once instead of on every hit.
 * @type {{ key: string, html: string } | null}
 */
let cachedListPage = null;

function renderProxyListPage(userIDs, hostName) {
	const cacheKey = `${hostName}|${userIDs.join(',')}`;
	if (cachedListPage && cachedListPage.key === cacheKey) return cachedListPage.html;
	const html = buildProxyListPage(userIDs, hostName);
	cachedListPage = { key: cacheKey, html };
	return html;
}

/**
 * Builds the /list document from scratch.
 * @param {string[]} userIDs
 * @param {string | null} hostName
 * @returns {string}
 */
function buildProxyListPage(userIDs, hostName) {
	const bootstrap = JSON.stringify({
		host: hostName || '',
		uuids: userIDs,
		names: COUNTRY_NAMES,
		probeSni: PROBE_SNI,
		rows: getProxyCatalog().map((entry) => [entry.cc, entry.host, entry.isp, entry.latency, entry.kind]),
	}).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Proxy list</title>
<link rel="icon" href="data:," />
<script>
	// Applied before first paint so the page never flashes the wrong theme.
	(function () {
		var stored = null;
		try { stored = localStorage.getItem('proxy-list-theme'); } catch (error) { /* storage may be blocked */ }
		var dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
		if (dark) document.documentElement.classList.add('dark');
	})();
</script>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { darkMode: 'class' };</script>
</head>
<body class="h-full bg-white text-slate-800 antialiased dark:bg-slate-950 dark:text-slate-200">
<script id="bootstrap" type="application/json">${bootstrap}</script>
<div class="flex h-full flex-col">
	<header class="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/60">
		<div class="flex flex-wrap items-center gap-3">
			<h1 class="text-sm font-semibold tracking-wide text-slate-900 dark:text-slate-100">Proxy list</h1>
			<span id="counts" class="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400"></span>
			<input id="search" type="search" placeholder="Fuzzy search host, country or ISP..."
				class="min-w-[16rem] flex-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder-slate-500" />
			<label class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" title="Swap the edge address in every generated link for the Vinaphone test host; the pinned proxy is unchanged">
				<input id="vinaphone" type="checkbox" class="h-4 w-4 accent-sky-500" />Test Vinaphone
			</label>
			<label class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">UUID
				<select id="uuid" class="max-w-[18rem] rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs text-slate-900 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"></select>
			</label>
			<button id="copySelected" type="button"
				class="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40">Copy links</button>
			<button id="copySub" type="button"
				class="rounded bg-slate-200 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">Copy subscription</button>
			<button id="measure" type="button"
				class="rounded bg-slate-200 px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-300 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600">Re-measure selected</button>
			<button id="clearFilters" type="button"
				class="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-500 hover:border-slate-400 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200">Reset</button>
			<button id="theme" type="button" title="Toggle dark and light theme"
				class="rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-500 hover:border-slate-400 hover:text-slate-800 dark:border-slate-700 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200"></button>
		</div>
		<p id="status" class="mt-2 hidden text-xs text-sky-600 dark:text-sky-400"></p>
	</header>

	<div class="min-h-0 flex-1 overflow-hidden">
		<div class="flex h-full flex-col overflow-hidden">
			<table class="w-full table-fixed border-collapse text-sm">
				<colgroup>
					<col class="w-10" /><col class="w-40" /><col class="w-52" /><col class="w-52" /><col class="w-28" /><col class="w-32" /><col /><col class="w-20" />
				</colgroup>
				<thead class="bg-slate-100 text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
					<tr>
						<th class="px-2 py-2 text-left"><input id="selectAll" type="checkbox" title="Select every visible row" class="h-4 w-4 accent-sky-500" /></th>
						<th class="px-2 py-2 text-left" data-col="cc"></th>
						<th class="px-2 py-2 text-left" data-col="host"></th>
						<th class="px-2 py-2 text-left" data-col="isp"></th>
						<th class="px-2 py-2 text-left" data-col="scan"></th>
						<th class="px-2 py-2 text-left" data-col="edge"></th>
						<th class="px-2 py-2 text-left" data-col="link"></th>
						<th class="px-2 py-2 text-right uppercase tracking-wide">Action</th>
					</tr>
				</thead>
			</table>
			<div id="scroller" class="min-h-0 flex-1 overflow-y-scroll">
				<div id="spacer" class="relative w-full">
					<table id="bodyTable" class="w-full table-fixed border-collapse text-sm">
						<colgroup>
							<col class="w-10" /><col class="w-40" /><col class="w-52" /><col class="w-52" /><col class="w-28" /><col class="w-32" /><col /><col class="w-20" />
						</colgroup>
						<tbody id="rows" class="divide-y divide-slate-200 dark:divide-slate-800/70"></tbody>
					</table>
				</div>
			</div>
		</div>
	</div>
</div>

<div id="popover" class="fixed z-50 hidden w-72 rounded border border-slate-300 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900"></div>

<div id="modal" class="fixed inset-0 z-[60] hidden items-center justify-center bg-slate-900/50 p-4 dark:bg-slate-950/80">
	<div class="w-full max-w-4xl rounded-lg border border-slate-300 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900">
		<div class="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
			<h2 id="modalTitle" class="text-sm font-semibold text-slate-900 dark:text-slate-100"></h2>
			<button type="button" data-modal-close class="rounded px-2 text-lg leading-none text-slate-400 hover:text-slate-800 dark:hover:text-slate-200">&times;</button>
		</div>
		<div class="px-4 py-3">
			<p id="modalNote" class="mb-2 text-xs text-slate-500"></p>
			<textarea id="modalText" readonly rows="8" spellcheck="false"
				class="w-full resize-y rounded border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800 outline-none focus:border-sky-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"></textarea>
		</div>
		<div class="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
			<span id="modalStatus" class="mr-auto text-xs text-emerald-600 dark:text-emerald-400"></span>
			<button type="button" data-modal-close class="rounded border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500">Close</button>
			<button type="button" id="modalCopy" class="rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500">Copy to clipboard</button>
		</div>
	</div>
</div>

<script>
(function () {
	'use strict';
	var DATA = JSON.parse(document.getElementById('bootstrap').textContent);
	var ROW_HEIGHT = 36;
	var OVERSCAN = 8;
	var MEASURE_BATCH = 50;
	var THEME_KEY = 'proxy-list-theme';
	/** Address substituted into every link while "Test Vinaphone" is ticked. */
	var VINAPHONE_ADDRESS = 'vina.std.io.vn:443';
	var COLUMNS = [
		{ key: 'cc', label: 'Country', filter: 'values', hint: '' },
		{ key: 'host', label: 'Host', filter: 'text', hint: '' },
		{ key: 'isp', label: 'ISP', filter: 'values', hint: '' },
		{ key: 'scan', label: 'Scan', filter: 'range',
			hint: 'TCP round trip from the GitHub runner that last refreshed the catalog - a rough ranking hint, not your latency' },
		{ key: 'edge', label: 'Edge', filter: null,
			hint: 'Measured on demand from the Cloudflare edge: TCP handshake plus the time to relay a TLS ClientHello through the proxy. "no relay" means it accepts connections but forwards nothing. Not comparable with Scan - different origin' },
		{ key: 'link', label: 'Link', filter: null, hint: '' }
	];

	var rows = DATA.rows.map(function (r, i) {
		var name = DATA.names[r[0]] || r[0];
		return {
			id: i, cc: r[0], host: r[1], isp: r[2], latency: r[3], kind: r[4],
			live: undefined, measuring: false, country: name, score: 0,
			haystack: (r[0] + ' ' + name + ' ' + r[1] + ' ' + r[2] + ' ' + r[4]).toLowerCase()
		};
	});

	var state = {
		query: '',
		sortKey: 'scan',
		sortDir: 1,
		sortTouched: false,
		byRelevance: false,
		filters: { cc: null, isp: null, host: '', latencyMax: null },
		selected: {},
		selectedCount: 0,
		view: rows.slice()
	};

	function pick(id) { return document.getElementById(id); }
	var el = {
		search: pick('search'), uuid: pick('uuid'), rows: pick('rows'), bodyTable: pick('bodyTable'),
		scroller: pick('scroller'), spacer: pick('spacer'), counts: pick('counts'), popover: pick('popover'),
		status: pick('status'), selectAll: pick('selectAll'), copySelected: pick('copySelected'),
		copySub: pick('copySub'), measure: pick('measure'), theme: pick('theme'), modal: pick('modal'),
		vinaphone: pick('vinaphone'),
		modalTitle: pick('modalTitle'), modalNote: pick('modalNote'), modalText: pick('modalText'),
		modalCopy: pick('modalCopy'), modalStatus: pick('modalStatus')
	};

	function flag(cc) {
		if (cc === 'ZZ' || cc.length !== 2) return '\\uD83C\\uDF10';
		return String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65);
	}

	var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
	function esc(value) {
		return String(value).replace(/[&<>"]/g, function (c) { return ESCAPES[c]; });
	}

	// Subsequence match: every query character must appear in order. Consecutive
	// hits and matches on a word boundary score higher, so tight hits float up.
	function fuzzy(text, query) {
		var ti = 0, qi = 0, score = 0, streak = 0;
		while (ti < text.length && qi < query.length) {
			if (text.charCodeAt(ti) === query.charCodeAt(qi)) {
				streak += 1;
				score += streak;
				if (ti === 0 || text.charCodeAt(ti - 1) === 32) score += 4;
				qi += 1;
			} else {
				streak = 0;
			}
			ti += 1;
		}
		return qi === query.length ? score : -1;
	}

	// row.latency is the catalog scan; row.live is the on-demand edge probe:
	// undefined means never probed, null means unreachable, otherwise it is
	// { connect, relay, ok, reason }. A host that connects but will not relay
	// sorts with the failures - it is no more useful than an unreachable one.
	function edgeSortValue(row) {
		if (!row.live || !row.live.ok) return Infinity;
		return row.live.connect + row.live.relay;
	}

	/** The single number shown in the edge column: connect plus relay. */
	function edgeTotal(live) {
		return live.connect + (live.relay || 0);
	}

	var PROBE_REASONS = {
		'no-response': 'connected, but relayed nothing back - this proxy is dead',
		'tls-alert': 'connected and answered with a TLS alert - it refused to relay',
		'not-tls': 'connected, but the reply was not a TLS ServerHello'
	};

	function linkFor(row) {
		var sni = DATA.host;
		// The client always connects to the worker's own edge; the row picks the
		// proxy the worker leaves through, pinned in the WebSocket path. Without
		// that parameter the worker would fall back to a random pool member and
		// the row selection would mean nothing.
		var address = el.vinaphone.checked ? VINAPHONE_ADDRESS : sni + ':443';
		var path = '/?ed=2048&proxyip=' + encodeURIComponent(row.host);
		return 'vless://' + el.uuid.value + '@' + address
			+ '?encryption=none&security=tls&sni=' + sni + '&fp=chrome&type=ws&host=' + sni
			+ '&path=' + encodeURIComponent(path) + '#' + encodeURIComponent(row.cc + '-' + row.host);
	}

	function sortValue(row, key) {
		if (key === 'scan') return row.latency;
		if (key === 'edge') return edgeSortValue(row);
		if (key === 'cc') return row.country;
		if (key === 'link') return linkFor(row);
		return row[key];
	}

	function applyFilters() {
		var query = state.query.trim().toLowerCase();
		var f = state.filters;
		var hostNeedle = f.host.trim().toLowerCase();
		var out = [];
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			if (f.cc && !f.cc[row.cc]) continue;
			if (f.isp && !f.isp[row.isp]) continue;
			if (hostNeedle && row.host.toLowerCase().indexOf(hostNeedle) === -1) continue;
			if (f.latencyMax !== null && row.latency > f.latencyMax) continue;
			if (query) {
				var score = fuzzy(row.haystack, query);
				if (score < 0) continue;
				row.score = score;
			} else {
				row.score = 0;
			}
			out.push(row);
		}
		// While searching, relevance wins until the user picks a column explicitly.
		state.byRelevance = query !== '' && !state.sortTouched;
		var key = state.sortKey;
		var dir = state.sortDir;
		var byRelevance = state.byRelevance;
		out.sort(function (a, b) {
			if (byRelevance && a.score !== b.score) return b.score - a.score;
			var av = sortValue(a, key);
			var bv = sortValue(b, key);
			if (av < bv) return -dir;
			if (av > bv) return dir;
			return a.host < b.host ? -1 : 1;
		});
		state.view = out;
		el.scroller.scrollTop = 0;
		renderHeader();
		renderRows();
		renderCounts();
	}

	function renderCounts() {
		el.counts.textContent = state.view.length + ' of ' + rows.length + ' shown, '
			+ state.selectedCount + ' selected' + (state.byRelevance ? ', ranked by relevance' : '');
		var none = state.selectedCount === 0;
		el.copySelected.disabled = none;
		el.copySub.disabled = none;
		el.measure.disabled = none;
		var all = state.view.length > 0;
		for (var i = 0; i < state.view.length; i++) {
			if (!state.selected[state.view[i].id]) { all = false; break; }
		}
		el.selectAll.checked = all;
	}

	function renderHeader() {
		COLUMNS.forEach(function (col) {
			var th = document.querySelector('th[data-col="' + col.key + '"]');
			var active = state.sortKey === col.key && !state.byRelevance;
			var arrow = active ? (state.sortDir === 1 ? ' \\u25B2' : ' \\u25BC') : '';
			var filtered = (col.key === 'cc' && state.filters.cc)
				|| (col.key === 'isp' && state.filters.isp)
				|| (col.key === 'host' && state.filters.host !== '')
				|| (col.key === 'scan' && state.filters.latencyMax !== null);
			var html = '<div class="flex items-center gap-1">'
				+ '<button type="button" data-sort="' + col.key + '" title="Sort by ' + esc(col.label)
				+ (col.hint ? '. ' + esc(col.hint) : '')
				+ '" class="flex-1 truncate text-left uppercase tracking-wide hover:text-slate-900 dark:hover:text-slate-100'
				+ (active ? ' text-slate-900 dark:text-slate-100' : '') + '">' + esc(col.label) + arrow + '</button>';
			if (col.filter) {
				html += '<button type="button" data-filter="' + col.key + '" title="Filter and search this column"'
					+ ' class="shrink-0 rounded px-1 '
					+ (filtered
						? 'bg-sky-600 text-white'
						: 'text-slate-400 hover:text-slate-800 dark:text-slate-500 dark:hover:text-slate-200')
					+ '">\\u25BE</button>';
			}
			th.innerHTML = html + '</div>';
		});
	}

	function renderRows() {
		var total = state.view.length;
		el.spacer.style.height = (total * ROW_HEIGHT) + 'px';
		var start = Math.max(0, Math.floor(el.scroller.scrollTop / ROW_HEIGHT) - OVERSCAN);
		var visible = Math.ceil(el.scroller.clientHeight / ROW_HEIGHT) + OVERSCAN * 2;
		var end = Math.min(total, start + visible);
		var html = '';
		for (var i = start; i < end; i++) {
			var row = state.view[i];
			var checked = state.selected[row.id] ? ' checked' : '';
			var edgeCell;
			if (row.measuring) {
				edgeCell = '<span class="text-[11px] text-sky-600 dark:text-sky-400">probing...</span>';
			} else if (row.live === undefined) {
				edgeCell = '<button type="button" data-remeasure="' + row.id
					+ '" title="Ask the Cloudflare edge to connect and relay a TLS ClientHello through this host"'
					+ ' class="rounded border border-dashed border-slate-300 px-1.5 text-[11px] text-slate-400'
					+ ' hover:border-sky-500 hover:text-sky-600 dark:border-slate-700 dark:text-slate-500 dark:hover:text-sky-400">measure</button>';
			} else if (row.live === null) {
				edgeCell = '<button type="button" data-remeasure="' + row.id
					+ '" title="No TCP connection from the Cloudflare edge"'
					+ ' class="rounded px-1 text-xs hover:underline text-rose-500 dark:text-rose-400">unreachable</button>';
			} else if (!row.live.ok) {
				edgeCell = '<button type="button" data-remeasure="' + row.id
					+ '" title="' + esc(PROBE_REASONS[row.live.reason] || row.live.reason)
					+ '" class="rounded px-1 text-xs hover:underline text-amber-600 dark:text-amber-400">no relay</button>';
			} else {
				edgeCell = '<button type="button" data-remeasure="' + row.id
					+ '" title="' + row.live.connect + ' ms TCP + ' + row.live.relay + ' ms to relay a ClientHello to '
					+ esc(DATA.probeSni) + '"'
					+ ' class="rounded px-1 text-xs tabular-nums hover:underline text-emerald-700 dark:text-emerald-400">'
					+ edgeTotal(row.live) + ' ms</button>';
			}
			var link = linkFor(row);
			html += '<tr class="hover:bg-slate-50 dark:hover:bg-slate-900/60" style="height:' + ROW_HEIGHT + 'px">'
				+ '<td class="px-2"><input type="checkbox" data-id="' + row.id + '" class="h-4 w-4 accent-sky-500"' + checked + ' /></td>'
				+ '<td class="truncate px-2"><span class="mr-1">' + flag(row.cc) + '</span>' + esc(row.country) + '</td>'
				+ '<td class="truncate px-2 font-mono text-xs">' + esc(row.host)
				+ (row.kind === 'pool' ? '<span class="ml-2 rounded bg-indigo-600/20 px-1 text-[10px] text-indigo-700 dark:text-indigo-300">pool</span>' : '')
				+ '</td>'
				+ '<td class="truncate px-2 text-slate-500 dark:text-slate-400">' + esc(row.isp) + '</td>'
				+ '<td class="px-2 tabular-nums text-slate-500 dark:text-slate-400">' + row.latency + ' ms</td>'
				+ '<td class="px-2">' + edgeCell + '</td>'
				+ '<td class="px-2"><button type="button" data-copy="' + row.id + '" title="' + esc(link)
				+ '" class="block w-full truncate text-left font-mono text-[11px] text-sky-700 hover:underline dark:text-sky-400">'
				+ esc(link) + '</button></td>'
				+ '<td class="px-2 text-right"><button type="button" data-copy="' + row.id
				+ '" class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:border-sky-500 hover:text-sky-600 dark:border-slate-700 dark:text-slate-300 dark:hover:text-sky-400">Copy</button></td>'
				+ '</tr>';
		}
		el.rows.innerHTML = html;
		el.bodyTable.style.transform = 'translateY(' + (start * ROW_HEIGHT) + 'px)';
	}

	function selectedRows() {
		return rows.filter(function (row) { return state.selected[row.id]; });
	}

	var statusTimer = null;
	function showStatus(message) {
		el.status.textContent = message;
		el.status.classList.remove('hidden');
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(function () { el.status.classList.add('hidden'); }, 5000);
	}

	// --- theme -------------------------------------------------------------

	function paintThemeButton() {
		var dark = document.documentElement.classList.contains('dark');
		el.theme.textContent = dark ? '\\u2600 Light' : '\\u263D Dark';
	}

	el.theme.addEventListener('click', function () {
		var dark = document.documentElement.classList.toggle('dark');
		try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (error) { /* storage may be blocked */ }
		paintThemeButton();
	});
	paintThemeButton();

	// --- copy modal --------------------------------------------------------

	function openModal(title, note, text) {
		el.modalTitle.textContent = title;
		el.modalNote.textContent = note;
		el.modalText.value = text;
		el.modalStatus.textContent = '';
		el.modal.classList.remove('hidden');
		el.modal.classList.add('flex');
		el.modalText.focus();
		el.modalText.select();
		// Offer the clipboard straight away; the textarea is the fallback when
		// the browser denies clipboard access.
		copyToClipboard(text);
	}

	function closeModal() {
		el.modal.classList.add('hidden');
		el.modal.classList.remove('flex');
	}

	function copyToClipboard(text) {
		if (!navigator.clipboard) {
			el.modalStatus.textContent = 'Clipboard unavailable - select the text above and copy manually.';
			return;
		}
		navigator.clipboard.writeText(text).then(function () {
			el.modalStatus.textContent = 'Copied to clipboard.';
		}, function () {
			el.modalStatus.textContent = 'Clipboard blocked - select the text above and copy manually.';
		});
	}

	el.modal.addEventListener('click', function (event) {
		if (event.target === el.modal || event.target.closest('[data-modal-close]')) closeModal();
	});
	el.modalCopy.addEventListener('click', function () { copyToClipboard(el.modalText.value); });
	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape') { closeModal(); el.popover.classList.add('hidden'); }
	});

	// --- live probing ------------------------------------------------------

	function probe(targets) {
		var batches = [];
		for (var i = 0; i < targets.length; i += MEASURE_BATCH) batches.push(targets.slice(i, i + MEASURE_BATCH));
		var done = 0;
		targets.forEach(function (row) { row.measuring = true; });
		renderRows();
		return batches.reduce(function (chain, batch) {
			return chain.then(function () {
				return fetch('/list/measure', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ hosts: batch.map(function (row) { return row.host; }) })
				}).then(function (response) {
					if (!response.ok) throw new Error('probe request failed with status ' + response.status);
					return response.json();
				}).then(function (payload) {
					batch.forEach(function (row) {
						row.measuring = false;
						if (Object.prototype.hasOwnProperty.call(payload.results, row.host)) row.live = payload.results[row.host];
					});
					done += batch.length;
					if (targets.length > 1) showStatus('Probed ' + done + ' of ' + targets.length + ' host(s)...');
					renderRows();
				});
			});
		}, Promise.resolve()).then(null, function (error) {
			targets.forEach(function (row) { row.measuring = false; });
			renderRows();
			throw error;
		});
	}

	// --- column filter popovers -------------------------------------------

	function distinct(key) {
		var counts = Object.create(null);
		rows.forEach(function (row) { counts[row[key]] = (counts[row[key]] || 0) + 1; });
		return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
			.map(function (value) { return { value: value, count: counts[value] }; });
	}

	function allValues(key) {
		var set = Object.create(null);
		rows.forEach(function (row) { set[row[key]] = true; });
		return set;
	}

	var INPUT_CLASS = 'w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100';

	function openPopover(key, anchor) {
		var col = COLUMNS.filter(function (c) { return c.key === key; })[0];
		var box = anchor.getBoundingClientRect();
		el.popover.style.left = Math.max(8, Math.min(box.left, window.innerWidth - 296)) + 'px';
		el.popover.style.top = (box.bottom + 4) + 'px';
		el.popover.dataset.key = key;
		el.popover.classList.remove('hidden');

		if (col.filter === 'text') {
			el.popover.innerHTML = '<label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Host contains</label>'
				+ '<input id="pf-text" class="' + INPUT_CLASS + '" value="' + esc(state.filters.host) + '" />';
			var text = pick('pf-text');
			text.focus();
			text.oninput = function () { state.filters.host = text.value; applyFilters(); };
			return;
		}

		if (col.filter === 'range') {
			el.popover.innerHTML = '<label class="mb-1 block text-[11px] uppercase tracking-wide text-slate-500">Max scan latency (ms)</label>'
				+ '<input id="pf-range" type="number" min="0" step="50" class="' + INPUT_CLASS + '" value="'
				+ (state.filters.latencyMax === null ? '' : state.filters.latencyMax) + '" />';
			var range = pick('pf-range');
			range.focus();
			range.oninput = function () {
				state.filters.latencyMax = range.value === '' ? null : Number(range.value);
				applyFilters();
			};
			return;
		}

		var values = distinct(key);
		el.popover.innerHTML = '<input id="pf-search" class="mb-2 ' + INPUT_CLASS + '" placeholder="Search values..." />'
			+ '<div class="mb-2 flex gap-3 text-[11px]">'
			+ '<button type="button" id="pf-all" class="text-sky-600 hover:underline dark:text-sky-400">Select all</button>'
			+ '<button type="button" id="pf-none" class="text-sky-600 hover:underline dark:text-sky-400">Select none</button></div>'
			+ '<div id="pf-list" class="max-h-64 overflow-auto"></div>';

		function paint(needle) {
			var active = state.filters[key];
			var html = '';
			values.forEach(function (entry) {
				var label = key === 'cc' ? (DATA.names[entry.value] || entry.value) : entry.value;
				if (needle && label.toLowerCase().indexOf(needle) === -1 && entry.value.toLowerCase().indexOf(needle) === -1) return;
				var on = !active || active[entry.value];
				html += '<label class="flex items-center gap-2 py-0.5 text-xs">'
					+ '<input type="checkbox" data-value="' + esc(entry.value) + '" class="h-3 w-3 accent-sky-500"' + (on ? ' checked' : '') + ' />'
					+ '<span class="flex-1 truncate">' + (key === 'cc' ? flag(entry.value) + ' ' : '') + esc(label) + '</span>'
					+ '<span class="text-slate-400">' + entry.count + '</span></label>';
			});
			pick('pf-list').innerHTML = html || '<p class="py-2 text-xs text-slate-500">No matches</p>';
		}

		paint('');
		pick('pf-search').oninput = function () { paint(this.value.toLowerCase()); };
		pick('pf-all').onclick = function () { state.filters[key] = null; paint(''); applyFilters(); };
		pick('pf-none').onclick = function () { state.filters[key] = Object.create(null); paint(''); applyFilters(); };
		pick('pf-list').onchange = function (event) {
			var value = event.target.dataset.value;
			if (value === undefined) return;
			if (!state.filters[key]) state.filters[key] = allValues(key);
			if (event.target.checked) state.filters[key][value] = true;
			else delete state.filters[key][value];
			applyFilters();
		};
	}

	// --- wiring ------------------------------------------------------------

	DATA.uuids.forEach(function (uuid) {
		var option = document.createElement('option');
		option.value = uuid;
		option.textContent = uuid;
		el.uuid.appendChild(option);
	});

	el.search.addEventListener('input', function () { state.query = el.search.value; applyFilters(); });
	el.uuid.addEventListener('change', renderRows);
	el.vinaphone.addEventListener('change', renderRows);
	el.scroller.addEventListener('scroll', renderRows, { passive: true });
	window.addEventListener('resize', renderRows);

	document.querySelector('thead').addEventListener('click', function (event) {
		var sort = event.target.closest('[data-sort]');
		if (sort) {
			var key = sort.dataset.sort;
			// Clicking the column that is already sorted always flips direction,
			// including the default sort the table opens with.
			if (state.sortKey === key && !state.byRelevance) state.sortDir = -state.sortDir;
			else { state.sortKey = key; state.sortDir = 1; }
			state.sortTouched = true;
			el.popover.classList.add('hidden');
			applyFilters();
			return;
		}
		var filter = event.target.closest('[data-filter]');
		if (!filter) return;
		if (!el.popover.classList.contains('hidden') && el.popover.dataset.key === filter.dataset.filter) {
			el.popover.classList.add('hidden');
		} else {
			openPopover(filter.dataset.filter, filter);
		}
	});

	document.addEventListener('click', function (event) {
		if (el.popover.contains(event.target) || event.target.closest('[data-filter]')) return;
		el.popover.classList.add('hidden');
	});

	el.rows.addEventListener('change', function (event) {
		var id = event.target.dataset.id;
		if (id === undefined) return;
		if (event.target.checked) {
			if (!state.selected[id]) { state.selected[id] = true; state.selectedCount += 1; }
		} else if (state.selected[id]) {
			delete state.selected[id];
			state.selectedCount -= 1;
		}
		renderCounts();
	});

	el.rows.addEventListener('click', function (event) {
		var remeasure = event.target.closest('[data-remeasure]');
		if (remeasure) {
			var target = rows[Number(remeasure.dataset.remeasure)];
			probe([target]).then(function () {
				var result = target.live;
				if (result === null) {
					showStatus(target.host + ' is unreachable from the Cloudflare edge.');
				} else if (!result.ok) {
					showStatus(target.host + ' connected in ' + result.connect + ' ms but did not relay ('
						+ result.reason + ').');
				} else {
					showStatus(target.host + ' relayed to ' + DATA.probeSni + ' in ' + edgeTotal(result)
						+ ' ms (' + result.connect + ' ms TCP + ' + result.relay + ' ms relay).');
				}
			}, function (error) {
				showStatus('Measurement failed: ' + error.message);
			});
			return;
		}
		var copy = event.target.closest('[data-copy]');
		if (!copy) return;
		var row = rows[Number(copy.dataset.copy)];
		openModal('VLESS link', row.country + ' - ' + row.host + ' - ' + row.isp, linkFor(row));
	});

	el.selectAll.addEventListener('change', function () {
		var on = el.selectAll.checked;
		state.view.forEach(function (row) {
			if (on && !state.selected[row.id]) { state.selected[row.id] = true; state.selectedCount += 1; }
			if (!on && state.selected[row.id]) { delete state.selected[row.id]; state.selectedCount -= 1; }
		});
		renderRows();
		renderCounts();
	});

	el.copySelected.addEventListener('click', function () {
		var links = selectedRows().map(linkFor);
		openModal('VLESS links', links.length + ' selected proxy(s), one link per line', links.join('\\n'));
	});

	el.copySub.addEventListener('click', function () {
		var links = selectedRows().map(linkFor);
		openModal('Subscription', 'Base64 of ' + links.length + ' node(s) - paste into a client as subscription content',
			btoa(links.join('\\n')));
	});

	pick('clearFilters').addEventListener('click', function () {
		state.query = '';
		el.search.value = '';
		state.sortKey = 'scan';
		state.sortDir = 1;
		state.sortTouched = false;
		state.filters = { cc: null, isp: null, host: '', latencyMax: null };
		state.selected = {};
		state.selectedCount = 0;
		el.popover.classList.add('hidden');
		applyFilters();
	});

	el.measure.addEventListener('click', function () {
		var targets = selectedRows();
		el.measure.disabled = true;
		showStatus('Probing ' + targets.length + ' host(s) from the Cloudflare edge...');
		probe(targets).then(function () {
			showStatus('Re-measured ' + targets.length + ' host(s) from the Cloudflare edge.');
		}, function (error) {
			showStatus('Measurement failed: ' + error.message);
		}).then(function () {
			el.measure.disabled = state.selectedCount === 0;
		});
	});

	applyFilters();
})();
</script>
</body>
</html>`;
}

const httpPortSet = new Set([80, 8080, 8880, 2052, 2086, 2095, 2082]);
const httpsPortSet = new Set([443, 8443, 2053, 2096, 2087, 2083]);

function createVlessSub(userIDPath, hostName, proxyIPPool) {
	const userIDArray = userIDPath.includes(',') ? userIDPath.split(',') : [userIDPath];
	// One node is emitted per userID x port x proxyIP, so cap the proxy hosts used
	// here to keep the subscription small enough for clients to import comfortably.
	const subProxyIPs = (proxyIPPool || proxyIPs).slice(0, SUB_PROXY_IP_LIMIT);
	// Every node dials the worker's own edge; the nodes differ only in the proxy
	// pinned in the `proxyip` path parameter, which is what the worker reads.
	const pathFor = (proxyHost) => encodeURIComponent('/?ed=2048&proxyip=' + encodeURIComponent(proxyHost));
	const commonUrlPartHttp = `?encryption=none&security=none&fp=chrome&type=ws&host=${hostName}&path=`;
	const commonUrlPartHttps = `?encryption=none&security=tls&sni=${hostName}&fp=chrome&type=ws&host=${hostName}&path=`;

	const output = userIDArray.flatMap((userID) => {
		const httpConfigs = Array.from(httpPortSet).flatMap((port) => {
			if (hostName.includes('pages.dev')) return [];
			const urlPart = `${hostName}-HTTP-${port}`;
			return subProxyIPs.map((proxyHost) => atob(pt) + '://' + userID + atob(at) + hostName + ':' + port
				+ commonUrlPartHttp + pathFor(proxyHost) + '#' + urlPart + '-' + proxyHost + '-' + atob(ed));
		});

		const httpsConfigs = Array.from(httpsPortSet).flatMap((port) => {
			const urlPart = `${hostName}-HTTPS-${port}`;
			return subProxyIPs.map((proxyHost) => atob(pt) + '://' + userID + atob(at) + hostName + ':' + port
				+ commonUrlPartHttps + pathFor(proxyHost) + '#' + urlPart + '-' + proxyHost + '-' + atob(ed));
		});

		return [...httpConfigs, ...httpsConfigs];
	});

	return output.join('\n');
}

const cn_hostnames = [
	// "account.zula.ir",
	// "zula.com",
	// "telewebion.com",
	'cdn.appsflyer.com',
	// 'alibaba.ir',
	// 'soft98.ir',
	// 'yasdl.com',
	// 'uplod.ir',
];
