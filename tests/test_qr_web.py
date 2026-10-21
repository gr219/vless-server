import functools
import http.server
import os
import sys
import tempfile
import threading
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from qr_web import QrHandler, asset_version, normalize_prefix, rewrite_path  # noqa: E402


class RewritePathTest(unittest.TestCase):
    def test_root_paths_are_served_as_is(self):
        self.assertEqual(rewrite_path("/", "/qr"), ("/", None))
        self.assertEqual(rewrite_path("/app.js?v=1", "/qr"), ("/app.js?v=1", None))

    def test_prefixed_paths_are_stripped(self):
        self.assertEqual(rewrite_path("/qr/", "/qr"), ("/", None))
        self.assertEqual(rewrite_path("/qr/vless.js", "/qr"), ("/vless.js", None))
        self.assertEqual(rewrite_path("/qr/app.js?v=1", "/qr"), ("/app.js?v=1", None))

    def test_bare_prefix_redirects_with_trailing_slash(self):
        self.assertEqual(rewrite_path("/qr", "/qr"), (None, "/qr/"))
        self.assertEqual(rewrite_path("/qr?a=b", "/qr"), (None, "/qr/?a=b"))

    def test_lookalike_paths_are_not_stripped(self):
        self.assertEqual(rewrite_path("/qrcode.js", "/qr"), ("/qrcode.js", None))

    def test_empty_prefix_disables_rewriting(self):
        self.assertEqual(rewrite_path("/qr", ""), ("/qr", None))


class NormalizePrefixTest(unittest.TestCase):
    def test_forms(self):
        for raw in ("qr", "/qr", "/qr/", " qr/ "):
            self.assertEqual(normalize_prefix(raw), "/qr")
        self.assertEqual(normalize_prefix("/"), "")
        self.assertEqual(normalize_prefix(""), "")

    def test_rejects_query_characters(self):
        with self.assertRaises(ValueError):
            normalize_prefix("/qr?x")


class AssetVersionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def write(self, name, text):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as file:
            file.write(text)

    def test_changes_only_with_scripts_and_styles(self):
        self.write("app.js", "a")
        self.write("index.html", "x")
        first = asset_version(self.dir)
        self.write("index.html", "y")
        self.assertEqual(asset_version(self.dir), first)
        self.write("app.js", "b")
        self.assertNotEqual(asset_version(self.dir), first)

    def test_index_gets_the_version_and_other_files_are_untouched(self):
        self.write("index.html", '<script src="app.js?v=__ASSET_VERSION__"></script>')
        self.write("app.js", "console.log('__ASSET_VERSION__')")
        version = asset_version(self.dir)

        class Handler(QrHandler):
            prefix = "/qr"
            asset_version = version

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=self.dir))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}"

        for path in ("/", "/index.html", "/qr/", "/qr/index.html"):
            with urllib.request.urlopen(base + path) as resp:
                self.assertEqual(resp.read().decode(), f'<script src="app.js?v={version}"></script>', path)
        with urllib.request.urlopen(base + "/qr/app.js?v=old") as resp:
            self.assertEqual(resp.read().decode(), "console.log('__ASSET_VERSION__')")


if __name__ == "__main__":
    unittest.main()
