#!/usr/bin/env python3
"""Local development server with caching disabled.

Usage: python3 tools/serve.py [port]      (default 8765, serves the repository root)
Open http://localhost:<port>/ — localhost counts as a secure context, so camera/GPS APIs work
in desktop browsers. For an iPhone you need HTTPS (see README: "Testing on an iPhone").
"""
import functools
import http.server
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{port}/")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
