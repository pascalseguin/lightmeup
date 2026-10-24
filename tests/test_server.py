"""Tests for server.py: E1.31 packet layout and the HTTP bridge. Run with: python -m unittest discover tests"""
import http.server
import json
import socket
import struct
import sys
import threading
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class PacketTest(unittest.TestCase):
    def test_e131_layout(self):
        s = server.SacnSender(3, "127.0.0.1")
        d = s.packet(bytes([10, 128, 255]))
        self.assertEqual(len(d), 638)
        self.assertEqual(d[4:16], b"ASC-E1.17\0\0\0")
        self.assertEqual(struct.unpack("!H", d[16:18])[0], 0x7000 | 622)
        self.assertEqual(struct.unpack("!I", d[18:22])[0], 4)
        self.assertEqual(struct.unpack("!H", d[38:40])[0], 0x7000 | 600)
        self.assertEqual(d[44:53], b"LightMeUp")
        self.assertEqual(struct.unpack("!H", d[113:115])[0], 3)
        self.assertEqual(struct.unpack("!H", d[115:117])[0], 0x7000 | 523)
        self.assertEqual(struct.unpack("!H", d[123:125])[0], 513)
        self.assertEqual(list(d[125:129]), [0, 10, 128, 255])
        s.close()

    def test_multicast_address(self):
        s = server.SacnSender(258, "multicast")
        self.assertEqual(s.addr, ("239.255.1.2", 5568))
        s.close()


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rx.bind(("127.0.0.1", 0))
        self.rx.settimeout(5)
        sender = server.SacnSender(1, "127.0.0.1")
        sender.addr = self.rx.getsockname()
        server.Handler.sender = sender
        self.httpd = server.start_server("127.0.0.1", 0, True)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        server.Handler.sender.close()
        self.rx.close()

    def test_status(self):
        with urllib.request.urlopen(self.base + "/api/status") as r:
            body = json.load(r)
        self.assertTrue(body["ok"])
        self.assertEqual(body["version"], server.__version__)

    def test_serves_app(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"LightMeUp", r.read())

    def test_dmx_forwarded(self):
        req = urllib.request.Request(self.base + "/api/dmx", data=bytes([1, 2, 3]), method="POST")
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 204)
        pkt, _ = self.rx.recvfrom(1000)
        self.assertEqual(list(pkt[126:129]), [1, 2, 3])

    def test_rejects_oversized_frame(self):
        req = urllib.request.Request(self.base + "/api/dmx", data=bytes(513), method="POST")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 400)


class PortFallbackTest(unittest.TestCase):
    def test_next_free_port_when_default_taken(self):
        blocker = http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
        taken = blocker.server_address[1]
        try:
            s = server.start_server("127.0.0.1", taken, False)
            self.assertNotEqual(s.server_address[1], taken)
            s.server_close()
            with self.assertRaises(SystemExit):
                server.start_server("127.0.0.1", taken, True)
        finally:
            blocker.server_close()


if __name__ == "__main__":
    unittest.main()
