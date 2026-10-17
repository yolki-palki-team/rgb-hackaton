"""Private HTTPS regtest transport and loopback adapters for native SDK and WDK."""

import http.client
import json
import os
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from desktop_wallet import read_private

LIMIT = 8 * 1024 * 1024


class Client:
    def __init__(self, config):
        self.config = config
        self.local = threading.local()
        self.url = urlsplit(config["url"])
        if (
            self.url.scheme != "https"
            or not self.url.hostname
            or self.url.username
            or self.url.password
            or self.url.query
            or self.url.fragment
            or self.url.path != "/chain"
        ):
            raise ValueError("Expected an HTTPS /chain invitation URL")
        for key in ("token", "chainId"):
            value = config.get(key, "")
            if len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
                raise ValueError("Invalid network invitation")

    @classmethod
    def from_env(cls):
        return cls(read_private(Path(os.environ["PALKA_CHAIN_CONFIG"])))

    def raw(self, endpoint, payload=None, content_type="application/json"):
        conn = getattr(self.local, "connection", None)
        if conn is None:
            conn = http.client.HTTPSConnection(self.url.hostname, self.url.port or 443, timeout=45)
            self.local.connection = conn
        try:
            conn.request(
                "GET" if payload is None else "POST",
                self.url.path + endpoint,
                payload,
                {
                    "Authorization": "Bearer " + self.config["token"],
                    "X-Palka-Chain": self.config["chainId"],
                    "Content-Type": content_type,
                },
            )
            response = conn.getresponse()
            raw = response.read(LIMIT + 1)
            if len(raw) > LIMIT or response.getheader("X-Palka-Chain") != self.config["chainId"]:
                raise ValueError("Remote chain checkpoint mismatch or oversized response")
            if response.status != 200:
                # Match the local bitcoin-cli failure contract. Recovery probes
                # for transactions that may not have been broadcast yet.
                error_type = (
                    RuntimeError if endpoint == "/rpc" and response.status == 400 else ValueError
                )
                raise error_type(
                    f"Shared network request failed ({response.status}): "
                    + raw.decode(errors="replace")[:250]
                )
            return raw
        except Exception:
            conn.close()
            self.local.connection = None
            raise

    def request(self, endpoint, data):
        return json.loads(self.raw(endpoint, json.dumps(data).encode()))["result"]

    def health(self):
        info = json.loads(self.raw("/health"))
        if info.get("network") != "regtest" or info.get("chainId") != self.config["chainId"]:
            raise ValueError("Remote regtest checkpoint mismatch")
        # Verify the credential as well as the public health response.
        if (
            self.request("/rpc", {"method": "getblockhash", "params": [1]})
            != self.config["chainId"]
        ):
            raise ValueError("Remote Core checkpoint mismatch")
        return info


class ElectrumHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(120)
        while True:
            line = self.rfile.readline(LIMIT + 1)
            if not line or len(line) > LIMIT:
                return
            try:
                request = json.loads(line)
                response = self.server.client.request("/electrum", request)
                self.wfile.write(json.dumps(response).encode() + b"\n")
                self.wfile.flush()
            except Exception:
                # Never return fabricated balances or silently fall back to a local chain.
                return


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != "/json-rpc":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= LIMIT:
                raise ValueError("Invalid body size")
            result = self.server.client.raw(
                "/proxy",
                self.rfile.read(length),
                self.headers.get("Content-Type", "application/json"),
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(result)))
            self.end_headers()
            self.wfile.write(result)
        except Exception:
            self.send_error(502)


class TCPServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class Adapters:
    def __init__(self, client):
        self.servers = []
        try:
            for server_class, handler, port in (
                (TCPServer, ElectrumHandler, 51001),
                (ThreadingHTTPServer, ProxyHandler, 53000),
            ):
                server = server_class(("127.0.0.1", port), handler)
                server.client = client
                self.servers.append(server)
                threading.Thread(target=server.serve_forever, daemon=True).start()
        except Exception:
            self.close()
            raise

    def close(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()


def environment(path):
    return {
        "PALKA_CHAIN_CONFIG": str(path),
        "RGB_INDEXER_URL": "127.0.0.1:51001",
        "RGB_PROXY_URL": "http://127.0.0.1:53000/json-rpc",
        "WDK_ELECTRUM_PORT": "51001",
    }
