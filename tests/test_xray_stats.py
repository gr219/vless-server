import copy
import importlib.util
import json
import pathlib
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent / "scripts"


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


xray_stats = load_script("xray-stats")


def sample_config() -> dict:
    """The shape main.py writes in dual-transport mode, after warp-route.py."""
    return {
        "log": {"loglevel": "debug"},
        "inbounds": [
            {
                "port": 10080, "listen": "127.0.0.1", "protocol": "vless",
                "settings": {"clients": [
                    {"id": "main-uuid", "level": 0},
                    {"id": "warp-uuid", "email": "warp", "level": 0},
                ], "decryption": "none"},
                "streamSettings": {"network": "ws", "security": "none", "wsSettings": {"path": "/"}},
            },
            {
                "port": 10081, "listen": "127.0.0.1", "protocol": "vless",
                "settings": {"clients": [{"id": "main-uuid", "level": 0}], "decryption": "none"},
                "streamSettings": {"network": "xhttp", "security": "none"},
            },
            {"port": 1080, "protocol": "socks", "settings": {}},
        ],
        "outbounds": [{"tag": "direct", "protocol": "freedom"}],
        "routing": {"rules": [{"type": "field", "user": ["warp"], "outboundTag": "warp"}]},
    }


class ApplyStatsTest(unittest.TestCase):
    def test_gives_unnamed_clients_the_direct_email_and_keeps_existing_ones(self) -> None:
        config = xray_stats.apply_stats(sample_config())
        emails = [c["email"] for c in config["inbounds"][0]["settings"]["clients"]]
        self.assertEqual(emails, ["direct", "warp"])
        self.assertEqual(config["inbounds"][1]["settings"]["clients"][0]["email"], "direct")

    def test_trusts_forwarded_for_on_vless_inbounds_only(self) -> None:
        config = xray_stats.apply_stats(sample_config())
        for inbound in config["inbounds"][:2]:
            self.assertEqual(inbound["streamSettings"]["sockopt"]["trustedXForwardedFor"], ["CF-Connecting-IP"])
        self.assertNotIn("streamSettings", config["inbounds"][2])

    def test_keeps_existing_stream_settings(self) -> None:
        config = xray_stats.apply_stats(sample_config())
        self.assertEqual(config["inbounds"][0]["streamSettings"]["wsSettings"], {"path": "/"})

    def test_enables_stats_api_and_user_policy(self) -> None:
        config = xray_stats.apply_stats(sample_config())
        self.assertEqual(config["stats"], {})
        self.assertEqual(config["api"], {"tag": "api", "listen": "127.0.0.1:10085", "services": ["StatsService"]})
        self.assertEqual(config["policy"]["levels"]["0"], {
            "statsUserUplink": True, "statsUserDownlink": True, "statsUserOnline": True,
        })

    def test_merges_into_existing_policy(self) -> None:
        config = sample_config()
        config["policy"] = {"levels": {"0": {"handshake": 4}}, "system": {"statsInboundUplink": True}}
        xray_stats.apply_stats(config)
        self.assertEqual(config["policy"]["levels"]["0"]["handshake"], 4)
        self.assertTrue(config["policy"]["levels"]["0"]["statsUserOnline"])
        self.assertEqual(config["policy"]["system"], {"statsInboundUplink": True})

    def test_leaves_routing_and_outbounds_alone(self) -> None:
        original = sample_config()
        config = xray_stats.apply_stats(copy.deepcopy(original))
        self.assertEqual(config["routing"], original["routing"])
        self.assertEqual(config["outbounds"], original["outbounds"])

    def test_main_rewrites_the_file_in_place(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "config.json"
            path.write_text(json.dumps(sample_config()), encoding="utf-8")
            xray_stats.main(str(path))
            written = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("api", written)
            self.assertEqual(sorted(p.name for p in pathlib.Path(tmp).iterdir()), ["config.json"])


if __name__ == "__main__":
    unittest.main()
