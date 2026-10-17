"""Authenticated HTTPS-upstream gateway for a private, disposable-value regtest chain.

Caddy terminates TLS. Core and Electrum are never published on host ports.
Only the faucet's miner wallet is held here; participant keys stay on desktops.
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LIMIT = 8 * 1024 * 1024
RPC_METHODS = {
    "getblockchaininfo",
    "getblockcount",
    "getblockhash",
    "getblockheader",
    "gettxout",
    "getrawtransaction",
    "decoderawtransaction",
    "combinepsbt",
    "finalizepsbt",
    "testmempoolaccept",
    "sendrawtransaction",
}
ELECTRUM_METHODS = {
    "server.version",
    "server.features",
    "server.ping",
    "server.banner",
    "blockchain.headers.subscribe",
    "blockchain.block.header",
    "blockchain.block.headers",
    "blockchain.estimatefee",
    "blockchain.relayfee",
    "mempool.get_fee_histogram",
    "blockchain.scripthash.subscribe",
    "blockchain.scripthash.unsubscribe",
    "blockchain.scripthash.get_balance",
    "blockchain.scripthash.get_history",
    "blockchain.scripthash.listunspent",
    "blockchain.scripthash.get_mempool",
    "blockchain.transaction.get",
    "blockchain.transaction.get_merkle",
    "blockchain.transaction.broadcast",
    "blockchain.transaction.id_from_pos",
}


def atomic(path, data):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(data, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def core(method, params=None, wallet=False):
    conn = http.client.HTTPConnection("bitcoind", 18443, timeout=30)
    credential = base64.b64encode(
        f"{os.environ['BTCUSER']}:{os.environ['BTCPASS']}".encode()
    ).decode()
    try:
        conn.request(
            "POST",
            "/wallet/palka-faucet" if wallet else "/",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}),
            {"Authorization": "Basic " + credential, "Content-Type": "application/json"},
        )
        response = json.loads(conn.getresponse().read(LIMIT))
        if response.get("error"):
            raise ValueError("Core RPC failed: " + str(response["error"].get("message")))
        return response["result"]
    finally:
        conn.close()


def electrum(request):
    batch = isinstance(request, list)
    requests = request if batch else [request]
    if not requests or len(requests) > 1000:
        raise ValueError("Invalid Electrum batch")
    responses = []
    with socket.create_connection(("electrs", 50001), timeout=30) as sock:
        with sock.makefile("rwb") as stream:
            for item in requests:
                if not isinstance(item, dict) or item.get("method") not in ELECTRUM_METHODS:
                    raise ValueError("Electrum method is not permitted")
                if item["method"] == "server.features":
                    responses.append(
                        {
                            "id": item.get("id"),
                            "result": {
                                "genesis_hash": core("getblockhash", [0]),
                                "hash_function": "sha256",
                                "protocol_min": "1.4",
                                "protocol_max": "1.4",
                                "server_version": "palka-regtest",
                            },
                        }
                    )
                    continue
                if (
                    item["method"] == "blockchain.transaction.get"
                    and len(item.get("params", [])) > 1
                    and item["params"][1] is True
                ):
                    try:
                        result = core("getrawtransaction", [item["params"][0], True])
                        responses.append({"jsonrpc": "2.0", "id": item.get("id"), "result": result})
                    except ValueError as error:
                        responses.append(
                            {
                                "jsonrpc": "2.0",
                                "id": item.get("id"),
                                "error": {"code": -5, "message": str(error)},
                            }
                        )
                    continue
                stream.write(json.dumps(item).encode() + b"\n")
                stream.flush()
                while True:
                    raw = stream.readline(LIMIT + 1)
                    if not raw or len(raw) > LIMIT:
                        raise ValueError("Invalid Electrum response")
                    response = json.loads(raw)
                    if response.get("id") == item.get("id"):
                        responses.append(response)
                        break
    return responses if batch else responses[0]


class Network:
    def assignment(self, owner):
        path = self.state / "catalog.json"
        with self.lock:
            entries = json.loads(path.read_text()) if path.exists() else {}
            for ticker, entry in entries.items():
                if entry["ownerId"] == owner:
                    return ticker
            for ticker in ("X", "DUSD"):
                if ticker not in entries:
                    entries[ticker] = {"ownerId": owner}
                    atomic(path, entries)
                    return ticker
            return None

    def __init__(self, state):
        self.state = state
        state.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        if core("getblockchaininfo")["chain"] != "regtest":
            raise ValueError("Regtest required")
        if "palka-faucet" not in core("listwallets"):
            names = {item["name"] for item in core("listwalletdir")["wallets"]}
            core("loadwallet" if "palka-faucet" in names else "createwallet", ["palka-faucet"])
        self.miner = core("getnewaddress", wallet=True)
        if core("getblockcount") < 101:
            core("generatetoaddress", [101 - core("getblockcount"), self.miner])
        self.chain_id = core("getblockhash", [1])
        marker = state / "checkpoint.json"
        if marker.exists() and json.loads(marker.read_text())["chainId"] != self.chain_id:
            raise ValueError("Chain volume changed; restore the original chain")
        atomic(marker, {"chainId": self.chain_id})

    def fund(self, request):
        owner, address = request.get("ownerId", ""), request.get("address", "")
        purpose = request.get("purpose")
        if not re.fullmatch(r"participant-[0-9a-f]{64}", owner):
            raise ValueError("Automatic participant ID required")
        if purpose not in ("btc", "rgb", "wdk"):
            raise ValueError("Expected btc, rgb or wdk funding purpose")
        if not address.startswith("bcrt1") or not core("validateaddress", [address])["isvalid"]:
            raise ValueError("Valid regtest address required")
        sats = 100_000 if purpose == "rgb" else 1_000_000
        key = hashlib.sha256(f"{owner}:{purpose}".encode()).hexdigest()
        path = self.state / ("fund-" + key + ".json")
        with self.lock:
            if path.exists():
                receipt = json.loads(path.read_text())
                if receipt["address"] != address:
                    raise ValueError("Funding is already bound to a different address")
                if not receipt.get("txid"):
                    raise ValueError(
                        "Uncertain faucet payment; operator must reconcile before retrying"
                    )
                return receipt
            receipt = {"ownerId": owner, "address": address, "purpose": purpose, "sats": str(sats)}
            # Fail closed if Core accepted a payment but the process crashed before saving its txid.
            atomic(path, receipt)
            receipt["txid"] = core("sendtoaddress", [address, sats / 100_000_000, key], wallet=True)
            atomic(path, receipt)
            core("generatetoaddress", [1, self.miner])
            return receipt

    def catalog(self, request):
        path = self.state / "catalog.json"
        with self.lock:
            entries = json.loads(path.read_text()) if path.exists() else {}
            ticker = request.get("ticker")
            if ticker is None:
                return entries
            if ticker not in ("X", "DUSD"):
                raise ValueError("Only X and DUSD demo issuance is supported")
            owner = request.get("ownerId", "")
            if not re.fullmatch(r"participant-[0-9a-f]{64}", owner):
                raise ValueError("Automatic participant ID required")
            entry = entries.get(ticker, {"ownerId": owner})
            if entry["ownerId"] != owner:
                raise ValueError(
                    "This asset already has an issuer; sync its existing contract instead"
                )
            if "contract" in request:
                candidate = {
                    "ownerId": owner,
                    "contractId": request["contractId"],
                    "contract": request["contract"],
                }
                base64.b64decode(candidate["contract"], validate=True)
                if not candidate["contractId"].startswith("rgb:"):
                    raise ValueError("RGB contract ID required")
                if "contract" in entry and candidate != entry:
                    raise ValueError("Published contracts are immutable")
                entry = candidate
            entries[ticker] = entry
            atomic(path, entries)
            return entry

    def mine(self):
        while True:
            time.sleep(5)
            try:
                with self.lock:
                    if core("getrawmempool"):
                        core("generatetoaddress", [1, self.miner])
            except Exception:
                print("Automatic confirmation failed; retrying", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(45)

    def log_message(self, *_):
        pass

    def reply(self, status, data, content_type="application/json"):
        raw = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("X-Palka-Chain", self.server.network.chain_id)
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path != "/health":
            self.reply(404, {"error": "Not found"})
            return
        try:
            network = self.server.network
            if core("getblockhash", [1]) != network.chain_id:
                raise ValueError("Chain changed")
            indexed = electrum({"id": 1, "method": "blockchain.headers.subscribe", "params": []})
            if indexed.get("error"):
                raise ValueError("Indexer unavailable")
            self.reply(
                200,
                {
                    "network": "regtest",
                    "chainId": network.chain_id,
                    "height": core("getblockcount"),
                    "indexedHeight": indexed["result"]["height"],
                },
            )
        except Exception:
            self.reply(503, {"error": "Chain unavailable"})

    def do_POST(self):
        if self.path == "/bootstrap":
            self.bootstrap()
            return
        token = os.environ["CHAIN_TOKEN"]
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
            self.reply(401, {"error": "Invalid network invitation"})
            return
        if self.headers.get("X-Palka-Chain") != self.server.network.chain_id:
            self.reply(409, {"error": "Chain checkpoint mismatch"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= LIMIT:
                raise ValueError("Invalid request size")
            raw = self.rfile.read(length)
            if self.path == "/proxy":
                conn = http.client.HTTPConnection("rgb-proxy", 3000, timeout=30)
                try:
                    conn.request(
                        "POST",
                        "/json-rpc",
                        raw,
                        {"Content-Type": self.headers.get("Content-Type", "application/json")},
                    )
                    response = conn.getresponse()
                    self.reply(
                        response.status,
                        response.read(LIMIT),
                        response.getheader("Content-Type", "application/json"),
                    )
                finally:
                    conn.close()
                return
            request = json.loads(raw)
            if self.path == "/rpc":
                if request.get("method") not in RPC_METHODS:
                    raise ValueError("Core method is not permitted")
                result = core(request["method"], request.get("params", []))
            elif self.path == "/electrum":
                result = electrum(request)
            elif self.path == "/fund":
                result = self.server.network.fund(request)
            elif self.path == "/catalog":
                result = self.server.network.catalog(request)
            else:
                self.reply(404, {"error": "Not found"})
                return
            self.reply(200, {"result": result})
        except (ValueError, KeyError, TypeError) as error:
            self.reply(400, {"error": str(error)})
        except Exception:
            self.reply(502, {"error": "Upstream unavailable; do not repeat an uncertain payment"})

    def bootstrap(self):
        # Explicit demo enrollment: reuse the participant's market identity, not wallet keys.
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        if not re.fullmatch(r"[0-9a-f]{64}", token) or self.headers.get("Origin"):
            self.reply(401, {"error": "Participant credential required"})
            return
        if self.headers.get("Content-Length") != "2":
            self.reply(400, {"error": "Empty JSON object required"})
            return
        if self.rfile.read(2) != b"{}":
            self.reply(400, {"error": "Empty JSON object required"})
            return
        conn = http.client.HTTPConnection("runtime", 4100, timeout=15)
        try:
            conn.request(
                "POST",
                "/participants",
                b"{}",
                {
                    "Authorization": "Bearer " + token,
                    "Content-Type": "application/json",
                },
            )
            response = conn.getresponse()
            registration = json.loads(response.read(4096))
            owner = (
                "participant-"
                + hashlib.sha256(("palka-participant-v1:" + token).encode()).hexdigest()
            )
            if response.status not in (200, 201) or registration.get("ownerId") != owner:
                self.reply(403, {"error": "Market registration rejected"})
                return
            self.reply(
                200,
                {
                    "network": "regtest",
                    "chainId": self.server.network.chain_id,
                    "token": os.environ["CHAIN_TOKEN"],
                    "asset": self.server.network.assignment(owner),
                },
            )
        except Exception:
            self.reply(503, {"error": "Market enrollment unavailable"})
        finally:
            conn.close()


def main():
    os.umask(0o077)
    network = Network(Path(os.environ.get("CHAIN_STATE", "/state")))
    server = ThreadingHTTPServer(("0.0.0.0", 8090), Handler)
    server.network = network
    threading.Thread(target=network.mine, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
