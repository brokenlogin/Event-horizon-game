#!/usr/bin/env python3
"""Serve Event Horizon at http://localhost:8000 (no caching, so edits show up on reload).

Usage: ./serve.sh [PORT] [--lan] [--remote] [--open]
  --lan     also serve on your local network, so another computer on the same
            Wi-Fi can open the game from this machine
  --remote  host REMOTE multiplayer: runs the game relay and opens a free
            Cloudflare quick tunnel to it (needs `cloudflared`), then prints a
            share code for you and your friends to paste into the game
  --open    open the game in your browser

The relay (at /relay) passes messages between the players in one room. The
host's game still runs the world; this just forwards what it says. It uses
only the Python standard library.
"""
import base64
import hashlib
import http.server
import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import webbrowser

args = sys.argv[1:]
PORT = next((int(a) for a in args if a.isdigit()), 8000)
LAN = '--lan' in args
REMOTE = '--remote' in args
os.chdir(os.path.dirname(os.path.abspath(__file__)))

tunnel_code = None   # the quick tunnel's name, once cloudflared reports it


# ---------------------------------------------------------------------------
# Minimal WebSocket (RFC 6455) — text frames only, which is all the game sends
# ---------------------------------------------------------------------------
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MAX_MESSAGE = 64 * 1024        # bytes; game messages are a few hundred
MAX_RATE = 400                 # messages per second per connection before we start dropping


class WebSocket:
    def __init__(self, sock):
        self.sock = sock
        self.lock = threading.Lock()
        self.alive = True
        self.window = time.monotonic()
        self.count = 0

    def _read(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError('closed')
            buf += chunk
        return buf

    def recv(self):
        """Next text message, or None once the connection is closed."""
        parts = []
        while True:
            try:
                b1, b2 = self._read(2)
                opcode, fin = b1 & 0x0F, b1 & 0x80
                n = b2 & 0x7F
                if n == 126:
                    n = struct.unpack('>H', self._read(2))[0]
                elif n == 127:
                    n = struct.unpack('>Q', self._read(8))[0]
                if n > MAX_MESSAGE:
                    return None
                mask = self._read(4) if b2 & 0x80 else b'\0\0\0\0'
                data = bytearray(self._read(n))
                for i in range(n):
                    data[i] ^= mask[i & 3]
            except (OSError, ConnectionError, ValueError):
                return None
            if opcode == 0x8:                       # close
                return None
            if opcode == 0x9:                       # ping
                self._frame(0xA, bytes(data))
                continue
            if opcode == 0xA:                       # pong
                continue
            parts.append(bytes(data))
            if sum(len(p) for p in parts) > MAX_MESSAGE:
                return None
            if fin:
                # simple flood control
                now = time.monotonic()
                if now - self.window >= 1:
                    self.window, self.count = now, 0
                self.count += 1
                if self.count > MAX_RATE:
                    parts = []
                    continue
                return b''.join(parts).decode('utf-8', 'replace')

    def _frame(self, opcode, payload):
        n = len(payload)
        head = bytearray([0x80 | opcode])
        if n < 126:
            head.append(n)
        elif n < 65536:
            head.append(126)
            head += struct.pack('>H', n)
        else:
            head.append(127)
            head += struct.pack('>Q', n)
        with self.lock:
            if not self.alive:
                return
            try:
                self.sock.sendall(bytes(head) + payload)
            except OSError:
                self.alive = False

    def send(self, obj):
        self._frame(0x1, (obj if isinstance(obj, str) else json.dumps(obj, separators=(',', ':'))).encode())

    def close(self):
        if self.alive:
            self._frame(0x8, b'')
        self.alive = False
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# The relay: one hosted room per server. Messages from the host go to one
# guest (`to`) or all of them; messages from a guest go to the host, tagged
# with the guest's relay id.
#   client -> relay:  {t:'host'} | {t:'join'} | {t:'d', m, to?} | {t:'kick', peer}
#   relay -> client:  {t:'hosted'} | {t:'joined'} | {t:'error', why}
#                     {t:'peer-join', peer} | {t:'peer-leave', peer} | {t:'d', m, from?} | {t:'closed'}
# ---------------------------------------------------------------------------
MAX_GUESTS = 7      # the game itself admits 3; a little headroom for refusals


class Relay:
    def __init__(self):
        self.lock = threading.Lock()
        self.host = None
        self.guests = {}
        self.next_id = 1

    def serve(self, ws):
        role, pid = None, None
        try:
            while True:
                raw = ws.recv()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                t = msg.get('t')
                if role is None:
                    if t == 'host':
                        with self.lock:
                            taken = self.host is not None and self.host.alive
                            if not taken:
                                self.host, role = ws, 'host'
                        if taken:
                            ws.send({'t': 'error', 'why': 'Someone is already hosting on this server. Only one game at a time.'})
                            break
                        ws.send({'t': 'hosted'})
                        log('host connected')
                    elif t == 'join':
                        with self.lock:
                            host = self.host if self.host is not None and self.host.alive else None
                            ok = host is not None and len(self.guests) < MAX_GUESTS
                            if ok:
                                pid, role = self.next_id, 'guest'
                                self.next_id += 1
                                self.guests[pid] = ws
                        if not ok:
                            ws.send({'t': 'error', 'why': 'No game is being hosted right now. The host needs to press HOST first.' if host is None else 'That room is full.'})
                            break
                        ws.send({'t': 'joined'})
                        host.send({'t': 'peer-join', 'peer': pid})
                        log(f'guest {pid} joined')
                    continue
                if t == 'd':
                    if role == 'host':
                        to = msg.get('to')
                        with self.lock:
                            targets = list(self.guests.values()) if to is None else [self.guests[to]] if to in self.guests else []
                        out = json.dumps({'t': 'd', 'm': msg.get('m')}, separators=(',', ':'))
                        for g in targets:
                            g.send(out)
                    else:
                        with self.lock:
                            host = self.host
                        if host is not None:
                            host.send(json.dumps({'t': 'd', 'from': pid, 'm': msg.get('m')}, separators=(',', ':')))
                elif t == 'kick' and role == 'host':
                    with self.lock:
                        g = self.guests.pop(msg.get('peer'), None)
                    if g is not None:
                        g.close()
        finally:
            ws.close()
            with self.lock:
                if role == 'host' and self.host is ws:
                    self.host = None
                    gone = list(self.guests.values())
                    self.guests.clear()
                    leaving_host = None
                else:
                    gone = []
                    leaving_host = self.host if role == 'guest' and self.guests.pop(pid, None) is not None else None
            for g in gone:
                g.send({'t': 'closed'})
                g.close()
            if leaving_host is not None:
                leaving_host.send({'t': 'peer-leave', 'peer': pid})
            if role:
                log('host left' if role == 'host' else f'guest {pid} left')


relay = Relay()


def log(text):
    if REMOTE:
        print(f'  [{time.strftime("%H:%M:%S")}] {text}', flush=True)


# ---------------------------------------------------------------------------
# HTTP: the game files, plus /relay (WebSocket) and /relay-info
# ---------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/relay' and self.headers.get('Upgrade', '').lower() == 'websocket':
            self._websocket()
            return
        if path == '/relay-info':
            body = json.dumps({'code': tunnel_code}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # never serve hidden files (.git etc.), especially through the tunnel
        if any(part.startswith('.') or part == '__pycache__' for part in path.split('/') if part):
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        path = self.path.split('?', 1)[0]
        if any(part.startswith('.') or part == '__pycache__' for part in path.split('/') if part):
            self.send_error(404)
            return
        super().do_HEAD()

    def _websocket(self):
        key = self.headers.get('Sec-WebSocket-Key')
        if not key:
            self.send_error(400)
            return
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, 'Switching Protocols')
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', accept)
        http.server.BaseHTTPRequestHandler.end_headers(self)   # no cache header on the upgrade
        self.wfile.flush()
        self.close_connection = True
        self.connection.settimeout(60)    # the game pings every second; silence means it's gone
        relay.serve(WebSocket(self.connection))

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def lan_ip():
    """Best guess at this machine's LAN address (no packets are actually sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return None


# ---------------------------------------------------------------------------
# Cloudflare quick tunnel (no account): gives the relay a public https address
# ---------------------------------------------------------------------------
def find_cloudflared():
    found = shutil.which('cloudflared')
    if found:
        return found
    for p in ('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared',
              r'C:\Program Files (x86)\cloudflared\cloudflared.exe', r'C:\Program Files\cloudflared\cloudflared.exe'):
        if os.path.exists(p):
            return p
    return None


def start_tunnel():
    exe = find_cloudflared()
    if not exe:
        print('\n  cloudflared is not installed, so REMOTE hosting cannot start.')
        print('  Mac:      brew install cloudflared')
        print('  Windows:  winget install --id Cloudflare.cloudflared')
        print('  Linux:    see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n')
        return None
    proc = subprocess.Popen(
        [exe, 'tunnel', '--no-autoupdate', '--url', f'http://127.0.0.1:{PORT}'],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )

    def watch():
        global tunnel_code
        for line in proc.stdout:
            m = re.search(r'https://([a-z0-9-]+)\.trycloudflare\.com', line)
            if m and not tunnel_code:
                tunnel_code = m.group(1)
                print('\n  ============================================================')
                print('   REMOTE HOSTING READY')
                print(f'   Share code:  {tunnel_code}')
                print('  ============================================================')
                print(f'   1. Open the game: http://localhost:{PORT}  (the code is filled in for you)')
                print('      or the usual link, and paste the share code yourself.')
                print('   2. MULTIPLAYER -> REMOTE -> HOST.')
                print('   3. Send the share code to your friends: MULTIPLAYER -> REMOTE -> JOIN.')
                print('   Keep this window open while you play. Ctrl+C ends the session.')
                print('   (A brand-new tunnel can take ~10 seconds before it answers.)\n', flush=True)
                if '--open' in args:
                    webbrowser.open(f'http://localhost:{PORT}')
        if not tunnel_code:
            print('\n  cloudflared stopped before the tunnel came up. Check your internet connection and try again.\n', flush=True)

    threading.Thread(target=watch, daemon=True).start()
    return proc


def open_server():
    """Bind the server, moving up to the next free port if this one is taken
    (another copy of the game server is usually what's sitting on it)."""
    global PORT
    host = '0.0.0.0' if LAN else '127.0.0.1'
    first = PORT
    for port in range(first, first + 20):
        try:
            server = Server((host, port), Handler)
        except OSError as e:
            if e.errno in (48, 98, 10048):     # address in use (macOS, Linux, Windows)
                continue
            raise
        if port != first:
            print(f'(Port {first} is busy, probably another copy of this server, so using {port}.)')
        PORT = port
        return server
    sys.exit(f'Ports {first}-{first + 19} are all busy. Close other copies of the server and try again.')


if __name__ == '__main__':
    httpd = open_server()
    url = f'http://localhost:{PORT}'
    print(f'Event Horizon running at {url}  (Ctrl+C to stop)')
    if LAN:
        ip = lan_ip()
        print(f'On your local network: http://{ip}:{PORT}' if ip else 'On your local network: http://<this-computer-ip>:' + str(PORT))
    # a plain kill should clean up the tunnel just like Ctrl+C does
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    tunnel = None
    try:
        if REMOTE:
            print('Starting the Cloudflare tunnel for REMOTE multiplayer...', flush=True)
            tunnel = start_tunnel()
        elif '--open' in args:
            webbrowser.open(url)
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if tunnel is not None:
            tunnel.terminate()
        httpd.server_close()
