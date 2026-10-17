"""Answer /stats in the Telegram chat with who is connected to each profile.

Started in the background by the Tunnel workflow's hold step. It long-polls
getUpdates, ignores every chat but TELEGRAM_CHAT_ID, and replies to /stats with
each VLESS user's online IPs and traffic since the server started, read from
the Xray stats API that scripts/xray-stats.py enables.

Telegram lets one getUpdates poller per bot at a time. While a new run takes
over from the old one both poll for a few seconds; the loser gets a 409 and
retries, so that overlap is harmless.

Logs never carry the bot token or client IPs, because the workflow's logs are
public.

Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (required); HOLD_DEADLINE
(epoch seconds the session ends), RUN_URL (optional).
"""
import argparse
import html
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API_BASE = "https://api.telegram.org/bot{token}/{method}"
POLL_TIMEOUT_S = 50
RETRY_DELAY_S = 10
XRAY_API_TIMEOUT_S = 10


class TelegramError(Exception):
    """A Telegram Bot API call failed; the message never contains the token."""

    def __init__(self, code: str, method: str, status: int, description: str) -> None:
        super().__init__(f"{code}: {method} failed ({status}): {description}")
        self.status = status


class StatsError(Exception):
    """The Xray stats API could not be read."""


# In-memory history of client IPs seen since this process started:
# {email: {ip: first_seen_timestamp}}
HISTORICAL_IPS: dict[str, dict[str, int]] = {}


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{stamp}] {message}", file=sys.stderr, flush=True)


def telegram_call(token: str, method: str, payload: dict, timeout: float) -> dict:
    """POST a Bot API method and return its result, raising TelegramError."""
    request = urllib.request.Request(
        API_BASE.format(token=token, method=method),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as e:
        try:
            description = json.load(e).get("description", "")
        except (ValueError, OSError):
            description = ""
        raise TelegramError("ERR_TELEGRAM_HTTP", method, e.code, description) from None
    except (urllib.error.URLError, OSError, ValueError) as e:
        # str(e) of these never includes the request URL, so no token leaks.
        raise TelegramError("ERR_TELEGRAM_NETWORK", method, 0, type(e).__name__ + ": " + str(e)) from None
    if not body.get("ok"):
        raise TelegramError("ERR_TELEGRAM_NOT_OK", method, 200, body.get("description", ""))
    return body["result"]


def parse_command(text: str, bot_username: str) -> str:
    """Return the bare command ("/stats") of a message, or "" if it has none.

    A command addressed to another bot (/stats@other_bot) yields "".
    """
    if not text.startswith("/"):
        return ""
    command, _, target = text.split(maxsplit=1)[0].partition("@")
    if target and target.lower() != bot_username.lower():
        return ""
    return command.lower()


def is_from_allowed_chat(message: dict, allowed_chat_id: str) -> bool:
    return str(message.get("chat", {}).get("id", "")) == allowed_chat_id.strip()


def run_xray_api(xray_bin: str, server: str, args: list) -> dict:
    """Run an `xray api` subcommand and return its JSON output."""
    try:
        result = subprocess.run(
            [xray_bin, "api", *args, f"--server={server}"],
            capture_output=True, text=True, timeout=XRAY_API_TIMEOUT_S, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise StatsError(f"ERR_XRAY_API_UNREACHABLE: {type(e).__name__}") from None
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise StatsError(f"ERR_XRAY_API_FAILED: {detail[-1] if detail else 'exit ' + str(result.returncode)}")
    output = result.stdout.strip()
    if not output:
        return {}
    try:
        return json.loads(output)
    except ValueError:
        raise StatsError("ERR_XRAY_API_BAD_JSON: unexpected output from xray api") from None


def collect_stats(xray_bin: str, server: str, configured_users: list) -> dict:
    """Return {email: {"ips": [(ip, last_seen)], "total_ips": [(ip, first_seen)], "up": int, "down": int}}."""
    stats = {email: {"ips": [], "total_ips": [], "up": 0, "down": 0} for email in configured_users}

    now = int(time.time())
    online = run_xray_api(xray_bin, server, ["statsonlineiplist", "-all"])
    for user in online.get("users", []):
        email = user.get("email", "?")
        entry = stats.setdefault(email, {"ips": [], "total_ips": [], "up": 0, "down": 0})
        history = HISTORICAL_IPS.setdefault(email, {})
        for ip_data in user.get("ips", []):
            ip_str = ip_data.get("ip", "?")
            last_seen = int(ip_data.get("lastSeen", ip_data.get("last_seen", 0)))
            entry["ips"].append((ip_str, last_seen))
            if ip_str != "?" and ip_str not in history:
                history[ip_str] = last_seen or now

    for email, entry in stats.items():
        history = HISTORICAL_IPS.get(email, {})
        entry["total_ips"] = sorted(history.items(), key=lambda item: item[1])

    traffic = run_xray_api(xray_bin, server, ["statsquery", "-pattern", "user>>>"])
    for stat in traffic.get("stat", []):
        parts = stat.get("name", "").split(">>>")
        # user>>>{email}>>>traffic>>>{uplink|downlink}
        if len(parts) != 4 or parts[0] != "user" or parts[2] != "traffic":
            continue
        entry = stats.setdefault(parts[1], {"ips": [], "total_ips": [], "up": 0, "down": 0})
        key = "up" if parts[3] == "uplink" else "down"
        entry[key] = int(stat.get("value", 0))

    for entry in stats.values():
        entry["ips"].sort(key=lambda item: item[1])
    return stats


def format_bytes(count: int) -> str:
    value = float(count)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def format_duration(seconds: int) -> str:
    seconds = max(0, int(seconds))
    hours, minutes = divmod(seconds // 60, 60)
    return f"{hours}h{minutes:02d}m" if hours else f"{minutes}m"


def format_stats(stats: dict, now: int, started_at: int, deadline: int | None, run_url: str) -> str:
    """Render the /stats reply as Telegram HTML."""
    lines = ["<b>📊 VLESS stats</b>"]
    timing = f"Up {format_duration(now - started_at)}"
    if deadline:
        timing += f" · restarts in {format_duration(deadline - now)}"
    lines.append(timing)

    total_online = sum(len(entry["ips"]) for entry in stats.values())
    all_historical_ips = set()
    for entry in stats.values():
        all_historical_ips.update(ip for ip, _ in entry.get("total_ips", []))
    total_connected = len(all_historical_ips)

    lines.append(f"<b>{total_online}</b> online · <b>{total_connected}</b> total unique IP(s) connected\n")

    for email in sorted(stats):
        entry = stats[email]
        online_ips = entry["ips"]
        total_ips = entry.get("total_ips", [])
        lines.append(f"<b>{html.escape(email)}</b>: {len(online_ips)} online · {len(total_ips)} total")
        if online_ips:
            lines.append("  <i>Online now:</i>")
            for ip, last_seen in online_ips:
                since = datetime.fromtimestamp(last_seen, timezone.utc).strftime("%H:%M") if last_seen else "?"
                lines.append(f"    • <code>{html.escape(ip)}</code> (active {since} UTC)")
        
        # Display full list of IPs connected to this profile since start
        if total_ips:
            lines.append("  <i>Connected IPs:</i>")
            for ip, first_seen in total_ips:
                first_str = datetime.fromtimestamp(first_seen, timezone.utc).strftime("%H:%M") if first_seen else "?"
                is_active = any(ip == cur_ip for cur_ip, _ in online_ips)
                status = " (online)" if is_active else f" (seen {first_str} UTC)"
                lines.append(f"    • <code>{html.escape(ip)}</code>{status}")

        lines.append(f"  ↑ {format_bytes(entry['up'])}  ↓ {format_bytes(entry['down'])}\n")
    if run_url:
        lines.append(f"{html.escape(run_url)}")
    return "\n".join(lines).strip()


def read_configured_users(config_path: str) -> list:
    """Emails of all VLESS clients, so idle profiles still show up as 0."""
    try:
        with open(config_path, encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError) as e:
        log(f"ERR_CONFIG_UNREADABLE: {type(e).__name__}; listing only users Xray reports.")
        return []
    emails = set()
    for inbound in config.get("inbounds", []):
        if inbound.get("protocol") == "vless":
            for client in inbound.get("settings", {}).get("clients", []):
                if client.get("email"):
                    emails.add(client["email"])
    return sorted(emails)


def build_reply(message: dict, text: str) -> dict:
    reply = {
        "chat_id": message["chat"]["id"],
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
        "reply_parameters": {"message_id": message["message_id"], "allow_sending_without_reply": True},
    }
    if message.get("is_topic_message") and message.get("message_thread_id"):
        reply["message_thread_id"] = message["message_thread_id"]
    return reply


def skip_backlog(token: str) -> int:
    """Return the offset past any update sent while no run was polling."""
    pending = telegram_call(token, "getUpdates", {"offset": -1, "timeout": 0}, timeout=30)
    return pending[-1]["update_id"] + 1 if pending else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--xray", required=True, help="Path to the real Xray binary.")
    parser.add_argument("--config", required=True, help="Path to Xray's config.json.")
    parser.add_argument("--api", default="127.0.0.1:10085", help="Xray stats API address.")
    args = parser.parse_args()

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        log("ERR_TELEGRAM_CONFIG_MISSING: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.")
        return 2
    deadline_raw = os.environ.get("HOLD_DEADLINE", "")
    deadline = int(deadline_raw) if deadline_raw.isdigit() else None
    run_url = os.environ.get("RUN_URL", "")
    started_at = int(time.time())
    users = read_configured_users(args.config)

    while True:
        try:
            bot_username = telegram_call(token, "getMe", {}, timeout=30)["username"]
            offset = skip_backlog(token)
            break
        except TelegramError as e:
            log(f"{e}; retrying in {RETRY_DELAY_S}s.")
            time.sleep(RETRY_DELAY_S)
    log(f"Listening for /stats as @{bot_username} ({len(users)} configured user(s)).")

    while True:
        try:
            updates = telegram_call(
                token, "getUpdates",
                {"offset": offset, "timeout": POLL_TIMEOUT_S, "allowed_updates": ["message"]},
                timeout=POLL_TIMEOUT_S + 15,
            )
        except TelegramError as e:
            # 409: another run is polling (overlap) or a webhook is set.
            log(f"{e}; retrying in {RETRY_DELAY_S}s.")
            time.sleep(RETRY_DELAY_S)
            continue

        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message")
            if not message or not is_from_allowed_chat(message, chat_id):
                continue
            if parse_command(message.get("text", ""), bot_username) != "/stats":
                continue
            try:
                stats = collect_stats(args.xray, args.api, users)
                text = format_stats(stats, int(time.time()), started_at, deadline, run_url)
            except StatsError as e:
                log(str(e))
                text = f"⚠️ Stats unavailable: {html.escape(str(e))}"
            try:
                telegram_call(token, "sendMessage", build_reply(message, text), timeout=30)
                log("Answered /stats.")
            except TelegramError as e:
                log(str(e))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
