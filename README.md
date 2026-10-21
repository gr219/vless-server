# vless-server

3x-ui panel running behind Cloudflare Tunnel, published at `azr2.std.io.vn` via `tunnel2.yml`.

- A run holds for up to 350 minutes. A cron trigger starts a new run every 5 hours, and every push to `main` starts one after CI passes.
- A new run takes over without a gap (`scripts/handover.py`): the running one snapshots its panel database while still serving, the new one starts from that snapshot, and the old one disconnects only once the new tunnel connection is up.
- Inbounds automatically provisioned:
  - Port `8443`: `VLESS-XHTTP-8443` (direct routing, path `/`)
  - Port `8444`: `VLESS-XHTTP-WARP-8444` (WARP routing, path `/warp`)

## Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_TUNNEL2_TOKEN` | yes | Token of the Cloudflare Tunnel that publishes the panel and inbounds. |
| `XUI_USERNAME` | yes | 3x-ui panel login. |
| `XUI_PASSWORD` | yes | 3x-ui panel password. |
| `TELEGRAM_BOT_TOKEN` | no | Telegram bot for the panel URL message and 3x-ui notifications. |
| `TELEGRAM_CHAT_ID` | no | Chat that receives those messages. |
| `TELEGRAM_THREAD_ID` | no | Forum topic within that chat. |
