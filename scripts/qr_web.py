"""Static server for the VLESS QR page (web/qr/).

The page lives at http://localhost:<port>/. Cloudflare Tunnel does not strip
the public path, so https://<host>/qr/app.js arrives here as /qr/app.js; the
--prefix is therefore removed from request paths, and a bare /qr is redirected
to /qr/ so the page's relative asset URLs stay under the tunnel route.

Cloudflare's browser cache TTL overrides this server's Cache-Control for .js
and .css files, so index.html's __ASSET_VERSION__ placeholders are replaced
with a hash of those files: a changed script gets a new URL.
"""
import argparse
import functools
import hashlib
import http.server
import os
import sys
from typing import Optional, Tuple

DEFAULT_DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "qr")
ASSET_VERSION_TOKEN = b"__ASSET_VERSION__"
INDEX_PATHS = ("/", "/index.html")


def rewrite_path(request_path: str, prefix: str) -> Tuple[Optional[str], Optional[str]]:
    """Maps a request path onto the site root.

    Returns (path_to_serve, None), or (None, redirect_location) for the bare
    prefix. Paths outside the prefix are served as they are.
    """
    path, sep, query = request_path.partition("?")
    suffix = sep + query
    if not prefix:
        return request_path, None
    if path == prefix:
        return None, prefix + "/" + suffix
    if path.startswith(prefix + "/"):
        return path[len(prefix):] + suffix, None
    return request_path, None


def normalize_prefix(prefix: str) -> str:
    """Turns 'qr', '/qr' or '/qr/' into '/qr'; '' or '/' disables it."""
    stripped = prefix.strip().strip("/")
    if stripped and any(ch in stripped for ch in "?#"):
        raise ValueError(f"ERR_QR_WEB_BAD_PREFIX: prefix must be a plain path, got {prefix!r}.")
    return "/" + stripped if stripped else ""


def asset_version(directory: str) -> str:
    """Short hash of the top-level .js and .css files' names and contents."""
    digest = hashlib.sha256()
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if name.endswith((".js", ".css")) and os.path.isfile(path):
            digest.update(name.encode())
            with open(path, "rb") as file:
                digest.update(file.read())
    return digest.hexdigest()[:12]


class QrHandler(http.server.SimpleHTTPRequestHandler):
    prefix = ""
    asset_version = ""

    def _route(self) -> bool:
        """Rewrites self.path; returns False when a redirect was sent instead."""
        path, location = rewrite_path(self.path, self.prefix)
        if location is not None:
            self.send_response(301)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        self.path = path
        return True

    def _send_index(self) -> None:
        with open(os.path.join(self.directory, "index.html"), "rb") as file:
            body = file.read().replace(ASSET_VERSION_TOKEN, self.asset_version.encode())
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self._route():
            if self.path.partition("?")[0] in INDEX_PATHS:
                self._send_index()
            else:
                super().do_GET()

    def do_HEAD(self):
        if self._route():
            if self.path.partition("?")[0] in INDEX_PATHS:
                self._send_index()
            else:
                super().do_HEAD()

    def end_headers(self):
        # The page is tiny and changes with each deploy; never serve it stale.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve the VLESS QR page")
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--prefix", default="/qr", help="public path prefix to strip ('' to disable)")
    parser.add_argument("--directory", default=DEFAULT_DIRECTORY)
    args = parser.parse_args()

    directory = os.path.abspath(args.directory)
    if not os.path.isfile(os.path.join(directory, "index.html")):
        print(f"ERR_QR_WEB_NO_INDEX: {directory} has no index.html.", file=sys.stderr)
        return 1
    try:
        QrHandler.prefix = normalize_prefix(args.prefix)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1

    QrHandler.asset_version = asset_version(directory)
    handler = functools.partial(QrHandler, directory=directory)
    with http.server.ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Serving {directory} on http://{args.bind}:{args.port}/ (prefix {QrHandler.prefix or 'none'})", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
