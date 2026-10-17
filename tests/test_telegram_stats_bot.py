import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent / "scripts"


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bot = load_script("telegram-stats-bot")

# Shapes as printed by `xray api statsonlineiplist -all` / `statsquery` (v26.7.11).
ONLINE_JSON = {"users": [{"email": "direct", "ips": [
    {"ip": "203.0.113.9", "lastSeen": 1760700000},
    {"ip": "198.51.100.4", "lastSeen": 1760690000},
]}]}
TRAFFIC_JSON = {"stat": [
    {"name": "user>>>direct>>>traffic>>>uplink", "value": 2048},
    {"name": "user>>>direct>>>traffic>>>downlink", "value": 5 * 1024 * 1024},
    {"name": "user>>>warp>>>traffic>>>downlink", "value": 10},
    {"name": "inbound>>>api>>>traffic>>>uplink", "value": 99},
]}


def completed(stdout: str = "", returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], returncode, stdout=stdout, stderr=stderr)


def fake_xray(args: list, **_kwargs) -> subprocess.CompletedProcess:
    if "statsonlineiplist" in args:
        return completed(json.dumps(ONLINE_JSON))
    return completed(json.dumps(TRAFFIC_JSON))


class ParseCommandTest(unittest.TestCase):
    def test_plain_and_addressed_commands(self) -> None:
        self.assertEqual(bot.parse_command("/stats", "my_bot"), "/stats")
        self.assertEqual(bot.parse_command("/STATS now", "my_bot"), "/stats")
        self.assertEqual(bot.parse_command("/stats@My_Bot", "my_bot"), "/stats")

    def test_ignores_other_bots_and_plain_text(self) -> None:
        self.assertEqual(bot.parse_command("/stats@other_bot", "my_bot"), "")
        self.assertEqual(bot.parse_command("stats", "my_bot"), "")
        self.assertEqual(bot.parse_command("", "my_bot"), "")


class AllowedChatTest(unittest.TestCase):
    def test_matches_only_the_configured_chat(self) -> None:
        self.assertTrue(bot.is_from_allowed_chat({"chat": {"id": -1001234}}, "-1001234"))
        self.assertTrue(bot.is_from_allowed_chat({"chat": {"id": 42}}, " 42\n"))
        self.assertFalse(bot.is_from_allowed_chat({"chat": {"id": 43}}, "42"))
        self.assertFalse(bot.is_from_allowed_chat({}, "42"))


class CollectStatsTest(unittest.TestCase):
    def test_merges_online_ips_traffic_and_idle_users(self) -> None:
        with mock.patch.object(bot.subprocess, "run", side_effect=fake_xray):
            stats = bot.collect_stats("xray", "127.0.0.1:10085", ["direct", "warp", "idle"])
        self.assertEqual(stats["direct"]["ips"], [("198.51.100.4", 1760690000), ("203.0.113.9", 1760700000)])
        self.assertEqual(sorted(ip for ip, _ in stats["direct"]["total_ips"]), ["198.51.100.4", "203.0.113.9"])
        self.assertEqual((stats["direct"]["up"], stats["direct"]["down"]), (2048, 5 * 1024 * 1024))
        self.assertEqual(stats["warp"], {"ips": [], "total_ips": [], "up": 0, "down": 10})
        self.assertEqual(stats["idle"], {"ips": [], "total_ips": [], "up": 0, "down": 0})
        self.assertNotIn("api", stats)

    def test_empty_output_means_nobody_online(self) -> None:
        with mock.patch.object(bot.subprocess, "run", return_value=completed("")):
            stats = bot.collect_stats("xray", "127.0.0.1:10085", ["direct"])
        self.assertEqual(stats, {"direct": {"ips": [], "total_ips": [], "up": 0, "down": 0}})

    def test_api_failure_raises_with_error_code(self) -> None:
        with mock.patch.object(bot.subprocess, "run", return_value=completed(returncode=1, stderr="connection refused")):
            with self.assertRaisesRegex(bot.StatsError, "ERR_XRAY_API_FAILED: connection refused"):
                bot.collect_stats("xray", "127.0.0.1:10085", [])

    def test_missing_binary_raises_with_error_code(self) -> None:
        with mock.patch.object(bot.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(bot.StatsError, "ERR_XRAY_API_UNREACHABLE"):
                bot.collect_stats("xray", "127.0.0.1:10085", [])


class FormatTest(unittest.TestCase):
    def test_format_bytes(self) -> None:
        self.assertEqual(bot.format_bytes(0), "0 B")
        self.assertEqual(bot.format_bytes(2048), "2.0 KB")
        self.assertEqual(bot.format_bytes(5 * 1024 ** 3), "5.0 GB")
        self.assertEqual(bot.format_bytes(3 * 1024 ** 4), "3072.0 GB")

    def test_format_duration(self) -> None:
        self.assertEqual(bot.format_duration(59), "0m")
        self.assertEqual(bot.format_duration(3 * 3600 + 5 * 60), "3h05m")
        self.assertEqual(bot.format_duration(-10), "0m")

    def test_format_stats(self) -> None:
        stats = {
            "direct": {
                "ips": [("203.0.113.9", 1760700000)],
                "total_ips": [("203.0.113.9", 1760700000), ("198.51.100.4", 1760690000)],
                "up": 2048,
                "down": 0,
            },
            "<warp>": {"ips": [], "total_ips": [], "up": 0, "down": 0},
        }
        text = bot.format_stats(stats, now=10_000, started_at=10_000 - 3700, deadline=10_000 + 600, run_url="https://x/run")
        self.assertIn("Up 1h01m · restarts in 10m", text)
        self.assertIn("<b>1</b> online · <b>2</b> total unique IP(s) connected", text)
        self.assertIn("<b>direct</b>: 1 online · 2 total", text)
        self.assertIn("• <code>203.0.113.9</code> (active 11:20 UTC)", text)
        self.assertIn("• <code>198.51.100.4</code> (seen 08:33 UTC)", text)
        self.assertIn("<b>&lt;warp&gt;</b>: 0 online · 0 total", text)
        self.assertIn("↑ 2.0 KB  ↓ 0 B", text)
        self.assertTrue(text.endswith("https://x/run"))

    def test_format_stats_without_deadline(self) -> None:
        text = bot.format_stats({}, now=100, started_at=100, deadline=None, run_url="")
        self.assertNotIn("restarts", text)


class ConfiguredUsersTest(unittest.TestCase):
    def test_reads_vless_client_emails(self) -> None:
        config = {"inbounds": [
            {"protocol": "vless", "settings": {"clients": [{"id": "a", "email": "direct"}, {"id": "b", "email": "warp"}]}},
            {"protocol": "vless", "settings": {"clients": [{"id": "a", "email": "direct"}, {"id": "c"}]}},
            {"protocol": "socks", "settings": {"clients": [{"email": "ignored"}]}},
        ]}
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "config.json"
            path.write_text(json.dumps(config), encoding="utf-8")
            self.assertEqual(bot.read_configured_users(str(path)), ["direct", "warp"])

    def test_missing_config_yields_no_users(self) -> None:
        self.assertEqual(bot.read_configured_users("/nonexistent/config.json"), [])


class BuildReplyTest(unittest.TestCase):
    def test_replies_in_the_same_topic(self) -> None:
        message = {"chat": {"id": -100}, "message_id": 7, "is_topic_message": True, "message_thread_id": 3}
        reply = bot.build_reply(message, "hi")
        self.assertEqual(reply["chat_id"], -100)
        self.assertEqual(reply["message_thread_id"], 3)
        self.assertEqual(reply["reply_parameters"]["message_id"], 7)

    def test_no_thread_outside_topics(self) -> None:
        reply = bot.build_reply({"chat": {"id": 1}, "message_id": 2, "message_thread_id": 9}, "hi")
        self.assertNotIn("message_thread_id", reply)


class TelegramCallTest(unittest.TestCase):
    def test_error_never_contains_the_token(self) -> None:
        error = bot.urllib.error.URLError("name resolution failed")
        with mock.patch.object(bot.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(bot.TelegramError) as ctx:
                bot.telegram_call("123:SECRET", "getMe", {}, timeout=1)
        self.assertIn("ERR_TELEGRAM_NETWORK", str(ctx.exception))
        self.assertNotIn("SECRET", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
