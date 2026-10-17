# vless-server

VLESS over WebSocket/xHTTP, published at `azr.std.io.vn:443` through a named
Cloudflare Tunnel.

- A run holds for up to 350 minutes. A cron trigger starts a new run every 5 hours
  and the `tunnel` concurrency group cancels the one it replaces.
- Every push to `main` cancels the running tunnel and starts a fresh one.

## Secrets

- `CLOUDFLARE_TUNNEL_TOKEN`: tunnel token. Public hostname `azr.std.io.vn` →
  `http://localhost:80`.
- `ENV_CONFIG`: full `.env` content, written to `.env` at runtime. Must set
  `XRAY_UUID` and `PASSWORD`; leave `TUNNEL_TOKEN` empty. Optional `WARP_UUID`:
  clients using it exit through Cloudflare WARP, everyone else goes direct.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_THREAD_ID` (optional): each run sends the WS and
  xHTTP `vless://` links, each with a QR code, to this chat once the tunnel is up.

## Connected clients (`/stats`)

With the Telegram secrets set, send `/stats` in `TELEGRAM_CHAT_ID` (messages
from any other chat are ignored). The bot replies with, per profile (`direct`
for `XRAY_UUID`, `warp` for `WARP_UUID`), the client IPs that currently have an
open connection and the traffic since the run started.

- A "client" is a distinct source IP: devices behind one NAT count once.
- The IP comes from Cloudflare's `X-Forwarded-For`, whose first entry a client
  can set itself; fine for counting, not for access control.
- The bot polls Telegram with `getUpdates`, so the bot must not have a webhook
  set. While one run takes over from the next, both poll for a few seconds;
  the resulting `409 Conflict` lines in `stats-bot.log` are expected.
