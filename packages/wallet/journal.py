"""Local durable reservation/signature journal. No keys and no network calls."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)

def digest(value):
    return hashlib.sha256(b"rgb-local-approval-v1\0" + canonical(value).encode()).hexdigest()

class Journal:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, isolation_level=None)
        os.chmod(path, 0o600)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS trades (
          id TEXT PRIMARY KEY, digest TEXT NOT NULL, intent TEXT NOT NULL,
          state TEXT NOT NULL, signature TEXT, txid TEXT,
          chain_confirmed INTEGER NOT NULL DEFAULT 0,
          rgb_accepted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS reservations (
          outpoint TEXT PRIMARY KEY, trade_id TEXT NOT NULL REFERENCES trades(id)
        );
        """)

    def transaction(self, fn):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            result = fn()
            self.db.execute("COMMIT")
            return result
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def reserve(self, trade_id, intent, outpoints):
        if intent.get("network") != "regtest" or not outpoints or len(set(outpoints)) != len(outpoints):
            raise ValueError("invalid reservation")
        h = digest(intent)
        def op():
            row = self.db.execute("SELECT digest,state FROM trades WHERE id=?", (trade_id,)).fetchone()
            if row:
                if row != (h,"AWAITING_APPROVAL"):
                    raise ValueError("trade cannot be replaced or reopened")
                existing = {r[0] for r in self.db.execute("SELECT outpoint FROM reservations WHERE trade_id=?",(trade_id,))}
                if existing != set(outpoints):
                    raise ValueError("reservation inputs changed")
                return h
            self.db.execute("INSERT INTO trades(id,digest,intent,state) VALUES(?,?,?,?)", (trade_id,h,canonical(intent),"AWAITING_APPROVAL"))
            for point in outpoints:
                self.db.execute("INSERT INTO reservations VALUES(?,?)",(point,trade_id))
            return h
        return self.transaction(op)

    def begin_signing(self, trade_id, approval_digest, approved=False):
        def op():
            row = self.db.execute("SELECT digest,intent,state,signature FROM trades WHERE id=?",(trade_id,)).fetchone()
            if not row or not approved or row[0] != approval_digest or digest(json.loads(row[1])) != approval_digest:
                raise ValueError("explicit current approval required")
            if row[2] in ("SIGNING","SIGNED","RECONCILING","BROADCAST","CONFIRMED"):
                # SIGNING without signature is deliberately pinned for recovery.
                return row[3]
            if row[2] != "AWAITING_APPROVAL":
                raise ValueError("trade not signable")
            self.db.execute("UPDATE trades SET state='SIGNING' WHERE id=?",(trade_id,))
            return None
        return self.transaction(op)

    def record_signature(self, trade_id, signed_psbt):
        def op():
            row = self.db.execute("SELECT state,signature FROM trades WHERE id=?",(trade_id,)).fetchone()
            if not row or row[0] not in ("SIGNING","SIGNED"):
                raise ValueError("not signing")
            if row[1] and row[1] != signed_psbt:
                raise ValueError("signature already recorded")
            self.db.execute("UPDATE trades SET state='SIGNED',signature=? WHERE id=?",(signed_psbt,trade_id))
        self.transaction(op)

    def release(self, trade_id):
        def op():
            row = self.db.execute("SELECT state FROM trades WHERE id=?",(trade_id,)).fetchone()
            if not row or row[0] != "AWAITING_APPROVAL":
                raise ValueError("signature may exist: TTL cannot release these inputs")
            self.db.execute("DELETE FROM reservations WHERE trade_id=?",(trade_id,))
            self.db.execute("UPDATE trades SET state='CANCELLED' WHERE id=?",(trade_id,))
        self.transaction(op)

    def broadcast_result(self, trade_id, txid, known):
        def op():
            row = self.db.execute("SELECT state,txid FROM trades WHERE id=?",(trade_id,)).fetchone()
            if not row or row[0] not in ("SIGNED","RECONCILING","BROADCAST") or (row[1] and row[1] != txid):
                raise ValueError("invalid broadcast transition")
            self.db.execute("UPDATE trades SET state=?,txid=? WHERE id=?",("BROADCAST" if known else "RECONCILING",txid,trade_id))
        self.transaction(op)

    def receipt(self, trade_id, chain_confirmed, rgb_accepted):
        def op():
            row = self.db.execute("SELECT state FROM trades WHERE id=?",(trade_id,)).fetchone()
            if not row or row[0] not in ("BROADCAST","RECONCILING","CONFIRMED"):
                raise ValueError("not broadcast")
            status = "CONFIRMED" if chain_confirmed and rgb_accepted else "RECONCILING"
            self.db.execute("UPDATE trades SET state=?,chain_confirmed=?,rgb_accepted=? WHERE id=?",(status,int(chain_confirmed),int(rgb_accepted),trade_id))
            # Keep historical reservations. Spending confirmed outputs uses different outpoints.
        self.transaction(op)

    def snapshot(self, trade_id):
        self.db.row_factory = sqlite3.Row
        row = self.db.execute("SELECT * FROM trades WHERE id=?",(trade_id,)).fetchone()
        self.db.row_factory = None
        return dict(row) if row else None
