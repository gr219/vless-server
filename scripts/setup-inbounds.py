"""Helper script to configure 3x-ui inbounds and WARP routing.

Ensures:
1. WARP outbound exists in Xray settings.
2. Routing rule directing inbound-8444 to warp outbound exists in Xray settings.
3. Inbound on port 8443 (VLESS XHTTP, direct).
4. Inbound on port 8444 (VLESS XHTTP, routed to WARP).
"""
import argparse
import http.cookiejar
import json
import secrets
import sys
import urllib.parse
import urllib.request
import uuid


class PanelClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/") + "/"
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.csrf_token = ""

    def get_csrf(self) -> str:
        url = urllib.parse.urljoin(self.base_url, "csrf-token")
        req = urllib.request.Request(url)
        with self.opener.open(req) as resp:
            data = json.load(resp)
            self.csrf_token = data.get("obj", "")
            return self.csrf_token

    def login(self, username, password) -> bool:
        csrf = self.get_csrf()
        url = urllib.parse.urljoin(self.base_url, "login")
        payload = urllib.parse.urlencode({
            "_csrf": csrf,
            "username": username,
            "password": password,
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={
            "Content-Type": "application/x-www-form-urlencoded"
        })
        with self.opener.open(req) as resp:
            data = json.load(resp)
            if not data.get("success"):
                raise RuntimeError(f"Login failed: {data.get('msg')}")
        self.get_csrf()  # refresh CSRF for authenticated session
        return True

    def api_get(self, endpoint: str) -> dict:
        url = urllib.parse.urljoin(self.base_url, endpoint.lstrip("/"))
        req = urllib.request.Request(url, headers={
            "X-CSRF-Token": self.csrf_token,
            "Accept": "application/json",
        })
        with self.opener.open(req) as resp:
            return json.load(resp)

    def api_post(self, endpoint: str, data=None, form=None) -> dict:
        url = urllib.parse.urljoin(self.base_url, endpoint.lstrip("/"))
        headers = {
            "X-CSRF-Token": self.csrf_token,
            "Accept": "application/json",
        }
        if form is not None:
            body = urllib.parse.urlencode(form).encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif data is not None:
            body = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"
        else:
            body = b""

        req = urllib.request.Request(url, data=body, headers=headers)
        with self.opener.open(req) as resp:
            return json.load(resp)


def summarize(res: dict) -> str:
    """Logs only a response's outcome. Panel responses echo inbound settings
    (client IDs, subIds) and WARP keys, and this repo's Actions logs are public.
    """
    return f"success={res.get('success')} msg={res.get('msg', '')!r}"


def ensure_warp_and_routing(client: PanelClient):
    print("Checking Xray settings (outbounds & routing)...")
    res = client.api_post("panel/api/xray/")
    raw_obj = res.get("obj", "")
    if isinstance(raw_obj, str):
        xray_data = json.loads(raw_obj)
    else:
        xray_data = raw_obj or {}

    template = xray_data.get("xraySetting", {})
    if isinstance(template, str):
        template = json.loads(template)
    elif not isinstance(template, dict):
        template = {}

    outbounds = template.setdefault("outbounds", [])
    has_warp = any(o.get("tag") == "warp" for o in outbounds if isinstance(o, dict))

    if not has_warp:
        print("WARP outbound not found in Xray settings. Registering WARP...")
        try:
            warp_res = client.api_post("panel/api/xray/warp/changeIp")
            print("WARP registration response:", summarize(warp_res))
            # Re-fetch settings
            res = client.api_post("panel/api/xray/")
            raw_obj = res.get("obj", "")
            xray_data = json.loads(raw_obj) if isinstance(raw_obj, str) else raw_obj
            template = xray_data.get("xraySetting", {})
            if isinstance(template, str):
                template = json.loads(template)
        except Exception as e:
            print(f"Warning: could not auto-register WARP via API ({e}). Creating wireguard outbound entry...")
            outbounds.append({
                "tag": "warp",
                "protocol": "wireguard",
                "streamSettings": {"sockopt": {"domainStrategy": "ForceIPv4v6"}},
                "targetStrategy": "ForceIPv4v6",
                "settings": {
                    "mtu": 1420,
                    "peers": [{"endpoint": "engage.cloudflareclient.com:2408"}],
                    "noKernelTun": True,
                }
            })

    # Check routing rule for inbound-8444 -> warp
    routing = template.setdefault("routing", {})
    rules = routing.setdefault("rules", [])
    has_rule = any(
        isinstance(r, dict) and "inbound-8444" in r.get("inboundTag", []) and r.get("outboundTag") == "warp"
        for r in rules
    )

    if not has_rule:
        print("Adding routing rule: inbound-8444 -> warp")
        rules.insert(0, {
            "type": "field",
            "inboundTag": ["inbound-8444"],
            "outboundTag": "warp",
        })
        save_res = client.api_post("panel/api/xray/update", form={"xraySetting": json.dumps(template)})
        print("Updated Xray routing rules:", summarize(save_res))
    else:
        print("Routing rule inbound-8444 -> warp already exists.")


def configure_telegram_bot(client: PanelClient, bot_token: str, chat_id: str):
    if not bot_token or not chat_id:
        print("Telegram bot credentials not provided, skipping Telegram settings.")
        return

    print("Configuring Telegram bot settings in panel...")
    res = client.api_post("panel/api/setting/all")
    settings = res.get("obj", {}) or {}
    print(f"Current tgBotEnable: {settings.get('tgBotEnable')}")

    # Build update payload
    settings["tgBotEnable"] = True
    settings["tgBotToken"] = bot_token
    settings["tgBotChatId"] = str(chat_id)
    settings["tgBotLoginNotify"] = True

    update_res = client.api_post("panel/api/setting/update", data=settings)
    print("Telegram settings update (JSON) response:", summarize(update_res))
    if not update_res.get("success"):
        # Try form encoded update
        form_payload = {k: str(v) if not isinstance(v, bool) else ("true" if v else "false") for k, v in settings.items() if v is not None}
        update_res = client.api_post("panel/api/setting/update", form=form_payload)
        print("Telegram settings update (Form) response:", summarize(update_res))

    # Test Telegram bot if supported
    try:
        test_res = client.api_post("panel/api/setting/testTgBot")
        print("Test Telegram bot response:", summarize(test_res))
    except Exception as e:
        print("Telegram test call skipped/warning:", e)


def build_inbound_payload(port: int, remark: str, host: str, path: str, client_uuid: str, sub_id: str) -> dict:
    return {
        "up": 0,
        "down": 0,
        "total": 0,
        "remark": remark,
        "enable": True,
        "expiryTime": 0,
        "listen": "",
        "port": port,
        "protocol": "vless",
        "settings": {
            "clients": [{
                "id": client_uuid,
                "flow": "",
                "email": f"client-{port}",
                "limitIp": 0,
                "totalGB": 0,
                "expiryTime": 0,
                "enable": True,
                "tgId": 0,
                "subId": sub_id,
                "comment": "",
                "reset": 0,
            }],
            "decryption": "none",
            "fallbacks": [],
        },
        "streamSettings": {
            "network": "xhttp",
            "security": "none",
            "xhttpSettings": {
                "host": host,
                "path": path,
                "mode": "auto",
            },
            "sockopt": {
                "tcpcongestion": "bbr",
                "trustedXForwardedFor": ["CF-Connecting-IP"],
            },
        },
        "sniffing": {
            "enabled": True,
            "destOverride": ["http", "tls", "quic"],
        },
    }


def ensure_inbound(client: PanelClient, port: int, remark: str, host: str, path: str = "/"):
    inbounds_res = client.api_get("panel/api/inbounds/list")
    inbounds = inbounds_res.get("obj", []) or []
    match = next((ib for ib in inbounds if ib.get("port") == port), None)

    client_uuid = str(uuid.uuid4())
    sub_id = secrets.token_hex(8)
    payload = build_inbound_payload(port, remark, host, path, client_uuid, sub_id)

    if match:
        ib_id = match.get("id")
        print(f"Inbound on port {port} exists (id: {ib_id}). Updating...")
        # Keep existing clients if available
        existing_settings = match.get("settings")
        if isinstance(existing_settings, str):
            try: existing_settings = json.loads(existing_settings)
            except Exception: existing_settings = {}
        if isinstance(existing_settings, dict) and existing_settings.get("clients"):
            payload["settings"]["clients"] = existing_settings["clients"]

        res = client.api_post(f"panel/api/inbounds/update/{ib_id}", data=payload)
        print(f"Update inbound {port} response:", summarize(res))
        if not res.get("success"):
            # Fallback to stringified format
            payload_str = dict(payload)
            payload_str["settings"] = json.dumps(payload["settings"])
            payload_str["streamSettings"] = json.dumps(payload["streamSettings"])
            payload_str["sniffing"] = json.dumps(payload["sniffing"])
            res = client.api_post(f"panel/api/inbounds/update/{ib_id}", data=payload_str)
            print(f"Update inbound {port} (stringified) response:", summarize(res))
    else:
        print(f"Creating new inbound on port {port} ({remark})...")
        res = client.api_post("panel/api/inbounds/add", data=payload)
        print(f"Create inbound {port} response:", summarize(res))
        if not res.get("success"):
            # Fallback to stringified format
            payload_str = dict(payload)
            payload_str["settings"] = json.dumps(payload["settings"])
            payload_str["streamSettings"] = json.dumps(payload["streamSettings"])
            payload_str["sniffing"] = json.dumps(payload["sniffing"])
            res = client.api_post("panel/api/inbounds/add", data=payload_str)
            print(f"Create inbound {port} (stringified) response:", summarize(res))
            if not res.get("success"):
                raise RuntimeError(f"Failed to create inbound on port {port}: {summarize(res)}")


def main():
    parser = argparse.ArgumentParser(description="3x-ui setup inbounds and routing")
    parser.add_argument("--base", required=True, help="Base panel URL")
    parser.add_argument("--username", required=True, help="Panel username")
    parser.add_argument("--password", required=True, help="Panel password")
    parser.add_argument("--host", default="azr2.std.io.vn", help="Host header for XHTTP")
    parser.add_argument("--tg-token", default="", help="Telegram Bot Token")
    parser.add_argument("--tg-chat-id", default="", help="Telegram Chat ID")
    args = parser.parse_args()

    client = PanelClient(args.base)
    client.login(args.username, args.password)
    print("Authenticated successfully with 3x-ui panel.")

    # 1. Inbound 8443: Direct XHTTP
    ensure_inbound(client, 8443, "VLESS-XHTTP-8443", args.host, path="/")

    # 2. Inbound 8444: WARP XHTTP
    ensure_inbound(client, 8444, "VLESS-XHTTP-WARP-8444", args.host, path="/warp")

    # 3. WARP Outbound & Routing rule for inbound-8444
    ensure_warp_and_routing(client)

    # 4. Telegram Bot communication settings
    configure_telegram_bot(client, args.tg_token, args.tg_chat_id)

    print("Setup completed successfully.")


if __name__ == "__main__":
    main()
