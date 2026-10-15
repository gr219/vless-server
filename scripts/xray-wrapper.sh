#!/usr/bin/env bash
# Installed by the Tunnel workflow in place of ./xray, with the real binary
# moved to ./xray-core. main.py writes config.json and starts `./xray run`
# straight away, so this is the one point where the config can be extended
# before Xray reads it. WARP_UUID reaches here from .env via main.py's
# load_dotenv().
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = run ] && [ -n "${WARP_UUID:-}" ]; then
  python3 "$here/warp-route.py" config.json "$here/wgcf.xray.json"
fi
exec "$here/xray-core" "$@"
