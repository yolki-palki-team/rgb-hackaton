"""Synthetic cancellation safety/crash tests; real settlement has a separate runner."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cancellation import cancel, reconcile

from journal import Journal, digest
from protocol import BTC, Backend, read, save


class CancellationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.backend = Backend.__new__(Backend)
        self.backend.root = Path(self.tmp.name)
        self.backend.wallet_id = "test-wallet"
        self.backend.owner = "alice"
        self.folder = self.backend.folder("trade")
        self.original = "a" * 64
        self.cancel_tx = "b" * 64
        self.intent = {
            "tradeId": "trade",
            "walletId": "test-wallet",
            "network": "regtest",
            "originalTxid": self.original,
            "cancellationTxid": self.cancel_tx,
        }
        save(self.folder / "cancellation-intent.json", self.intent)
        self.j = Journal(self.backend.root / "journal.sqlite")
        self.addCleanup(self.j.db.close)
        h = self.j.reserve("trade", {"network": "regtest"}, ["input:0", "rgb:1"])
        self.j.begin_signing("trade", h, True)
        self.j.record_signature("trade", "original-signature")

    def approved(self):
        self.j.begin_cancellation("trade")
        save(
            self.folder / "cancellation-approval.json",
            {"approvalDigest": digest(self.intent), "confirmed": True},
        )

    def assert_pinned(self):
        self.assertEqual(self.j.db.execute("SELECT count(*) FROM reservations").fetchone()[0], 2)
        self.assertNotEqual(self.j.snapshot("trade")["state"], "CANCELLED")

    def test_explicit_current_approval_required(self):
        for h, confirmed in [("wrong", True), (digest(self.intent), False)]:
            with self.assertRaisesRegex(ValueError, "approval"):
                cancel(self.backend, "trade", h, confirmed)
        self.assert_pinned()

    def test_unconfirmed_peer_hint_never_releases_or_signs(self):
        with (
            patch("cancellation.chain_transaction", return_value={"confirmations": 0}),
            patch.object(self.backend, "call_native") as native,
        ):
            self.assertIsNone(reconcile(self.backend, "trade", self.cancel_tx))
            native.assert_not_called()
        self.assert_pinned()

    def test_confirmed_unrelated_hint_is_rejected_and_reserves_remain(self):
        with (
            patch(
                "cancellation.chain_transaction",
                return_value={"confirmations": 2, "hex": "unrelated"},
            ),
            patch.object(self.backend, "call_native", side_effect=ValueError("not conflicting")),
        ):
            with self.assertRaisesRegex(ValueError, "not conflicting"):
                reconcile(self.backend, "trade", self.cancel_tx)
        self.assert_pinned()

    def test_confirmation_verified_before_release_and_repeated_after_restart(self):
        result = {
            "cancelled": True,
            "originalTxid": self.original,
            "cancellationTxid": self.cancel_tx,
        }
        with (
            patch(
                "cancellation.chain_transaction",
                return_value={"confirmations": 1, "hex": "conflict"},
            ),
            patch.object(self.backend, "call_native", return_value=result) as native,
        ):
            receipt = reconcile(self.backend, "trade", self.cancel_tx)
            self.assertEqual(receipt["state"], "cancelled")
            self.assertFalse(receipt["chainConfirmed"])
            self.assertFalse(receipt["rgbAccepted"])
            self.assertEqual(self.j.snapshot("trade")["state"], "CANCELLED")
            self.assertEqual(
                self.j.db.execute("SELECT count(*) FROM reservations").fetchone()[0], 0
            )
            self.assertEqual(reconcile(self.backend, "trade"), receipt)
            self.assertEqual(native.call_count, 2)
            self.assertEqual(self.j.snapshot("trade")["signature"], "original-signature")

    def test_lost_broadcast_response_retries_identical_bytes_without_resigning(self):
        self.approved()

        def rpc(method, *args):
            if method == "finalizepsbt":
                return {"complete": True, "hex": "immutable-raw"}
            if method == "decoderawtransaction":
                return {"txid": self.cancel_tx}
            if method == "sendrawtransaction":
                raise RuntimeError("response lost")
            raise AssertionError(method)

        with (
            patch("cancellation.chain_transaction", return_value={}),
            patch("protocol.rpc", side_effect=rpc) as node,
            patch.object(
                self.backend, "call_native", return_value={"signedPsbt": "cancel-signature"}
            ) as native,
        ):
            first = reconcile(self.backend, "trade")
            self.assertEqual(first["state"], "cancelling")
            self.assertEqual(reconcile(self.backend, "trade"), first)
            native.assert_called_once()
            sends = [c.args for c in node.call_args_list if c.args[0] == "sendrawtransaction"]
            self.assertEqual(sends, [("sendrawtransaction", "immutable-raw")] * 2)
            self.assertEqual(
                read(self.folder / "cancellation-finalized.json")["txid"], self.cancel_tx
            )
        self.assert_pinned()
        with self.assertRaisesRegex(ValueError, "TTL"):
            self.j.release("trade")

    def test_original_confirmation_wins_without_signing_cancel(self):
        self.approved()
        with (
            patch(
                "cancellation.chain_transaction",
                side_effect=lambda txid: {"confirmations": 1} if txid == self.original else {},
            ),
            patch.object(self.backend, "call_native") as native,
        ):
            self.assertIsNone(reconcile(self.backend, "trade"))
            native.assert_not_called()
        self.j.broadcast_result("trade", self.original, True)
        self.j.receipt("trade", True, True)
        self.assertEqual(self.j.snapshot("trade")["state"], "CONFIRMED")

    def test_cancel_after_background_settlement_returns_original_receipt(self):
        self.j.broadcast_result("trade", self.original, True)
        self.j.receipt("trade", True, True)
        with patch.object(self.backend, "sync", return_value={"state": "confirmed"}) as sync:
            self.assertEqual(
                cancel(self.backend, "trade", digest(self.intent), True), {"state": "confirmed"}
            )
            sync.assert_called_once_with("trade")
        self.assertFalse((self.folder / "cancellation-approval.json").exists())

    def test_original_signature_lost_between_native_and_python_is_read_only_recovered(self):
        self.approved()
        self.j.db.execute("UPDATE trades SET signature=NULL WHERE id='trade'")
        (self.folder / "released-signature.psbt").write_text("persisted-original-signature")
        (self.folder / "signature-intent.txt").write_text(self.j.snapshot("trade")["digest"])
        save(self.folder / "package.json", {"packageId": self.original})
        save(self.folder / "preview.json", {"balancesAfter": [{"asset": BTC, "amount": "1000"}]})
        with (
            patch("cancellation.reconcile", return_value=None),
            patch("protocol.rpc", return_value={"confirmations": 1, "hex": "original"}),
            patch.object(
                self.backend,
                "call_native",
                return_value={"txid": self.original, "rgbAccepted": True, "chainConfirmed": True},
            ) as native,
            patch.object(
                self.backend, "state", return_value={"balances": [{"asset": BTC, "amount": "1000"}]}
            ),
        ):
            self.assertEqual(self.backend.sync("trade")["state"], "confirmed")
            native.assert_called_once_with("sync-confirmed", "trade", rawTx="original")
        self.assertEqual(self.j.snapshot("trade")["signature"], "persisted-original-signature")


if __name__ == "__main__":
    unittest.main()
