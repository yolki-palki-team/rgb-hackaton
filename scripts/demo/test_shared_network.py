"""Regtest gateway authorization boundaries, retry safety and chain pinning."""

import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from chain_transport import Client

SOURCE = Path(__file__).resolve().parents[2] / "deploy/network_gateway.py"
SPEC = importlib.util.spec_from_file_location("network_gateway", SOURCE)
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


class GatewayTests(unittest.TestCase):
    def test_automatic_roles_are_persistent_and_do_not_replace_issuers(self):
        first = "participant-" + "1" * 64
        second = "participant-" + "2" * 64
        third = "participant-" + "3" * 64
        self.assertEqual(self.network.assignment(first), "X")
        self.assertEqual(self.network.assignment(first), "X")
        self.assertEqual(self.network.assignment(second), "DUSD")
        self.assertIsNone(self.network.assignment(third))
        self.assertEqual(self.network.catalog({})["X"]["ownerId"], first)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.network = gateway.Network.__new__(gateway.Network)
        self.network.state = Path(self.temp.name)
        self.network.lock = threading.Lock()
        self.network.miner = "synthetic-miner"
        self.request = {
            "ownerId": "participant-" + "a" * 64,
            "purpose": "btc",
            "address": "bcrt1synthetic",
        }
        self.payments = []

    def core(self, method, params=None, wallet=False):
        if method == "validateaddress":
            return {"isvalid": True}
        if method == "sendtoaddress":
            self.assertTrue(wallet)
            self.payments.append(params)
            return "synthetic-txid"
        if method == "generatetoaddress":
            return ["synthetic-block"]
        raise AssertionError(method)

    def test_faucet_retry_does_not_pay_twice(self):
        with patch.object(gateway, "core", side_effect=self.core):
            first = self.network.fund(self.request)
            self.assertEqual(self.network.fund(self.request), first)
            with self.assertRaisesRegex(ValueError, "different address"):
                self.network.fund(self.request | {"address": "bcrt1another"})
        self.assertEqual(len(self.payments), 1)
        self.assertEqual(first["sats"], "1000000")
        self.assertEqual(self.payments[0][1], 0.01)

    def test_uncertain_payment_is_not_retried(self):
        def broken(method, params=None, wallet=False):
            if method == "sendtoaddress":
                self.payments.append(params)
                raise ConnectionError("Lost response after broadcast")
            return self.core(method, params, wallet)

        with patch.object(gateway, "core", side_effect=broken):
            with self.assertRaises(ConnectionError):
                self.network.fund(self.request)
            with self.assertRaisesRegex(ValueError, "Uncertain"):
                self.network.fund(self.request)
        self.assertEqual(len(self.payments), 1)

    def test_rejects_non_regtest_address_and_arbitrary_amounts(self):
        with patch.object(gateway, "core", side_effect=self.core):
            with self.assertRaisesRegex(ValueError, "regtest address"):
                self.network.fund(self.request | {"address": "bc1mainnet"})
            receipt = self.network.fund(self.request | {"sats": "999999999999"})
        self.assertEqual(receipt["sats"], "1000000")

    def test_wdk_has_separate_capped_funding_receipt(self):
        with patch.object(gateway, "core", side_effect=self.core):
            self.network.fund(self.request)
            self.network.fund(self.request | {"purpose": "wdk"})
            self.network.fund(self.request | {"purpose": "rgb"})
        self.assertEqual([p[1] for p in self.payments], [0.01, 0.01, 0.001])

    def test_catalog_one_issuer_and_immutable_contract(self):
        request = {"ticker": "X", "ownerId": self.request["ownerId"]}
        self.network.catalog(request)
        with self.assertRaisesRegex(ValueError, "already has an issuer"):
            self.network.catalog(request | {"ownerId": "participant-" + "b" * 64})
        publication = request | {"contractId": "rgb:synthetic", "contract": "eA=="}
        self.network.catalog(publication)
        self.network.catalog(publication)
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.network.catalog(publication | {"contractId": "rgb:changed"})
        self.assertEqual(self.network.catalog({})["X"]["contractId"], "rgb:synthetic")

    def test_remote_core_never_exposes_wallet_or_node_administration(self):
        for method in (
            "stop",
            "createwallet",
            "dumpprivkey",
            "sendtoaddress",
            "generatetoaddress",
            "walletpassphrase",
        ):
            self.assertNotIn(method, gateway.RPC_METHODS)
        self.assertIn("sendrawtransaction", gateway.RPC_METHODS)
        with self.assertRaisesRegex(ValueError, "Regtest required"):
            with patch.object(gateway, "core", return_value={"chain": "main"}):
                gateway.Network(self.network.state)


class ClientTests(unittest.TestCase):
    def config(self):
        return {"url": "https://api.example.test/chain", "chainId": "a" * 64, "token": "b" * 64}

    def test_requires_https_and_pinned_chain(self):
        Client(self.config())
        for change in (
            {"url": "http://api.example.test/chain"},
            {"chainId": ""},
            {"url": "https://secret@api.example.test/chain"},
        ):
            with self.assertRaises(ValueError):
                Client(self.config() | change)

    def test_changed_chain_response_rejected(self):
        class Response:
            status = 200

            def read(self, _):
                return json.dumps({"result": 1}).encode()

            def getheader(self, _):
                return "c" * 64

        with patch("chain_transport.http.client.HTTPSConnection") as connection:
            connection.return_value.getresponse.return_value = Response()
            with self.assertRaisesRegex(ValueError, "checkpoint mismatch"):
                Client(self.config()).request("/rpc", {"method": "getblockcount"})

    def test_missing_remote_transaction_uses_local_rpc_error_contract(self):
        with patch("chain_transport.http.client.HTTPSConnection") as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 400
            response.getheader.return_value = "a" * 64
            response.read.return_value = b'{"error":"No such mempool or blockchain transaction"}'
            with self.assertRaisesRegex(RuntimeError, "No such mempool"):
                Client(self.config()).request(
                    "/rpc", {"method": "getrawtransaction", "params": ["test-txid", True]}
                )
            response.getheader.return_value = "c" * 64
            with self.assertRaisesRegex(ValueError, "checkpoint mismatch"):
                Client(self.config()).request(
                    "/rpc", {"method": "getrawtransaction", "params": ["test-txid", True]}
                )


if __name__ == "__main__":
    unittest.main()
