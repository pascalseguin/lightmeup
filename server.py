#!/usr/bin/env python3
"""LightMeUp live bridge.

Serves the show builder (app/) on http://localhost:8085 and forwards the DMX
frames it posts to the show network as E1.31 / sACN, the protocol xLights,
Falcon Player and most pixel/DMX controllers speak.

Usage:
    python3 server.py                          # multicast to universe 1
    python3 server.py --target 192.168.1.50    # unicast to one controller
    python3 server.py --universe 2 --port 8090
    python3 server.py --bind 0.0.0.0           # reachable from other devices on the network
    python3 server.py --open                   # also open the editor in the default browser

Only the Python standard library is needed.
"""
import argparse
import errno
import http.server
import json
import os
import socket
import struct
import sys
import threading
import uuid
import webbrowser
from pathlib import Path

__version__ = "0.1.0"

FROZEN = getattr(sys, "frozen", False)  # running from a packaged build (PyInstaller)
APP_DIR = (Path(getattr(sys, "_MEIPASS", "")) if FROZEN else Path(__file__).resolve().parent) / "app"
SACN_PORT = 5568
DEFAULT_PORT = 8085


class SacnSender:
    """Builds and sends 638-byte E1.31 data packets for one universe."""

    def __init__(self, universe, target, source_name="LightMeUp", priority=100):
        self.universe = universe
        self.multicast = target in (None, "", "multicast")
        self.addr = (f"239.255.{universe >> 8}.{universe & 0xFF}" if self.multicast else target, SACN_PORT)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        if self.multicast:
            self.sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)
        self.cid = uuid.uuid4().bytes
        self.name = source_name.encode()[:63].ljust(64, b"\0")
        self.priority = priority
        self.seq = 0
        self.lock = threading.Lock()

    def packet(self, data):
        data = bytes(data[:512]).ljust(512, b"\0")
        root = struct.pack("!HH12sHI16s", 0x0010, 0x0000, b"ASC-E1.17\0\0\0", 0x7000 | 622, 0x00000004, self.cid)
        framing = struct.pack("!HI64sBHBBH", 0x7000 | 600, 0x00000002, self.name, self.priority, 0, self.seq, 0, self.universe)
        dmp = struct.pack("!HBBHHHB", 0x7000 | 523, 0x02, 0xA1, 0x0000, 0x0001, 513, 0x00)
        return root + framing + dmp + data

    def send(self, data):
        with self.lock:
            self.sock.sendto(self.packet(data), self.addr)
            self.seq = (self.seq + 1) & 0xFF

    def close(self):
        self.sock.close()

    def describe(self):
        return f"{self.addr[0]} (multicast)" if self.multicast else self.addr[0]


class Handler(http.server.SimpleHTTPRequestHandler):
    sender = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/status":
            return self.reply_json({"ok": True, "version": __version__, "universe": self.sender.universe,
                                    "target": self.sender.describe()})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/dmx":
            return self.reply_json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length", 0))
        if not 0 < length <= 512:
            return self.reply_json({"error": "expected 1-512 bytes of DMX data"}, 400)
        self.sender.send(self.rfile.read(length))
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        if "/api/dmx" not in (args[0] if args else ""):
            super().log_message(fmt, *args)


def local_ips():
    """Best-effort list of this machine's IPv4 addresses, for printing reachable URLs."""
    ips = set()
    try:
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        ips.add(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()
    return sorted(ip for ip in ips if not ip.startswith("127."))


class Server(http.server.ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second program silently share a busy port; ask for exclusive use instead.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def port_busy(e):
    # Windows reports a port held by another program as WSAEADDRINUSE (10048) or WSAEACCES (10013).
    return e.errno in (errno.EADDRINUSE, errno.EACCES) or getattr(e, "winerror", None) in (10048, 10013)


def start_server(bind, port, explicit_port):
    """Bind the web server; if the default port is taken, try the next few."""
    tries = 1 if explicit_port else 20
    for p in range(port, port + tries):
        try:
            return Server((bind, p), Handler)
        except OSError as e:
            if not port_busy(e):
                raise
    raise SystemExit(f"Port {port} is already in use. Pick another one with --port.")


def main():
    ap = argparse.ArgumentParser(description="Serve LightMeUp and send its live output as E1.31/sACN.")
    ap.add_argument("--version", action="version", version=f"LightMeUp {__version__}")
    ap.add_argument("--target", default="multicast", help="controller IP address for unicast, or 'multicast' (default)")
    ap.add_argument("--universe", type=int, default=1, help="sACN universe number, 1-63999 (default 1)")
    ap.add_argument("--port", type=int, default=None, help=f"web page port (default {DEFAULT_PORT}, or the next free one)")
    ap.add_argument("--bind", default="127.0.0.1", help="address to serve the page on; use 0.0.0.0 to reach it from other devices")
    ap.add_argument("--open", dest="open_browser", action="store_true", default=FROZEN,
                    help="open the editor in the default web browser (default for installed builds)")
    ap.add_argument("--no-browser", dest="open_browser", action="store_false", help="don't open a browser")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # show status lines immediately, even when output is piped
    if not 1 <= args.universe <= 63999:
        ap.error("universe must be between 1 and 63999")

    Handler.sender = SacnSender(args.universe, args.target)
    server = start_server(args.bind, args.port or DEFAULT_PORT, args.port is not None)
    port = server.server_address[1]
    url = f"http://localhost:{port}"
    print(f"LightMeUp {__version__} is running:  {url}")
    if args.bind == "0.0.0.0":
        for ip in local_ips():
            print(f"                  also: http://{ip}:{port}")
    print(f"Live output -> sACN universe {args.universe} to {Handler.sender.describe()}")
    print("Keep this window open while you use LightMeUp. Close it (or press Ctrl+C) to stop.")
    if args.open_browser:
        threading.Timer(0.6, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        # A double-clicked window would vanish before the message could be read.
        if FROZEN and e.code not in (0, None):
            print(e.code if isinstance(e.code, str) else "LightMeUp stopped with an error.")
            input("Press Enter to close.")
            sys.exit(1)
        raise
