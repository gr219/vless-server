"""Route clients using WARP_UUID out through Cloudflare WARP.

main.py has one VLESS client and one exit for everyone. Called by the xray
wrapper on the config main.py just wrote, this adds WARP_UUID as a second
client on every VLESS inbound and sends that client's traffic to a WARP
(WireGuard) outbound, so the UUID in a link picks the exit. Everyone else
keeps whatever main.py set up, including ENABLE_WARP.
"""
import ipaddress
import json
import os
import socket
import sys

WARP_EMAIL = "warp"
# One of Cloudflare's published WARP endpoint addresses.
WARP_FALLBACK_IPV4 = "162.159.192.1"


def pin_endpoints_to_ipv4(outbound):
    """Replace endpoint hostnames with an IPv4 address.

    Xray may resolve engage.cloudflareclient.com to IPv6, and on a host
    without IPv6 (GitHub runners) the handshake then never completes.
    """
    for peer in outbound.get("settings", {}).get("peers", []):
        host, sep, port = peer.get("endpoint", "").strip().rpartition(":")
        host = host.strip("[]")
        if not sep or not host:
            continue
        try:
            ipaddress.ip_address(host)
            continue
        except ValueError:
            pass
        try:
            ipv4 = socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
        except OSError as e:
            ipv4 = WARP_FALLBACK_IPV4
            print(f"[!] Could not resolve WARP endpoint {host} to IPv4 ({e}), using {ipv4}")
        peer["endpoint"] = f"{ipv4}:{port}"


def main(config_path, warp_outbound_path):
    warp_uuid = os.environ["WARP_UUID"].strip()

    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)

    for inbound in config["inbounds"]:
        if inbound.get("protocol") != "vless":
            continue
        inbound["settings"]["clients"].append(
            {"id": warp_uuid, "email": WARP_EMAIL, "level": 0}
        )

    # With ENABLE_WARP on, main.py already added a WARP outbound from the same
    # wgcf.xray.json; reuse it rather than open a second tunnel on one account.
    outbounds = config["outbounds"]
    warp = next((o for o in outbounds if o.get("protocol") == "wireguard"), None)
    if warp is None:
        with open(warp_outbound_path, encoding="utf-8") as f:
            warp = json.load(f)
        warp["tag"] = "warp"
        pin_endpoints_to_ipv4(warp)
        outbounds.append(warp)

    # Force WARP outbound and wireguard/freedom to use IPv4 only
    warp.setdefault("settings", {})["domainStrategy"] = "forceipv4"

    # Also ensure Xray DNS resolves domain targets to IPv4 only when using WARP
    dns_servers = config.setdefault("dns", {}).setdefault("servers", [])
    config["dns"]["queryStrategy"] = "UseIPv4"

    # Block direct IPv6 leak/routing if needed, or route IPv6 to blackhole
    outbounds.append({"protocol": "blackhole", "tag": "block"})
    rules = config.setdefault("routing", {}).setdefault("rules", [])
    rules.insert(0, {"type": "field", "ip": ["::/0"], "outboundTag": "block"})
    rules.insert(0, {"type": "field", "user": [WARP_EMAIL], "outboundTag": warp["tag"]})

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
