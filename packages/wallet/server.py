#!/usr/bin/env python3
"""Authenticated loopback sidecar matching A's WalletAdapter protocol v1."""

import argparse
import fcntl
import json
import os
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from protocol import Backend, save


def create_server(backend, token, port=4201):
    if len(token) < 32:
        raise ValueError("WALLET_RPC_TOKEN must be at least 32 characters")
    lock = threading.Lock()
    timings = os.environ.get("PALKA_TIMINGS") == "1"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log tokens, policies or request bodies.

        def respond(self, status, value):
            raw = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            if self.path != "/rpc":
                return self.respond(404, {"error": "NOT_FOUND"})
            host = self.headers.get("Host", "")
            if host not in (
                f"127.0.0.1:{self.server.server_port}",
                f"localhost:{self.server.server_port}",
            ):
                return self.respond(403, {"error": "INVALID_HOST"})
            # This endpoint is server-to-server. Browser Origin is rejected, including null.
            if self.headers.get("Origin") is not None:
                return self.respond(403, {"error": "BROWSER_ORIGIN_FORBIDDEN"})
            if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.respond(401, {"error": "UNAUTHORIZED"})
            try:
                if self.headers.get("Transfer-Encoding"):
                    raise ValueError("chunked request unsupported")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1024 * 1024:
                    return self.respond(413, {"error": "BODY_TOO_LARGE"})
                request = json.loads(self.rfile.read(length))
                if (
                    set(request) != {"protocolVersion", "requestId", "method", "params"}
                    or request["protocolVersion"] != 1
                    or not isinstance(request["params"], dict)
                ):
                    raise ValueError("invalid envelope")
                with lock:
                    started = time.perf_counter() if timings else None
                    outcome = "WALLET_REJECTED"
                    try:
                        result = backend.handle(request["method"], request["params"])
                        outcome = "ok"
                    finally:
                        if started is not None:
                            duration = round((time.perf_counter() - started) * 1000, 3)
                            method = request["method"]
                            if method not in (
                                "capabilities",
                                "state",
                                "fundingTarget",
                                "reserve",
                                "release",
                                "prepare",
                                "validate",
                                "sign",
                                "recoverSignature",
                                "finalize",
                                "sync",
                            ):
                                method = "unknown"
                            try:
                                print(
                                    json.dumps(
                                        {
                                            "event": "wallet_rpc",
                                            "method": method,
                                            "durationMs": duration,
                                            "outcome": outcome,
                                        }
                                    ),
                                    file=sys.stderr,
                                    flush=True,
                                )
                            except (OSError, ValueError):
                                pass  # Diagnostics must not change the outcome of a wallet action.
                return self.respond(200, {"protocolVersion": 1, "result": result})
            except Exception as error:
                save(
                    backend.root / "last-rpc-error.json",
                    {"errorType": type(error).__name__, "message": str(error)},
                )
                # Logs/messages must not reveal full wallet state or private filesystem details.
                return self.respond(
                    200,
                    {
                        "protocolVersion": 1,
                        "error": {
                            "code": "WALLET_REJECTED",
                            "message": "Local validation failed; inspect the private wallet records and reconcile before retrying.",
                        },
                    },
                )

    return HTTPServer(("127.0.0.1", port), Handler)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, choices=["alice", "bob", "carol"])
    parser.add_argument("--owner")
    parser.add_argument("--port", type=int, default=4201)
    args = parser.parse_args()
    backend = Backend(args.profile, args.owner)
    # Interprocess ownership spans native subprocesses and Python journal/filesystem operations.
    lock = (backend.root / ".coordinator.lock").open("a")
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    server = create_server(backend, os.environ.get("WALLET_RPC_TOKEN", ""), args.port)
    print(
        json.dumps(
            {
                "listening": f"http://127.0.0.1:{args.port}",
                "profile": args.profile,
                "ownerId": backend.owner,
            }
        ),
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
