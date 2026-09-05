# vless-server

VLESS over WebSocket on Cloudflare Workers or Pages, with an authenticated
browser at `/list` for picking a proxy and copying its client link.

## Deploy

```bash
npx wrangler deploy
```

Pages deployments work the same way: the repository root is the build output and
`_worker.js` is the entry point.

## Configuration

All settings are environment variables. `wrangler.toml` holds them for local and
Workers deploys; on Pages, set the same names under **Settings -> Environment
variables**.

| Variable | Required | Purpose |
| --- | --- | --- |
| `UUID` | yes | One UUID, or several separated by commas. Every listed UUID authenticates and gets its own routes. |
| `PROXYIP` | no | Outbound relay hosts, comma separated. One is picked at random per request. Falls back to the list baked into `_worker.js`. |
| `DNS_RESOLVER_URL` | no | DNS-over-HTTPS endpoint used for outbound UDP DNS. |
| `ADMIN_USER` | for `/list` | HTTP Basic username for the proxy browser. |
| `ADMIN_PASS` | for `/list` | HTTP Basic password for the proxy browser. |

`/list` answers `503` while `ADMIN_USER` or `ADMIN_PASS` is unset. Once the
worker is deployed, move the password out of the committed file:

```bash
npx wrangler secret put ADMIN_PASS
```

### About `PROXYIP`

Cloudflare blocks outbound TCP from a Worker to its own IP ranges, so reaching a
site behind Cloudflare needs a relay. `PROXYIP` names that relay. Prefer the
rotating hostnames in `wrangler.toml`: each resolves to a pool of working IPs
that is refreshed continuously, so they keep working without redeploys.

## Routes

| Route | Auth | Response |
| --- | --- | --- |
| `/list` | Basic | The proxy browser. |
| `/list/measure` | Basic | `POST {"hosts":[...]}` - times a TCP handshake to each host from the Cloudflare edge. Up to 50 hosts per call. |
| `/sub/<uuid>` | none | Base64 subscription for that UUID, across every supported port. |
| `/bestip/<uuid>` | none | Proxies a third-party clean-IP subscription service for that UUID. |
| `/cf` | none | The request's Cloudflare metadata, for debugging. |
| anything else | none | Reverse-proxies a decoy hostname. |

`<uuid>` may be any UUID listed in `UUID`, not only the first.

WebSocket upgrades on any path carry the VLESS tunnel itself.

## The proxy browser

`/list` renders every entry in the catalog baked into `_worker.js`: 13 rotating
hostnames plus ~2,500 individual addresses across 62 countries, each verified to
relay TLS to Cloudflare.

- Sort by any column; click the active column again to reverse it.
- The caret on a header opens a per-column filter with its own search box.
  Country and ISP filter by value, Host by substring, Latency by upper bound.
- The search box does a fuzzy match over country, host and ISP. Results rank by
  relevance until a column is chosen explicitly.
- Pick a UUID to build links with; the Link column and every copy action follow
  it.
- **Test Vinaphone** swaps the address in every generated link for
  `vina.std.io.vn:443`, keeping the rest of the link and the row's tag intact.
  Unticking it puts each row's own address back.
- Copy a single link from a row, or tick rows and copy them together, either as
  plain links or as a base64 subscription.
- Two timing columns, deliberately kept apart because they measure different
  things and are not comparable:
  - **Scan** - TCP + TLS + a full HTTP fetch of `/cdn-cgi/trace` *through* the
    proxy to Cloudflare, timed from Central Europe when the catalog was built.
    Always present, and the column the "max latency" filter applies to.
  - **Edge** - a bare TCP handshake from the Cloudflare edge to the proxy, timed
    on demand. No TLS, no HTTP, and it starts from a PoP usually close to the
    proxy, so it lands far below the Scan figure for the same host. Click
    **measure** in a row, or tick rows and use **Re-measure selected**.

  Each column sorts on its own. Rows that were never probed sort last by Edge.

### Refreshing the catalog

Entries come from [NiREvil/vless](https://github.com/NiREvil/vless):
[`ProxyIP.md`](https://github.com/NiREvil/vless/blob/main/sub/ProxyIP.md) for the
rotating hostnames and
[`ProxyIP-Daily.md`](https://github.com/NiREvil/vless/blob/main/sub/ProxyIP-Daily.md)
for the daily scan. Both are re-tested by proxying a request to
`https://speed.cloudflare.com/cdn-cgi/trace` through each candidate; anything
that returns a trace is alive. Replace the `PROXY_CATALOG` block in `_worker.js`
with the survivors, keeping the `country<TAB>host<TAB>isp<TAB>latencyMs<TAB>kind`
layout.

## Ports

Cloudflare terminates HTTP on `80, 8080, 8880, 2052, 2086, 2095, 2082` and HTTPS
on `443, 8443, 2053, 2096, 2087, 2083`. Pages deployments serve HTTPS ports only.
`/sub/<uuid>` emits a node for every supported port.

## License

See [LICENSE](LICENSE).
