"""Turn on Xray's per-user stats for the Telegram /stats command.

Called by the xray wrapper on the config main.py just wrote (after
warp-route.py, when that runs). It gives every VLESS client an email, since
Xray only counts users that have one, enables per-user traffic and online-IP
tracking, and opens the stats API on 127.0.0.1 for scripts/telegram-stats-bot.py.

Every connection reaches Xray from cloudflared (through main.py's demux) on
127.0.0.1, which Xray leaves out of the online list, so the inbounds are also
told to take the client address from X-Forwarded-For. It is trusted only when
Cloudflare's CF-Connecting-IP header is present. Its first entry can still be
set by the client, which is fine for counting but not for access control.
"""
import json
import os
import sys

DIRECT_EMAIL = "direct"
API_LISTEN = "127.0.0.1:10085"
TRUSTED_XFF_HEADERS = ["CF-Connecting-IP"]


def apply_stats(config: dict) -> dict:
    """Return config with stats, the stats API and client emails added."""
    for inbound in config.get("inbounds", []):
        if inbound.get("protocol") != "vless":
            continue
        for client in inbound.get("settings", {}).get("clients", []):
            client.setdefault("email", DIRECT_EMAIL)
        sockopt = inbound.setdefault("streamSettings", {}).setdefault("sockopt", {})
        sockopt["trustedXForwardedFor"] = TRUSTED_XFF_HEADERS

    config["stats"] = {}
    config["api"] = {"tag": "api", "listen": API_LISTEN, "services": ["StatsService"]}

    levels = config.setdefault("policy", {}).setdefault("levels", {})
    level0 = levels.setdefault("0", {})
    level0.update({
        "statsUserUplink": True,
        "statsUserDownlink": True,
        "statsUserOnline": True,
    })
    return config


def main(config_path: str) -> None:
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    apply_stats(config)

    # Written aside and swapped in, so a failure here never leaves Xray a
    # half-written config.
    tmp_path = config_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    os.replace(tmp_path, config_path)


if __name__ == "__main__":
    main(sys.argv[1])
