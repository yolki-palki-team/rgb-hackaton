#!/usr/bin/env python3
"""TEST ONLY: real sidecar/crypto with one-shot transport failures, never fake settlement."""

import os
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/wallet"))
import protocol
import server

fault = os.environ["RGB_TEST_FAULT"]
if fault not in ("lost-sign-response", "broadcast-accepted", "broadcast-not-submitted"):
    raise ValueError("Unknown test-only fault")
original_server = server.create_server


def faulty_server(backend, token, port=4201):
    instance = original_server(backend, token, port)
    marker = backend.root / ("test-" + fault + ".json")
    original_respond = instance.RequestHandlerClass.respond
    original_rpc = protocol.rpc
    lookup_failure = False

    def respond(self, status, value):
        result = value.get("result")
        if (
            fault == "lost-sign-response"
            and isinstance(result, dict)
            and result.get("status") == "signed"
            and not marker.exists()
        ):
            protocol.save(
                marker,
                {
                    "signatureSaved": True,
                    "signatureHash": protocol.digest(value["result"]["signature"]),
                },
            )
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        return original_respond(self, status, value)

    def rpc(*args):
        nonlocal lookup_failure
        if (
            fault.startswith("broadcast-")
            and args[0] == "sendrawtransaction"
            and not marker.exists()
        ):
            txid = None
            if fault == "broadcast-accepted":
                txid = original_rpc(*args)
            protocol.save(
                marker, {"fault": fault, "acceptedByBitcoin": txid is not None, "txid": txid}
            )
            lookup_failure = True
            raise RuntimeError("TEST: RPC result lost at transport boundary")
        if lookup_failure and args[0] == "getrawtransaction":
            lookup_failure = False
            raise RuntimeError("TEST: follow-up lookup unavailable")
        return original_rpc(*args)

    instance.RequestHandlerClass.respond = respond
    protocol.rpc = rpc
    return instance


server.create_server = faulty_server
server.main()
