"""Synthetic protocol/transport cases; these are not settlement evidence."""

import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from journal import Journal
from protocol import BTC, Backend, digest, plan_check, read, save, units
from server import create_server


class ProtocolTests(unittest.TestCase):
    def plan(self):
        p = {
            "protocolVersion": 1,
            "tradeId": "unit",
            "revision": 0,
            "network": "regtest",
            "participants": ["a", "b"],
            "orderRefs": [{"orderId": "oa", "revision": 1}, {"orderId": "ob", "revision": 1}],
            "createdAt": 1,
            "feeState": "estimate",
            "fees": [{"ownerId": "a", "feeSats": "1000"}, {"ownerId": "b", "feeSats": "1000"}],
            "legs": [
                {"fromOwnerId": "a", "toOwnerId": "b", "asset": BTC, "amount": "100000"},
                {
                    "fromOwnerId": "b",
                    "toOwnerId": "a",
                    "asset": {
                        "kind": "rgb",
                        "network": "regtest",
                        "contractId": "rgb:synthetic-unit-only",
                        "precision": 0,
                        "symbol": "TEST",
                    },
                    "amount": "100",
                },
            ],
        }
        p["digest"] = digest(p)
        return p

    def test_final_fee_does_not_exceed_estimate(self):
        self.assertEqual(plan_check(self.plan(), "a"), {"a": 500, "b": 500})

    def test_wrong_digest_network_owner_and_topology(self):
        original = self.plan()
        for mutate in [
            lambda p: p.update(network="mainnet"),
            lambda p: p["participants"].__setitem__(1, "a"),
            lambda p: p["legs"][0].update(toOwnerId="a"),
            lambda p: p["fees"][0].update(feeSats="499"),
        ]:
            p = copy.deepcopy(original)
            mutate(p)
            p["digest"] = digest({k: v for k, v in p.items() if k != "digest"})
            with self.assertRaises(ValueError):
                plan_check(p, "a")
        original["legs"][0]["amount"] = "1"
        with self.assertRaises(ValueError):
            plan_check(original, "a")

    def test_units_boundaries(self):
        self.assertEqual(units(str(2**64 - 1)), 2**64 - 1)
        for v in [1, "01", "-1", "1e3", "1.1", str(2**64)]:
            with self.assertRaises(ValueError):
                units(v)


class HttpTests(unittest.TestCase):
    def test_auth_origin_host_and_envelope(self):
        class FakeBackend:
            def handle(self, method, params):
                if method != "state":
                    raise ValueError("synthetic rejection")
                return {"fixtureOnly": True}

        with tempfile.TemporaryDirectory() as tmp:
            backend = FakeBackend()
            backend.root = Path(tmp)
            token = "synthetic-test-token-32-characters-only"
            server = create_server(backend, token, 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/rpc"
            body = json.dumps(
                {"protocolVersion": 1, "requestId": "unit", "method": "state", "params": {}}
            ).encode()

            def request(headers, data=body):
                return urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=5)

            try:
                for headers, code in [
                    ({}, 401),
                    ({"Authorization": "Bearer " + token, "Origin": "null"}, 403),
                    ({"Authorization": "Bearer " + token, "Host": "evil.example"}, 403),
                ]:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        request(headers)
                    self.assertEqual(caught.exception.code, code)
                with request({"Authorization": "Bearer " + token}) as response:
                    self.assertEqual(
                        json.load(response), {"protocolVersion": 1, "result": {"fixtureOnly": True}}
                    )
                with request({"Authorization": "Bearer " + token}, b"{}") as response:
                    self.assertEqual(json.load(response)["error"]["code"], "WALLET_REJECTED")
            finally:
                server.shutdown()
                server.server_close()


class RecoveryTests(unittest.TestCase):
    """Synthetic crash-boundary regressions, not RGB settlement evidence."""

    def backend(self, tmp):
        backend = Backend.__new__(Backend)
        backend.root = Path(tmp)
        backend.owner = "alice"
        backend.wallet_id = "unit-wallet"
        folder = backend.folder("unit")
        package = {
            "protocolVersion": 1,
            "tradeId": "unit",
            "planRevision": 0,
            "packageId": "unit-tx",
            "planDigest": "plan",
            "unsignedTxDigest": "tx",
            "commitmentDigest": "rgb",
        }
        approval = {
            "protocolVersion": 1,
            "walletId": "unit-wallet",
            "ownerId": "alice",
            "network": "regtest",
            "tradeId": "unit",
            "planRevision": 0,
            **{
                k: package[k]
                for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
            },
            "approvalId": "original",
            "approvedAt": 1,
        }
        intent = {"network": "regtest", "fixture": "synthetic"}
        save(folder / "package.json", package)
        save(folder / "approval-intent.json", intent)
        journal = Journal(backend.root / "journal.sqlite")
        journal.reserve("unit", intent, ["synthetic:0"])
        journal.db.close()
        return backend, folder, package, approval

    def test_original_approval_and_signature_survive_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend, folder, package, approval = self.backend(tmp)
            with patch.object(
                backend, "call_native", return_value={"signedPsbt": "synthetic-signature"}
            ) as signer:
                original = backend.sign(package, approval)
                self.assertEqual(backend.sign(package, approval), original)
                signer.assert_called_once()
                with self.assertRaisesRegex(ValueError, "immutable"):
                    backend.sign(package, {**approval, "approvedAt": 2})
                self.assertEqual(read(folder / "user-approval.json"), approval)

    def test_read_only_recovery_never_signs_and_requires_original_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend, folder, package, approval = self.backend(tmp)
            save(folder / "user-approval.json", approval)
            with patch.object(
                backend, "call_native", return_value={"signedPsbt": "synthetic-signature"}
            ) as signer:
                with self.assertRaisesRegex(ValueError, "no durable signature"):
                    backend.recoverSignature(package)
                signer.assert_not_called()
                original = backend.sign(package, approval)
                self.assertEqual(backend.recoverSignature(package), original)
                signer.assert_called_once()
                with self.assertRaisesRegex(ValueError, "changed recovery package"):
                    backend.recoverSignature({**package, "payload": "changed"})
                self.assertEqual(read(folder / "user-approval.json"), approval)

    def test_independent_btc_credit_is_not_rgb_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend, folder, package, approval = self.backend(tmp)
            with patch.object(
                backend, "call_native", return_value={"signedPsbt": "synthetic-signature"}
            ):
                backend.sign(package, approval)
            save(folder / "preview.json", {"balancesAfter": [{"asset": BTC, "amount": "1000"}]})
            with (
                patch("protocol.rpc", return_value={"confirmations": 1, "hex": "synthetic"}),
                patch.object(
                    backend,
                    "call_native",
                    return_value={"txid": "unit-tx", "rgbAccepted": True, "chainConfirmed": True},
                ),
                patch.object(
                    backend, "state", return_value={"balances": [{"asset": BTC, "amount": "1200"}]}
                ),
            ):
                self.assertEqual(backend.sync("unit")["state"], "confirmed")
            self.assertEqual(
                read(folder / "receipt.json")["btcBalanceDifferenceFromPreviewSats"], "200"
            )


if __name__ == "__main__":
    unittest.main()
