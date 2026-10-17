import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from journal import Journal, digest

class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)/"wallet.sqlite"
        self.j = Journal(self.path)
        self.intent = {"network":"regtest","wallet":"alice","revision":1,"unsignedTx":"real-bytes-fixture","commitments":["proof-hash"],"fee":"500"}
        self.h = self.j.reserve("t",self.intent,["funding:0"])

    def tearDown(self):
        self.j.db.close()
        self.tmp.cleanup()

    def test_refusal_and_stale_approval(self):
        for approved,h in [(False,self.h),(True,"stale")]:
            with self.assertRaises(ValueError): self.j.begin_signing("t",h,approved)
        self.assertEqual(self.j.snapshot("t")["state"],"AWAITING_APPROVAL")

    def test_revision_fee_recipient_and_commitment_change_digest(self):
        for field,value in [("revision",2),("fee","501"),("wallet","bob"),("unsignedTx","changed output"),("commitments",["other proof"])]:
            changed={**self.intent,field:value}
            self.assertNotEqual(self.h,digest(changed))

    def test_reservation_atomic_conflict(self):
        with self.assertRaises(sqlite3.IntegrityError): self.j.reserve("other",self.intent,["new:0","funding:0"])
        self.assertIsNone(self.j.snapshot("other"))
        self.assertIsNone(self.j.db.execute("SELECT * FROM reservations WHERE outpoint='new:0'").fetchone())

    def test_cancel_then_no_reopen(self):
        self.j.release("t")
        with self.assertRaises(ValueError): self.j.reserve("t",self.intent,["funding:0"])

    def test_restart_after_signing_pins_inputs(self):
        self.j.begin_signing("t",self.h,True)
        self.j.db.close()
        self.j=Journal(self.path)
        with self.assertRaises(ValueError): self.j.release("t")
        self.assertEqual(self.j.snapshot("t")["state"],"SIGNING")

    def test_ambiguous_broadcast_and_separate_acceptance(self):
        self.j.begin_signing("t",self.h,True)
        self.j.record_signature("t","test-only-signature-fixture")
        self.j.broadcast_result("t","actual-txid-fixture",False)
        with self.assertRaises(ValueError): self.j.release("t")
        self.j.broadcast_result("t","actual-txid-fixture",True)
        self.j.receipt("t",True,False)
        self.assertEqual(self.j.snapshot("t")["state"],"RECONCILING")
        self.j.receipt("t",True,True)
        self.assertEqual(self.j.snapshot("t")["state"],"CONFIRMED")

    def test_idempotent_signature(self):
        self.j.begin_signing("t",self.h,True)
        self.j.record_signature("t","unit-fixture")
        self.assertEqual(self.j.begin_signing("t",self.h,True),"unit-fixture")
        with self.assertRaises(ValueError): self.j.record_signature("t","different")

    def test_intent_storage_tamper_detected(self):
        self.j.db.execute("UPDATE trades SET intent=?",(json.dumps({**self.intent,"fee":"999"}),))
        with self.assertRaises(ValueError): self.j.begin_signing("t",self.h,True)

if __name__ == "__main__": unittest.main()
