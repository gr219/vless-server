// @ts-ignore
import { connect } from 'cloudflare:sockets';

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

// if you want to use ipv6 or single proxyIP, please add comment at this line and remove comment at the next line
let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
// use single proxyIP instead of random
// let proxyIP = 'proxyip.cmliussss.net';
// ipv6 proxyIP example remove comment to use
// let proxyIP = "[2a01:4f8:c2c:123f:64:5:6810:c55a]"

/**
 * Parses the PROXYIP environment variable, which may hold a single host or a
 * comma-separated list, and returns a trimmed, non-empty list of hosts.
 * @param {string | undefined} rawProxyIP
 * @returns {string[]} the configured proxy hosts, or an empty array if unset
 */
// Maximum number of proxy hosts included in a generated subscription.
const SUB_PROXY_IP_LIMIT = 4;

function parseProxyIPs(rawProxyIP) {
	if (!rawProxyIP) return [];
	return rawProxyIP.split(',').map((host) => host.trim()).filter((host) => host.length > 0);
}

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
			const envProxyIPs = parseProxyIPs(env.PROXYIP);
			if (envProxyIPs.length > 0) {
				proxyIPs = envProxyIPs;
			}
			proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];
			dohURL = env.DNS_RESOLVER_URL || dohURL;
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
						const vlessSubConfig = createVlessSub(userID, request.headers.get('Host'));
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
				return await vlessOverWSHandler(request);
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
 * @returns {Promise<Response>} A Promise that resolves to a WebSocket response object.
 */
async function vlessOverWSHandler(request) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	let currentDate = new Date();
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		console.log(`[${currentDate} ${address}:${portWithRandomLog}] ${info}`, event || '');
	};
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
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
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
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {

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
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
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

	console.log(`userID: ${slicedBufferString}`);

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
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
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
 * Verified-alive proxy endpoints, one per line, tab separated as:
 *   countryCode <TAB> host <TAB> isp <TAB> latencyMs <TAB> kind
 *
 * "pool" rows are hostnames that resolve to a continuously refreshed set of
 * working IPs; "ip" rows are individual addresses. Every entry answered a TLS +
 * HTTP round trip to speed.cloudflare.com on 2026-09-05. The latency figure was
 * measured from Central Europe and is a rough ranking hint only - use the
 * "Re-measure selected" button on /list for timings from the Cloudflare edge.
 *
 * Sources:
 *   https://github.com/NiREvil/vless/blob/main/sub/ProxyIP.md
 *   https://github.com/NiREvil/vless/blob/main/sub/ProxyIP-Daily.md
 */
const PROXY_CATALOG = `HK	ProxyIP.HK.CMLiussss.net	CMLiussss rotating pool	151	pool
SG	ProxyIP.SG.CMLiussss.net	CMLiussss rotating pool	170	pool
ZZ	proxyip.cmliussss.net	CMLiussss rotating pool	242	pool
KR	ProxyIP.KR.CMLiussss.net	CMLiussss rotating pool	322	pool
JP	ProxyIP.JP.CMLiussss.net	CMLiussss rotating pool	454	pool
ZZ	proxy.farel.is-a.dev	Mixed rotating pool	494	pool
DE	ProxyIP.DE.CMLiussss.net	CMLiussss rotating pool	613	pool
ZZ	di.nscl.ir	Google / Amazon / Hetzner pool	671	pool
US	ProxyIP.US.CMLiussss.net	CMLiussss rotating pool	750	pool
ZZ	bpb.yousef.isegaro.com	BPB LTD rotating pool	823	pool
ZZ	proxyip.leilaomi.cc.cd	Mixed rotating pool	2153	pool
ZZ	proxyip.oracle.fxxk.dedyn.io	Oracle Cloud rotating pool	2286	pool
TR	tr.diam4.ggff.net	Stark Industries / PQ Hosting	2316	pool
HK	42.200.176.168	Hong Kong Telecommunications (HKT) Limited Business Internet	81	ip
HK	156.241.191.236	Fastmos Co Limited	90	ip
HK	219.76.13.166	Hong Kong Telecommunications (HKT) Limited Mass Internet	91	ip
HK	101.79.165.113	CDNetworks	94	ip
HK	103.192.179.132	HK DINGDIAN NETWORK LIMITED	101	ip
HK	2.27.109.236	LANDUPS LIMITED	101	ip
HK	156.224.76.187	Akile LTD	102	ip
HK	154.16.183.190	Hytron Network Services Limited	104	ip
HK	209.33.160.61	BAGE CLOUD LLC	104	ip
HK	103.101.0.73	Netrouting Hong Kong	105	ip
HK	199.15.78.83	JINX CO., LIMITED	106	ip
HK	42.200.231.108	Hong Kong Telecommunications (HKT) Limited Business Internet	108	ip
HK	219.76.13.169	Hong Kong Telecommunications (HKT) Limited Mass Internet	109	ip
HK	165.154.20.213	UCLOUD INFORMATION TECHNOLOGY (HK) LIMITED	111	ip
HK	219.76.13.181	Hong Kong Telecommunications (HKT) Limited Mass Internet	111	ip
HK	43.230.9.121	BEST WEBTECHNOLOGY LIMITED	111	ip
SG	149.28.159.222	Vultr Holdings, LLC	111	ip
HK	45.202.248.172	Akile LTD	112	ip
SG	138.2.108.213	Oracle Corporation	112	ip
HK	219.76.13.167	Hong Kong Telecommunications (HKT) Limited Mass Internet	113	ip
HK	156.224.76.205	Akile LTD	113	ip
SG	134.185.83.89	Oracle Corporation	113	ip
SG	134.185.82.47	Oracle Corporation	113	ip
SG	138.2.64.229	Oracle Corporation	113	ip
SG	149.118.48.187	Oracle Corporation	113	ip
HK	103.219.194.43	BAGE CLOUD LLC	114	ip
HK	103.219.193.95	BAGE CLOUD LLC	114	ip
SG	168.138.165.174	Oracle Public Cloud	114	ip
SG	45.32.127.54	Vultr Holdings, LLC	114	ip
SG	159.65.1.74	DigitalOcean, LLC	114	ip
HK	116.48.104.171	Hong Kong Telecommunications (HKT) Limited Mass Internet	115	ip
HK	38.6.219.125	PEG TECH INC	115	ip
HK	172.104.59.187	ZEN-HK	115	ip
SG	129.150.63.157	Oracle Corporation	115	ip
SG	146.190.93.62	DigitalOcean, LLC	115	ip
NL	43.169.19.179	16 COLLYER QUAY # 18-29 INCOME AT RAFFLES	116	ip
SG	134.185.85.155	Cloudflare, Inc.	117	ip
SG	158.178.224.249	Oracle Svenska AB	117	ip
SG	161.118.220.38	500 Oracle Parkway	117	ip
SG	68.183.227.216	DigitalOcean, LLC	117	ip
HK	219.76.13.177	Hong Kong Telecommunications (HKT) Limited Mass Internet	118	ip
SG	47.82.155.79	Alibaba Cloud LLC	118	ip
SG	134.185.84.175	Oracle Corporation	118	ip
SG	213.35.100.242	Oracle Svenska AB	118	ip
SG	157.245.148.160	DigitalOcean, LLC	118	ip
SG	139.180.159.133	SGP_VULTR_CUST	119	ip
SG	157.228.130.240	FIRST SERVER, SOCIEDAD LIMITADA	119	ip
SG	138.2.110.111	Oracle Corporation	119	ip
SG	61.13.236.181	SPTEL PTE. LTD.	120	ip
SG	138.2.76.34	Oracle Corporation	120	ip
SG	161.118.200.170	Cloudflare London, LLC	120	ip
SG	188.239.9.91	Huawei-Cloud-SG	120	ip
SG	178.93.160.236	Private Customer	120	ip
SG	178.128.86.3	DigitalOcean, LLC	120	ip
SG	213.35.123.85	Oracle Corporation	122	ip
SG	51.79.177.53	OVH Singapore PTE. LTD	122	ip
SG	68.183.227.180	DigitalOcean, LLC	122	ip
HK	156.239.245.134	BINARY NETWORKS SOLUTIONS LLC	123	ip
HK	216.176.237.166	Eons Data Communications Limited	124	ip
SG	82.47.245.2	Private Customer	124	ip
HK	103.118.40.94	Hong Kong Telecommunications (HKT) Limited Mass Internet	125	ip
SG	134.209.96.76	DigitalOcean, LLC	125	ip
SG	167.172.85.29	DigitalOcean, LLC	126	ip
HK	43.154.131.189	6 COLLYER QUAY	128	ip
HK	154.219.104.114	vape	129	ip
HK	20.205.121.200	Microsoft Corporation	129	ip
SG	134.185.91.72	Oracle Corporation	129	ip
SG	128.199.255.242	DigitalOcean, LLC	129	ip
HK	43.132.231.159	6 COLLYER QUAY	130	ip
SG	193.239.167.110	FIRST SERVER, SOCIEDAD LIMITADA	130	ip
HK	47.239.4.246	ALIBABA CLOUD - HK	131	ip
SG	43.170.38.62	6 COLLYER QUAY	131	ip
SG	167.71.195.238	DigitalOcean, LLC	131	ip
HK	47.79.78.40	Alibaba Cloud LLC	132	ip
HK	150.109.71.243	16 COLLYER QUAY	132	ip
NL	43.169.18.179	16 COLLYER QUAY # 18-29 INCOME AT RAFFLES	132	ip
SG	3.0.50.69	Amazon Data Services Singapore	132	ip
SG	83.147.234.163	FIRST SERVER, SOCIEDAD LIMITADA	132	ip
SG	149.33.30.122	3NT SOLUTIONS LLP	132	ip
HK	216.176.237.163	Eons Data Communications Limited	134	ip
HK	154.21.203.206	NetLab	134	ip
SG	157.228.130.244	FIRST SERVER, SOCIEDAD LIMITADA	134	ip
SG	45.139.226.157	SPEEDYPAGE-LTD	134	ip
HK	43.132.234.175	6 COLLYER QUAY	136	ip
SG	157.230.244.86	DigitalOcean, LLC	136	ip
SG	139.177.185.196	Akamai Connected Cloud / Linode	136	ip
HK	20.2.9.133	Microsoft Corporation	138	ip
SG	45.130.164.109	CloudWebManage Platform	138	ip
HK	8.210.29.68	Aliyun Computing Co.LTD	139	ip
SG	159.89.199.63	DigitalOcean, LLC	139	ip
US	103.3.26.26	NEXQLOUD, Inc.	141	ip
HK	43.159.1.170	6 COLLYER QUAY	142	ip
SG	188.166.249.31	DigitalOcean, LLC	142	ip
SG	150.109.11.223	6 COLLYER QUAY	144	ip
SG	143.198.211.180	DigitalOcean, LLC	144	ip
SG	165.245.176.192	DigitalOcean, LLC	144	ip
US	159.60.146.82	Unknown ISP	144	ip
SG	43.160.241.174	6 COLLYER QUAY	148	ip
SG	138.2.87.237	Oracle Corporation	148	ip
SG	138.2.66.236	Oracle Corporation	149	ip
SG	161.118.217.162	500 Oracle Parkway	150	ip
SG	162.4.173.156	VAYNE NETWORK PTE. LTD.	152	ip
SG	213.35.105.58	Cloudflare, Inc.	152	ip
SG	168.144.44.150	DigitalOcean, LLC	152	ip
SG	164.52.2.100	UCUL-SG	153	ip
SG	140.245.103.72	Oracle Corporation	153	ip
SG	43.134.174.114	6 COLLYER QUAY	155	ip
SG	129.226.202.149	16 COLLYER QUAY	155	ip
SG	43.133.61.219	6 COLLYER QUAY	157	ip
SG	43.163.113.253	16 COLLYER QUAY # 18-29 INCOME AT RAFFLES	159	ip
SG	43.156.116.194	6 COLLYER QUAY	161	ip
SG	124.156.202.172	16 COLLYER QUAY	162	ip
SG	164.52.2.99	UCUL-SG	163	ip
SG	43.156.181.203	16 COLLYER QUAY	163	ip
HK	185.132.125.163	IROKO Networks Corporation	164	ip
HK	43.175.131.30	6 COLLYER QUAY	166	ip
SG	164.52.2.98	UCUL-SG	167	ip
SG	20.6.12.145	Microsoft Corporation	168	ip
US	159.60.146.81	Unknown ISP	174	ip
HK	176.98.181.167	ALEKSEI FEDOROV PR KRUSEVAC	180	ip
SG	82.109.96.42	Private Customer	182	ip
HK	154.84.154.37	DATAGEAR LLP	186	ip
HK	138.124.111.115	365.partners INC	188	ip
JP	45.8.173.215	Private Customer	188	ip
JP	45.63.124.130	The Constant Company, LLC	188	ip
US	185.65.151.81	HLL LLC	189	ip
HK	139.28.169.72	BEAFORT LIMITED	190	ip
HK	91.149.237.61	Baxet Group Inc.	191	ip
JP	139.180.193.51	The Constant Company, LLC	191	ip
SG	162.128.72.114	Zenlayer (Singapore) PTE. LTD	192	ip
HK	43.168.16.112	ACE	193	ip
JP	66.42.40.47	TYO_VULTR_CUST	197	ip
JP	162.141.131.145	BAGE CLOUD LLC	198	ip
HK	195.58.144.166	Private Customer	200	ip
JP	198.13.43.34	The Constant Company, LLC	200	ip
HK	2.27.109.62	LANDUPS LIMITED	202	ip
JP	149.28.21.106	Vultr Holdings, LLC	204	ip
JP	161.33.4.103	Oracle Corporation	205	ip
JP	138.2.52.152	Oracle Corporation	206	ip
JP	140.83.87.85	Oracle Corporation	206	ip
JP	217.142.226.36	Oracle Corporation	206	ip
KR	61.109.188.223	CJcablenet	207	ip
JP	167.179.106.168	The Constant Company, LLC	208	ip
JP	45.76.198.248	Vultr Holdings, LLC	208	ip
JP	160.16.103.102	SAKURA Internet Inc.	209	ip
JP	140.83.58.91	imported inetnum object for OCPL-1	209	ip
JP	152.69.199.75	Oracle Corporation	209	ip
JP	34.84.135.67	Google LLC	209	ip
JP	109.107.140.90	xTom	210	ip
JP	167.179.77.74	The Constant Company, LLC	211	ip
JP	161.33.15.101	Oracle Corporation	211	ip
JP	207.148.108.85	Vultr Holdings, LLC	211	ip
SG	141.11.43.124	Private Customer	211	ip
JP	160.16.62.225	SAKURA Internet Inc.	213	ip
JP	45.77.27.173	Vultr Holdings, LLC	213	ip
KR	110.10.178.240	SK Broadband Co Ltd	213	ip
KR	123.111.169.70	SK Broadband Co Ltd	214	ip
JP	161.33.172.160	Oracle Corporation	215	ip
JP	172.238.19.67	Linode	215	ip
JP	167.179.75.237	TYO_VULTR_CUST	218	ip
JP	217.142.244.178	Oracle Svenska AB	219	ip
KR	211.110.208.116	SK Broadband Co Ltd	219	ip
JP	161.33.154.89	Oracle Corporation	220	ip
JP	132.226.5.25	Oracle Public Cloud	220	ip
JP	161.33.181.105	Oracle Corporation	221	ip
JP	207.148.99.230	TYO_VULTR_CUST	222	ip
KR	211.49.57.134	SK Broadband Co Ltd	222	ip
JP	160.16.209.61	SAKURA Internet Inc.	225	ip
JP	150.230.58.50	Oracle Corporation	225	ip
JP	168.138.52.221	Oracle Corporation	225	ip
VN	103.6.234.246	HASAKI VIETNAM SECURITY SERVICES COMPANY LIMITED	225	ip
JP	141.147.185.63	Oracle Corporation	226	ip
JP	141.147.185.181	Oracle Corporation	226	ip
JP	158.101.84.125	Oracle Public Cloud	227	ip
TH	43.133.110.81	6 COLLYER QUAY	227	ip
JP	141.147.182.70	Oracle Corporation	228	ip
JP	161.33.47.66	Oracle Corporation	230	ip
JP	138.2.31.37	Oracle Corporation	231	ip
JP	150.230.206.253	Oracle Corporation	231	ip
JP	151.145.74.149	Oracle Corporation	231	ip
JP	150.230.210.96	Oracle Corporation	231	ip
KR	61.109.188.221	CJcablenet	231	ip
JP	168.110.52.52	Oracle Corporation	232	ip
JP	138.2.21.53	Oracle Corporation	233	ip
JP	165.154.241.192	Scloud Pte Ltd t/a Scloud Pte Ltd	234	ip
JP	152.70.108.9	Oracle Corporation	234	ip
JP	141.147.149.223	Oracle Corporation	235	ip
JP	161.33.29.51	Oracle Corporation	235	ip
JP	217.142.225.47	Cloudflare London, LLC	235	ip
JP	140.83.55.25	imported inetnum object for OCPL-1	237	ip
JP	150.230.2.165	Oracle Corporation	237	ip
JP	168.138.193.193	Oracle Public Cloud	237	ip
KR	20.41.123.20	Microsoft Corporation	237	ip
JP	168.138.46.67	Oracle Public Cloud	238	ip
JP	138.2.52.92	Oracle Corporation	239	ip
JP	141.147.174.243	Oracle Corporation	239	ip
JP	155.248.181.189	Oracle Public Cloud	239	ip
JP	151.145.78.30	Oracle Corporation	241	ip
JP	150.230.212.247	Oracle Corporation	241	ip
JP	161.33.194.170	Oracle Corporation	242	ip
JP	140.238.49.222	Oracle Public Cloud	242	ip
HK	2.27.109.35	LANDUPS LIMITED	243	ip
JP	160.16.123.110	SAKURA Internet Inc.	243	ip
JP	161.33.129.98	Oracle Corporation	245	ip
JP	161.33.25.202	Oracle Corporation	245	ip
JP	161.33.157.193	Oracle Corporation	245	ip
JP	161.33.206.185	Oracle Corporation	249	ip
JP	141.147.176.154	Oracle Corporation	250	ip
JP	138.2.5.136	Cloudflare London, LLC	251	ip
JP	138.2.30.150	Oracle Corporation	252	ip
JP	161.33.135.154	Oracle Corporation	253	ip
JP	161.33.131.94	Oracle Corporation	254	ip
KR	27.102.134.233	KCInfra Inc.	255	ip
JP	172.234.89.153	Akamai Connected Cloud / Linode	256	ip
JP	64.110.104.119	Oracle Corporation	258	ip
KR	3.35.51.12	AWS Asia Pacific (Seoul) Region	259	ip
JP	141.147.162.33	Oracle Corporation	260	ip
JP	45.153.246.47	365 Group LLC	261	ip
JP	160.16.109.149	SAKURA Internet Inc.	261	ip
JP	154.83.95.77	Akile LTD	261	ip
KR	140.245.65.122	Oracle Corporation	262	ip
JP	54.95.106.234	Amazon Data Services Japan	264	ip
JP	8.219.155.125	Alibaba Cloud (Singapore) Private Limited	266	ip
JP	35.74.168.128	Amazon.com, Inc.	266	ip
JP	103.201.131.215	xTom Limited	271	ip
JP	216.195.204.29	Eons Data Communications Limited	273	ip
JP	137.220.225.56	CTG Server Ltd.	274	ip
JP	13.193.212.73	Amazon.com, Inc.	274	ip
KR	168.107.62.215	Oracle Corporation	274	ip
KR	168.107.0.210	Oracle Corporation	275	ip
TW	60.249.21.30	Chunghwa Telecom Data Communication Business Group	275	ip
JP	8.222.193.153	Alibaba Cloud (Singapore) Private Limited	276	ip
JP	64.83.40.108	NTT	276	ip
JP	64.83.39.176	NTT	276	ip
KR	152.67.214.155	Oracle Corporation	277	ip
KR	130.94.29.155	LIGHT NODE LIMITED	285	ip
KR	134.185.123.54	Oracle Corporation	285	ip
KR	168.107.9.102	Oracle Corporation	287	ip
KR	152.67.203.125	Oracle Corporation	287	ip
SG	85.149.211.122	BAGE CLOUD LLC	288	ip
JP	54.248.227.16	Amazon.com, Inc.	289	ip
KR	45.141.139.209	XNNET LIMITED	289	ip
KR	144.24.86.21	Oracle Corp UK Ltd	289	ip
KR	146.56.119.205	Oracle Corporation , Global software solutions , California , USA	289	ip
KR	134.185.99.52	Oracle Corporation	289	ip
KR	45.93.31.34	XNNET LIMITED	290	ip
IN	103.111.114.87	Melbikomas UAB	295	ip
JP	8.222.185.236	Alibaba Cloud (Singapore) Private Limited	295	ip
KR	134.185.127.173	Oracle Corporation	295	ip
JP	107.148.118.151	Private Customer	297	ip
JP	210.138.37.53	CDNetworks co., Ltd	298	ip
KR	152.69.229.110	Oracle Corporation	298	ip
JP	8.219.195.31	Alibaba Cloud (Singapore) Private Limited	299	ip
JP	15.168.27.230	Amazon Data Services Osaka	303	ip
KR	168.110.107.218	Oracle Corporation	304	ip
KR	64.176.230.12	The Constant Company, LLC	304	ip
BD	103.115.253.253	Star Internet Service	306	ip
IN	20.235.105.146	Microsoft Corporation	306	ip
KR	144.24.73.232	Oracle Corp UK Ltd	306	ip
JP	137.220.225.111	CTG Server Ltd.	308	ip
KR	168.110.101.249	Oracle Corporation	308	ip
JP	43.170.8.95	6 COLLYER QUAY	309	ip
JP	103.245.235.254	Skyquantum Telecom ltd	313	ip
IN	98.70.26.236	Microsoft Corporation	315	ip
IN	143.110.241.197	MANNDESHI GURU NET PRIVATE LIMITED	316	ip
JP	43.133.166.143	6 COLLYER QUAY	318	ip
KR	152.67.210.234	Oracle Public Cloud	319	ip
KR	146.56.106.214	Oracle Corporation	321	ip
IN	216.10.243.159	P.D.R Solutions FZC	322	ip
IN	134.209.148.128	DigitalOcean, LLC	323	ip
JP	103.27.186.39	Haixing Cloud	323	ip
JP	134.122.164.41	CTG Server Ltd.	323	ip
JP	154.36.155.70	PSINet, Inc.	323	ip
KR	152.67.208.47	Oracle Public Cloud	324	ip
KR	141.164.37.50	KOR_VULTR_CUST	326	ip
IN	143.110.182.104	MANNDESHI GURU NET PRIVATE LIMITED	330	ip
JP	64.176.62.94	The Constant Company, LLC	330	ip
JP	177.3.89.135	JT TELECOM INTERNATIONAL PTE.LTD.	331	ip
JP	64.176.41.21	Vultr Holdings, LLC	337	ip
IN	139.59.18.247	MANNDESHI GURU NET PRIVATE LIMITED	339	ip
JP	64.176.36.17	The Constant Company, LLC	339	ip
IN	5.253.30.229	BEAFORT LIMITED	342	ip
IN	161.118.179.243	500 Oracle Parkway	343	ip
IN	143.110.184.105	MANNDESHI GURU NET PRIVATE LIMITED	343	ip
SG	156.244.57.227	DigitalOcean, LLC	345	ip
IN	139.59.81.26	MANNDESHI GURU NET PRIVATE LIMITED	351	ip
JP	64.176.54.102	The Constant Company, LLC	352	ip
HK	139.177.185.88	ZEN-HK	354	ip
JP	161.33.212.104	Oracle Corporation	355	ip
IN	4.240.110.47	Microsoft Corporation	358	ip
IN	5.253.30.225	BEAFORT LIMITED	360	ip
IN	143.110.178.130	MANNDESHI GURU NET PRIVATE LIMITED	360	ip
IN	172.236.187.52	Linode	361	ip
JP	177.3.89.196	JT TELECOM INTERNATIONAL PTE.LTD.	362	ip
KR	132.145.89.240	Oracle Public Cloud	363	ip
JP	64.176.42.143	The Constant Company, LLC	366	ip
KR	132.145.81.4	Oracle Public Cloud	368	ip
KR	146.56.158.34	Oracle Corporation , Global software solutions , California , USA	370	ip
KR	146.56.188.74	Oracle Corporation , Global software solutions , California , USA	371	ip
KR	193.122.119.241	Oracle Public Cloud	371	ip
IN	20.235.220.189	Microsoft Corporation	374	ip
IN	5.253.28.108	BEAFORT LIMITED	376	ip
JP	134.122.164.55	CTG Server Ltd.	376	ip
KR	43.164.134.99	16 COLLYER QUAY # 18-29 INCOME AT RAFFLES	376	ip
IN	5.253.28.109	BEAFORT LIMITED	378	ip
SG	64.235.43.44	Singapore SG Datacenter	381	ip
IN	5.253.30.226	BEAFORT LIMITED	382	ip
IN	5.253.30.230	BEAFORT LIMITED	385	ip
KR	140.238.30.217	Oracle Corporation	385	ip
IN	5.253.28.245	BEAFORT LIMITED	387	ip
IN	5.253.30.228	BEAFORT LIMITED	391	ip
KR	132.226.23.185	Oracle Public Cloud	392	ip
KR	43.131.242.223	6 COLLYER QUAY	397	ip
KR	152.70.232.72	Oracle Corporation	403	ip
IN	5.253.29.83	BEAFORT LIMITED	407	ip
KR	193.123.236.97	Oracle Corporation	407	ip
KR	131.186.26.94	Oracle Public Cloud	409	ip
KR	152.70.254.197	Oracle Corporation	411	ip
KR	131.186.16.166	Oracle Public Cloud	412	ip
IN	139.59.47.74	MANNDESHI GURU NET PRIVATE LIMITED	414	ip
KR	146.56.142.151	Oracle Corporation	416	ip
KR	140.238.5.86	Oracle Public Cloud	432	ip
KR	129.154.211.146	Oracle Corporation	434	ip
KR	146.56.135.196	Cloudflare London, LLC	435	ip
KR	152.70.253.84	Oracle Corporation	439	ip
KR	64.110.70.64	Oracle Corporation	439	ip
KR	193.122.96.190	Oracle Corporation	440	ip
PH	122.2.198.74	IPG	478	ip
KR	119.205.235.58	Korea Telecom	485	ip
AE	20.174.15.226	Microsoft Corporation	497	ip
IN	139.84.174.65	The Constant Company, LLC	498	ip
US	129.159.37.136	Oracle Corporation	500	ip
US	64.181.251.32	Oracle Corporation	509	ip
US	149.28.92.56	Vultr Holdings, LLC	516	ip
US	38.65.9.110	ZMTO Technologies OÜ	517	ip
US	192.220.23.93	NTT America, Inc.	517	ip
BD	103.48.16.37	Bangladesh Computer Council	518	ip
US	64.181.255.215	Oracle Corporation	518	ip
US	150.230.41.112	Oracle Corporation	520	ip
US	64.181.247.243	Oracle Corporation	523	ip
US	129.159.36.93	Oracle Corporation	524	ip
US	163.192.52.18	Oracle Corporation	524	ip
US	170.9.59.156	Oracle Corporation	528	ip
US	146.235.220.243	Oracle Corporation	530	ip
US	147.224.59.149	Oracle Corporation	530	ip
US	163.192.3.96	Oracle Corporation	530	ip
US	146.235.213.124	Oracle Corporation	531	ip
US	163.192.10.125	Oracle Corporation	531	ip
JP	132.243.30.210	FIRST SERVER, SOCIEDAD LIMITADA	533	ip
US	163.192.61.105	Oracle Corporation	535	ip
US	64.181.227.82	Oracle Corporation	535	ip
US	192.9.250.241	Oracle Corporation	537	ip
US	163.192.60.170	Oracle Corporation	538	ip
US	192.9.237.242	Cloudflare London, LLC	538	ip
US	216.24.178.29	Cluster Logic Inc	539	ip
US	146.235.202.197	Cloudflare London, LLC	540	ip
US	159.54.180.96	Oracle Corporation	540	ip
US	163.47.42.64	5G NETWORK OPERATIONS PTY LTD	541	ip
US	146.235.233.180	Oracle Corporation	541	ip
US	152.70.123.137	Oracle Corporation	541	ip
US	167.234.221.72	Oracle Corporation	541	ip
US	38.65.9.104	ZMTO Technologies OÜ	543	ip
US	163.192.62.250	Oracle Corporation	543	ip
US	192.9.138.214	Oracle Corporation	543	ip
US	44.246.4.70	Amazon.com, Inc.	543	ip
US	154.40.34.236	NetLab Global	543	ip
AU	125.7.24.251	Macquarie Telecom	544	ip
US	146.235.199.164	Oracle Corporation	545	ip
US	192.9.243.53	Oracle Corporation	547	ip
US	117.55.228.179	UberGlobal UBRCBRVL5	548	ip
US	138.2.230.58	Oracle Corporation	548	ip
US	167.234.222.133	Oracle Corporation	548	ip
US	152.70.122.243	Oracle Corporation	549	ip
CH	87.120.222.199	GLOBAL CONNECTIVITY SOLUTIONS LLP	551	ip
FR	144.24.207.108	Oracle Corp UK Ltd	552	ip
US	117.55.239.57	UberGlobal UBRCBRCCA	552	ip
US	192.9.149.198	Oracle Corporation	552	ip
IT	195.231.38.220	Aruba S.p.A. - Cloud Services IT3	553	ip
FR	147.90.26.70	Seigohost LLC	554	ip
FR	147.90.26.63	Seigohost LLC	554	ip
FR	147.90.26.55	Seigohost LLC	555	ip
US	146.235.232.79	Oracle Corporation	555	ip
US	163.192.47.170	Oracle Corporation	555	ip
US	64.23.161.169	DigitalOcean, LLC	555	ip
CH	87.120.222.168	GLOBAL CONNECTIVITY SOLUTIONS LLP	557	ip
FR	147.90.26.18	Seigohost LLC	557	ip
FR	147.90.26.7	Seigohost LLC	558	ip
US	91.217.139.70	XNNET LIMITED	558	ip
US	104.168.146.122	HostPapa	558	ip
AT	151.236.8.190	EDIS IPv6 Infrastructure in Austria	559	ip
CH	213.176.18.108	GLOBAL CONNECTIVITY SOLUTIONS LLP	559	ip
CH	45.143.200.245	GLOBAL CONNECTIVITY SOLUTIONS LLP	559	ip
FR	147.90.26.92	Seigohost LLC	559	ip
FR	147.90.26.83	Seigohost LLC	559	ip
FR	82.70.232.70	Oracle Svenska AB	559	ip
JP	84.247.152.136	Contabo GmbH	559	ip
FR	147.90.26.39	Seigohost LLC	560	ip
FR	147.90.26.69	Seigohost LLC	560	ip
FR	147.90.26.78	Seigohost LLC	560	ip
FR	147.90.26.3	Seigohost LLC	560	ip
US	163.192.27.167	Oracle Corporation	560	ip
US	47.251.95.178	Alibaba Cloud - US	560	ip
CH	107.189.30.77	BuyVM	561	ip
FR	185.193.89.62	GLOBAL CONNECTIVITY SOLUTIONS LLP	561	ip
FR	195.154.184.21	Scaleway	561	ip
CH	87.120.222.2	GLOBAL CONNECTIVITY SOLUTIONS LLP	562	ip
FR	147.90.26.89	Seigohost LLC	562	ip
FR	147.90.26.67	Seigohost LLC	562	ip
FR	147.90.26.94	Seigohost LLC	562	ip
FR	147.90.26.93	Seigohost LLC	562	ip
FR	147.90.26.51	Seigohost LLC	562	ip
FR	82.70.249.215	Oracle Svenska AB	562	ip
FR	194.113.235.229	GLOBAL CONNECTIVITY SOLUTIONS LLP	562	ip
US	5.253.38.82	Private Customer	562	ip
US	161.153.127.161	Oracle Corporation	562	ip
US	146.190.56.83	DigitalOcean, LLC	562	ip
CH	167.17.181.45	Baxet Group Inc.	563	ip
CH	171.22.16.231	GLOBAL CONNECTIVITY SOLUTIONS LLP	563	ip
FR	147.90.26.9	Seigohost LLC	563	ip
FR	147.90.26.90	Seigohost LLC	563	ip
FR	147.90.26.23	Seigohost LLC	563	ip
FR	147.90.26.80	Seigohost LLC	563	ip
FR	147.90.26.75	Seigohost LLC	563	ip
US	138.2.236.17	Oracle Corporation	563	ip
US	167.234.210.174	Oracle Corporation	563	ip
US	104.225.154.171	Cluster Logic Inc	563	ip
US	154.21.197.32	NetLab	563	ip
CH	87.120.222.125	GLOBAL CONNECTIVITY SOLUTIONS LLP	564	ip
DE	92.5.85.78	Oracle Svenska AB	564	ip
FR	147.90.26.37	Seigohost LLC	564	ip
FR	147.90.26.15	Seigohost LLC	564	ip
US	47.77.210.148	Alibaba Cloud LLC	564	ip
US	150.230.35.200	Oracle Corporation	564	ip
CH	45.143.200.135	GLOBAL CONNECTIVITY SOLUTIONS LLP	565	ip
DE	92.5.0.222	Oracle Svenska AB	565	ip
DE	130.61.15.72	Oracle Public Cloud	565	ip
FR	147.90.26.50	Seigohost LLC	565	ip
FR	147.90.26.17	Seigohost LLC	565	ip
CH	84.234.17.132	Infomaniak Network SA	566	ip
CH	45.143.200.211	GLOBAL CONNECTIVITY SOLUTIONS LLP	566	ip
FR	147.90.26.82	Seigohost LLC	566	ip
FR	147.90.26.84	Seigohost LLC	566	ip
FR	45.155.54.115	Baykov Ilya Sergeevich	566	ip
KR	168.107.14.233	Oracle Corporation	566	ip
US	91.149.239.206	BG-NETWORK	566	ip
US	38.60.91.95	KURUN CLOUD INC	566	ip
US	38.181.44.56	HONG KONG COMMUNICATIONS INTERNATIONAL CO.,LIMITED	566	ip
US	167.172.223.14	DigitalOcean, LLC	566	ip
DE	5.182.87.164	AEZA GROUP LLC	567	ip
DE	45.145.41.201	dataforest GmbH	567	ip
FR	147.90.26.57	Seigohost LLC	567	ip
FR	147.90.26.61	Seigohost LLC	567	ip
FR	147.90.26.62	Seigohost LLC	567	ip
FR	147.90.26.91	Seigohost LLC	567	ip
US	137.131.9.209	Oracle Corporation	567	ip
US	161.153.21.107	Oracle Corporation	567	ip
US	129.146.49.224	Oracle Corporation	567	ip
DE	130.61.129.162	Oracle Public Cloud	568	ip
ES	45.86.229.28	BlueVPS OU	568	ip
FR	147.90.26.44	Seigohost LLC	568	ip
FR	147.90.26.68	Seigohost LLC	568	ip
FR	147.90.26.35	Seigohost LLC	568	ip
FR	188.92.28.24	Baykov Ilya Sergeevich	568	ip
FR	94.183.187.190	CGI GLOBAL LIMITED	568	ip
CH	83.228.199.3	Infomaniak Network SA	569	ip
CH	45.148.102.235	GLOBAL CONNECTIVITY SOLUTIONS LLP	569	ip
DE	172.86.95.236	RouterHosting LLC	569	ip
DE	195.245.239.124	Snowd Security OU	569	ip
DE	92.5.10.103	Oracle Svenska AB	569	ip
FR	45.81.243.217	Neterra Ltd.	569	ip
FR	147.90.26.74	Seigohost LLC	569	ip
FR	194.76.147.168	BEAFORT LIMITED	569	ip
US	168.151.20.157	BAGE CLOUD LLC	569	ip
CH	83.228.193.177	Infomaniak Network SA	570	ip
DE	93.152.224.43	DEDIK SERVICES LIMITED	570	ip
DE	31.77.168.50	QWINS-Hosting	570	ip
DE	95.181.174.121	AEZA GROUP LLC	570	ip
DE	130.61.208.80	Oracle Corporation	570	ip
FR	147.90.26.45	Seigohost LLC	570	ip
FR	147.90.26.87	Seigohost LLC	570	ip
US	192.18.136.255	Oracle Corporation	570	ip
US	45.202.243.88	Akile LTD	570	ip
US	147.182.229.237	DigitalOcean, LLC	570	ip
CH	82.38.64.162	HOSTKEY B.V.	571	ip
DE	89.168.95.195	Oracle Svenska AB	571	ip
DE	85.234.100.221	GLOBAL CONNECTIVITY SOLUTIONS LLP	571	ip
DE	5.180.82.38	freakhosting.com	571	ip
US	163.192.22.57	Oracle Corporation	571	ip
CH	152.67.64.55	Oracle Public Cloud	572	ip
FR	147.90.26.10	Seigohost LLC	572	ip
FR	147.90.26.88	Seigohost LLC	572	ip
FR	147.90.26.30	Seigohost LLC	572	ip
FR	147.90.26.60	Seigohost LLC	572	ip
FR	147.90.26.6	Seigohost LLC	572	ip
FR	94.183.186.228	CGI GLOBAL LIMITED	572	ip
US	144.24.30.113	Oracle Corp UK Ltd	572	ip
US	150.230.41.59	Oracle Corporation	572	ip
DE	193.23.197.40	Senko Digital LLC - DE Network	573	ip
DE	82.25.39.178	HOSTKEY B.V.	573	ip
DE	138.3.254.178	Oracle Network Information Services	573	ip
DE	104.207.130.92	Vultr Holdings, LLC	573	ip
FR	104.253.79.6	Subnet Digital LLC	573	ip
FR	217.60.5.249	CGI GLOBAL LIMITED	573	ip
US	34.212.240.129	Amazon Technologies Inc.	573	ip
CH	84.234.16.169	Infomaniak Network SA	574	ip
DE	91.132.160.255	Senko Digital LLC - DE Network	574	ip
DE	178.17.48.96	WAIcore Ltd	574	ip
DE	89.168.110.240	Oracle Svenska AB	574	ip
FR	147.90.26.12	Seigohost LLC	574	ip
FR	46.8.225.124	CGI GLOBAL LIMITED	574	ip
US	107.172.241.7	HostPapa	574	ip
CH	185.218.204.205	HOSTKEY B.V.	575	ip
CH	140.238.214.95	Oracle Corporation	575	ip
CH	152.67.85.239	Oracle Public Cloud	575	ip
DE	45.155.102.207	Unknown ISP	575	ip
DE	158.101.190.78	Oracle Corporation	575	ip
DE	45.43.88.232	FIRST SERVER LIMITED	575	ip
DE	103.31.76.16	Baxet Group Inc.	575	ip
DE	93.152.217.100	GLOBAL CONNECTIVITY SOLUTIONS LLP	575	ip
GB	57.128.176.87	OVH Ltd	575	ip
DE	185.59.251.86	adesso as a service GmbH	576	ip
DE	178.17.48.170	WAIcore Ltd	576	ip
DE	92.5.12.76	Oracle Svenska AB	576	ip
DE	92.246.136.38	AEZA GROUP LLC	576	ip
FR	217.60.37.34	CGI GLOBAL LIMITED	576	ip
FR	51.38.44.17	OVH SAS	576	ip
NL	80.74.30.45	CLODO CLOUD SERVICE CO. L.L.C	576	ip
NL	77.246.102.6	Amsterdam, Netherlands	576	ip
US	132.226.156.134	Oracle Corporation	576	ip
NL	144.124.241.129	Amsterdam, Netherlands	577	ip
NL	62.84.97.123	Amsterdam, Netherlands	577	ip
SG	38.244.150.113	3NT SOLUTIONS LLP	577	ip
AU	158.180.5.171	oracle	578	ip
DE	212.43.158.216	Podaon SIA	578	ip
DE	92.246.139.226	AEZA GROUP LLC	578	ip
DE	194.87.227.155	Baxet Group Inc.	578	ip
DE	191.96.94.226	freakhosting.com	578	ip
US	154.9.227.100	NetLab	578	ip
US	198.46.146.10	Danny Dahl	578	ip
DE	212.189.119.46	freakhosting.com	579	ip
FR	147.90.26.52	Seigohost LLC	579	ip
GB	57.128.177.22	OVH Ltd	579	ip
NL	213.21.248.53	Baykov Ilya Sergeevich	579	ip
US	129.153.98.190	Oracle Corporation	579	ip
US	165.232.51.34	DigitalOcean, LLC	579	ip
AU	207.148.80.190	The Constant Company, LLC	580	ip
CH	83.228.193.229	Infomaniak Network SA	580	ip
DE	79.132.136.161	Fornex Hosting S.L.	580	ip
DE	92.118.8.206	FIRST SERVER, SOCIEDAD LIMITADA	580	ip
DE	194.247.187.244	HOSTKEY B.V.	580	ip
DE	144.31.78.217	Amsterdam, Netherlands	580	ip
DE	3.68.62.122	A100 ROW GmbH	580	ip
FR	147.90.26.77	Seigohost LLC	580	ip
GB	57.128.178.122	OVH Ltd	580	ip
GB	57.128.183.3	OVH Ltd	580	ip
NL	109.73.204.202	Timeweb, LLP	580	ip
NL	72.56.21.244	Timeweb, LLP	580	ip
US	152.70.150.202	Oracle Corporation	580	ip
DE	185.68.184.15	Baykov Ilya Sergeevich	581	ip
DE	104.248.140.196	DigitalOcean, LLC	581	ip
FR	147.90.26.54	Seigohost LLC	581	ip
NL	147.45.170.176	Timeweb, LLP	581	ip
NL	88.218.120.170	CLODO CLOUD SERVICE CO. L.L.C	581	ip
NL	178.253.23.53	TimeWeb	581	ip
CH	213.176.18.232	GLOBAL CONNECTIVITY SOLUTIONS LLP	582	ip
CH	87.120.222.188	GLOBAL CONNECTIVITY SOLUTIONS LLP	582	ip
DE	151.247.209.11	HOSTKEY B.V.	582	ip
DE	62.133.60.155	GLOBAL CONNECTIVITY SOLUTIONS LLP	582	ip
FR	147.90.26.28	Seigohost LLC	582	ip
FR	217.60.252.25	CloudBackbone	582	ip
NL	94.176.3.215	Izitell Cloud - FZCO	582	ip
NL	146.103.122.49	Amsterdam, Netherlands	582	ip
NL	212.118.39.237	Amsterdam, Netherlands	582	ip
US	192.3.212.40	HostPapa	582	ip
US	137.184.122.138	DigitalOcean, LLC	582	ip
AU	161.33.237.158	Oracle Corporation	583	ip
CH	87.120.222.172	GLOBAL CONNECTIVITY SOLUTIONS LLP	583	ip
DE	45.43.88.219	FIRST SERVER LIMITED	583	ip
DE	165.245.217.16	DigitalOcean, LLC	583	ip
DE	113.30.190.30	Kamatera Inc	583	ip
FR	147.90.26.4	Seigohost LLC	583	ip
FR	185.234.100.41	Jogcorp SAS	583	ip
FR	38.180.240.91	3NT SOLUTIONS LLP	583	ip
GB	87.84.155.97	Private Customer	583	ip
NL	46.17.101.133	HOSTKEY B.V.	583	ip
CH	171.22.16.237	GLOBAL CONNECTIVITY SOLUTIONS LLP	584	ip
DE	89.107.10.194	Cloud Hosting Solutions, Limited.	584	ip
DE	31.172.70.20	Fornex Hosting S.L.	584	ip
DE	31.77.126.2	GTHost	584	ip
DE	85.121.53.39	Urban Network Solutions SRL	584	ip
GB	91.149.202.142	BG-NETWORK	584	ip
IT	5.249.148.85	Aruba S.p.A. - Cloud Services Farm2	584	ip
KR	146.56.110.165	Oracle Corporation , Global software solutions , California , USA	584	ip
NL	46.17.102.250	HOSTKEY B.V.	584	ip
NL	94.176.3.162	Izitell Cloud - FZCO	584	ip
NL	103.90.72.71	CLODO CLOUD SERVICE CO. L.L.C	584	ip
NL	72.56.18.20	Timeweb, LLP	584	ip
NL	194.87.83.44	Timeweb, LLP	584	ip
NL	212.34.133.61	Amsterdam, Netherlands	584	ip
NL	5.35.32.238	Amsterdam, Netherlands	584	ip
NL	144.124.226.215	Amsterdam, Netherlands	584	ip
NL	46.151.31.54	Amsterdam, Netherlands	584	ip
US	20.120.129.200	Microsoft Corporation	584	ip
CH	87.120.222.207	GLOBAL CONNECTIVITY SOLUTIONS LLP	585	ip
DE	193.124.92.58	GLB Bulut Teknolojisi Limited Sirketi	585	ip
DE	77.239.104.60	u1host ltd	585	ip
DE	213.21.241.85	u1host ltd	585	ip
DE	87.251.86.238	nuxtcloud	585	ip
DE	80.253.251.30	GLOBAL CONNECTIVITY SOLUTIONS LLP	585	ip
DE	57.129.62.51	OVH GmbH	585	ip
FR	147.90.26.25	Seigohost LLC	585	ip
GB	78.129.165.129	Iomart Group Plc	585	ip
GB	57.128.183.35	OVH Ltd	585	ip
NL	89.125.98.9	Baxet Group Inc.	585	ip
NL	91.132.57.151	CLODO CLOUD SERVICE CO. L.L.C	585	ip
NL	195.133.15.131	Timeweb, LLP	585	ip
NL	5.35.34.146	Amsterdam, Netherlands	585	ip
NL	89.110.71.35	Amsterdam, Netherlands	585	ip
NL	83.217.222.170	Timeweb, LLP	585	ip
NL	103.45.247.67	O.M.C. COMPUTERS & COMMUNICATIONS LTD	585	ip
CH	87.120.222.26	GLOBAL CONNECTIVITY SOLUTIONS LLP	586	ip
DE	79.132.140.36	Fornex Hosting S.L.	586	ip
DE	45.138.72.141	GTELCOM LLC	586	ip
DE	93.95.24.10	GTHost	586	ip
DE	103.56.84.189	Baxet Group Inc.	586	ip
ES	91.149.243.34	Baxet Group Inc.	586	ip
FR	147.90.26.49	Seigohost LLC	586	ip
FR	147.90.26.58	Seigohost LLC	586	ip
FR	147.90.26.27	Seigohost LLC	586	ip
FR	149.33.1.252	3NT SOLUTIONS LLP	586	ip
GB	57.128.178.63	OVH Ltd	586	ip
NL	188.227.84.40	ITGLOBAL.COM NL B.V.	586	ip
NL	45.114.61.233	CLODO CLOUD SERVICE CO. L.L.C	586	ip
NL	89.150.35.80	CLODO CLOUD SERVICE CO. L.L.C	586	ip
NL	147.90.229.175	GTHost	586	ip
NL	144.124.235.197	Amsterdam, Netherlands	586	ip
NL	89.110.68.158	Amsterdam, Netherlands	586	ip
NL	89.110.66.154	Amsterdam, Netherlands	586	ip
NL	195.200.28.174	SERVERS TECH FZCO	586	ip
NL	72.56.68.247	Timeweb, LLP	586	ip
US	50.118.184.82	EASY LINK LLC	586	ip
US	165.227.3.141	DigitalOcean, LLC	586	ip
CH	171.22.16.201	GLOBAL CONNECTIVITY SOLUTIONS LLP	587	ip
DE	3.127.55.133	A100 ROW GmbH	587	ip
DE	94.177.231.152	Cloud Services DC05	587	ip
FR	147.90.26.47	Seigohost LLC	587	ip
FR	147.90.26.64	Seigohost LLC	587	ip
FR	82.22.50.218	HOSTKEY B.V.	587	ip
GB	57.128.181.221	OVH Ltd	587	ip
NL	95.81.98.147	JSC IOT	587	ip
NL	45.14.49.124	ITGLOBAL.COM NL B.V.	587	ip
NL	195.63.133.177	SERVERS TECH FZCO	587	ip
NL	146.0.73.202	HOSTKEY B.V.	587	ip
NL	147.45.228.4	Timeweb, LLP	587	ip
NL	45.114.62.148	CLODO CLOUD SERVICE CO. L.L.C	587	ip
NL	89.150.59.208	CLODO CLOUD SERVICE CO. L.L.C	587	ip
NL	89.150.35.60	CLODO CLOUD SERVICE CO. L.L.C	587	ip
NL	146.103.96.54	Amsterdam, Netherlands	587	ip
NL	5.180.181.166	O.M.C. COMPUTERS & COMMUNICATIONS LTD	587	ip
NL	89.110.117.7	Amsterdam, Netherlands	587	ip
US	107.172.187.94	RackNerd LLC	587	ip
US	154.41.80.59	Cogent Communications, LLC	587	ip
AE	193.123.88.122	Oracle Corporation	588	ip
DE	150.241.123.99	Frankfurt, Germany	588	ip
DE	194.180.188.241	HOSTKEY B.V.	588	ip
DE	82.152.94.2	GTHost	588	ip
DE	150.241.108.48	u1host ltd	588	ip
DE	136.244.94.142	Vultr Holdings, LLC	588	ip
FR	147.90.26.76	Seigohost LLC	588	ip
FR	147.90.26.71	Seigohost LLC	588	ip
GB	91.149.238.88	Baxet Group Inc.	588	ip
GB	91.149.238.31	BG-NETWORK	588	ip
NL	143.14.1.8	GTHost	588	ip
NL	109.120.158.149	VPS1 network in Dronten, NL	588	ip
NL	89.46.131.91	CLODO CLOUD SERVICE CO. L.L.C	588	ip
NL	195.133.66.132	Timeweb, LLP	588	ip
NL	62.84.98.103	Amsterdam, Netherlands	588	ip
US	143.198.158.87	DigitalOcean, LLC	588	ip
DE	31.58.138.2	GTHost	589	ip
DE	91.228.154.216	www.fornex.com, Fornex Hosting S.L.	589	ip
DE	80.240.20.43	Hanauer Landstraße 302	589	ip
DE	91.149.223.242	Baxet Group Inc.	589	ip
FR	185.10.18.88	VIRTUASYS PARIS (PAR01FR)	589	ip
FR	147.90.26.29	Seigohost LLC	589	ip
FR	147.90.26.66	Seigohost LLC	589	ip
FR	147.90.26.43	Seigohost LLC	589	ip
FR	51.91.40.26	OVH Hispano	589	ip
NL	23.168.72.143	Private Customer	589	ip
NL	82.153.49.2	Private Customer	589	ip
NL	23.168.72.118	Private Customer	589	ip
NL	103.90.75.121	CLODO CLOUD SERVICE CO. L.L.C	589	ip
NL	176.124.201.7	Timeweb, LLP	589	ip
NL	185.130.224.202	HOSTKEY B.V.	589	ip
NL	89.124.99.79	SERVERS TECH FZCO	589	ip
NL	72.56.96.230	Timeweb, LLP	589	ip
NL	212.118.43.137	Amsterdam, Netherlands	589	ip
NL	89.110.117.133	Amsterdam, Netherlands	589	ip
DE	92.42.96.183	Ystel D.O.O. Tivat	590	ip
DE	82.21.117.56	HOSTKEY B.V.	590	ip
DE	93.95.24.149	GTHost	590	ip
DE	77.239.105.110	u1host ltd	590	ip
DE	185.189.58.222	MassiveGRID	590	ip
FR	147.90.26.33	Seigohost LLC	590	ip
GB	88.150.230.52	Iomart Managed Services Limited	590	ip
GB	57.128.179.189	OVH Ltd	590	ip
GB	57.128.182.21	OVH Ltd	590	ip
GB	57.128.183.82	OVH Ltd	590	ip
GB	57.128.183.248	OVH Ltd	590	ip
NL	23.168.72.90	GTHost	590	ip
NL	146.0.73.251	HOSTKEY B.V.	590	ip
NL	147.90.229.140	GTHost	590	ip
NL	89.110.123.23	Amsterdam, Netherlands	590	ip
NL	5.35.46.168	Amsterdam, Netherlands	590	ip
NL	31.59.129.67	Chunkserve Mateusz Peplinski	590	ip
NL	46.17.102.93	HOSTKEY B.V.	590	ip
AU	152.67.99.162	Oracle Public Cloud	591	ip
CH	91.90.193.24	Friendhosting LTD	591	ip
DE	82.21.117.137	HOSTKEY B.V.	591	ip
DE	185.233.81.207	FIRST SERVER LIMITED	591	ip
DE	92.42.99.21	Friendhosting LTD	591	ip
DE	222.167.252.174	HOSTKEY B.V.	591	ip
DE	130.61.38.70	Oracle Public Cloud	591	ip
DE	130.61.48.18	Oracle Public Cloud	591	ip
DE	84.32.223.113	Private Customer	591	ip
DE	194.58.33.218	nuxtcloud	591	ip
FR	147.90.26.40	Seigohost LLC	591	ip
FR	147.90.26.16	Seigohost LLC	591	ip
FR	147.90.26.85	Seigohost LLC	591	ip
FR	147.90.26.38	Seigohost LLC	591	ip
FR	45.77.61.133	Vultr Holdings, LLC	591	ip
GB	138.249.138.5	Costel Savulescu	591	ip
NL	62.171.228.242	Virterion LLC	591	ip
NL	23.168.72.194	Private Customer	591	ip
NL	185.204.52.78	Virterion LLC	591	ip
NL	46.17.99.222	HOSTKEY B.V.	591	ip
NL	147.90.229.173	GTHost	591	ip
NL	147.90.229.216	GTHost	591	ip
NL	212.118.43.163	Amsterdam, Netherlands	591	ip
NL	94.103.95.115	Amsterdam, Netherlands	591	ip
NL	146.103.114.180	Amsterdam, Netherlands	591	ip
NL	212.34.144.235	Amsterdam, Netherlands	591	ip
NL	195.133.81.231	Timeweb, LLP	591	ip
NL	93.183.91.207	SERVERS TECH FZCO	591	ip
CH	45.143.200.102	GLOBAL CONNECTIVITY SOLUTIONS LLP	592	ip
DE	95.85.230.15	WAIcore Ltd	592	ip
DE	94.141.123.243	WAIcore Ltd	592	ip
DE	185.242.113.75	IP-Projects GmbH & Co. KG	592	ip
DE	38.180.175.206	3NT SOLUTIONS LLP	592	ip
DE	138.2.158.232	Oracle Corporation	592	ip
DE	77.239.104.216	u1host ltd	592	ip
DE	45.95.0.43	nuxtcloud	592	ip
DE	195.133.193.94	Baxet Group Inc.	592	ip
DE	85.208.139.77	GLOBAL CONNECTIVITY SOLUTIONS LLP	592	ip
FR	129.151.245.96	Oracle Corporation	592	ip
GB	185.66.164.51	Perfecto Mobile UK LTD	592	ip
NL	23.168.72.165	GTHost	592	ip
NL	151.242.120.4	Private Customer	592	ip
NL	77.238.236.239	SERVERS TECH FZCO	592	ip
NL	80.74.31.211	CLODO CLOUD SERVICE CO. L.L.C	592	ip
NL	147.90.229.191	GTHost	592	ip
NL	82.22.146.226	HOSTKEY B.V.	592	ip
NL	72.56.99.67	Timeweb, LLP	592	ip
NL	94.156.177.78	Baykov Ilya Sergeevich	592	ip
NL	195.133.75.219	Baykov Ilya Sergeevich	592	ip
US	129.153.208.246	Oracle Corporation	592	ip
US	165.227.11.101	DigitalOcean, LLC	592	ip
DE	193.233.86.136	Cloud Hosting Solutions, Limited.	593	ip
FR	147.90.26.42	Seigohost LLC	593	ip
FR	31.56.176.44	CGI GLOBAL LIMITED	593	ip
FR	54.37.39.40	OVH SAS	593	ip
FR	51.91.16.135	OVH SAS	593	ip
NL	23.168.72.250	Private Customer	593	ip
NL	45.91.236.80	Timeweb.Cloud LLC	593	ip
NL	147.90.229.150	GTHost	593	ip
NL	89.110.73.231	Amsterdam, Netherlands	593	ip
NL	193.168.199.94	Baykov Ilya Sergeevich	593	ip
NL	45.151.233.249	Baykov Ilya Sergeevich	593	ip
NL	2.26.138.203	NKtelecom INC	593	ip
US	38.77.187.51	Wyyerd Group	593	ip
US	84.32.44.80	Hosteons Pte. Ltd.	593	ip
US	137.184.228.85	DigitalOcean, LLC	593	ip
DE	77.239.122.27	Amsterdam, Netherlands	594	ip
DE	91.219.23.154	GLOBAL CONNECTIVITY SOLUTIONS LLP	594	ip
DE	18.184.55.249	A100 ROW GmbH	594	ip
DE	83.219.249.208	Baykov Ilya Sergeevich	594	ip
DE	77.239.99.29	nuxtcloud	594	ip
NL	62.171.228.60	Virterion LLC	594	ip
NL	2.56.90.233	IHC network in Amsterdam, NL (Iron Hosting Centre Ltd., London, UK)	594	ip
NL	45.133.117.190	Hizakura B.V.	594	ip
NL	194.246.82.213	Amsterdam, Netherlands	594	ip
NL	108.61.164.231	JW Lucasweg 35	594	ip
NL	166.1.22.116	InterLIR LLC	594	ip
US	161.153.52.204	Oracle Corporation	594	ip
US	154.41.80.90	Cogent Communications, LLC	594	ip
CH	152.67.79.135	Oracle Public Cloud	595	ip
DE	95.181.174.88	AEZA GROUP LLC	595	ip
DE	150.241.105.10	u1host ltd	595	ip
DE	31.77.223.15	nuxtcloud	595	ip
FR	147.90.26.22	Seigohost LLC	595	ip
FR	147.90.26.36	Seigohost LLC	595	ip
FR	147.90.26.20	Seigohost LLC	595	ip
FR	147.90.26.53	Seigohost LLC	595	ip
GB	57.128.183.133	OVH Ltd	595	ip
NL	77.238.248.43	SERVERS TECH FZCO	595	ip
NL	147.90.229.229	GTHost	595	ip
NL	144.124.245.51	Amsterdam, Netherlands	595	ip
NL	146.103.114.134	Amsterdam, Netherlands	595	ip
NL	212.22.74.89	Baykov Ilya Sergeevich	595	ip
NL	85.192.42.157	AEZA GROUP LLC	595	ip
NL	5.253.189.62	NKtelecom INC	595	ip
NL	146.0.79.33	HOSTKEY B.V.	595	ip
CH	140.238.208.210	Oracle Public Cloud	596	ip
DE	37.1.198.23	IROKO Networks Corporation	596	ip
DE	185.125.102.120	AEZA GROUP LLC	596	ip
FR	109.61.110.151	365.partners INC	596	ip
FR	104.238.191.179	Vultr Holdings, LLC	596	ip
GB	95.163.153.198	AEZA GROUP LLC	596	ip
NL	85.136.112.166	Virterion LLC	596	ip
NL	151.246.240.4	Private Customer	596	ip
NL	147.90.229.221	GTHost	596	ip
NL	89.34.18.95	Liquid Web B.V.	596	ip
NL	138.124.3.109	Baykov Ilya Sergeevich	596	ip
NL	186.190.213.211	GTHost	596	ip
DE	84.200.77.75	UltaHost Inc	597	ip
DE	91.149.233.78	Baxet Group Inc.	597	ip
GB	132.145.29.208	Oracle Public Cloud	597	ip
NL	193.109.69.214	HOSTKEY B.V.	597	ip
NL	80.71.232.52	Private Customer	597	ip
NL	5.34.180.230	VDS and Dedicated subnet	597	ip
NL	95.181.162.221	AEZA GROUP LLC	597	ip
NL	77.247.178.238	Serverhosting	597	ip
CH	140.238.209.8	Oracle Public Cloud	598	ip
DE	38.180.219.131	3NT SOLUTIONS LLP	598	ip
DE	78.17.74.129	RCS Technologies FZE LLC	598	ip
DE	31.57.13.65	SEBEK sp. z o.o	598	ip
FR	2.7.113.69	POP GRE	598	ip
FR	193.42.62.63	Mo's Operations GmbH	598	ip
FR	194.76.146.25	BEAFORT LIMITED	598	ip
GB	194.146.24.240	O.M.C. COMPUTERS & COMMUNICATIONS LTD	598	ip
NL	147.90.218.2	GTHost	598	ip
NL	143.14.1.4	Private Customer	598	ip
NL	62.60.247.217	AEZA GROUP LLC	598	ip
NL	185.45.113.201	Bradler & Krantz GmbH & Co KG	598	ip
NL	202.148.52.47	HOSTKEY B.V.	598	ip
NL	147.90.229.117	GTHost	598	ip
NL	62.171.228.38	Virterion LLC	598	ip
NL	89.110.117.113	SERVERS TECH FZCO	598	ip
NL	186.190.213.6	Private Customer	598	ip
NL	45.150.33.1	AEZA GROUP LLC	598	ip
US	107.174.154.23	HostPapa	598	ip
US	107.174.40.115	HostPapa	598	ip
DE	178.17.48.78	WAIcore Ltd	599	ip
DE	89.125.68.56	Snowd Security OU	599	ip
DE	143.20.160.37	Private Customer	599	ip
FR	147.90.26.65	Seigohost LLC	599	ip
FR	147.90.26.19	Seigohost LLC	599	ip
GB	78.129.253.115	Iomart Managed Services Limited	599	ip
JP	138.2.59.112	Oracle Corporation	599	ip
NL	195.63.129.196	SERVERS TECH FZCO	599	ip
NL	151.242.120.8	GTHost	599	ip
NL	23.168.72.139	GTHost	599	ip
NL	185.103.255.245	FIRST SERVER, SOCIEDAD LIMITADA	599	ip
NL	45.12.69.152	Iron Hosting Centre Ltd., London, UK (rw)	599	ip
NL	85.136.181.194	Virterion LLC	599	ip
NL	147.90.229.94	GTHost	599	ip
NL	147.90.229.56	GTHost	599	ip
NL	195.26.224.135	Amsterdam, Netherlands	599	ip
NL	86.107.197.239	MVPS LTD	599	ip
US	199.241.32.102	BAGE CLOUD LLC	599	ip
US	192.236.234.71	Hostwinds Seattle	599	ip
US	198.52.244.111	Kamatera, Inc.	599	ip
CH	185.237.225.95	Friendhosting LTD	600	ip
DE	164.92.243.195	DigitalOcean, LLC	600	ip
GB	57.128.181.125	OVH Ltd	600	ip
GB	57.128.177.172	OVH Ltd	600	ip
GB	57.128.176.90	OVH Ltd	600	ip
NL	89.124.104.185	SERVERS TECH FZCO	600	ip
NL	185.94.165.207	FIRST SERVER, SOCIEDAD LIMITADA	600	ip
NL	109.69.57.181	FIRST SERVER, SOCIEDAD LIMITADA	600	ip
NL	80.74.30.241	CLODO CLOUD SERVICE CO. L.L.C	600	ip
NL	85.192.60.129	AEZA GROUP LLC	600	ip
NL	62.197.48.250	IROKO Networks Corporation	600	ip
NL	206.189.107.74	DigitalOcean, LLC	600	ip
NL	5.180.182.128	O.M.C. COMPUTERS & COMMUNICATIONS LTD	600	ip
BG	185.232.170.111	FIRST SERVER, SOCIEDAD LIMITADA	601	ip
DE	156.226.174.20	Akile LTD	601	ip
FR	80.71.229.235	FASTWARP LLP	601	ip
FR	94.183.186.121	CGI GLOBAL LIMITED	601	ip
NL	185.225.202.227	GLOBALTECH LLC	601	ip
NL	151.246.240.100	GTHost	601	ip
NL	45.133.118.153	Hizakura B.V.	601	ip
NL	147.90.229.211	GTHost	601	ip
NL	5.129.239.6	TimeWeb Ltd.	601	ip
NL	45.150.33.143	AEZA GROUP LLC	601	ip
NL	93.88.205.184	NKtelecom INC	601	ip
NL	186.190.213.37	GTHost	601	ip
NL	67.220.80.230	GTHost	601	ip
NL	178.62.242.239	DigitalOcean Amsterdam	601	ip
US	156.154.245.84	Arbor Cloud	601	ip
US	146.190.148.120	DigitalOcean, LLC	601	ip
DE	38.180.166.140	3NT SOLUTIONS LLP	602	ip
DE	145.223.100.111	Hostinger International Limited	602	ip
DE	130.61.56.135	Oracle Public Cloud	602	ip
DE	83.219.249.189	Baykov Ilya Sergeevich	602	ip
DE	46.101.148.54	DigitalOcean, LLC	602	ip
FR	193.42.60.235	Mo's Operations GmbH	602	ip
FR	172.233.249.145	Linode	602	ip
NL	185.203.243.56	Podaon SIA	602	ip
NL	188.253.26.230	SIA VEESP	602	ip
NL	147.90.229.203	GTHost	602	ip
NL	147.90.229.185	GTHost	602	ip
NL	5.129.226.114	TimeWeb Ltd.	602	ip
NL	82.25.60.219	HOSTKEY B.V.	602	ip
NL	79.137.197.212	AEZA GROUP LLC	602	ip
NL	176.126.85.109	HostHatch LLC	602	ip
NL	5.253.189.215	NKtelecom INC	602	ip
NL	67.220.80.253	GTHost	602	ip
CH	45.143.200.180	GLOBAL CONNECTIVITY SOLUTIONS LLP	603	ip
DE	156.226.175.115	Akile LTD	603	ip
DE	68.183.213.79	DigitalOcean, LLC	603	ip
DE	143.20.160.143	Private Customer	603	ip
FR	147.90.26.86	Seigohost LLC	603	ip
GB	45.150.66.75	GLOBAL CONNECTIVITY SOLUTIONS LLP	603	ip
NL	188.227.107.171	ITGLOBAL.COM NL B.V.	603	ip
NL	147.90.229.237	GTHost	603	ip
NL	5.129.216.14	JSC TIMEWEB	603	ip
NL	86.107.197.161	MVPS LTD	603	ip
NL	146.190.236.144	DigitalOcean, LLC	603	ip
NL	185.167.96.18	Kamatera Inc	603	ip
US	141.148.145.112	Oracle Corporation	603	ip
US	23.94.123.231	RackNerd LLC	603	ip
CH	45.143.200.141	GLOBAL CONNECTIVITY SOLUTIONS LLP	604	ip
DE	144.31.218.65	SERV.HOST GROUP LTD	604	ip
DE	5.61.46.9	IROKO Networks Corporation	604	ip
FR	147.90.26.59	Seigohost LLC	604	ip
FR	20.33.23.66	Microsoft Corporation	604	ip
FR	147.90.26.41	Seigohost LLC	604	ip
GB	31.97.58.104	Hostinger International Limited	604	ip
GB	84.8.145.58	Oracle Svenska AB	604	ip
GB	57.128.179.254	OVH Ltd	604	ip
NL	89.35.131.5	RCS Technologies FZE LLC	604	ip
NL	146.0.79.124	HOSTKEY B.V.	604	ip
NL	89.124.77.146	SERVERS TECH FZCO	604	ip
NL	147.90.229.189	GTHost	604	ip
NL	147.90.229.194	GTHost	604	ip
NL	152.42.128.92	DigitalOcean, LLC	604	ip
CH	83.228.193.188	Infomaniak Network SA	605	ip
DE	192.124.182.154	ALEKSEI FEDOROV PR KRUSEVAC	605	ip
DE	103.228.168.182	Fornex Hosting S.L.	605	ip
DE	185.255.179.157	Baykov Ilya Sergeevich	605	ip
DE	213.21.241.211	u1host ltd	605	ip
DE	85.121.124.8	Urban Network Solutions SRL	605	ip
DE	89.40.117.143	Cloud Services DC05	605	ip
DE	167.71.45.93	DigitalOcean, LLC	605	ip
GB	132.145.46.142	Oracle Public Cloud	605	ip
NL	45.151.106.65	MHost LLC	605	ip
NL	194.58.47.105	RCS Technologies FZE LLC	605	ip
NL	62.60.245.67	AEZA GROUP LLC	605	ip
NL	62.60.244.168	AEZA GROUP LLC	605	ip
NL	103.137.250.68	CLODO CLOUD SERVICE CO. L.L.C	605	ip
NL	176.222.52.246	HOSTKEY B.V.	605	ip
NL	147.90.229.165	GTHost	605	ip
NL	147.90.229.244	GTHost	605	ip
NL	147.90.229.34	GTHost	605	ip
NL	77.246.104.142	Amsterdam, Netherlands	605	ip
NL	217.144.189.5	AEZA GROUP LLC	605	ip
NL	5.2.77.93	The Infrastructure Group B.V.	605	ip
NL	45.153.186.22	MVPS LTD	605	ip
NL	209.38.38.145	DigitalOcean, LLC	605	ip
US	132.226.67.208	Oracle Public Cloud	605	ip
US	67.209.183.236	Hurricane Electric LLC	605	ip
DE	206.251.50.222	Cloud Source, Inc.	606	ip
DE	195.54.33.164	TK Rustelekom LLC	606	ip
DE	167.17.176.36	Snowd Security OU	606	ip
DE	45.43.89.236	FIRST SERVER LIMITED	606	ip
FR	193.42.60.24	Mo's Operations GmbH	606	ip
NL	145.249.115.239	GLOBAL CONNECTIVITY SOLUTIONS LLP	606	ip
NL	194.0.194.38	SkyCore Technologies L.L.C-FZ	606	ip
NL	188.253.26.128	SIA VEESP	606	ip
NL	212.80.218.89	SkyCore Technologies L.L.C-FZ	606	ip
NL	45.114.62.226	CLODO CLOUD SERVICE CO. L.L.C	606	ip
NL	188.241.196.180	CLODO CLOUD SERVICE CO. L.L.C	606	ip
NL	134.98.146.122	Oracle Svenska AB	606	ip
NL	72.56.73.35	Timeweb, LLP	606	ip
NL	95.215.8.28	Baykov Ilya Sergeevich	606	ip
NL	93.113.171.31	Baxet Group Inc.	606	ip
NL	85.192.60.46	AEZA GROUP LLC	606	ip
CH	83.228.193.162	Infomaniak Network SA	607	ip
DE	194.28.225.2	nuxtcloud	607	ip
DE	140.82.34.21	Vultr Holdings, LLC	607	ip
DE	162.19.247.245	OVH GmbH	607	ip
DE	87.106.38.212	IONOS SE	607	ip
FR	94.183.186.27	CGI GLOBAL LIMITED	607	ip
GB	35.176.75.87	Amazon Data Services UK	607	ip
GB	57.128.176.37	OVH Ltd	607	ip
GB	57.128.182.27	OVH Ltd	607	ip
NL	103.137.248.227	CLODO CLOUD SERVICE CO. L.L.C	607	ip
NL	5.181.134.24	Etheron Hosting	607	ip
NL	77.238.234.82	SERVERS TECH FZCO	607	ip
NL	31.57.44.213	HOSTKEY B.V.	607	ip
NL	77.110.118.177	AEZA GROUP LLC	607	ip
NL	5.255.116.214	The Infrastructure Group B.V.	607	ip
NL	209.38.101.169	DigitalOcean, LLC	607	ip
DE	77.239.104.229	u1host ltd	608	ip
FR	147.90.26.73	Seigohost LLC	608	ip
FR	147.90.26.72	Seigohost LLC	608	ip
FR	185.10.18.238	VIRTUASYS PARIS (PAR01FR)	608	ip
GB	57.128.178.36	OVH Ltd	608	ip
GB	57.128.183.59	OVH Ltd	608	ip
GB	57.128.179.45	OVH Ltd	608	ip
GB	57.128.183.214	OVH Ltd	608	ip
NL	23.168.72.69	GTHost	608	ip
NL	45.114.61.149	CLODO CLOUD SERVICE CO. L.L.C	608	ip
NL	45.12.255.177	Snowd Security OU	608	ip
NL	195.96.129.16	Xantho UAB	608	ip
NL	194.87.208.118	Timeweb, LLP	608	ip
NL	138.124.3.59	Baykov Ilya Sergeevich	608	ip
NL	195.133.38.54	Reliable Communications s.r.o.	608	ip
NL	193.233.127.143	GLOBAL CONNECTIVITY SOLUTIONS LLP	608	ip
US	156.154.245.83	Arbor Cloud	608	ip
AU	152.67.126.254	Oracle Corporation	609	ip
FR	185.234.100.40	Jogcorp SAS	609	ip
FR	185.10.19.205	VIRTUASYS PARIS (PAR01FR)	609	ip
GB	103.13.208.242	O.M.C. COMPUTERS & COMMUNICATIONS LTD	609	ip
GB	57.128.176.82	OVH Ltd	609	ip
NL	89.125.17.216	RCS Technologies FZE LLC	609	ip
NL	89.124.83.8	SERVERS TECH FZCO	609	ip
NL	46.30.47.125	Eurobyte VPS (Iron Hosting Centre Ltd., London, UK)	609	ip
NL	80.74.25.110	CLODO CLOUD SERVICE CO. L.L.C	609	ip
NL	89.125.85.228	Snowd Security OU	609	ip
NL	194.87.35.130	Baykov Ilya Sergeevich	609	ip
US	49.51.34.124	Tencent cloud computing (Beijing) Co., Ltd.	609	ip
US	156.154.208.11	Arbor Cloud	609	ip
US	129.146.242.209	Oracle Corporation	609	ip
US	165.232.136.226	DigitalOcean, LLC	609	ip
DE	154.91.170.4	BitCommand LLC	610	ip
DE	87.251.87.213	nuxtcloud	610	ip
DE	194.37.80.244	O.M.C. COMPUTERS & COMMUNICATIONS LTD	610	ip
NL	138.124.3.235	Baykov Ilya Sergeevich	610	ip
NL	95.85.228.11	1Cent Host	610	ip
NL	31.59.47.71	CGI GLOBAL LIMITED	610	ip
US	137.184.39.15	DigitalOcean, LLC	610	ip
CH	45.85.93.49	Internet Utilities Europe and Asia Limited	611	ip
DE	151.244.201.2	GTHost	611	ip
DE	185.202.113.166	BitCommand LLC	611	ip
DE	213.21.241.179	u1host ltd	611	ip
DE	87.251.87.36	nuxtcloud	611	ip
DE	209.38.207.244	DigitalOcean, LLC	611	ip
FR	147.90.26.34	Seigohost LLC	611	ip
FR	51.91.78.12	OVH SAS	611	ip
GB	132.226.211.229	Oracle Public Cloud	611	ip
GB	68.168.31.169	GTHost	611	ip
NL	2.58.14.96	Crowncloud	611	ip
NL	23.168.72.93	Private Customer	611	ip
NL	193.160.96.232	FiberXpress BV	611	ip
NL	104.249.40.219	Individual Entrepreneur Anton Levin	611	ip
NL	79.137.205.190	AEZA GROUP LLC	611	ip
NL	213.142.147.133	IROKO Networks Corporation	611	ip
NL	194.58.39.80	Baxet Group Inc.	611	ip
CH	83.228.198.53	Infomaniak Network SA	612	ip
DE	185.233.81.147	FIRST SERVER, SOCIEDAD LIMITADA	612	ip
DE	93.95.24.81	Fleece Cloud LLC	612	ip
DE	150.230.155.135	Oracle Corporation	612	ip
DE	150.241.108.6	u1host ltd	612	ip
DE	195.58.38.9	nuxt.cloud hosting provider	612	ip
FR	109.120.179.99	AEZA GROUP LLC	612	ip
GB	193.123.180.197	Oracle Corporation	612	ip
GB	57.128.183.108	OVH Ltd	612	ip
NL	212.80.216.85	SkyCore Technologies L.L.C-FZ	612	ip
NL	45.154.35.142	SkyCore Technologies L.L.C-FZ	612	ip
NL	216.57.106.100	Timeweb, LLP	612	ip
NL	72.56.79.203	Timeweb, LLP	612	ip
NL	45.82.13.135	GLOBAL CONNECTIVITY SOLUTIONS LLP	612	ip
NL	161.35.80.204	DigitalOcean, LLC	612	ip
CH	45.148.102.244	GLOBAL CONNECTIVITY SOLUTIONS LLP	613	ip
DE	185.248.143.21	IP-Projects GmbH & Co. KG	613	ip
DE	64.188.105.184	Senko Digital LLC - DE Network	613	ip
DE	195.133.44.21	GLB Bulut Teknolojisi Limited Sirketi	613	ip
DE	64.188.118.137	Frankfurt, Germany	613	ip
DE	3.69.0.8	A100 ROW GmbH	613	ip
DE	64.188.79.4	1Cent Host	613	ip
DE	85.208.139.48	HOST TELECOM LTD	613	ip
DE	5.61.39.183	IROKO Networks Corporation	613	ip
FR	185.234.100.241	Jogcorp SAS	613	ip
FR	31.59.103.13	CGI GLOBAL LIMITED	613	ip
NL	77.238.254.35	SERVERS TECH FZCO	613	ip
NL	147.90.229.223	GTHost	613	ip
NL	165.232.80.138	DigitalOcean, LLC	613	ip
NL	161.35.247.7	DigitalOcean, LLC	613	ip
NL	158.101.216.230	Oracle Public Cloud	613	ip
DE	94.125.101.103	Baykov Ilya Sergeevich	614	ip
DE	185.137.137.99	Eonix Corporation	614	ip
DE	178.17.58.11	GLOBAL CONNECTIVITY SOLUTIONS LLP	614	ip
FR	89.168.35.114	Oracle Svenska AB	614	ip
GB	91.227.62.95	GTHost	614	ip
NL	176.119.141.145	Snowd Security OU	614	ip
NL	23.168.72.85	GTHost	614	ip
NL	77.246.104.245	Amsterdam, Netherlands	614	ip
NL	94.103.81.63	Amsterdam, Netherlands	614	ip
NL	72.56.24.235	Timeweb, LLP	614	ip
NL	82.115.4.109	SIA VEESP	614	ip
NL	186.190.213.123	GTHost	614	ip
NL	134.209.136.197	DigitalOcean, LLC	614	ip
NL	165.232.89.21	DigitalOcean, LLC	614	ip
CH	45.85.93.45	Internet Utilities Europe and Asia Limited	615	ip
DE	5.39.249.167	ahbr company limited	615	ip
DE	141.147.31.174	Oracle Corporation	615	ip
DE	185.207.133.114	u1host ltd	615	ip
GB	78.129.253.158	Iomart Managed Services Limited	615	ip
NL	64.225.77.36	DigitalOcean, LLC	615	ip
NL	66.248.207.162	HOSTKEY B.V.	615	ip
NL	72.56.110.17	Timeweb, LLP	615	ip
NL	72.56.90.198	Timeweb, LLP	615	ip
NL	109.122.202.74	Melbikomas UAB	615	ip
NL	67.220.80.247	Private Customer	615	ip
NL	186.190.213.143	GTHost	615	ip
NL	185.247.117.195	O.M.C. COMPUTERS & COMMUNICATIONS LTD	615	ip
US	173.249.207.151	Tzulo-DJC	615	ip
DE	144.31.72.69	Amsterdam, Netherlands	616	ip
DE	103.75.199.16	Parsun Network Solutions PTY LTD	616	ip
DE	192.248.183.18	Hanauer Landstraße 302	616	ip
DE	18.184.27.249	A100 ROW GmbH	616	ip
FR	147.90.26.8	Seigohost LLC	616	ip
GB	209.38.165.5	DigitalOcean, LLC	616	ip
GB	57.128.177.198	OVH Ltd	616	ip
NL	94.241.174.229	Timeweb, LLP	616	ip
NL	212.192.217.100	Timeweb, LLP	616	ip
NL	91.186.215.131	FIRST SERVER, SOCIEDAD LIMITADA	616	ip
NL	209.250.255.90	JW Lucasweg 35	616	ip
NL	151.246.240.8	GTHost	616	ip
US	172.247.244.74	CloudRadium L.L.C	616	ip
US	159.223.201.58	DigitalOcean, LLC	616	ip
AU	140.238.198.5	Oracle Public Cloud	617	ip
DE	109.94.170.104	365 Group LLC	617	ip
ES	212.227.90.142	IONOS SE	617	ip
GB	54.38.214.128	OVH Ltd	617	ip
IT	80.211.170.53	Aruba S.p.A. - Cloud Services Farm2	617	ip
NL	185.239.71.145	Cluster Logic Inc	617	ip
NL	31.59.150.31	ExpressHost LTD	617	ip
NL	62.171.228.207	Virterion LLC	617	ip
NL	151.245.92.236	HOSTKEY B.V.	617	ip
NL	23.108.217.103	Servers.com B.V.	617	ip
NL	46.17.97.176	HOSTKEY B.V.	617	ip
NL	144.124.239.222	Amsterdam, Netherlands	617	ip
NL	82.115.4.65	SIA VEESP	617	ip
NL	195.54.175.160	IROKO Networks Corporation	617	ip
NL	195.133.38.227	NKtelecom INC	617	ip
NL	68.183.1.163	DigitalOcean, LLC	617	ip
SE	206.168.213.106	Hostup AB	617	ip
SE	196.196.5.28	SA	617	ip
US	172.245.148.211	RackNerd LLC	617	ip
DE	89.106.78.217	ComputeBox Hosting	618	ip
DE	5.187.3.105	Fornex Hosting S.L.	618	ip
DE	150.241.105.29	u1host ltd	618	ip
DE	85.208.139.92	HOST TELECOM LTD	618	ip
DE	138.197.183.219	DigitalOcean, LLC	618	ip
GB	109.169.76.23	Iomart Managed Services Limited	618	ip
NL	45.129.143.91	ALEKSEI FEDOROV PR KRUSEVAC	618	ip
NL	188.253.26.143	SIA VEESP	618	ip
NL	185.253.219.161	NETH LLC	618	ip
NL	95.85.226.7	1Cent Host	618	ip
NL	37.48.90.120	LeaseWeb Netherlands B.V.	618	ip
US	137.131.54.130	Oracle Corporation	618	ip
DE	31.172.72.83	Fornex Hosting S.L.	619	ip
DE	193.23.219.31	Senko Digital LLC - DE Network	619	ip
DE	79.133.51.180	UltaHost Inc	619	ip
DE	87.106.198.216	IONOS SE	619	ip
FR	147.90.14.132	HOSTKEY B.V.	619	ip
NL	23.168.72.23	GTHost	619	ip
NL	2.26.83.250	play2go.cloud - Cheap and reliable hosting	619	ip
NL	212.108.82.225	Unknown ISP	619	ip
NL	103.90.73.87	CLODO CLOUD SERVICE CO. L.L.C	619	ip
NL	185.223.169.157	Brainoza OU	619	ip
NL	158.180.12.117	Oracle Corporation	619	ip
NL	212.111.89.16	Amsterdam, Netherlands	619	ip
NL	80.76.34.50	FIRST SERVER, SOCIEDAD LIMITADA	619	ip
US	192.80.63.51	Perfecto Mobile Inc	619	ip
US	129.153.65.249	Oracle Corporation	619	ip
DE	43.131.1.244	6 COLLYER QUAY	620	ip
DE	217.110.20.141	Colt DC	620	ip
DE	82.153.50.212	JCA Engineering Ltd	620	ip
DE	77.91.66.21	1Cent Host	620	ip
KR	146.56.108.129	Oracle Corporation , Global software solutions , California , USA	620	ip
NL	23.168.72.21	Private Customer	620	ip
NL	66.151.42.239	Unknown ISP	620	ip
NL	194.36.190.2	Host Sailor Ltd	620	ip
GB	178.62.81.173	DigitalOcean London	621	ip
IT	151.91.39.191	Stellantis Auto SAS	621	ip
IT	158.180.239.66	Oracle Corporation	621	ip
NL	147.90.89.146	Private Customer	621	ip
NL	147.90.229.115	GTHost	621	ip
NL	5.129.238.238	TimeWeb Ltd.	621	ip
NL	212.34.153.65	Amsterdam, Netherlands	621	ip
NL	195.133.40.41	Timeweb, LLP	621	ip
NL	185.198.58.36	HostSailor RO Services	621	ip
DE	31.76.96.60	IT-Garage	622	ip
DE	64.188.118.5	Frankfurt, Germany	622	ip
DE	82.115.19.143	BitCommand LLC	622	ip
NL	185.233.184.13	Snowd Security OU	622	ip
NL	185.204.52.112	Virterion LLC	622	ip
NL	94.177.51.198	Individual Entrepreneur Anton Levin	622	ip
NL	147.90.229.205	GTHost	622	ip
NL	146.103.103.122	Amsterdam, Netherlands	622	ip
NL	195.133.38.112	Reliable Communications s.r.o.	622	ip
NL	212.192.215.163	Baxet Group Inc.	622	ip
NL	186.190.213.82	GTHost	622	ip
PL	94.103.0.67	GLOBAL CONNECTIVITY SOLUTIONS LLP	622	ip
SE	103.177.249.122	Hostup AB	622	ip
US	163.192.58.117	Oracle Corporation	622	ip
US	192.129.133.225	RackNerd LLC	622	ip
CH	140.238.208.240	Oracle Public Cloud	623	ip
DE	89.125.54.80	Snowd Security OU	623	ip
DE	18.156.209.101	A100 ROW GmbH	623	ip
DE	91.196.34.122	Germany, Frankfurt	623	ip
IT	158.180.231.216	Oracle Corporation	623	ip
NL	217.177.11.243	www.fornex.com, Fornex Hosting S.L.	623	ip
NL	23.168.72.41	GTHost	623	ip
NL	151.246.240.2	GTHost	623	ip
NL	185.243.112.197	CrownCloud	623	ip
NL	193.160.96.234	FiberXpress BV	623	ip
NL	109.104.153.94	oneprovider.com - Amsterdam Infrastructure	623	ip
NL	67.220.80.252	GTHost	623	ip
NL	186.190.213.5	GTHost	623	ip
NL	81.4.100.123	RouteLabel V.O.F.	623	ip
SE	37.203.209.42	ggyy-nl	623	ip
US	45.158.127.48	SERVA ONE LTD	623	ip
AU	192.9.175.224	Oracle Corporation	624	ip
DE	89.19.209.6	Timeweb, LLP	624	ip
DE	45.149.235.29	SERV.HOST GROUP LTD	624	ip
DE	185.255.179.166	Baykov Ilya Sergeevich	624	ip
DE	84.200.77.47	UltaHost Inc	624	ip
FR	144.91.77.167	Contabo GmbH	624	ip
NL	31.44.0.180	ITGLOBAL.COM NL B.V.	624	ip
NL	77.220.214.135	Podaon SIA	624	ip
NL	185.186.244.116	INXY LTD.	624	ip
NL	185.164.163.149	VPS1 network in Dronten, NL	624	ip
NL	147.90.229.40	GTHost	624	ip
NL	151.243.176.192	HOSTKEY B.V.	624	ip
NL	91.84.98.166	Amsterdam, Netherlands	624	ip
NL	194.87.82.149	Baxet Group Inc.	624	ip
NL	67.220.80.6	GTHost	624	ip
PL	51.75.32.106	OVH Sp. z o. o.	624	ip
US	198.12.120.194	RackNerd LLC	624	ip
US	23.94.59.201	RackNerd LLC	624	ip
BG	193.239.160.89	FIRST SERVER, SOCIEDAD LIMITADA	625	ip
DE	86.53.110.160	GTT-CUSTOMER	625	ip
DE	72.56.106.58	Timeweb, LLP	625	ip
DE	217.154.237.115	IONOS SE	625	ip
DE	138.124.228.122	nuxtcloud	625	ip
NL	23.168.72.227	GTHost	625	ip
NL	31.76.14.138	Amsterdam, Netherlands	625	ip
NL	109.120.142.143	IHC network in Amsterdam, NL (Iron Hosting Centre Ltd., London, UK)	625	ip
NL	185.233.203.113	FIRST SERVER, SOCIEDAD LIMITADA	625	ip
NL	46.149.75.249	Amsterdam, Netherlands	625	ip
NL	37.220.84.132	Timeweb, LLP	625	ip
US	129.153.74.231	Oracle Corporation	625	ip
US	192.3.251.89	RackNerd LLC	625	ip
DE	79.132.138.87	Fornex Hosting S.L.	626	ip
DE	192.91.186.156	FASTWARP LLP	626	ip
DE	31.76.0.15	SERV.HOST GROUP LTD	626	ip
DE	195.58.39.173	nuxtcloud	626	ip
NL	77.238.244.233	SERVERS TECH FZCO	626	ip
NL	212.7.207.4	LeaseWeb Netherlands B.V.	626	ip
NL	45.87.41.18	SpectraIP B.V.	626	ip
NL	147.90.229.51	GTHost	626	ip
NL	158.173.195.240	Private Customer	626	ip
NL	89.124.65.242	SERVERS TECH FZCO	626	ip
NL	147.90.229.176	GTHost	626	ip
NL	45.144.232.27	Baykov Ilya Sergeevich	626	ip
NL	178.62.206.22	DigitalOcean Amsterdam	626	ip
PL	31.76.251.97	VPSPay - vpspay.cloud	626	ip
PL	217.182.79.55	OVH Sp. z o. o.	626	ip
RU	194.87.71.141	LLC Baxet	626	ip
US	129.146.129.34	Oracle Corporation	626	ip
CH	146.70.71.157	M247 LTD Zurich	627	ip
DE	144.31.214.124	SERV.HOST GROUP LTD	627	ip
FR	45.63.114.83	Vultr Holdings, LLC	627	ip
GB	130.185.144.78	Fabric_zone	627	ip
NL	62.171.228.127	Virterion LLC	627	ip
NL	185.103.255.142	FIRST SERVER, SOCIEDAD LIMITADA	627	ip
NL	193.23.118.195	LayerSwitch B.V.	627	ip
NL	147.90.229.86	GTHost	627	ip
NL	2.27.169.241	Private Customer	627	ip
NL	78.142.231.122	Virtual Machine Solutions LLC	627	ip
NL	185.167.97.93	Kamatera Inc	627	ip
PL	138.124.104.104	Intezio Networks Warsaw	627	ip
PL	45.192.12.142	ExpressHost LTD	627	ip
US	43.130.58.238	6 COLLYER QUAY	627	ip
DE	185.103.253.187	FIRST SERVER, SOCIEDAD LIMITADA	628	ip
DE	31.58.85.103	SEBEK sp. z o.o	628	ip
DE	94.156.112.142	play2go.cloud - Cheap and reliable hosting	628	ip
DE	18.196.70.197	A100 ROW GmbH	628	ip
DE	167.99.131.6	DigitalOcean, LLC	628	ip
NL	62.171.228.94	Virterion LLC	628	ip
NL	89.125.119.65	RCS Technologies FZE LLC	628	ip
NL	2.27.169.2	Private Customer	628	ip
NL	89.150.35.129	CLODO CLOUD SERVICE CO. L.L.C	628	ip
NL	185.216.85.114	Iron Hosting Centre LTD	628	ip
NL	134.98.143.133	Oracle Svenska AB	628	ip
NL	194.87.130.218	Timeweb, LLP	628	ip
PL	51.68.141.223	OVH Sp. z o. o.	628	ip
DE	37.1.195.124	IROKO Networks Corporation	629	ip
DE	18.197.218.69	A100 ROW GmbH	629	ip
DE	194.164.192.16	IONOS SE	629	ip
DE	152.42.178.179	DigitalOcean, LLC	629	ip
FR	45.95.172.206	Mo's Operations GmbH	629	ip
NL	147.45.225.134	Timeweb, LLP	629	ip
NL	95.47.138.133	Serverel Inc.	629	ip
NL	194.87.216.205	GLOBAL CONNECTIVITY SOLUTIONS LLP	629	ip
NL	67.220.80.246	Private Customer	629	ip
NL	213.183.51.71	Melbicom infrastructure	629	ip
NL	185.36.143.71	Brainoza OU	629	ip
NL	159.223.4.44	DigitalOcean, LLC	629	ip
NL	147.90.229.224	GTHost	629	ip
DE	169.40.138.79	Private Customer	630	ip
DE	45.129.242.17	SERVA ONE LTD	630	ip
DE	62.60.217.230	AEZA GROUP LLC	630	ip
DE	18.185.254.189	Amazon Data Services Ireland Ltd	630	ip
NL	88.218.248.195	GLB Bulut Teknolojisi Limited Sirketi	630	ip
NL	194.0.194.212	SkyCore Technologies L.L.C-FZ	630	ip
NL	185.92.74.108	FOXCLOUD LLP CDN	630	ip
NL	5.45.70.203	IROKO Networks Corporation	630	ip
NL	147.90.229.167	GTHost	630	ip
NL	202.148.52.97	HOSTKEY B.V.	630	ip
NL	147.90.229.65	GTHost	630	ip
NL	177.3.208.34	play2go.cloud - Cheap and reliable hosting	630	ip
NL	178.208.87.151	Digital City FZE	630	ip
NL	147.90.229.212	GTHost	630	ip
NL	91.201.114.78	VDSINA VDS Hosting ipv6	630	ip
NL	95.168.174.248	LeaseWeb Netherlands B.V.	630	ip
NL	23.94.220.233	RackNerd LLC	630	ip
NL	188.166.79.180	Digital Ocean, Inc.	630	ip
US	49.51.231.21	Tencent cloud computing (Beijing) Co., Ltd.	630	ip
US	129.146.242.248	Oracle Corporation	630	ip
US	64.49.28.173	Private Customer	630	ip
US	205.186.76.198	Private Customer	630	ip
CH	16.63.207.85	Amazon Data Services Switzerland	631	ip
DE	5.44.46.142	Timeweb, LLP	631	ip
NL	194.154.26.110	www.fornex.com, Fornex Hosting S.L.	631	ip
NL	45.87.107.158	Serverio technologijos MB	631	ip
NL	45.155.249.66	servinga GmbH	631	ip
US	129.146.201.236	Oracle Corporation	631	ip
DE	195.133.93.16	Hostman LTD	632	ip
DE	89.168.100.165	Oracle Svenska AB	632	ip
DE	57.131.143.10	OVH GmbH	632	ip
FR	185.171.202.243	Dyjix SAS	632	ip
NL	23.168.72.17	GTHost	632	ip
NL	193.124.189.227	FIRST SERVER, SOCIEDAD LIMITADA	632	ip
NL	147.90.229.87	GTHost	632	ip
NL	147.90.229.233	GTHost	632	ip
NL	91.103.253.171	FIRST SERVER, SOCIEDAD LIMITADA	632	ip
NL	175.110.114.20	WORLDSTREAM	632	ip
PL	95.85.254.27	1Cent Host	632	ip
PL	45.144.50.4	Newserverlife LLC	632	ip
US	158.101.15.61	Oracle Public Cloud	632	ip
US	23.95.215.195	RackNerd LLC	632	ip
US	198.23.246.97	RackNerd LLC	632	ip
CH	132.243.174.185	ALEXHOST SRL	633	ip
NL	2.26.110.36	Amsterdam, Netherlands	633	ip
NL	5.253.189.224	NKtelecom INC	633	ip
NL	185.138.88.7	GLOBAL CONNECTIVITY SOLUTIONS LLP	633	ip
PL	176.105.253.43	BREEZLE LLC	633	ip
PL	95.85.246.250	1Cent Host	633	ip
US	158.101.9.18	Oracle Public Cloud	633	ip
US	64.227.109.151	DigitalOcean, LLC	633	ip
DE	64.188.105.125	Senko Digital LLC - DE Network	634	ip
DE	95.85.237.48	MHost LLC	634	ip
DE	195.54.33.1	TK Rustelekom LLC	634	ip
DE	95.140.154.46	lease for Timeweb	634	ip
DE	216.57.104.59	Timeweb, LLP	634	ip
FR	82.70.234.100	Oracle Svenska AB	634	ip
GB	172.187.200.28	Microsoft Limited	634	ip
NL	2.27.39.136	Amsterdam, Netherlands	634	ip
NL	82.38.71.240	HOSTKEY B.V.	634	ip
NL	147.90.229.241	GTHost	634	ip
NL	178.173.248.215	SIA VEESP	634	ip
NL	168.100.9.81	BL Networks	634	ip
PL	193.108.170.80	Kutumova Olena	634	ip
PL	51.77.58.226	OVH Sp. z o. o.	634	ip
DE	64.188.118.69	Frankfurt, Germany	635	ip
DE	185.246.222.239	Frankfurt, Germany	635	ip
FR	152.228.191.232	SEVIN Jacques	635	ip
GB	57.128.178.232	OVH Ltd	635	ip
NL	185.130.224.105	HOSTKEY B.V.	635	ip
NL	72.56.72.94	Timeweb, LLP	635	ip
NL	158.101.214.54	Oracle Public Cloud	635	ip
BG	185.232.170.226	FIRST SERVER, SOCIEDAD LIMITADA	636	ip
DE	77.239.98.108	nuxt.cloud	636	ip
FR	109.199.122.5	Contabo GmbH	636	ip
GB	8.208.19.143	Aliyun Computing Co.LTD	636	ip
NL	45.147.199.13	Podaon SIA	636	ip
NL	45.131.187.210	Individual Entrepreneur Anton Levin	636	ip
NL	194.87.62.165	Baykov Ilya Sergeevich	636	ip
NL	159.223.224.134	DigitalOcean, LLC	636	ip
PL	45.194.66.88	Cloud Innovation Ltd	636	ip
US	129.146.196.8	Oracle Corporation	636	ip
CH	167.17.181.72	Baxet Group Inc.	637	ip
FR	45.95.174.14	RackNerd, LLC	637	ip
FR	92.119.125.143	RACKNERD-FR	637	ip
NL	185.209.162.35	It Hosting Group	637	ip
NL	185.233.184.70	Snowd Security OU	637	ip
NL	170.168.61.171	Costel Savulescu	637	ip
NL	138.124.3.156	Baykov Ilya Sergeevich	637	ip
NL	45.144.154.149	Individual Entrepreneur Anton Levin	638	ip
NL	195.133.63.147	Timeweb, LLP	638	ip
DE	87.120.205.64	WAIcore Ltd	639	ip
DE	45.150.32.112	AEZA GROUP LLC	639	ip
GB	18.134.196.127	Amazon Data Services UK	639	ip
NL	103.102.228.113	Individual Entrepreneur Anton Levin	639	ip
NL	147.90.229.186	GTHost	639	ip
NL	192.210.175.185	HostPapa	639	ip
NL	212.193.1.234	Baxet Group Inc.	639	ip
SE	89.127.201.202	www.fornex.com, Fornex Hosting S.L.	639	ip
US	132.226.29.245	Oracle Corporation	639	ip
BG	185.204.53.58	Virterion LLC	640	ip
DE	134.122.77.148	DigitalOcean, LLC	640	ip
FR	91.134.43.127	OVH SAS	640	ip
GB	132.226.210.229	Oracle Public Cloud	640	ip
NL	89.125.123.248	Snowd Security OU	640	ip
NL	185.209.161.243	It Hosting Group	640	ip
NL	188.208.103.45	Snowd Security OU	640	ip
NL	72.56.124.66	Timeweb, LLP	640	ip
US	64.181.218.67	Oracle Corporation	640	ip
DE	144.31.227.24	Amsterdam, Netherlands	641	ip
DE	109.122.197.126	WAIcore Ltd	641	ip
DE	80.244.13.16	GTHost	641	ip
FR	88.218.78.48	RACKNERD-FR	641	ip
IE	85.159.229.122	GLOBAL INTERNET SOLUTIONS LLC	641	ip
NL	5.181.134.74	Etheron Hosting	641	ip
NL	2.27.169.240	Private Customer	641	ip
NL	147.90.229.120	GTHost	641	ip
NL	194.87.31.49	GLOBAL CONNECTIVITY SOLUTIONS LLP	641	ip
US	107.172.32.207	HostPapa	641	ip
US	185.255.198.123	BACK WAVES LIMITED - US	641	ip
DE	31.172.73.59	www.fornex.com, Fornex Hosting S.L.	642	ip
DE	132.145.232.171	Oracle Corporation	642	ip
ES	93.93.119.91	ARSYS INTERNET S.L.U.	642	ip
GB	134.65.56.95	Oracle Corporation	642	ip
GB	134.65.60.202	Oracle Corporation	642	ip
NL	195.133.39.185	Individual Entrepreneur Anton Levin	642	ip
NL	62.60.245.255	NetCrafters OU	642	ip
NL	147.90.89.114	Private Customer	642	ip
NL	77.221.155.180	AEZA GROUP LLC	642	ip
NL	167.99.44.172	DigitalOcean, LLC	642	ip
US	43.130.6.39	6 COLLYER QUAY	642	ip
AE	139.185.45.106	Oracle Corporation	643	ip
DE	138.2.162.105	Oracle Corporation	643	ip
GB	45.32.180.58	Vultr Holdings, LLC	643	ip
NL	147.90.229.231	GTHost	643	ip
NL	2.27.169.193	Private Customer	643	ip
NL	2.56.212.167	MVPS LTD	643	ip
NL	185.246.155.198	Melbikomas UAB	644	ip
SE	70.34.210.205	The Constant Company, LLC	644	ip
US	43.153.105.7	6 COLLYER QUAY	644	ip
DE	109.122.198.64	WAIcore Ltd	645	ip
DE	89.168.98.97	Oracle Svenska AB	645	ip
ES	92.178.109.187	Orange Spain Network	645	ip
NL	147.90.89.101	Private Customer	645	ip
US	45.143.129.188	BITSFLOWCLOUD	645	ip
US	132.226.73.78	Oracle Public Cloud	645	ip
CZ	91.184.248.36	SmartApe OU	646	ip
DE	2.26.61.126	Frankfurt, Germany	646	ip
DE	158.180.17.177	Oracle Corporation	646	ip
FI	195.96.156.240	Individual Entrepreneur Anton Levin	646	ip
FR	158.178.215.52	Oracle Svenska AB	646	ip
GB	144.24.228.237	Oracle Corp UK Ltd	646	ip
NL	80.74.26.226	CLODO CLOUD SERVICE CO. L.L.C	646	ip
NL	91.232.114.148	Telemagic B.V.	646	ip
NL	78.142.228.156	Virtual Machine Solutions LLC	646	ip
NL	62.171.228.103	Virterion LLC	646	ip
NL	195.246.110.206	WEBHOST LLC	646	ip
NL	185.246.152.159	Melbicom infrastructure	646	ip
RU	188.68.223.17	Selectel Network	646	ip
US	129.146.165.161	Oracle Corporation	646	ip
AU	168.138.110.138	Oracle Corporation	647	ip
DE	64.188.66.138	play2go.cloud - Cheap and reliable hosting	647	ip
DE	64.188.99.214	Cloud Hosting Solutions, Limited.	647	ip
NL	62.60.245.155	AEZA GROUP LLC	647	ip
NL	147.90.229.60	GTHost	647	ip
NL	2.27.169.6	Private Customer	647	ip
NL	89.42.142.72	SERVA ONE LTD	647	ip
PL	2.59.163.33	GLOBAL CONNECTIVITY SOLUTIONS LLP	647	ip
CA	40.177.65.8	Amazon Data Services Canada	648	ip
FI	192.145.29.34	Baykov Ilya Sergeevich	648	ip
NL	147.90.89.200	Private Customer	648	ip
NL	178.173.254.43	SIA VEESP	648	ip
SE	37.203.209.50	Reverse-Proxy	648	ip
SE	89.125.243.165	Baxet Group Inc.	648	ip
US	129.146.47.135	Oracle Corporation	648	ip
US	192.3.134.177	RackNerd LLC	648	ip
NL	158.173.195.97	Private Customer	649	ip
NL	185.246.217.72	NetCrafters OU	649	ip
NL	23.94.220.207	RackNerd LLC	649	ip
DE	77.221.157.32	AEZA GROUP LLC	650	ip
FI	193.221.203.206	Baykov Ilya Sergeevich	650	ip
FI	45.131.185.234	Baxet Group Inc.	650	ip
GB	79.72.91.32	Oracle Svenska AB	650	ip
PL	212.119.43.76	FASTWARP LLP	650	ip
FI	185.106.94.143	FIRST SERVER, SOCIEDAD LIMITADA	651	ip
GB	88.80.186.197	Linode, LLC	651	ip
NL	45.149.234.112	Individual Entrepreneur Anton Levin	651	ip
NL	94.177.51.17	Individual Entrepreneur Anton Levin	651	ip
NL	72.56.95.38	Timeweb, LLP	651	ip
NL	94.142.137.72	FIRST SERVER, SOCIEDAD LIMITADA	651	ip
NL	185.156.172.196	M247 LTD Amsterdam Infrastructure	651	ip
NL	62.171.228.179	Virterion LLC	651	ip
PL	45.198.0.236	ExpressHost LTD	651	ip
DE	103.228.168.80	Fornex Hosting S.L.	652	ip
DE	18.198.227.161	A100 ROW GmbH	652	ip
FI	109.172.54.73	GLOBAL CONNECTIVITY SOLUTIONS LLP	652	ip
FR	37.60.232.144	Contabo GmbH	652	ip
HU	185.225.68.232	ATW Internet Kft.	652	ip
IL	185.239.48.237	LLC Smart Ape	652	ip
NL	94.241.173.217	Timeweb, LLP	652	ip
NL	103.102.228.10	Individual Entrepreneur Anton Levin	652	ip
NL	45.87.107.247	Serverio technologijos MB	652	ip
US	43.162.119.244	6 COLLYER QUAY	652	ip
US	137.131.4.105	Oracle Corporation	652	ip
US	64.177.112.4	The Constant Company, LLC	652	ip
CH	91.245.225.69	GLB Bulut Teknolojisi Limited Sirketi	653	ip
DE	148.253.208.57	SEBEK sp. z o.o	653	ip
DE	2.26.250.79	nuxtcloud	653	ip
FI	91.149.219.49	BG-NETWORK	653	ip
NL	185.198.165.92	Friendhosting LTD	653	ip
NL	147.90.229.222	GTHost	653	ip
NL	82.115.6.21	SIA VEESP	653	ip
NL	212.193.1.208	Baxet Group Inc.	653	ip
DE	144.31.214.138	SERV.HOST GROUP LTD	654	ip
DE	85.215.196.151	IONOS SE	654	ip
NL	95.179.140.212	JW Lucasweg 35	654	ip
DE	91.108.243.115	IP Lomakin Artem Aleksandrovich	655	ip
DE	93.185.157.153	Frankfurt, Germany	655	ip
DE	2.26.108.197	Frankfurt, Germany	655	ip
DE	18.192.93.64	A100 ROW GmbH	655	ip
FI	84.19.3.83	Individual Entrepreneur Anton Levin	655	ip
FI	78.17.35.41	Snowd Security OU	655	ip
FR	109.199.126.6	Contabo GmbH	655	ip
NL	147.90.229.164	GTHost	655	ip
NL	62.84.172.69	Matteo Martelloni trading as DELUXHOST	655	ip
PL	31.56.188.106	GOLD IP L.L.C-FZ	655	ip
RU	5.159.101.86	Selectel Network	655	ip
US	158.101.5.192	Oracle Public Cloud	655	ip
NL	45.95.42.172	Host Sailor Ltd	656	ip
NL	93.113.171.95	Baxet Group Inc.	656	ip
PL	95.85.254.170	1Cent Host	656	ip
US	31.220.31.67	Hostinger International Limited	656	ip
US	34.136.112.104	Google LLC	656	ip
DE	2.26.53.123	play2go.cloud - Cheap and reliable hosting	657	ip
GB	212.113.116.93	AEZA GROUP LLC	657	ip
IE	198.55.103.168	VPS ACE	657	ip
MD	5.181.158.96	MivoCloud	657	ip
NL	167.71.66.234	DigitalOcean, LLC	657	ip
US	23.95.88.103	RackNerd LLC	657	ip
US	66.63.166.118	RackNerd LLC	657	ip
BG	185.205.210.144	Redcluster LTD	658	ip
DE	5.253.188.137	DePowered	658	ip
DE	35.157.240.237	Amazon Data Services Ireland Ltd	658	ip
DE	94.130.72.184	Hetzner Online GmbH	658	ip
FI	45.131.185.203	Baxet Group Inc.	658	ip
FR	84.247.166.22	Contabo GmbH	658	ip
LV	84.21.172.81	Baykov Ilya Sergeevich	658	ip
NL	194.87.0.196	Iron Hosting Centre Ltd., London, UK (rw) abuse@ironhostr.me	658	ip
NL	151.247.25.120	NetGrid Host LTD	658	ip
NL	45.142.203.189	S.S NETSHOP INTERNET SERVICES LTD	658	ip
PL	95.164.90.133	Netassist Limited	658	ip
US	66.154.101.223	ASSERTIVENET	658	ip
US	104.168.87.130	RackNerd LLC	658	ip
DE	18.159.105.97	Amazon Data Services Ireland Ltd	659	ip
FI	185.230.190.148	LIVI HOSTING LTD	659	ip
FI	194.48.140.149	Individual Entrepreneur Anton Levin	659	ip
FI	212.87.222.32	GLOBAL CONNECTIVITY SOLUTIONS LLP	659	ip
GB	193.106.196.250	InterLIR Marketplace	659	ip
NL	2.59.183.210	SERVA ONE LTD	659	ip
NL	45.132.107.196	Podaon SIA	659	ip
TR	195.16.74.73	WorkTitans B.V.	659	ip
CZ	91.199.147.23	SmartApe OU	660	ip
DE	193.37.70.63	Cloud Hosting Solutions, Limited.	660	ip
DE	212.113.104.94	Eduard Ilin	660	ip
FI	91.211.114.202	Baykov Ilya Sergeevich	660	ip
FI	185.112.82.28	Creanova	660	ip
MU	41.76.42.116	Mauritius Telecom Ltd	660	ip
NL	2.27.169.138	Private Customer	660	ip
NL	45.158.81.143	Brainoza OU	660	ip
PL	82.40.38.216	HOSTKEY B.V.	660	ip
RU	212.41.15.119	Selectel Network	660	ip
BE	148.177.146.71	Johnson & Johnson	661	ip
DE	72.56.106.210	Timeweb, LLP	661	ip
FI	91.211.114.208	Baykov Ilya Sergeevich	661	ip
FI	193.168.198.220	Baykov Ilya Sergeevich	661	ip
SE	185.21.11.91	www.fornex.com, Fornex Hosting S.L.	661	ip
AL	103.167.234.26	Albanian Hosting SH.P.K. t/a AlbHost SH.P.K.	662	ip
DE	3.68.31.54	A100 ROW GmbH	662	ip
LV	188.130.154.155	CGI GLOBAL LIMITED	662	ip
SE	158.179.206.143	oracle	662	ip
SE	80.66.78.207	GLOBAL CONNECTIVITY SOLUTIONS LLP	662	ip
NL	185.36.143.123	Brainoza OU	663	ip
RU	91.107.64.160	Data Storage Center JSC	663	ip
CZ	87.236.146.76	SmartApe OU	664	ip
FI	193.124.181.123	I-SERVERS LTD	664	ip
GB	213.1.145.50	BT-R101-TEST	664	ip
NL	2.27.169.140	Private Customer	664	ip
NL	81.22.132.136	Internet Utilities Europe and Asia Limited	664	ip
NL	91.223.123.210	Friendhosting LTD	664	ip
PL	91.108.237.23	interlir citytelecom 07 12 2025	664	ip
RU	31.129.48.139	Selectel Network	664	ip
DE	3.67.232.136	Amazon Data Services Ireland Ltd	665	ip
FI	193.124.182.211	FIRST SERVER, SOCIEDAD LIMITADA	665	ip
NL	194.33.35.241	AEZA GROUP LLC	665	ip
US	43.153.78.145	6 COLLYER QUAY	665	ip
US	152.70.157.193	Oracle Corporation	665	ip
US	205.186.76.197	Private Customer	665	ip
NL	31.57.196.162	Private Customer	666	ip
NL	185.23.238.76	Individual Entrepreneur Anton Levin	666	ip
NL	81.22.132.183	Internet Utilities Europe and Asia Limited	666	ip
US	141.148.159.253	Oracle Corporation	666	ip
DE	62.60.217.170	NetCrafters OU	667	ip
DE	18.193.131.26	A100 ROW GmbH	667	ip
FI	91.217.76.237	FIRST SERVER, SOCIEDAD LIMITADA	667	ip
GB	35.176.187.206	Amazon Data Services UK	667	ip
NL	158.173.195.216	Private Customer	667	ip
BG	193.239.160.134	FIRST SERVER, SOCIEDAD LIMITADA	668	ip
CY	213.7.187.34	Cyprus Telecommunications Authority	668	ip
DE	88.198.82.148	Hetzner Online GmbH	668	ip
DE	212.113.104.95	Eduard Ilin	668	ip
FI	193.124.183.92	FIRST SERVER, SOCIEDAD LIMITADA	668	ip
GB	159.65.19.63	DigitalOcean, LLC	668	ip
PL	185.253.44.97	Friendhosting LTD	668	ip
PL	45.142.212.24	IT Hostline Ltd	668	ip
US	185.186.245.90	INXY LTD.	668	ip
DE	77.239.104.82	u1host ltd	669	ip
FI	83.97.78.168	DGTL TECH UK LLP	669	ip
LV	45.158.169.78	as56971 network	669	ip
NL	89.127.214.183	www.fornex.com, Fornex Hosting S.L.	669	ip
NL	193.106.150.144	RU DOMISHKO	669	ip
NL	185.244.218.189	Podaon SIA	669	ip
NL	92.112.124.25	Matteo Martelloni trading as DELUXHOST	669	ip
PL	82.118.20.234	GREEN FLOID LLC	669	ip
TR	185.219.132.27	hostigger_datacenter_TR	669	ip
BG	185.148.146.9	Belcloud LTD	670	ip
DE	185.221.237.22	Deployish Limited	670	ip
DE	2.26.21.163	Frankfurt, Germany	670	ip
DK	89.185.80.238	GLOBAL CONNECTIVITY SOLUTIONS LLP	670	ip
FI	46.20.106.214	Baykov Ilya Sergeevich	670	ip
US	161.153.117.68	Oracle Corporation	670	ip
BG	185.203.116.174	Belcloud LTD	671	ip
DE	5.75.182.89	Hetzner Online GmbH	671	ip
ES	141.253.194.63	Cloudflare London, LLC	671	ip
FI	89.125.81.30	Snowd Security OU	671	ip
FI	164.215.97.18	Individual Entrepreneur Anton Levin	671	ip
FI	185.239.141.89	Individual Entrepreneur Anton Levin	671	ip
NL	2.27.169.43	Private Customer	671	ip
NL	185.36.143.187	Brainoza OU	671	ip
TR	84.32.230.201	Private Customer	671	ip
DE	31.76.100.103	VPSPay - vpspay.cloud	672	ip
DE	116.202.132.205	HOS-524675	672	ip
DE	46.225.149.10	Hetzner Online GmbH	672	ip
GB	193.106.196.231	InterLIR Marketplace	672	ip
LV	31.57.105.140	CGI GLOBAL LIMITED	672	ip
NL	151.247.25.122	NetGrid Host LTD	672	ip
US	35.239.174.101	Google LLC	672	ip
US	104.168.125.179	RackNerd LLC	672	ip
BG	185.205.210.83	Belcloud LTD	673	ip
CZ	45.151.183.22	Retzor-com	673	ip
DE	49.12.237.71	Hetzner Online GmbH	673	ip
DE	91.108.243.39	DePowered	673	ip
DE	212.192.4.231	DePowered	673	ip
DE	88.198.149.98	Hetzner Online GmbH	673	ip
EE	45.129.199.117	BlueVPS OU	673	ip
FI	185.232.204.222	Individual Entrepreneur Anton Levin	673	ip
FI	104.128.131.94	FIRST SERVER, SOCIEDAD LIMITADA	673	ip
FI	138.124.244.182	GCS Service Network	673	ip
SE	87.251.85.34	GLOBAL CONNECTIVITY SOLUTIONS LLP	673	ip
TR	138.124.107.35	Plant Holding GmbH	673	ip
DE	88.198.82.145	Hetzner Online GmbH	674	ip
DE	88.198.82.154	Hetzner Online GmbH	674	ip
FI	78.17.99.49	Snowd Security OU	674	ip
KR	149.28.128.67	The Constant Company, LLC	674	ip
FI	185.212.149.7	Creanova	675	ip
GB	132.145.73.22	Oracle Public Cloud	675	ip
LV	151.242.43.187	Private Customer	675	ip
LV	31.57.105.53	CGI GLOBAL LIMITED	675	ip
LV	31.56.113.127	CGI GLOBAL LIMITED	675	ip
NL	89.42.142.219	SERVA ONE LTD	675	ip
NL	158.173.195.198	Private Customer	675	ip
DE	129.159.25.87	Oracle Corporation	676	ip
FI	46.243.6.25	I-SERVERS LTD	676	ip
FI	195.96.156.92	Individual Entrepreneur Anton Levin	676	ip
GB	77.221.153.69	AEZA GROUP LLC	676	ip
LT	195.181.244.107	UAB Interneto vizija	676	ip
NL	109.176.207.168	Private Customer	676	ip
NL	185.36.143.205	Brainoza OU	676	ip
US	104.238.129.180	Vultr Holdings, LLC	676	ip
DE	150.241.105.185	u1host ltd	677	ip
FI	217.179.49.227	Anton Levin	677	ip
FI	45.131.135.79	Individual Entrepreneur Anton Levin	677	ip
FI	185.17.2.147	PSERVERS Enterprise Network	677	ip
FI	78.153.139.145	GLOBAL CONNECTIVITY SOLUTIONS LLP	677	ip
FI	212.87.222.43	GLOBAL CONNECTIVITY SOLUTIONS LLP	677	ip
FI	81.177.214.13	GLOBAL CONNECTIVITY SOLUTIONS LLP	677	ip
FI	83.172.135.107	EDIS Infrastructure in Finland	677	ip
FR	84.247.177.135	Contabo GmbH	677	ip
LV	193.164.155.76	as56971 network	677	ip
LV	31.56.113.17	CGI GLOBAL LIMITED	677	ip
NL	31.57.196.20	Private Customer	677	ip
PL	139.28.97.231	Individual Entrepreneur Anton Levin	677	ip
US	158.101.5.169	Oracle Public Cloud	677	ip
GB	217.154.53.220	IONOS SE	678	ip
LV	85.31.102.163	Sia Nano IT	678	ip
LV	193.164.155.223	as56971 network	678	ip
US	66.154.115.151	ASSERTIVENET	678	ip
DE	88.198.82.149	Hetzner Online GmbH	679	ip
IE	54.247.36.82	Amazon Data Services Ireland Limited	679	ip
US	172.86.73.221	RouterHosting LLC	679	ip
DE	91.107.130.114	Hetzner Online GmbH	680	ip
FI	82.25.185.46	HOSTKEY B.V.	680	ip
FI	185.188.181.14	PSERVERS Enterprise Network	680	ip
FR	109.199.127.101	Contabo GmbH	680	ip
NL	95.140.147.83	JSC TIMEWEB	680	ip
DE	88.99.189.60	Hetzner Online GmbH	681	ip
DE	116.203.58.165	Hetzner Online GmbH	681	ip
DE	178.105.227.210	Hetzner Online GmbH	681	ip
FI	193.32.179.220	Baykov Ilya Sergeevich	681	ip
FI	178.17.53.85	GLOBAL CONNECTIVITY SOLUTIONS LLP	681	ip
LV	109.248.163.151	as56971 network	681	ip
NL	158.173.195.225	Private Customer	681	ip
SE	84.32.99.229	Private Customer	681	ip
US	18.222.50.18	Amazon Technologies Inc.	681	ip
BG	91.215.155.140	Friendhosting LTD	682	ip
DE	185.66.165.51	Perfecto Mobile UK Ltd (/24 used in Germany)	682	ip
DE	3.66.115.225	A100 ROW GmbH	682	ip
DE	157.90.123.229	Hetzner Online GmbH	682	ip
DE	88.99.92.84	Hetzner Online GmbH	682	ip
FI	78.17.64.207	Snowd Security OU	682	ip
FI	192.145.29.179	Baykov Ilya Sergeevich	682	ip
GB	185.170.215.228	MVPS LTD	682	ip
LV	31.57.28.22	CGI GLOBAL LIMITED	682	ip
NL	147.90.89.14	Private Customer	682	ip
NL	185.159.75.51	O.M.C. COMPUTERS & COMMUNICATIONS LTD	682	ip
DE	88.198.82.153	Hetzner Online GmbH	683	ip
DE	88.198.82.150	Hetzner Online GmbH	683	ip
DE	91.99.161.159	Hetzner Online GmbH	683	ip
DE	91.107.152.178	Hetzner Online GmbH	683	ip
FI	91.217.76.192	FIRST SERVER, SOCIEDAD LIMITADA	683	ip
LV	94.183.190.104	as56971 network	683	ip
TR	185.235.243.172	WorkTitans B.V.	683	ip
US	129.146.46.164	Oracle Corporation	683	ip
DE	88.198.82.146	Hetzner Online GmbH	684	ip
DE	49.13.228.85	Hetzner Online GmbH	684	ip
FI	194.48.140.109	Individual Entrepreneur Anton Levin	684	ip
FI	109.107.171.147	ALEKSEI FEDOROV PR KRUSEVAC	684	ip
FI	87.239.251.254	FIRST SERVER LIMITED	684	ip
FR	88.96.47.56	Oracle Svenska AB	684	ip
LV	31.57.105.139	CGI GLOBAL LIMITED	684	ip
LV	31.56.113.20	CGI GLOBAL LIMITED	684	ip
NL	45.158.81.45	Brainoza OU	684	ip
RO	85.90.196.11	GREEN FLOID LLC	684	ip
RS	38.180.100.80	3NT SOLUTIONS LLP	684	ip
RU	5.189.239.36	Selectel Network	684	ip
CH	38.180.161.128	3NT SOLUTIONS LLP	685	ip
FR	82.64.120.239	Free SAS	685	ip
GB	87.106.65.110	IONOS SE	685	ip
LV	31.56.117.15	CGI GLOBAL LIMITED	685	ip
LV	31.57.26.96	CGI GLOBAL LIMITED	685	ip
PL	45.43.137.179	Individual Entrepreneur Anton Levin	685	ip
US	155.94.173.121	ContactJam	685	ip
BG	78.128.127.93	DA International Group Ltd.	686	ip
DE	142.132.178.99	Hetzner Online GmbH	686	ip
DE	91.99.148.150	Hetzner Online GmbH	686	ip
FI	138.124.75.161	Baykov Ilya Sergeevich	686	ip
FI	93.152.207.163	GLOBAL CONNECTIVITY SOLUTIONS LLP	686	ip
GB	152.67.148.205	Oracle Public Cloud	686	ip
TR	141.98.118.80	Hostigger INC.	686	ip
US	18.216.55.100	Amazon Technologies Inc.	686	ip
DE	46.249.100.111	Deployish Limited	687	ip
DE	88.198.82.151	Hetzner Online GmbH	687	ip
DE	37.220.83.176	Timeweb, LLP	687	ip
FI	82.40.57.83	HOSTKEY B.V.	687	ip
FI	78.17.39.165	Snowd Security OU	687	ip
FI	185.230.190.29	LIVI HOSTING LTD	687	ip
FI	46.38.156.59	Individual Entrepreneur Anton Levin	687	ip
GB	87.117.205.16	RapidSwitch Ltd	687	ip
US	144.225.255.169	Private Customer	687	ip
FI	212.192.223.30	Baxet Group Inc.	688	ip
LV	94.183.189.154	CGI GLOBAL LIMITED	688	ip
LV	217.60.3.198	CGI GLOBAL LIMITED	688	ip
TR	185.234.66.91	WorkTitans B.V.	688	ip
US	141.148.136.150	Oracle Corporation	688	ip
BA	185.99.2.175	Globalhost d.o.o. - Virtual Private Servers	689	ip
FI	185.104.250.62	I-SERVERS LTD	689	ip
FI	82.25.185.188	HOSTKEY B.V.	689	ip
FI	138.124.244.176	GCS Service Network	689	ip
NL	2.59.183.140	SERVA ONE LTD	689	ip
US	45.13.214.176	* WWW.RARECLOUD.IO *	689	ip
FI	198.105.124.249	I-SERVERS LTD	690	ip
FI	45.9.74.238	PSERVERS Enterprise Network	690	ip
FI	37.143.129.215	Oneprovider.com - Helsinki Infrastructure	690	ip
PL	91.149.253.249	BG-NETWORK	690	ip
PL	194.87.128.46	Baxet Group Inc.	690	ip
RO	185.104.181.228	DataNode DC SRL	690	ip
FI	46.243.1.237	I-SERVERS LTD	691	ip
FI	185.94.167.63	PSERVERS Enterprise Network	691	ip
GB	104.128.190.209	365 Group LLC	691	ip
NL	31.57.196.109	Private Customer	691	ip
NL	46.30.46.217	Eurobyte VPS (Iron Hosting Centre Ltd., London, UK)	691	ip
US	3.132.174.45	Amazon Technologies Inc.	691	ip
FI	193.84.2.148	HOSTKEY B.V.	692	ip
LV	178.248.75.57	SERVA ONE LTD	692	ip
LV	188.130.206.87	CGI GLOBAL LIMITED	692	ip
TR	185.235.243.19	WorkTitans B.V.	692	ip
TR	185.39.204.17	GLOBAL CONNECTIVITY SOLUTIONS LLP	692	ip
US	207.246.94.121	The Constant Company, LLC	692	ip
CH	38.180.85.203	3NT SOLUTIONS LLP	693	ip
DE	167.235.69.166	Hetzner Online GmbH	693	ip
EE	185.23.236.111	IT-Develop DOO	693	ip
LV	194.87.89.41	Baxet Group Inc.	693	ip
NL	46.30.41.73	Iron Hosting Centre Ltd., London, UK (Eurobyte VPS)	693	ip
RU	109.61.108.158	Securebit AG	693	ip
US	66.154.117.245	ASSERTIVENET	693	ip
DE	78.47.146.151	Hetzner Online GmbH	694	ip
FI	85.204.18.93	Snowd Security OU	694	ip
FI	46.17.106.121	I-SERVERS LTD	694	ip
FI	93.152.207.174	GLOBAL CONNECTIVITY SOLUTIONS LLP	694	ip
FI	151.245.140.204	HOSTKEY B.V.	694	ip
LV	31.58.137.94	Private Customer	694	ip
LV	217.60.60.38	CGI GLOBAL LIMITED	694	ip
NL	31.57.196.39	Private Customer	694	ip
NL	95.142.41.131	Iron Hosting Centre LTD	694	ip
RU	31.129.49.103	Selectel Network	694	ip
US	31.172.69.16	www.fornex.com, Fornex Hosting S.L.	694	ip
US	185.106.95.125	GTELCOM LLC	694	ip
EE	80.77.25.142	servinga.com - Estonia	695	ip
LV	193.164.155.38	as56971 network	695	ip
LV	46.8.71.249	as56971 network	695	ip
US	149.28.56.202	Vultr Holdings, LLC	695	ip
US	158.101.97.163	Oracle Public Cloud	695	ip
DE	88.198.82.147	Hetzner Online GmbH	696	ip
FI	89.125.210.106	Snowd Security OU	696	ip
FI	193.47.60.247	Baykov Ilya Sergeevich	696	ip
DE	138.201.170.108	Hetzner Online GmbH	697	ip
FI	194.180.189.194	HOSTKEY B.V.	697	ip
FI	192.145.29.96	Baykov Ilya Sergeevich	697	ip
LV	95.182.90.125	Cloud Software - FZCO	697	ip
LV	217.60.60.49	CGI GLOBAL LIMITED	697	ip
NL	2.27.169.118	Private Customer	697	ip
US	150.136.102.41	Oracle Public Cloud	697	ip
DE	5.75.220.97	Hetzner Online GmbH	698	ip
FI	212.237.219.24	HOSTKEY B.V.	698	ip
FI	95.214.9.167	FIRST SERVER, SOCIEDAD LIMITADA	698	ip
LV	31.56.177.194	CGI GLOBAL LIMITED	698	ip
CZ	178.208.91.177	Iron Hosting Centre Ltd., London, UK (mchost)	699	ip
FI	185.94.167.223	PSERVERS Enterprise Network	699	ip
FI	45.14.165.234	Baykov Ilya Sergeevich	699	ip
LV	185.113.139.184	Baykov Ilya Sergeevich	699	ip
RU	185.151.243.200	Selectel Network	699	ip
US	150.136.117.165	Oracle Public Cloud	699	ip
FI	185.104.250.9	PSERVERS Enterprise Network	700	ip
LV	91.239.23.93	Perviy TSOD LLC	700	ip
LV	195.123.210.147	GREEN FLOID LLC	700	ip
CA	155.138.128.135	Vultr Holdings, LLC	701	ip
GB	51.195.235.202	OVH Ltd	701	ip
LV	31.56.206.215	CGI GLOBAL LIMITED	701	ip
SE	51.20.202.203	A100 ROW Inc	701	ip
FI	212.237.219.99	HOSTKEY B.V.	702	ip
LV	31.56.113.117	as56971 network	702	ip
NL	178.208.66.185	Iron Hosting Centre Ltd., London, UK	702	ip
NL	185.37.8.234	Brainoza OU	702	ip
PL	194.59.186.97	Pronet LLC	702	ip
LV	31.58.77.150	CGI GLOBAL LIMITED	703	ip
US	31.59.40.241	CGI GLOBAL LIMITED	703	ip
EE	185.36.141.81	Brainoza OU	704	ip
LV	91.204.75.253	Individual Entrepreneur Anton Levin	704	ip
LV	31.59.106.71	CGI GLOBAL LIMITED	704	ip
SE	51.21.18.89	A100 ROW Inc	704	ip
US	63.142.251.8	Nodisto IT, LLC	704	ip
US	140.99.254.179	Internet Utilities NA LLC	704	ip
LV	104.252.127.58	Subnet Digital LLC	705	ip
TR	94.131.108.136	WorkTitans B.V.	705	ip
LV	92.118.148.225	Friendhosting LTD	706	ip
LV	185.92.183.217	as56971 network	706	ip
LV	46.8.237.3	CGI GLOBAL LIMITED	706	ip
LV	94.183.190.163	CGI GLOBAL LIMITED	706	ip
NL	185.94.164.160	FIRST SERVER LIMITED	706	ip
US	128.203.252.97	Microsoft Corp	706	ip
US	205.185.113.76	FranTech Solutions	706	ip
US	208.167.245.42	Vultr Holdings, LLC	706	ip
DK	193.180.208.234	Webdock AS44803	707	ip
LV	31.57.26.159	CGI GLOBAL LIMITED	707	ip
LV	31.57.106.178	CGI GLOBAL LIMITED	707	ip
LV	46.8.232.233	CGI GLOBAL LIMITED	707	ip
NL	77.221.133.14	IHC network in Amsterdam, NL	707	ip
PL	176.124.33.59	BlueVPS OU	707	ip
RU	109.205.56.213	RocketCloud.ru	707	ip
DE	5.187.7.220	www.fornex.com, Fornex Hosting S.L.	708	ip
DE	49.12.62.150	MASTERCODE	708	ip
LV	151.242.43.135	Private Customer	708	ip
TR	45.89.52.247	WorkTitans B.V.	708	ip
FI	45.67.202.173	Snowd Security OU	709	ip
LV	85.159.228.232	GLOBAL CONNECTIVITY SOLUTIONS LLP	709	ip
LV	31.57.105.164	CGI GLOBAL LIMITED	709	ip
US	129.146.243.18	Oracle Corporation	709	ip
US	45.38.249.40	Subnet Digital LLC	709	ip
TR	185.255.93.189	2E TELEKOMUNIKASYON LTD STI	710	ip
FI	185.58.207.112	I-SERVERS LTD	711	ip
TR	94.131.123.74	WorkTitans B.V.	711	ip
US	52.230.146.177	Microsoft Corporation	711	ip
US	147.45.60.98	GLOBAL CONNECTIVITY SOLUTIONS LLP	711	ip
AU	169.224.230.14	Oracle Corporation	712	ip
EE	5.101.180.145	Network for hosting services	712	ip
FI	193.222.97.232	Individual Entrepreneur Anton Levin	712	ip
LV	31.57.107.178	CGI GLOBAL LIMITED	712	ip
NL	158.173.195.25	Private Customer	712	ip
RU	157.22.231.205	AdminVPS OOO	712	ip
US	150.136.58.0	Oracle Public Cloud	712	ip
FI	87.239.250.142	FIRST SERVER LIMITED	713	ip
FI	66.151.35.81	HOSTKEY B.V.	713	ip
FR	161.97.66.16	Contabo GmbH	713	ip
NL	158.173.195.180	Private Customer	713	ip
BG	185.82.218.224	ITLDC EU2.SOF Datacenter Network	714	ip
FI	144.31.184.200	CHSL Helsinki	714	ip
SE	130.49.190.27	GLOBAL CONNECTIVITY SOLUTIONS LLP	714	ip
US	129.80.172.213	Oracle Corporation	714	ip
FI	66.151.35.226	HOSTKEY B.V.	715	ip
TR	94.131.123.12	WorkTitans B.V.	715	ip
US	129.213.148.107	Oracle Corporation	715	ip
US	149.28.62.21	Vultr Holdings, LLC	715	ip
FI	198.105.124.163	I-SERVERS LTD	716	ip
LV	31.57.106.35	CGI GLOBAL LIMITED	716	ip
MD	194.102.104.18	Cloudflare London, LLC	716	ip
NL	147.90.89.248	Private Customer	716	ip
RU	213.171.29.38	Cloud Technologies LLC trading as Cloud.ru	716	ip
US	209.237.135.93	Web.com Group, Inc.	716	ip
FI	212.237.219.37	HOSTKEY B.V.	717	ip
LT	89.40.15.168	UAB Interneto vizija	717	ip
LV	46.8.64.232	CGI GLOBAL LIMITED	717	ip
US	129.80.221.237	Oracle Corporation	717	ip
FI	195.26.230.188	Unknown ISP	718	ip
FI	45.133.245.28	I-SERVERS LTD	718	ip
RU	45.141.102.169	MT FINANCE LLC	718	ip
RU	157.22.230.81	AdminVPS OOO	718	ip
DE	91.107.254.128	Hetzner Online GmbH	719	ip
GB	45.89.63.101	Baykov Ilya Sergeevich	719	ip
IS	194.247.183.118	HOSTKEY B.V.	719	ip
LV	104.252.127.144	Subnet Digital LLC	719	ip
LV	46.8.64.53	CGI GLOBAL LIMITED	719	ip
TR	31.40.204.93	White Label Services, LLC	719	ip
LV	46.8.236.208	CGI GLOBAL LIMITED	720	ip
US	129.159.84.71	Oracle Corporation	720	ip
US	150.136.81.108	Oracle Public Cloud	720	ip
EE	185.4.73.45	IPv6 network for hosting services	721	ip
LT	195.181.244.216	UAB Interneto vizija	721	ip
PL	188.116.40.37	Artnet Sp. z o.o.	721	ip
SE	84.32.99.133	Private Customer	721	ip
FI	45.67.202.36	Snowd Security OU	722	ip
LT	45.93.137.149	Hostinger International Limited	722	ip
LV	31.59.41.159	CGI GLOBAL LIMITED	722	ip
US	206.81.10.201	DigitalOcean, LLC	722	ip
TR	77.92.145.164	ULTAHOST HOSTING VE VERI MERKEZI LTD. STI.	724	ip
US	144.34.228.162	Cluster Logic Inc	724	ip
DE	88.198.82.158	Hetzner Online GmbH	725	ip
EE	185.36.141.193	Brainoza OU	725	ip
LV	31.57.62.124	CGI GLOBAL LIMITED	725	ip
US	150.136.6.109	Oracle Public Cloud	725	ip
US	77.110.124.146	NetCrafters OU	725	ip
LV	95.182.115.72	CGI GLOBAL LIMITED	726	ip
US	185.28.175.51	Anton Levin	726	ip
DE	88.198.82.155	Hetzner Online GmbH	727	ip
DE	188.245.161.141	Hetzner Online GmbH	728	ip
NL	147.90.89.88	Private Customer	728	ip
NL	45.12.69.178	Iron Hosting Centre Ltd., London, UK (rw)	728	ip
RU	212.74.227.162	Selectel Network	728	ip
TR	89.45.45.110	2E Telekomunikasyon LTD. STI.	728	ip
US	129.213.94.19	Oracle Public Cloud	728	ip
GB	129.151.93.57	Oracle Corporation	729	ip
KG	188.240.213.40	RCS Technologies FZE LLC	729	ip
NL	195.78.49.204	Retzor-com	729	ip
PL	178.255.46.176	Artnet Sp. z o.o.	729	ip
GB	85.192.60.101	AEZA GROUP LLC	730	ip
SE	84.32.208.201	Private Customer	730	ip
TR	82.26.136.32	HOSTKEY B.V.	730	ip
FI	212.237.219.73	HOSTKEY B.V.	731	ip
SE	129.151.204.65	Oracle Corporation	731	ip
US	143.47.96.200	Oracle Corporation	731	ip
US	143.198.31.221	DigitalOcean, LLC	731	ip
LV	31.57.106.126	CGI GLOBAL LIMITED	732	ip
NL	109.120.154.167	Iron Hosting Centre LTD	732	ip
RU	5.129.243.72	JSC TIMEWEB	732	ip
US	172.174.11.248	Microsoft Limited	732	ip
US	150.136.160.138	Oracle Public Cloud	732	ip
US	77.110.114.56	NetCrafters OU	733	ip
US	162.243.115.22	DigitalOcean, LLC	733	ip
RU	91.188.213.107	Helou LLC	734	ip
DE	78.47.150.18	Hetzner Online GmbH	735	ip
FI	202.71.12.226	Snowd Security OU	735	ip
FI	144.31.126.232	Ace Data Centers II, LLC	735	ip
FI	2.26.105.99	Xorek.Cloud Helsinki	735	ip
FR	185.208.206.40	Contabo GmbH	735	ip
LV	188.130.206.93	CGI GLOBAL LIMITED	735	ip
TR	45.12.143.25	WorkTitans B.V.	735	ip
US	129.159.119.161	Oracle Corporation	735	ip
US	150.136.76.13	Oracle Public Cloud	736	ip
US	150.136.105.229	Oracle Public Cloud	737	ip
US	51.81.223.184	OVH US LLC	737	ip
US	3.86.85.68	Amazon Data Services Northern Virginia	737	ip
US	92.118.10.173	FIRST SERVER, SOCIEDAD LIMITADA	738	ip
DE	176.9.228.165	Vahid Daneshmand	739	ip
US	38.180.204.104	3NT SOLUTIONS LLP	739	ip
US	172.212.108.47	Microsoft Limited	739	ip
US	162.243.1.134	DigitalOcean, LLC	739	ip
NL	202.133.89.8	BitCommand LLC	740	ip
US	20.39.37.65	Microsoft Limited	740	ip
US	64.227.6.94	DigitalOcean, LLC	740	ip
US	138.128.247.246	Cloud Web Manage	740	ip
CH	5.175.236.58	Switzerland infrastructure	741	ip
RU	212.193.26.83	JSC TIMEWEB	741	ip
US	4.236.130.132	Microsoft Corporation	741	ip
DE	167.233.25.42	Hetzner Online GmbH	742	ip
NL	31.15.19.61	IT-DELUX ltd.	742	ip
US	204.12.225.226	WholeSale Internet, Inc.	742	ip
AU	207.211.148.122	Oracle Corporation	743	ip
CH	5.175.236.48	Switzerland infrastructure	743	ip
US	20.106.211.232	Microsoft Corporation	743	ip
US	44.209.52.7	Amazon Data Services Northern Virginia	743	ip
CA	45.133.18.31	ITGLOBAL.COM NL B.V.	744	ip
CA	159.203.2.180	DigitalOcean, LLC	744	ip
US	150.136.102.152	Oracle Corporation	744	ip
US	34.132.50.119	Google LLC	745	ip
US	78.111.88.107	ITGLOBAL.COM NL B.V.	746	ip
US	162.243.0.223	DigitalOcean, LLC	746	ip
LV	85.203.39.55	EstNOC-Global	747	ip
DE	194.5.65.61	Huize Holdings LLC	748	ip
US	162.243.8.196	DigitalOcean, LLC	748	ip
LV	46.8.228.102	CGI GLOBAL LIMITED	749	ip
NL	46.29.239.149	LLC POWERNET	749	ip
US	132.145.145.12	Oracle Corporation	749	ip
US	46.17.107.199	FIRST SERVER, SOCIEDAD LIMITADA	749	ip
US	198.251.81.70	FranTech Solutions	749	ip
US	82.26.93.52	HOSTKEY B.V.	749	ip
DE	47.245.131.215	Alibaba Cloud LLC	750	ip
CA	167.99.183.13	DigitalOcean, LLC	751	ip
CH	5.175.236.54	Switzerland infrastructure	751	ip
UA	91.218.212.223	TOV 'Dream Line Holding'	751	ip
US	107.172.155.121	RackNerd LLC	751	ip
US	107.173.53.237	RackNerd LLC	751	ip
CH	176.10.125.114	Datasource AG	752	ip
KR	192.46.231.158	The Constant Company, LLC	753	ip
PL	37.252.6.119	IROKO Networks Corporation	753	ip
US	150.136.139.228	Oracle Public Cloud	753	ip
US	38.132.122.241	M247 Europe SRL	753	ip
DE	140.99.101.63	Internet Utilities NA LLC	754	ip
US	77.110.125.182	NetCrafters OU	754	ip
IE	54.77.206.41	Amazon Technologies Inc.	755	ip
NL	31.15.19.21	Individual Entrepreneur Ildar Gilmutdinov	755	ip
NL	31.15.19.180	Individual Entrepreneur Ildar Gilmutdinov	755	ip
RU	91.243.86.18	EdgeCenter LLC	755	ip
US	107.172.139.14	RackNerd LLC	755	ip
US	165.22.32.120	DigitalOcean, LLC	755	ip
CH	5.175.236.53	Switzerland infrastructure	756	ip
FI	85.90.208.87	IROKO Networks Corporation	756	ip
RU	45.129.2.201	LLC Baxet	756	ip
US	191.222.247.124	Private Customer	756	ip
FI	31.77.158.172	play2go.cloud - Cheap and reliable hosting	757	ip
US	51.81.209.10	OVH US LLC	757	ip
CA	167.160.190.137	HostPapa	758	ip
LV	168.222.255.164	Individual Entrepreneur Anton Levin	758	ip
US	107.170.4.12	DigitalOcean, LLC	759	ip
US	198.23.187.242	HostPapa	759	ip
NL	194.147.149.54	IT-DELUX ltd.	760	ip
RU	161.104.44.138	Selectel Network	760	ip
CA	45.133.16.41	ITGLOBAL.COM NL B.V.	761	ip
DE	185.250.180.145	Huize Holdings LLC	761	ip
US	178.156.139.174	Hetzner Online GmbH	761	ip
CA	72.11.145.117	HostPapa	762	ip
NL	89.150.35.155	CLODO CLOUD SERVICE CO. L.L.C	762	ip
FI	109.206.243.100	Xorek.Cloud Helsinki	763	ip
US	159.65.240.40	DigitalOcean, LLC	763	ip
CH	185.195.69.19	Datasource AG	764	ip
FI	194.113.38.246	Xorek.Cloud Helsinki	764	ip
NL	43.170.17.114	16 COLLYER QUAY # 18-29 INCOME AT RAFFLES	764	ip
UA	31.41.221.121	ON-LINE Ltd	764	ip
US	162.243.115.23	DigitalOcean, LLC	764	ip
CH	5.175.236.4	Switzerland infrastructure	765	ip
DE	5.231.223.188	on1x infrastructure	767	ip
FI	2.26.23.174	Xorek.Cloud Helsinki	767	ip
US	104.168.56.73	HostPapa	767	ip
US	23.94.79.83	HostPapa	767	ip
DE	5.231.223.183	on1x infrastructure	768	ip
US	172.245.180.180	RackNerd LLC	768	ip
US	167.99.49.60	DigitalOcean, LLC	770	ip
NL	194.147.149.62	IT-DELUX ltd.	771	ip
NL	31.15.19.10	Individual Entrepreneur Ildar Gilmutdinov	771	ip
PL	91.92.46.238	Baykov Ilya Sergeevich	771	ip
RU	217.26.29.24	Beget LLC	771	ip
AM	2.56.204.183	Proitlab LLC	772	ip
DE	212.113.112.23	LIMITED LIABILITY COMPANY RELCOM-SPB	772	ip
DE	89.58.45.162	netcup GmbH	772	ip
RU	185.105.91.243	FIRST SERVER, SOCIEDAD LIMITADA	772	ip
AU	16.176.42.97	Amazon Corporate Services Pty Ltd	773	ip
FI	94.156.180.27	SERV.HOST GROUP LTD	773	ip
RU	45.10.41.205	JSC TIMEWEB	773	ip
US	129.80.89.243	Oracle Corporation	773	ip
US	45.138.27.90	ITGLOBAL.COM NL B.V.	774	ip
AU	207.211.146.175	Oracle Corporation	775	ip
US	107.175.209.186	HostPapa	775	ip
FI	144.31.143.6	Xorek.Cloud Helsinki	776	ip
NL	31.15.19.106	Individual Entrepreneur Ildar Gilmutdinov	776	ip
PL	64.176.68.73	The Constant Company, LLC	776	ip
US	172.232.232.163	Linode	776	ip
US	95.182.94.210	Cloud Software - FZCO	776	ip
CA	172.98.207.58	CENTRILOGICCANADA	777	ip
RU	84.252.75.139	FIRST SERVER, SOCIEDAD LIMITADA	778	ip
US	104.234.50.53	Private Customer	778	ip
CA	72.11.150.104	HostPapa	779	ip
DE	46.38.241.239	netcup GmbH	779	ip
US	192.210.133.140	RackNerd LLC	779	ip
CA	40.233.99.248	Oracle Corporation	780	ip
CA	140.238.144.211	Oracle Corporation	780	ip
EG	38.54.59.70	LIGHT NODE LIMITED	780	ip
FI	94.156.180.201	SERV.HOST GROUP LTD	780	ip
RU	84.54.57.138	Cloud Technologies LLC trading as Cloud.ru	780	ip
RU	45.9.13.99	UFO Hosting LLC	780	ip
RU	185.26.121.79	Hostland ltd	780	ip
US	8.221.126.227	Aliyun Computing Co.LTD	780	ip
US	198.96.88.148	Interserver, Inc	780	ip
NL	158.101.218.12	Oracle Public Cloud	781	ip
RU	80.76.42.191	TIME-HOST-NET	781	ip
CA	40.233.71.238	Oracle Corporation	782	ip
RU	95.215.108.132	GLOBAL INTERNET SOLUTIONS LLC	782	ip
CA	40.233.103.212	Oracle Corporation	783	ip
BE	35.210.99.51	Google LLC	784	ip
CA	40.233.87.120	Oracle Corporation	784	ip
CH	91.192.102.55	Datasource AG	785	ip
FI	31.77.144.240	play2go.cloud - Cheap and reliable hosting	785	ip
RU	194.67.203.149	PSERVERS Enterprise Network	786	ip
RU	185.137.235.254	Selectel Network	786	ip
US	166.1.160.140	Ace Data Centers, Inc.	786	ip
RU	91.188.214.126	Helou LLC	788	ip
RU	217.18.60.228	JSC TIMEWEB	788	ip
RU	185.128.107.175	FIRST SERVER, SOCIEDAD LIMITADA	788	ip
US	162.243.115.21	DigitalOcean, LLC	788	ip
DE	94.159.108.42	H2NEXUS LTD	789	ip
SE	91.184.247.38	Linode	791	ip
US	45.148.125.245	Baykov Ilya Sergeevich	791	ip
DE	152.53.229.84	netcup GmbH	792	ip
DE	94.159.98.123	H2NEXUS LTD	793	ip
PL	70.34.251.88	The Constant Company, LLC	794	ip
CA	140.238.158.86	Oracle Public Cloud	795	ip
PL	91.92.46.117	Baykov Ilya Sergeevich	795	ip
US	31.169.125.150	Baykov Ilya Sergeevich	795	ip
US	23.95.148.8	RackNerd LLC	795	ip
US	162.251.204.43	BGP Announcement	796	ip
DE	94.159.103.41	H2NEXUS LTD	797	ip
NL	62.132.1.27	Private Customer	798	ip
US	43.170.25.96	ACE	798	ip
RU	141.98.190.45	UFO Hosting LLC	799	ip
RU	5.129.223.137	JSC TIMEWEB	799	ip
US	204.44.74.241	HostPapa	799	ip
DE	152.53.138.139	Anexia Holding GmbH	800	ip
RU	45.91.52.102	Delta Ltd	800	ip
CH	91.192.102.153	Datasource AG	801	ip
RU	95.182.120.53	Ildar Gilmutdinov PE	801	ip
US	198.160.7.51	Perfecto Mobile Inc	801	ip
CA	40.233.116.225	Oracle Corporation	802	ip
RU	89.127.197.225	www.fornex.com, Fornex Hosting S.L.	802	ip
RU	5.129.245.158	JSC TIMEWEB	802	ip
DE	8.209.83.19	Westendstrabe 28, 60325 Frankfurt am Main	803	ip
GB	140.235.74.26	berrybyte	803	ip
GB	34.39.62.53	Google LLC	803	ip
RU	45.132.255.173	FIRST SERVER, SOCIEDAD LIMITADA	803	ip
US	107.172.222.174	Danny Dahl	803	ip
BE	35.241.172.224	Google LLC	804	ip
IL	82.166.137.24	ADSL_VIP	804	ip
PL	70.34.243.123	The Constant Company, LLC	804	ip
RU	212.67.17.226	JSC TIMEWEB	804	ip
US	198.23.150.223	Hurricane Electric LLC	804	ip
DE	167.233.25.100	Hetzner Online GmbH	805	ip
DE	188.40.171.73	HOS-2566228	805	ip
ES	34.175.202.195	Google LLC	805	ip
NL	31.15.19.199	Individual Entrepreneur Ildar Gilmutdinov	805	ip
DE	2.27.35.104	Frankfurt, Germany	806	ip
RU	95.182.120.255	Ildar Gilmutdinov PE	806	ip
RU	194.190.153.170	Ugreshskaya st, 2c147	806	ip
DE	45.140.19.2	Time-Host Ltd	807	ip
DE	45.13.226.112	YottaSrc Hosting and Cloud Service	808	ip
DE	2.28.73.85	Hetzner Online GmbH	808	ip
DE	94.159.103.71	H2NEXUS LTD	809	ip
DE	195.201.150.4	Hetzner Online GmbH	809	ip
DE	88.198.82.156	Hetzner Online GmbH	810	ip
LV	195.135.253.121	SIA VEESP	810	ip
DE	195.201.152.120	Hetzner Online GmbH	813	ip
RU	109.248.168.38	Datacheap LLC	813	ip
DE	91.107.171.251	Hetzner Online GmbH	814	ip
TR	188.132.183.17	ULTAHOST HOSTING VE VERI MERKEZI LTD. STI.	814	ip
CA	68.233.122.42	Oracle Corporation	815	ip
DE	49.13.64.206	Hetzner Online GmbH	815	ip
DK	193.180.211.40	Webdock.io ApS	816	ip
PL	31.169.126.35	Baykov Ilya Sergeevich	816	ip
RU	217.26.26.14	Beget LLC	816	ip
DE	94.159.106.11	H2.NEXUS Frankfurt Network	817	ip
DE	43.240.149.208	DASABO OU	817	ip
RU	80.68.156.187	Timeweb.Cloud LLC	817	ip
RU	5.23.52.184	JSC TIMEWEB	817	ip
US	159.203.34.9	DigitalOcean, LLC	817	ip
AM	2.56.204.246	Proitlab LLC	819	ip
DE	88.198.82.152	Hetzner Online GmbH	820	ip
DE	88.198.82.157	Hetzner Online GmbH	820	ip
DE	31.57.241.56	DASABO OU	821	ip
DE	128.140.73.159	Hetzner Online GmbH	821	ip
PL	31.169.126.66	Baykov Ilya Sergeevich	821	ip
NL	176.222.52.201	HOSTKEY B.V.	823	ip
US	129.159.34.196	Oracle Corporation	823	ip
RU	91.184.244.230	Hosting technology LTD	824	ip
US	75.127.4.251	RackNerd LLC	824	ip
DE	94.159.101.193	H2NEXUS LTD	825	ip
DE	91.99.222.109	Hetzner Online GmbH	825	ip
NL	213.108.199.59	GTELCOM LLC	825	ip
RU	212.67.15.76	Beget LLC	825	ip
DE	185.220.100.168	F3 Netze e.V.	826	ip
DE	94.159.106.205	H2NEXUS LTD	826	ip
LV	216.173.71.171	SIA VEESP	826	ip
DE	94.159.106.20	H2.NEXUS Frankfurt Network	827	ip
US	107.175.89.174	HostPapa	827	ip
LV	188.253.20.190	SIA VEESP	828	ip
NL	77.239.111.51	Amsterdam, Netherlands	828	ip
LV	37.128.204.20	SIA VEESP	829	ip
US	213.170.157.1	RedShield Security Ltd	829	ip
PL	64.176.73.77	The Constant Company, LLC	830	ip
RU	5.181.108.232	Beget LLC	830	ip
US	45.61.184.32	FranTech Solutions	830	ip
DE	94.159.109.104	H2NEXUS LTD	831	ip
RU	195.133.145.236	MT FINANCE LLC	831	ip
HU	109.122.217.24	RackForest	832	ip
FI	92.42.102.109	1Cent Host	833	ip
AU	168.138.29.110	Oracle Public Cloud	834	ip
LV	94.158.219.126	SIA VEESP	834	ip
RU	217.114.12.143	Beget LLC	835	ip
LV	45.43.76.227	SIA VEESP	836	ip
RU	92.241.18.106	JSC Svyazinform	836	ip
LV	169.40.2.78	SIA VEESP	837	ip
FI	79.137.184.183	AEZA GROUP LLC	838	ip
LV	94.158.218.244	SIA VEESP	838	ip
RU	178.20.41.204	VDSINA VDS Hosting	840	ip
IS	89.147.108.252	1984 ehf	841	ip
RU	46.29.115.144	Global Communications LLC	841	ip
RU	85.198.109.141	Hosting technology LTD	841	ip
CA	40.233.77.25	Oracle Corporation	842	ip
RU	45.90.218.109	FIRST SERVER, SOCIEDAD LIMITADA	842	ip
CA	167.114.67.25	OVH Hosting, Inc.	843	ip
DE	94.159.97.247	H2NEXUS LTD	843	ip
LV	91.197.3.7	SIA VEESP	843	ip
CA	149.56.14.62	OVH Hosting, Inc.	844	ip
LV	5.34.210.234	SIA VEESP	845	ip
FI	150.241.88.13	Xorek.Cloud Helsinki	846	ip
DO	181.36.229.212	ALTICE DOMINICANA S.A.	847	ip
TR	188.132.183.40	ULTAHOST HOSTING VE VERI MERKEZI LTD. STI.	847	ip
DE	94.159.100.136	H2NEXUS LTD	849	ip
SE	138.124.71.139	Baykov Ilya Sergeevich	849	ip
CH	152.67.67.58	Cloudflare London, LLC	850	ip
DE	188.68.43.154	netcup GmbH	850	ip
LV	5.34.211.35	SIA VEESP	850	ip
AE	145.241.116.8	Oracle Svenska AB	851	ip
DE	5.252.226.232	netcup GmbH	851	ip
EE	80.79.123.93	Aktsiaselts WaveCom	851	ip
SE	192.145.30.27	Baykov Ilya Sergeevich	851	ip
US	184.174.97.38	REGXA LLC	851	ip
CA	140.238.152.64	Oracle Public Cloud	852	ip
NL	141.144.195.228	Oracle Corporation	852	ip
DE	94.159.110.41	H2NEXUS LTD	853	ip
SE	45.80.229.176	NetCrafters OU	853	ip
EE	83.217.210.42	Baykov Ilya Sergeevich	854	ip
IS	195.246.230.125	1984 ehf	854	ip
US	117.55.231.178	UberGlobal UBRCBRCCA	854	ip
CA	40.233.77.216	Oracle Corporation	855	ip
LV	5.34.214.205	SIA VEESP	855	ip
TR	130.94.1.150	LIGHT NODE LIMITED	855	ip
RU	31.192.111.185	LLC IT BASIS	857	ip
AD	91.187.93.166	Andorra Telecom	858	ip
DE	195.58.38.63	nuxtcloud	858	ip
CA	40.233.110.251	Oracle Corporation	859	ip
LV	185.242.107.169	Veesp datacenter clients	859	ip
RU	192.144.57.214	Hosting technology LTD	859	ip
AM	139.45.214.122	RETN AM Limited Liability Company	860	ip
DK	193.181.210.149	Webdock.io ApS	860	ip
DE	94.159.105.148	H2NEXUS LTD	861	ip
RU	193.124.130.225	Hosting technology LTD	861	ip
CA	40.233.117.135	Oracle Corporation	862	ip
LV	77.73.71.113	SIA VEESP	864	ip
LV	5.34.208.208	SIA VEESP	864	ip
RU	178.154.222.149	Yandex.Cloud LLC	864	ip
RU	147.45.245.15	JSC TIMEWEB	864	ip
FI	87.239.251.89	FIRST SERVER LIMITED	865	ip
LV	46.32.185.5	SIA VEESP	865	ip
RU	217.26.27.147	Beget LLC	865	ip
RU	188.225.34.155	TimeWeb Ltd.	865	ip
DE	193.23.211.202	Senko Digital LLC - DE Network	866	ip
LV	5.34.211.94	SIA VEESP	866	ip
CH	195.141.59.27	Trueb AG	867	ip
FI	83.219.97.75	1Cent Host	867	ip
SE	213.165.33.192	AEZA GROUP LLC	867	ip
US	129.153.217.73	Oracle Corporation	868	ip
EE	38.180.216.120	3NT SOLUTIONS LLP	869	ip
FI	45.144.53.200	H2NEXUS LTD	869	ip
KZ	213.148.10.155	Modern Server Solutions LLP	869	ip
CA	170.9.43.85	Oracle Corporation	871	ip
AM	139.45.214.126	RETN AM Limited Liability Company	873	ip
DE	87.120.126.131	H2.NEXUS Frankfurt Network	873	ip
LV	195.135.253.164	SIA VEESP	873	ip
US	64.49.28.77	TAIPEI101 NETWORK LLC	873	ip
FI	38.244.137.183	3NT SOLUTIONS LLP	874	ip
RU	5.8.52.100	Petersburg Internet Network ltd.	874	ip
LV	192.144.39.33	SIA Serverum	877	ip
LV	193.68.89.45	Versija SIA	877	ip
DE	213.108.198.116	NKtelecom INC	878	ip
EE	80.79.123.100	Aktsiaselts WaveCom	878	ip
FI	138.124.103.161	AEZA GROUP LLC	878	ip
NL	95.181.162.170	AEZA GROUP LLC	879	ip
EE	38.244.154.149	3NT SOLUTIONS LLP	880	ip
FI	193.23.201.56	play2go.cloud - Cheap and reliable hosting	880	ip
NL	194.87.134.130	Timeweb, LLP	880	ip
GB	62.60.186.81	AEZA GROUP LLC	884	ip
LV	5.34.208.18	SIA VEESP	884	ip
SE	37.252.9.236	IROKO Networks Corporation	885	ip
DE	95.169.204.125	MVPS LTD	887	ip
GB	83.147.254.8	AEZA GROUP LLC	888	ip
GB	62.60.250.200	AEZA GROUP LLC	889	ip
FI	45.144.52.173	H2NEXUS LTD	891	ip
LV	2.26.88.78	SERV.HOST GROUP LTD	891	ip
TR	185.200.36.36	High Speed Telekomunikasyon ve Hab. Hiz. Ltd. Sti.	892	ip
GB	62.60.153.58	AEZA GROUP LLC	893	ip
FI	176.125.254.216	FI-Network	895	ip
RU	80.249.151.223	Selectel Network	897	ip
LV	188.253.17.14	SIA VEESP	899	ip
RU	79.143.30.23	Selectel Network	900	ip
SE	91.184.240.196	AEZA GROUP LLC	900	ip
FI	91.186.213.30	NetCrafters OU	901	ip
GB	147.45.76.29	AEZA GROUP LLC	901	ip
GB	185.125.101.29	AEZA GROUP LLC	901	ip
RU	155.212.160.127	JSC IOT	901	ip
RU	94.250.249.129	JSC IOT	901	ip
SE	45.80.231.90	NetCrafters OU	901	ip
RU	194.87.218.134	GLOBAL INTERNET SOLUTIONS LLC	902	ip
LV	188.253.23.155	SIA VEESP	903	ip
EE	138.124.4.38	Baykov Ilya Sergeevich	906	ip
US	40.160.239.172	OVH US LLC	906	ip
NL	185.18.54.143	www.fornex.com, Fornex Hosting S.L.	907	ip
DE	201.10.80.72	GLOBALTECH LLC	908	ip
FI	38.244.136.91	3NT SOLUTIONS LLP	908	ip
LV	91.197.3.157	SIA VEESP	909	ip
FI	31.76.103.14	VPSPay - vpspay.cloud	910	ip
NL	212.87.220.98	Baykov Ilya Sergeevich	910	ip
US	99.63.206.163	AT&T Enterprises, LLC	910	ip
GB	83.147.192.190	AEZA GROUP LLC	914	ip
NL	194.0.194.7	SkyCore Technologies L.L.C-FZ	916	ip
SY	185.235.16.12	Bitakat Company LTD	916	ip
US	107.173.87.103	RackNerd LLC	916	ip
GB	212.113.103.4	AEZA GROUP LLC	918	ip
RU	95.213.226.60	Selectel MSK	918	ip
GB	89.22.227.190	AEZA GROUP LLC	919	ip
MX	148.223.138.11	Uninet S. A. de C.V.	919	ip
SE	77.221.143.166	AEZA GROUP LLC	919	ip
SE	83.147.254.115	AEZA GROUP LLC	919	ip
SE	91.186.217.94	AEZA GROUP LLC	921	ip
SE	77.232.143.94	AEZA GROUP LLC	922	ip
SE	83.147.254.71	AEZA GROUP LLC	922	ip
US	147.75.230.160	Aryaka Networks, Inc.	923	ip
GB	83.147.192.104	AEZA GROUP LLC	924	ip
GB	109.120.132.115	AEZA GROUP LLC	924	ip
NL	45.12.69.139	Iron Hosting Centre Ltd., London, UK (rw)	926	ip
EE	185.255.178.131	Baykov Ilya Sergeevich	928	ip
NL	103.102.228.173	Individual Entrepreneur Anton Levin	928	ip
FI	83.147.252.215	AEZA GROUP LLC	929	ip
CA	151.145.42.203	Oracle Corporation	930	ip
NL	31.77.103.218	Private Customer	930	ip
RU	185.247.185.103	JSC TIMEWEB	930	ip
GB	62.60.237.175	AEZA GROUP LLC	933	ip
FI	109.120.134.104	AEZA GROUP LLC	935	ip
FI	194.113.38.229	Xorek.Cloud Helsinki	938	ip
GB	85.192.25.131	AEZA GROUP LLC	938	ip
FI	138.124.25.223	AEZA GROUP LLC	939	ip
NL	79.132.139.128	www.fornex.com, Fornex Hosting S.L.	939	ip
GB	77.221.136.148	AEZA GROUP LLC	943	ip
GB	83.147.252.174	AEZA GROUP LLC	949	ip
NL	176.222.54.227	HOSTKEY B.V.	949	ip
RU	155.212.216.144	Beget LLC	950	ip
FI	62.60.237.142	NetCrafters OU	951	ip
GB	83.147.254.36	AEZA GROUP LLC	951	ip
SE	77.110.97.230	AEZA GROUP LLC	951	ip
RU	80.87.198.98	JSC Datacenter	953	ip
GB	83.147.254.14	AEZA GROUP LLC	956	ip
SE	109.120.134.216	AEZA GROUP LLC	956	ip
UZ	82.148.2.86	SERVERCORE UZ Network	956	ip
AE	3.29.240.49	Amazon Data Services UAE	959	ip
GB	147.45.72.251	AEZA GROUP LLC	961	ip
FI	65.109.141.230	Hetzner Online GmbH	964	ip
FI	65.21.16.186	Hetzner Online GmbH	964	ip
GB	79.137.248.111	AEZA GROUP LLC	966	ip
SE	89.22.233.52	AEZA GROUP LLC	966	ip
SE	91.186.217.49	NetCrafters OU	966	ip
SE	83.147.254.63	AEZA GROUP LLC	966	ip
GB	77.221.138.138	AEZA GROUP LLC	967	ip
SE	213.176.119.139	NetCrafters OU	968	ip
FI	83.147.192.158	AEZA GROUP LLC	971	ip
RU	2.26.104.64	Russia, Moscow	972	ip
RU	2.26.104.87	Russia, Moscow	972	ip
RU	45.8.249.237	JSC Selectel	973	ip
US	147.75.230.207	Aryaka Networks, Inc.	973	ip
DE	87.251.87.249	nuxtcloud	975	ip
FI	95.216.223.177	Hetzner Online GmbH	977	ip
US	147.75.230.33	Aryaka Networks, Inc.	978	ip
SE	77.110.96.220	AEZA GROUP LLC	979	ip
CH	144.24.255.71	Oracle Corp UK Ltd	980	ip
GB	77.110.97.193	AEZA GROUP LLC	980	ip
SE	89.22.236.205	AEZA GROUP LLC	980	ip
FI	85.192.31.30	AEZA GROUP LLC	982	ip
GB	77.221.143.39	AEZA GROUP LLC	984	ip
SE	185.58.115.45	Baykov Ilya Sergeevich	985	ip
EE	185.123.53.53	BlueVPS OU	986	ip
RU	31.76.230.241	Russia, Moscow	987	ip
GB	77.221.136.180	AEZA GROUP LLC	994	ip
FI	65.21.16.187	Hetzner Online GmbH	995	ip
GB	193.188.20.224	AEZA GROUP LLC	998	ip
LV	193.68.89.220	Versija SIA	999	ip
AE	84.235.255.82	Oracle Svenska AB	1005	ip
FI	79.137.206.249	AEZA GROUP LLC	1005	ip
NL	185.75.189.205	WEBHOST LLC	1005	ip
SE	41.216.182.98	FORTIS Hosting services	1009	ip
US	129.153.214.71	Oracle Corporation	1010	ip
FI	95.217.177.97	Hetzner Online GmbH	1012	ip
FI	65.21.62.180	Hetzner Online GmbH	1014	ip
RU	152.89.218.135	LLC Smart Ape	1015	ip
FI	64.188.74.233	Senko Digital LLC - FI Network	1016	ip
RU	109.73.205.8	JSC TIMEWEB	1017	ip
FI	135.181.84.31	Hetzner Online GmbH	1019	ip
FI	95.217.12.150	Hetzner Online GmbH	1020	ip
GB	147.45.76.230	AEZA GROUP LLC	1021	ip
SE	109.120.132.6	AEZA GROUP LLC	1021	ip
FI	65.21.122.159	HOS-799619	1027	ip
LV	217.145.79.186	Private Customer	1027	ip
US	172.252.125.72	2E TELEKOMUNIKASYON LTD STI	1029	ip
FI	65.21.109.73	Hetzner Online GmbH	1032	ip
NL	188.226.153.14	Digital Ocean, Inc.	1032	ip
CL	129.151.124.127	Oracle Corporation	1037	ip
RU	109.107.189.6	AEZA GROUP Ltd	1039	ip
FI	89.167.109.28	Hetzner Online GmbH	1040	ip
SE	51.20.160.11	A100 ROW Inc	1041	ip
BY	144.31.129.7	H2.NEXUS Minsk Network	1044	ip
RU	77.223.96.12	Selectel Network	1044	ip
FR	85.208.70.235	Three Fourteen SASU	1047	ip
FI	45.144.53.206	H2NEXUS LTD	1053	ip
GB	109.120.134.11	AEZA GROUP LLC	1053	ip
BR	157.151.4.93	Oracle Corporation	1054	ip
SE	83.147.254.245	AEZA GROUP LLC	1056	ip
FI	65.108.217.253	Hetzner Online GmbH	1059	ip
CL	186.67.70.55	ENTEL CHILE S.A.	1061	ip
SE	91.186.219.82	NetCrafters OU	1065	ip
US	47.57.181.17	Alibaba Cloud - US	1066	ip
BR	38.180.79.9	3NT SOLUTIONS LLP	1069	ip
FI	95.216.140.177	Hetzner Online GmbH	1069	ip
FI	37.27.11.192	Hetzner Online GmbH	1070	ip
FI	95.217.164.169	Hetzner Online GmbH	1078	ip
CA	148.116.81.218	Oracle Corporation	1081	ip
KZ	185.4.180.39	PS Internet Company LLP	1085	ip
BR	38.180.78.255	3NT SOLUTIONS LLP	1087	ip
FI	84.22.150.176	NetCrafters OU	1089	ip
FI	65.108.245.196	Hetzner Online GmbH	1089	ip
FI	65.21.224.102	Hetzner Online GmbH	1101	ip
FI	85.192.48.34	H2NEXUS LTD	1102	ip
ZA	102.130.120.40	Light Bridge Internet (Pty) Ltd	1107	ip
AU	168.138.22.243	Cloudflare, Inc.	1108	ip
BR	150.230.78.183	Oracle Corporation	1113	ip
NL	79.137.205.184	AEZA GROUP Ltd	1115	ip
BR	64.181.188.99	Oracle Corporation	1117	ip
DE	185.236.26.30	Huize Holdings LLC	1119	ip
ZA	84.8.142.203	Oracle Svenska AB	1122	ip
KZ	38.180.38.137	3NT SOLUTIONS LLP	1124	ip
ZA	102.210.243.7	Light Bridge Internet (Pty) Ltd	1128	ip
CL	129.151.113.165	Cloudflare London, LLC	1132	ip
US	192.193.104.25	Citibank N.A.	1132	ip
DE	2.26.118.141	nuxtcloud	1142	ip
FI	95.217.237.91	Hetzner Online GmbH	1152	ip
FI	37.27.24.143	Hetzner Online GmbH	1157	ip
FI	64.188.76.196	1Cent Host	1160	ip
FR	37.187.98.185	OVH SAS	1173	ip
FI	37.27.92.255	Hetzner Online GmbH	1174	ip
FI	109.120.185.29	NetCrafters OU	1177	ip
LT	5.199.173.195	UAB Cherry Servers	1187	ip
SA	158.101.242.224	Cloudflare London, LLC	1202	ip
DE	146.19.207.133	Cloud Hosting Solutions, Limited.	1216	ip
FI	65.109.214.25	Hetzner Online GmbH	1247	ip
FI	37.27.113.239	Hetzner Online GmbH	1248	ip
KZ	45.88.90.13	GLB Bulut Teknolojisi Limited Sirketi	1255	ip
NL	31.134.207.148	DC1.AMSTERDAM Cooperatie U.A.	1260	ip
BR	201.16.130.6	ALGAR TELECOM S/A	1271	ip
HK	38.190.210.250	SonderCloud Limited	1279	ip
KZ	91.200.148.120	Quasar LLC	1285	ip
FI	46.62.164.80	Hetzner Online GmbH	1340	ip
CO	157.137.229.226	Oracle Corporation	1410	ip
US	45.12.88.57	Hostsymbol Pte. Ltd.	1457	ip
LT	5.199.162.130	UAB Cherry Servers	1481	ip
ZA	84.8.137.211	Cloudflare London, LLC	1543	ip
FI	91.186.212.238	NetCrafters OU	1574	ip
NL	185.185.41.34	HostUS	1599	ip
DE	132.226.197.103	Oracle Public Cloud	1617	ip
DE	212.113.99.18	Eduard Ilin	1646	ip
AU	45.77.236.204	Vultr Holdings, LLC	1648	ip
DE	91.149.222.113	BG-NETWORK	1653	ip
FI	89.125.2.229	Snowd Security OU	1691	ip
FI	194.164.235.67	Unknown ISP	1735	ip
AU	207.211.157.214	Oracle Corporation	1780	ip
US	147.135.10.209	OVH US LLC	1829	ip
NL	217.60.26.123	as56971 network	1882	ip
FI	144.31.152.127	Xorek.Cloud Helsinki	1887	ip
DE	77.239.98.122	nuxt.cloud	2057	ip
US	179.255.185.123	IT Hostline Ltd	2257	ip
NL	193.124.49.35	Baxet Group Inc.	2310	ip
AU	137.23.29.90	Oracle Corporation	2356	ip
FR	145.223.69.87	NET 145 223 68 0 22	2632	ip
DE	89.40.117.130	Cloud Services DC05	2643	ip
HU	38.180.109.174	3NT SOLUTIONS LLP	3638	ip
JP	153.121.45.101	SAKURA Internet Inc.	3751	ip
NL	84.235.167.198	Oracle Corporation	3837	ip
DE	5.181.187.58	freakhosting.com	4429	ip
FI	46.243.6.218	PSERVERS Enterprise Network	4699	ip
JP	38.207.130.136	Nearoute Limited	4773	ip
DE	8.211.36.136	Alibaba Cloud (Singapore) Private Limited	4843	ip
IN	219.65.73.81	Reliance Jio Infocomm Limited	5039	ip
RU	217.70.20.11	Cloudflare London, LLC	5398	ip
RU	95.171.21.193	Universum bit Ltd.	6127	ip
DE	94.159.99.172	H2.NEXUS Frankfurt Network	7856	ip`;

/** @typedef {{ cc: string, host: string, isp: string, latency: number, kind: string }} ProxyEntry */

/** @type {ProxyEntry[] | null} */
let cachedCatalog = null;

/**
 * Parses PROXY_CATALOG once per isolate.
 * @returns {ProxyEntry[]}
 */
function getProxyCatalog() {
	if (cachedCatalog) return cachedCatalog;
	cachedCatalog = PROXY_CATALOG.split('\n').filter((line) => line.length > 0).map((line) => {
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
 * Times a TCP handshake to host:443 from the Cloudflare edge.
 *
 * This is deliberately NOT the same measurement as the catalog's latency
 * figure. The catalog value is a full TCP + TLS + HTTP round trip made through
 * the proxy to Cloudflare from a client machine; this is a bare TCP handshake
 * from a Cloudflare PoP that is usually close to the proxy. Expect it to be far
 * smaller, and do not compare the two - /list keeps them in separate columns
 * for that reason.
 *
 * @param {string} host
 * @returns {Promise<number | null>} round trip in milliseconds, or null if unreachable
 */
async function measureHost(host) {
	const started = Date.now();
	let socket;
	try {
		socket = connect({ hostname: host, port: 443 });
		await Promise.race([
			socket.opened,
			new Promise((_, reject) => setTimeout(() => reject(new Error('ERR_MEASURE_TIMEOUT')), MEASURE_TIMEOUT_MS)),
		]);
		return Date.now() - started;
	} catch (error) {
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
function renderProxyListPage(userIDs, hostName) {
	const bootstrap = JSON.stringify({
		host: hostName || '',
		uuids: userIDs,
		names: COUNTRY_NAMES,
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
			<label class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400" title="Swap the address in every generated link for the Vinaphone test host">
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
			hint: 'TCP + TLS + HTTP round trip through the proxy to Cloudflare, measured from Central Europe when the catalog was built' },
		{ key: 'edge', label: 'Edge', filter: null,
			hint: 'TCP handshake from the Cloudflare edge to the proxy, measured on demand. Not comparable with Scan: no TLS, no HTTP, and a different origin' },
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
	// undefined means never probed, null means the probe found it unreachable.
	function edgeSortValue(row) {
		if (row.live === undefined || row.live === null) return Infinity;
		return row.live;
	}

	function linkFor(row) {
		var sni = DATA.host;
		// "Test Vinaphone" swaps only the address, keeping the row's tag so the
		// link can still be traced back to the proxy it was generated from.
		var address = el.vinaphone.checked ? VINAPHONE_ADDRESS : row.host + ':443';
		return 'vless://' + el.uuid.value + '@' + address
			+ '?encryption=none&security=tls&sni=' + sni + '&fp=chrome&type=ws&host=' + sni
			+ '&path=%2F%3Fed%3D2048#' + encodeURIComponent(row.cc + '-' + row.host);
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
					+ '" title="Time a TCP handshake to this host from the Cloudflare edge"'
					+ ' class="rounded border border-dashed border-slate-300 px-1.5 text-[11px] text-slate-400'
					+ ' hover:border-sky-500 hover:text-sky-600 dark:border-slate-700 dark:text-slate-500 dark:hover:text-sky-400">measure</button>';
			} else {
				edgeCell = '<button type="button" data-remeasure="' + row.id + '" title="Measure again"'
					+ ' class="rounded px-1 text-xs hover:underline '
					+ (row.live === null
						? 'text-rose-500 dark:text-rose-400">unreachable'
						: 'tabular-nums text-emerald-700 dark:text-emerald-400">' + row.live + ' ms')
					+ '</button>';
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
				showStatus(result === null
					? target.host + ' is unreachable from the Cloudflare edge.'
					: target.host + ' answered in ' + result + ' ms.');
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

function createVlessSub(userIDPath, hostName) {
	const userIDArray = userIDPath.includes(',') ? userIDPath.split(',') : [userIDPath];
	// One node is emitted per userID x port x proxyIP, so cap the proxy hosts used
	// here to keep the subscription small enough for clients to import comfortably.
	const subProxyIPs = proxyIPs.slice(0, SUB_PROXY_IP_LIMIT);
	const commonUrlPartHttp = `?encryption=none&security=none&fp=chrome&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#`;
	const commonUrlPartHttps = `?encryption=none&security=tls&sni=${hostName}&fp=chrome&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#`;

	const output = userIDArray.flatMap((userID) => {
		const httpConfigs = Array.from(httpPortSet).flatMap((port) => {
			if (!hostName.includes('pages.dev')) {
				const urlPart = `${hostName}-HTTP-${port}`;
				const vlessMainHttp = atob(pt) + '://' + userID + atob(at) + hostName + ':' + port + commonUrlPartHttp + urlPart;
				return subProxyIPs.flatMap((proxyIP) => {
					const vlessSecHttp = atob(pt) + '://' + userID + atob(at) + proxyIP + ':' + port + commonUrlPartHttp + urlPart + '-' + proxyIP + '-' + atob(ed);
					return [vlessMainHttp, vlessSecHttp];
				});
			}
			return [];
		});

		const httpsConfigs = Array.from(httpsPortSet).flatMap((port) => {
			const urlPart = `${hostName}-HTTPS-${port}`;
			const vlessMainHttps = atob(pt) + '://' + userID + atob(at) + hostName + ':' + port + commonUrlPartHttps + urlPart;
			return subProxyIPs.flatMap((proxyIP) => {
				const vlessSecHttps = atob(pt) + '://' + userID + atob(at) + proxyIP + ':' + port + commonUrlPartHttps + urlPart + '-' + proxyIP + '-' + atob(ed);
				return [vlessMainHttps, vlessSecHttps];
			});
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
