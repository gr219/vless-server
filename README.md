# vless-server

VLESS over WebSocket on Cloudflare Workers, with an authenticated browser at
`/list` for picking a proxy and copying its client link. The proxy a user picks
is the proxy their traffic leaves through.

## Deploy

```bash
npm ci
npm test
npx wrangler deploy
```

The proxy catalog is not bundled: `_worker.js` fetches it live from
`CATALOG_URL` at request time rather than being inlined at deploy time, so it
no longer needs a build step of its own. `npx wrangler deploy` still runs the
`predeploy` step that provisions the SOCKS5 credentials (see
[Secrets](#secrets)), so deploy through it rather than serving the repository
root as-is.

## Configuration

All settings are environment variables. `wrangler.toml` holds them for local and
Workers deploys; on Pages, set the same names under **Settings -> Environment
variables**.

| Variable | Required | Purpose |
| --- | --- | --- |
| `UUID` | yes | One UUID, or several separated by commas. Every listed UUID authenticates and gets its own routes. Secret: never commit it. |
| `PROXYIP` | no | Outbound relay hosts, comma separated. Used when a connection does not pin one itself; falls back to the list baked into `_worker.js`. |
| `DNS_RESOLVER_URL` | no | DNS-over-HTTPS endpoint used for outbound UDP DNS. |
| `ADMIN_USER` | for `/list` | HTTP Basic username for the proxy browser. |
| `ADMIN_PASS` | for `/list` | HTTP Basic password for the proxy browser. |
| `DEBUG` | no | `"true"` turns on per-connection tunnel logging. Off by default; see [CPU limits](#cpu-limits). |
| `CATALOG_URL` | no | Where the proxy catalog is fetched from. Defaults to the upstream NiREvil/vless CSV; override to point at a fork or a mirror. |
| `CATALOG_TTL_SECONDS` | no | How long a fetched catalog is reused before refetching, in seconds. Defaults to `21600` (6 hours). |

### Secrets

`UUID`, `ADMIN_PASS`, `SOCKS_USER` and `SOCKS_PASS` are credentials and are
deliberately absent from `wrangler.toml`. The repository is public, so nothing
that authenticates a client belongs in a committed file. `_worker.js` ships no
fallback UUID: every route answers `503` until one is configured, and `/list`
answers `503` while `ADMIN_USER` or `ADMIN_PASS` is unset. SOCKS5 answers every
handshake with "no acceptable method" while `SOCKS_USER` or `SOCKS_PASS` is
unset.

`SOCKS_USER`/`SOCKS_PASS` don't need setting by hand: `npm run deploy`'s
`predeploy` step (`scripts/socks-creds.mjs`) generates them once, the first
time it finds either missing, and otherwise leaves them alone - they're baked
into every `socks5://` link `/list` hands out, so silently regenerating them on
every deploy would break everything already distributed. To replace them
deliberately, run `npm run socks:rotate`; that kills every previously
distributed link.

Set the rest per environment:

```bash
# Workers deploy
npx wrangler secret put UUID
npx wrangler secret put ADMIN_PASS

# Local `wrangler dev` - .dev.vars is git ignored and overrides [vars].
# Quote the values: an unquoted '#' starts a comment and would silently
# truncate the rest.
cat > .dev.vars <<'EOF'
UUID="your-uuid,another-uuid"
ADMIN_PASS="your-password"
EOF
```

The `Tunnel` workflow reads both from repository secrets of the same name
(**Settings -> Secrets and variables -> Actions**) and writes them to
`.dev.vars` on the runner.

### About `PROXYIP`

Cloudflare blocks outbound TCP from a Worker to its own IP ranges, so reaching a
site behind Cloudflare needs a relay. `PROXYIP` names that relay. Prefer the
rotating hostnames in `wrangler.toml`: each resolves to a pool of working IPs
that is refreshed continuously, so they keep working without redeploys.

A client pins the relay it wants in its WebSocket path:

```
path=/?ed=2048&proxyip=ProxyIP.SG.CMLiussss.net
```

Every link `/list` and `/sub/<uuid>` generate carries that parameter, which is
what makes a row's choice binding - the address in the link is always the
worker's own edge. A connection with no `proxyip`, or with one that fails
validation, falls back to a random host from `PROXYIP`. The value accepts a
hostname, an IPv4 address or a bracketed IPv6 literal, with an optional
`:port`.

The selected relay is the route, not a fallback: the outbound connection is
opened through it, so the exit IP is the relay's. The two cases differ in what
happens when the relay is unreachable:

| Selection | First hop | If it fails |
| --- | --- | --- |
| `proxyip=` pinned by the client | the pinned relay | the connection fails |
| random host from `PROXYIP` | that host | retries direct |

A pinned relay never falls back to a direct connection. Picking a row in
`/list` is a deliberate choice of exit IP, and quietly reverting to direct
would hand out the host's own address instead without saying so.

This matters most off Cloudflare. Earlier revisions connected direct first and
only reached for the relay when that returned no data, which looked correct on
Workers - Cloudflare blocks outbound connections to its own ranges, so the
direct attempt failed and the relay took over. Anywhere egress is unrestricted,
such as the GitHub Actions host, the direct attempt simply succeeded and
`proxyip` never had any effect at all.

## Routes

| Route | Auth | Response |
| --- | --- | --- |
| `/list` | Basic | The proxy browser. |
| `/list/measure` | Basic | `POST {"hosts":[...]}` - probes each host from the Cloudflare edge. Up to 50 hosts per call. |
| `/sub/<uuid>` | none | Base64 subscription for that UUID, across every supported port. |
| `/bestip/<uuid>` | none | Proxies a third-party clean-IP subscription service for that UUID. |
| `/cf` | none | The request's Cloudflare metadata, for debugging. |
| anything else | none | Reverse-proxies a decoy hostname. |

`<uuid>` may be any UUID listed in `UUID`, not only the first.

WebSocket upgrades on any path carry a tunnel. `/sub/<uuid>` and `/bestip/<uuid>`
are VLESS-only regardless of protocol selection.

## Protocols

VLESS is the default inbound protocol. A client asks for SOCKS5 instead by
adding `proto=socks5` to the WebSocket path; anything else, including its
absence, is VLESS.

SOCKS5 requires username/password auth (RFC 1929) - `SOCKS_USER` and
`SOCKS_PASS` (see [Secrets](#secrets)) - and the worker refuses every SOCKS5
handshake with "no acceptable method" while either is unset.

There is no standard `socks5://` URI format for a WebSocket transport, so the
link `/list` emits is not a drop-in proxy URL:

```
socks5://user:pass@host:443?proxyip=host:port&proto=socks5#label
```

The query string is the WebSocket path a SOCKS5-speaking client must be
configured with by hand - host, that path, and `proto=socks5` - not decoration
on an otherwise-standard link. `/list`'s copy modal states this limitation
wherever it hands out a SOCKS5 link.

## The proxy browser

`/list` renders every entry in the live catalog: individual IP:port addresses
across dozens of countries, each verified alive when the catalog was last
refreshed.

Columns: Country, Host, Port, ISP, Edge, Link.

- Sort by any column; click the active column again to reverse it.
- The caret on a header opens a per-column filter with its own search box.
  Country, ISP and Port filter by value, Host by substring.
- The search box does a fuzzy match over country, host and ISP. Results rank by
  relevance until a column is chosen explicitly.
- Pick a protocol (VLESS or SOCKS5) and a UUID to build links with; the Link
  column and every copy action follow both. See [Protocols](#protocols) for
  what changes when SOCKS5 is selected.
- Every generated link dials the worker's own hostname and pins the row's proxy
  in its path, so picking a row changes the route your traffic actually takes.
- **Test Vinaphone** swaps that edge address for `vina.std.io.vn:443`, leaving
  the pinned proxy and the row's tag intact.
- Copy a single link from a row, or tick rows and copy them together, either as
  plain links or as a base64 subscription.
- **Edge** is the only timing figure: measured on demand from the Cloudflare
  edge, the TCP handshake plus the time to relay a TLS ClientHello for
  `speed.cloudflare.com` through the proxy. The upstream catalog no longer
  carries a scan-time latency figure to show alongside it. Click **measure** in
  a row, or tick rows and use **Re-measure selected**. Three outcomes:
  - a time in milliseconds - the proxy connected *and* relayed;
  - **no relay** (amber) - it accepted the connection but forwarded nothing, or
    answered with a TLS alert. A dead proxy that still answers TCP, which a
    handshake-only probe would have scored as healthy;
  - **unreachable** (red) - no TCP connection at all.

  Rows that were never probed, and rows that will not relay, sort last by Edge.

  The Edge probe stops at the first response record. Measuring throughput would
  mean completing the TLS handshake, and the Workers socket API ties the TLS SNI
  to the connect hostname, so the edge cannot open a session *through* an
  SNI-routed proxy. A megabytes-per-second figure needs a client that speaks the
  tunnel end to end.

### The catalog source

Entries come live from [NiREvil/vless](https://github.com/NiREvil/vless)'s
per-proxy CSV, at the URL named by `CATALOG_URL`. `_worker.js` fetches it on
demand, parses each entry's country, host, port and ISP, and caches the parsed
result both in module scope (reused for the life of the isolate) and in the
Cache API (shared across isolates in the same Cloudflare PoP), for
`CATALOG_TTL_SECONDS` before refetching.

A failed refetch is not fatal: the worker keeps serving the last catalog it
parsed successfully. There is one genuinely empty case - a cold isolate, no
usable Cache API entry, and a failing fetch - which serves an empty catalog and
shows an error banner on `/list`.

### Tests

```bash
npm test
```

Node's built-in runner, no dependencies. `test/load-worker.mjs` loads
`_worker.js` outside the Workers runtime by stubbing `cloudflare:sockets`.

## Logging

`[observability]` in `wrangler.toml` enables Workers Logs, so console output is
retained and searchable in the dashboard under **Workers -> vless-server ->
Logs**. Without it, output is only visible live:

```bash
npx wrangler tail
npx wrangler tail --status error      # just the failures
```

By default the worker logs errors and nothing else. `DEBUG="true"` adds a line
per tunnel event (stream open, close, abort, retry, DNS). Turn it on to
diagnose, then turn it back off - see below for why.

The client's UUID is deliberately never logged.

## CPU limits

The Workers **free tier allows 10 ms of CPU per invocation**. A WebSocket tunnel
is a *single* invocation that lives for the whole session, so every millisecond
of JavaScript spent relaying that connection accrues to one 10 ms budget. A busy
tunnel will exhaust it, and Cloudflare reports `Worker exceeded CPU time limit`.

Waiting on the network is not CPU time, so an idle connection is fine. The cost
is proportional to how much JavaScript runs per chunk relayed.

What this repository does to keep the hot path cheap:

- Tunnel logging is off unless `DEBUG="true"`. When off, `log()` is a shared
  no-op, so no strings are built and no I/O is queued per stream event.
- The `/list` document is memoised per isolate, so the catalog is serialised
  once per hostname/UUID-list combination rather than on every request.

If the errors persist after that, they are coming from the tunnel itself and no
amount of code tuning will fix them on the free tier. The Workers Paid plan
($5/month) raises the limit from 10 ms to 30 s per invocation, which is the
actual remedy for a proxy carrying real traffic.

### Finding the ceiling

Every tunnel connection logs one line when it closes:

```
conn {"outcome":"close","target":"example.com:443 tcp","upBytes":41984,
      "downBytes":8317440,"totalBytes":8359424,"ms":12043}
```

Sort those by `totalBytes` and compare against the CPU errors. The largest
`totalBytes` a connection reaches before dying is the practical per-connection
ceiling on this plan. If connections die at a consistent byte figure, the relay
is the cause and only the paid plan or a transport that recycles connections
will move it. If they die at wildly different sizes, or at very small ones, look
elsewhere first.

Two other free-tier limits produce failures that look similar but are not CPU:

- **50 subrequests per invocation.** DNS sent through the tunnel costs one
  `fetch` to `DNS_RESOLVER_URL` per query, all charged to the same WebSocket
  invocation. A connection that issues more than 50 DNS queries fails with
  `Too many subrequests`. Resolving DNS on the client avoids this.
- **100k requests per day**, which any transport that splits a stream across
  many HTTP requests will reach quickly.

## Ports

Cloudflare terminates HTTP on `80, 8080, 8880, 2052, 2086, 2095, 2082` and HTTPS
on `443, 8443, 2053, 2096, 2087, 2083`. Pages deployments serve HTTPS ports only.
`/sub/<uuid>` emits a node for every supported port.

## License

See [LICENSE](LICENSE).
