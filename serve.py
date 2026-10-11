#!/usr/bin/env python3
"""Serve Event Horizon at http://localhost:8000 (no caching, so edits show up on reload)."""
import http.server
import os
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    url = f'http://localhost:{PORT}'
    print(f'Event Horizon running at {url}  (Ctrl+C to stop)')
    if '--open' in sys.argv:
        webbrowser.open(url)
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
