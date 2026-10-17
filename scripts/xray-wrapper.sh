#!/usr/bin/env bash
# Installed by the Tunnel workflow in place of ./xray, with the real binary
# moved to ./xray-core. main.py writes config.json and starts `./xray run`
# straight away, so this is the one point where the config can be extended
# before Xray reads it. WARP_UUID reaches here from .env via main.py's
# load_dotenv(); warp-route.py is only present once WARP was set up.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = run ]; then
  if [ -n "${WARP_UUID:-}" ] && [ -f "$here/warp-route.py" ]; then
    python3 "$here/warp-route.py" config.json "$here/wgcf.xray.json"
  fi
  # Stats only feed /stats; a failure must not keep the server from starting.
  if ! python3 "$here/xray-stats.py" config.json; then
    echo "[!] ERR_STATS_PATCH_FAILED: could not enable Xray stats; starting without them." >&2
  fi
fi
exec "$here/xray-core" "$@"
