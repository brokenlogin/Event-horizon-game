#!/usr/bin/env python3
"""Serve Event Horizon at http://localhost:8000 (no caching, so edits show up on reload).

Usage: ./serve.sh [PORT] [--lan] [--open]
  --lan   also serve on your local network, so another computer on the same
          Wi-Fi can open the game from this machine (for multiplayer)
  --open  open the game in your browser
"""
import http.server
import os
import socket
import sys
import webbrowser

args = sys.argv[1:]
PORT = next((int(a) for a in args if a.isdigit()), 8000)
LAN = '--lan' in args
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *args):
        pass


def lan_ip():
    """Best guess at this machine's LAN address (no packets are actually sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return None


if __name__ == '__main__':
    url = f'http://localhost:{PORT}'
    print(f'Event Horizon running at {url}  (Ctrl+C to stop)')
    if LAN:
        ip = lan_ip()
        print(f'On your local network: http://{ip}:{PORT}' if ip else 'On your local network: http://<this-computer-ip>:' + str(PORT))
    if '--open' in args:
        webbrowser.open(url)
    with http.server.ThreadingHTTPServer(('0.0.0.0' if LAN else '127.0.0.1', PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
