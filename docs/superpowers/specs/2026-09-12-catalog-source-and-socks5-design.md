# Remote proxy catalog, per-proxy ports, and SOCKS5 inbound

Status: approved, not yet implemented
Date: 2026-09-12

## Summary

Four changes to `vless-server`, in one pass because they touch the same code:

1. Retire the generated `data/proxies.tsv` catalog and its refresh workflow; the
   worker fetches the upstream CSV directly at runtime.
2. Honour the per-proxy port the CSV carries, instead of assuming 443.
3. Move CI to Node 24.
4. Accept SOCKS5 as a second inbound protocol next to VLESS, chosen from a
   dropdown in `/list`.

## 1. Catalog: runtime fetch, cached

### Source

`https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/country_proxies/02_proxies.csv`

Header and column mapping:

| CSV column    | Destination   | Notes                                 |
| ------------- | ------------- | ------------------------------------- |
| `IP Address`  | `entry.host`  |                                       |
| `Port`        | `entry.port`  | integer, 1-65535                      |
| `TLS`         | dropped       | `true` on all 10,579 current rows     |
| `Data Center` | `entry.cc`    | two-letter country code               |
| `Region`      | dropped       | `N/A` on all current rows             |
| `City`        | dropped       | `-` on all current rows               |
| `ASN`         | `entry.isp`   |                                       |
| `latency`     | dropped       | `-` on all current rows               |

`ProxyEntry` becomes `{ cc: string, host: string, port: number, isp: string }`.
The `latency` and `kind` fields are gone.

A row is kept only when it has exactly 8 comma-separated fields, a two-letter
uppercase `cc`, a non-empty `host`, and a `Port` that parses as an integer in
range. Anything else is skipped silently — an upstream format change must
degrade to a smaller catalog, never to a 500.

### Caching

`getProxyCatalog()` becomes `async fetchProxyCatalog()`, with three layers:

- **Module scope.** A parsed `ProxyEntry[]` plus the timestamp it was parsed.
  A warm isolate inside the TTL does no work at all.
- **`caches.default`.** Keyed on the catalog URL, `cf: { cacheTtl }`, so a cold
  isolate in a PoP that already fetched it does not hit GitHub again.
- **Stale on error.** A failed or non-200 refetch keeps serving the last good
  parse. A cold isolate with no cache and a failed fetch yields an empty
  catalog, and `/list` renders an error banner instead of a table.

TTL: 6 hours, as `CATALOG_TTL_SECONDS` in `[vars]`.

The catalog URL itself is `CATALOG_URL` in `[vars]`, so it is overridable
without a code change.

### Blast radius

The tunnel data path does not read the catalog. It routes on the `PROXYIP`
pool and on the `proxyip=` parameter the client pins, both of which are
independent of this fetch. An upstream outage degrades `/list` and `/measure`
only; established and new tunnels are unaffected.

### Removals

- `data/proxies.tsv`
- `scripts/refresh-catalog.mjs`
- `test/refresh-catalog.test.mjs`
- `.github/workflows/refresh-proxy-catalog.yml`
- the `[[rules]]` Text block in `wrangler.toml`
- the `catalog` and `catalog:check` npm scripts
- the `.tsv` inlining branch in `test/load-worker.mjs`

## 2. Per-proxy ports

`parseRequestedProxyIP()` and `planOutbound()` already parse and honour
`host:port`; the callers are what assume 443.

- `linkFor()` emits `proxyip=<host>:<port>` using the row's port.
- `measureHost(host)` becomes `measureHost(host, port)` and connects to that
  port rather than 443.
- `/measure` validates the requested `host:port` pair against the catalog. The
  current check is a `Set` of hosts; it becomes a `Set` of `host:port` strings,
  so a caller cannot use the endpoint to probe an arbitrary port on a
  catalogued host.

## 3. `/list` columns

- **Scan** is removed — the column, its sort key, and its range filter. The
  upstream CSV has no usable latency figure, so there is nothing to show.
- **Kind** is replaced by **Port**, sortable, from the CSV.
- **Edge** is unchanged and becomes the only latency figure on the page. Its
  tooltip drops the "not comparable with Scan" sentence, which no longer has a
  referent.

The default sort moves from `scan` to `cc`.

## 4. SOCKS5 inbound over WebSocket

### Selection

A client asks for SOCKS5 with `proto=socks5` in the WebSocket request query.
Anything else, including its absence, is VLESS. The choice is explicit rather
than sniffed from the first byte: it is deterministic, it is testable without
constructing a handshake, and it keeps the two protocol paths from having to
agree about what a first byte means.

### Handshake

`socks5OverWSHandler(request, proxyIPPool, env)` implements RFC 1928 and
RFC 1929 over the WebSocket byte stream:

- **Greeting.** Client sends `05 <n> <methods...>`. The worker replies
  `05 02`, selecting username/password. If the client does not offer `02` the
  worker replies `05 FF` and closes. Method `00` (no auth) is never selected,
  so the worker is never reachable as an open proxy.
- **Auth.** Client sends `01 <ulen> <user> <plen> <pass>`. Both are compared
  against the configured credentials with the existing `safeEqual` constant-time
  comparison. Success replies `01 00`; failure replies `01 01` and closes.
- **Request.** Client sends `05 01 00 <atyp> <addr> <port>`. `ATYP` `01`
  (IPv4), `03` (domain) and `04` (IPv6) are all accepted.
  - `CONNECT` (`01`) is handled.
  - `BIND` (`02`) and `UDP ASSOCIATE` (`03`) reply `05 07` — command not
    supported. Neither has a meaning over a single WebSocket byte stream.
- **Reply.** On a successful outbound connection the worker replies
  `05 00 00 01 00 00 00 00 00 00`. A bound address of `0.0.0.0:0` is what a
  relay with no local address to advertise returns, and clients accept it.
  A failed connection replies `05 01` (general failure) and closes.
- **Relay.** After the reply the stream is raw bytes in both directions,
  reusing `planOutbound`, `handleTCPOutBound` and `remoteSocketToWS` unchanged.

Any malformed frame closes the socket rather than guessing. The parser must
handle a handshake split across several WebSocket messages and several
handshake stages arriving in one message, since neither is under our control.

### Credentials

`SOCKS_USER` and `SOCKS_PASS` are Workers secrets, generated once rather than
per build so that distributed links keep working across deploys.

`scripts/socks-creds.mjs`:

- Lists the worker's existing secrets via `wrangler secret list`.
- If both names are present, exits without doing anything.
- Otherwise generates a 12-character user and a 32-character password from
  `crypto.randomBytes` over a URL-safe alphabet, uploads each with
  `wrangler secret put`, and prints them once.
- `--rotate` regenerates and overwrites unconditionally.

Wired in as `predeploy` in `package.json`, plus a `socks:rotate` script. The
worker answers SOCKS5 handshakes with `05 FF` while either secret is unset,
matching how `/list` answers 503 until `ADMIN_PASS` exists.

The UUID is deliberately not reused as the SOCKS5 password: the two protocols
should not share one credential, so revoking a SOCKS5 user does not disturb
VLESS clients.

### Link format

The `Protocol` dropdown in the `/list` header — `VLESS` (default) and
`SOCKS5`, persisted in `localStorage` under `proxy-list-proto` — drives
`linkFor()`.

VLESS is unchanged apart from the port:

```
vless://<uuid>@<edge>:443?encryption=none&security=tls&sni=<edge>&fp=chrome
  &type=ws&host=<edge>&path=%2F%3Fed%3D2048%26proxyip%3D<host>%3A<port>#<cc>-<host>
```

SOCKS5:

```
socks5://<user>:<pass>@<edge>:443?proxyip=<host>:<port>&proto=socks5#<cc>-<host>
```

**Known limitation, accepted.** No standard `socks5://` share URI encodes a
WebSocket transport, so this URI does not by itself tell a client to speak
WebSocket to the edge. It will not work unedited in a client that needs the
transport spelled out. The query parameters are not decoration: they are
exactly the WebSocket path the user must configure
(`/?proxyip=...&proto=socks5`), so the URI carries everything needed to
complete the config by hand. The copy modal states this in a note above the
text.

`SOCKS_USER` and `SOCKS_PASS` reach the page through the `/list` bootstrap
JSON. `/list` is already behind HTTP Basic auth, so this exposes the
credentials to exactly the audience that is meant to distribute them.

### Out of scope

`/sub/<uuid>` and `/bestip/<uuid>` build their configs from the `PROXYIP` pool
rather than the catalog, and stay VLESS-only. The dropdown is a `/list`
feature; a SOCKS5 subscription feed is a separate request if it is ever wanted.

## 5. CI

- `.github/workflows/ci.yml`: `node-version` `22` -> `24`.
- `.github/workflows/tunnel.yml`: same bump, for consistency.
- `.github/workflows/refresh-proxy-catalog.yml`: deleted.

## 6. Testing

`test/load-worker.mjs` loses the `.tsv` inlining branch and gains an injectable
`fetch` stub, so catalog tests run offline against a fixture and never reach
the network.

| File | Covers |
| ---- | ------ |
| `test/proxy-catalog.test.mjs` (rewritten) | header skipped; every well-formed row parsed; port parsed as an integer; rows with wrong field counts, bad country codes and out-of-range ports dropped; a non-200 response keeps the previous parse; a cold failure yields an empty catalog rather than throwing |
| `test/socks5-handshake.test.mjs` (new) | method selection, including `05 FF` when `02` is not offered and when the secrets are unset; auth accept and reject; `CONNECT` for IPv4, domain and IPv6; `BIND` and `UDP ASSOCIATE` rejected with `05 07`; a handshake split across messages; several stages coalesced into one message; malformed input closes the socket |
| `test/proxy-ip.test.mjs` (extended) | `proto=socks5` routes to the SOCKS5 handler and its absence routes to VLESS |
| `test/outbound-route.test.mjs`, `test/client-hello.test.mjs`, `test/uuid-config.test.mjs` | unchanged |

`npx wrangler deploy --dry-run` in CI still catches a broken bundle; with the
Text rule gone it no longer has a catalog import to resolve.
