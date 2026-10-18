import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from journal import Journal, digest


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "wallet.sqlite"
        self.j = Journal(self.path)
        self.intent = {
            "network": "regtest",
            "wallet": "alice",
            "revision": 1,
            "unsignedTx": "real-bytes-fixture",
            "commitments": ["proof-hash"],
            "fee": "500",
        }
        self.h = self.j.reserve("t", self.intent, ["funding:0"])

    def tearDown(self):
        self.j.db.close()
        self.tmp.cleanup()

    def test_refusal_and_stale_approval(self):
        for approved, h in [(False, self.h), (True, "stale")]:
            with self.assertRaises(ValueError):
                self.j.begin_signing("t", h, approved)
        self.assertEqual(self.j.snapshot("t")["state"], "AWAITING_APPROVAL")

    def test_revision_fee_recipient_and_commitment_change_digest(self):
        for field, value in [
            ("revision", 2),
            ("fee", "501"),
            ("wallet", "bob"),
            ("unsignedTx", "changed output"),
            ("commitments", ["other proof"]),
        ]:
            changed = {**self.intent, field: value}
            self.assertNotEqual(self.h, digest(changed))

    def test_reservation_atomic_conflict(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.j.reserve("other", self.intent, ["new:0", "funding:0"])
        self.assertIsNone(self.j.snapshot("other"))
        self.assertIsNone(
            self.j.db.execute("SELECT * FROM reservations WHERE outpoint='new:0'").fetchone()
        )

    def test_cancel_then_no_reopen(self):
        self.j.release("t")
        self.j.db.close()
        self.j = Journal(self.path)
        self.j.release("t")
        self.assertEqual(self.j.snapshot("t")["state"], "CANCELLED")
        self.assertEqual(
            self.j.db.execute("SELECT COUNT(*) FROM reservations WHERE trade_id='t'").fetchone()[0],
            0,
        )
        with self.assertRaises(ValueError):
            self.j.reserve("t", self.intent, ["funding:0"])

    def test_restart_after_signing_pins_inputs(self):
        self.j.begin_signing("t", self.h, True)
        self.j.db.close()
        self.j = Journal(self.path)
        with self.assertRaises(ValueError):
            self.j.release("t")
        self.assertEqual(self.j.snapshot("t")["state"], "SIGNING")

    def test_ambiguous_broadcast_and_separate_acceptance(self):
        self.j.begin_signing("t", self.h, True)
        self.j.record_signature("t", "test-only-signature-fixture")
        self.j.broadcast_result("t", "actual-txid-fixture", False)
        with self.assertRaises(ValueError):
            self.j.release("t")
        self.j.broadcast_result("t", "actual-txid-fixture", True)
        self.j.receipt("t", True, False)
        self.assertEqual(self.j.snapshot("t")["state"], "RECONCILING")
        self.j.receipt("t", True, True)
        self.assertEqual(self.j.snapshot("t")["state"], "CONFIRMED")

    def test_idempotent_signature(self):
        self.j.begin_signing("t", self.h, True)
        self.j.record_signature("t", "unit-fixture")
        self.assertEqual(self.j.begin_signing("t", self.h, True), "unit-fixture")
        with self.assertRaises(ValueError):
            self.j.record_signature("t", "different")

    def test_intent_storage_tamper_detected(self):
        self.j.db.execute(
            "UPDATE trades SET intent=?", (json.dumps({**self.intent, "fee": "999"}),)
        )
        with self.assertRaises(ValueError):
            self.j.begin_signing("t", self.h, True)

    def test_plan_reservation_only_one_active_and_immutable_binding(self):
        self.j.release("t")
        plan = {"network": "regtest", "tradeId": "next", "digest": "unit-fixture"}
        self.j.reserve_plan("next", plan, ["next:0"])
        with self.assertRaises(ValueError):
            self.j.reserve_plan("other", plan, ["other:0"])
        with self.assertRaises(ValueError):
            self.j.reserve_plan("next", plan, ["changed:0"])
        h = self.j.bind_approval("next", plan, self.intent)
        self.assertEqual(h, self.j.bind_approval("next", plan, self.intent))
        with self.assertRaises(ValueError):
            self.j.bind_approval("next", plan, {**self.intent, "fee": "999"})
        self.j.begin_signing("next", h, True)
        with self.assertRaises(ValueError):
            self.j.release("next")

    def test_custom_signet_approval_keeps_reserved_network_and_challenge_immutable(self):
        self.j.release("t")
        plan = {"network": "signetcustom", "tradeId": "mutinynet"}
        self.j.reserve_plan("mutinynet", plan, ["mutinynet:0"])
        with self.assertRaisesRegex(ValueError, "approval network"):
            self.j.bind_approval("mutinynet", plan, self.intent)
        intent = {
            **self.intent,
            "network": "signetcustom",
            "signetChallenge": "synthetic-challenge",
        }
        approval = self.j.bind_approval("mutinynet", plan, intent)
        self.assertNotEqual(approval, digest({**intent, "signetChallenge": "other-challenge"}))
        with self.assertRaises(ValueError):
            self.j.bind_approval(
                "mutinynet", plan, {**intent, "signetChallenge": "other-challenge"}
            )
        self.assertIsNone(self.j.begin_signing("mutinynet", approval, True))

    def test_preparing_can_cancel_but_not_reopen(self):
        self.j.release("t")
        plan = {"network": "regtest"}
        self.j.reserve_plan("next", plan, ["next:0"])
        self.j.release("next")
        with self.assertRaises(ValueError):
            self.j.reserve_plan("next", plan, ["next:0"])

    def test_sequential_fills_need_confirmed_receipt_and_fresh_approval_after_restart(self):
        self.j.begin_signing("t", self.h, True)
        self.j.record_signature("t", "first-fill-signature")
        self.j.broadcast_result("t", "first-fill-txid", True)
        self.j.receipt("t", True, False)
        next_plan = {"network": "regtest", "tradeId": "next", "counterparty": "carol"}
        with self.assertRaisesRegex(ValueError, "another active"):
            self.j.reserve_plan("next", next_plan, ["first-fill-change:0"])
        self.j.receipt("t", True, True)
        self.j.db.close()
        self.j = Journal(self.path)
        self.j.reserve_plan("next", next_plan, ["first-fill-change:0"])
        next_intent = {**self.intent, "revision": 3, "unsignedTx": "next-fill-bytes"}
        next_digest = self.j.bind_approval("next", next_plan, next_intent)
        for approval, confirmed in [(self.h, True), (next_digest, False)]:
            with self.assertRaisesRegex(ValueError, "explicit current approval"):
                self.j.begin_signing("next", approval, confirmed)
        self.assertEqual(self.j.snapshot("next")["state"], "AWAITING_APPROVAL")
        self.j.begin_signing("next", next_digest, True)
        self.assertEqual(self.j.snapshot("t")["state"], "CONFIRMED")
        self.assertEqual(
            dict(self.j.db.execute("SELECT outpoint,trade_id FROM reservations")),
            {"funding:0": "t", "first-fill-change:0": "next"},
        )


if __name__ == "__main__":
    unittest.main()
