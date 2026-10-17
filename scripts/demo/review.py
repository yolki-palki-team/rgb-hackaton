#!/usr/bin/env python3
"""Prepare review, require its exact digest, then sign locally and reconcile."""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from cooperative import prepare
from regtest import ROOT, STATE, native, rpc

sys.path.insert(0, str(ROOT / "packages/wallet"))
from journal import Journal, canonical, digest


def save(path, value, raw=False):
    path = Path(path)
    data = value if raw else canonical(value)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as f:
        os.chmod(temp, 0o600)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def btc_total(state):
    # Include immature rewards in both snapshots: maturity alone must not look like trade income.
    return sum(int(state["btc"][k]["future"]) for k in ("vanilla", "colored"))


def review(scenario):
    os.umask(0o077)
    package = prepare(scenario)
    expected = (
        {"alice": "-100500", "bob": "99500"}
        if scenario == "direct"
        else {"alice": "-333", "bob": "99667", "carol": "-100334"}
    )
    reviews = []
    before = {}
    for profile in package["participants"]:
        root = STATE / profile
        if (root / "signature-intent.txt").exists():
            raise RuntimeError(
                "a signature already exists: use recover, never overwrite this review"
            )
        state = native("state", profile)
        before[profile] = {
            "btcSats": str(btc_total(state)),
            "stockBalances": state["stockBalances"],
        }
        owns = {
            f"{u['utxo']['outpoint']['txid']}:{u['utxo']['outpoint']['vout']}"
            for u in state["unspents"]
        }
        points = [
            f"{i['txid']}:{i['vout']}"
            for i in package["inputs"]
            if f"{i['txid']}:{i['vout']}" in owns
        ]
        receives = [
            {k: v for k, v in c.items() if k not in ("receiver", "ticker", "psbt")}
            for c in package["consignments"]
            if c["receiver"] == profile
        ]
        intent = {
            "network": "regtest",
            "profile": profile,
            "fingerprint": native("identity", profile)["fingerprint"],
            "tradeId": package["final"]["candidateTxid"],
            "planRevision": 1,
            "scenario": scenario,
            "candidateTxid": package["final"]["candidateTxid"],
            "feeSats": "1000",
            "expectedBtcDeltaSats": expected[profile],
            "assignments": package["assignments"].get(profile, {}),
            "receives": receives,
            "ownedInputs": points,
            "sighash": "ALL",
        }
        journal = Journal(root / "journal.sqlite")
        h = journal.reserve(intent["tradeId"], intent, points)
        journal.db.close()
        save(root / "review-package.json", package)
        save(root / "approval-intent.json", intent)
        preflight = native("preflight-sign", profile, approvalDigest=h)
        reviews.append(
            {
                "profile": profile,
                "approvalDigest": h,
                "expectedBtcDeltaSats": expected[profile],
                "preflight": preflight,
            }
        )
    report = {
        "scenario": scenario,
        "network": "regtest",
        "candidateTxid": package["final"]["candidateTxid"],
        "feeSats": "1000",
        "reviews": reviews,
        "validations": package["validations"],
        "before": before,
        "signed": False,
    }
    report["approvalDigest"] = digest(report)
    save(STATE / "review.json", report)
    return report


def execute(approval):
    report = json.loads((STATE / "review.json").read_text())
    computed = digest({k: v for k, v in report.items() if k != "approvalDigest"})
    if not approval or approval != report["approvalDigest"] or approval != computed:
        raise RuntimeError("explicit approval must match current review digest")
    txid = report["candidateTxid"]
    # The saved complete transaction is reused after restart or an ambiguous RPC response.
    final_path = STATE / "finalized.json"
    if final_path.exists():
        finalized = json.loads(final_path.read_text())
        if finalized["txid"] != txid:
            raise RuntimeError("different finalized transaction exists")
    else:
        signatures = []
        for item in report["reviews"]:
            p = item["profile"]
            j = Journal(STATE / p / "journal.sqlite")
            signed = j.begin_signing(txid, item["approvalDigest"], True)
            if signed is None:
                signed = native("sign", p, approved=True, approvalDigest=item["approvalDigest"])[
                    "signedPsbt"
                ]
                j.record_signature(txid, signed)
            signatures.append(signed)
            j.db.close()
        combined = rpc("combinepsbt", signatures)
        decoded = rpc("finalizepsbt", combined)
        if not decoded["complete"]:
            raise RuntimeError("incomplete signature set; inputs stay reserved")
        if rpc("decoderawtransaction", decoded["hex"])["txid"] != txid:
            raise RuntimeError("final transaction changed")
        finalized = {"txid": txid, "hex": decoded["hex"]}
        save(final_path, finalized)
    raw = finalized["hex"]
    try:
        known = rpc("getrawtransaction", txid, True)
    except RuntimeError:
        known = None
    if known is None:
        test = rpc("testmempoolaccept", [raw])[0]
        if not test.get("allowed"):
            raise RuntimeError(f"mempool refused {test}; signatures remain pinned")
        try:
            if rpc("sendrawtransaction", raw) != txid:
                raise RuntimeError("unexpected broadcast txid")
        except RuntimeError:
            # Never infer rejection from a timeout. Query by precomputed txid.
            try:
                known = rpc("getrawtransaction", txid, True)
            except RuntimeError as error:
                for item in report["reviews"]:
                    j = Journal(STATE / item["profile"] / "journal.sqlite")
                    j.broadcast_result(txid, txid, False)
                    j.db.close()
                raise RuntimeError(
                    "ambiguous broadcast; recover with SAME approval, do not release inputs"
                ) from error
    for item in report["reviews"]:
        j = Journal(STATE / item["profile"] / "journal.sqlite")
        if j.snapshot(txid)["state"] != "CONFIRMED":
            j.broadcast_result(txid, txid, True)
        j.db.close()
    known = rpc("getrawtransaction", txid, True)
    if known.get("confirmations", 0) < 1:
        try:
            rpc("createwallet", "regtest-miner")
        except RuntimeError:
            if "regtest-miner" not in rpc("listwallets"):
                raise
        miner = rpc("-rpcwallet=regtest-miner", "getnewaddress")
        rpc("generatetoaddress", 1, miner)
    receipts = {}
    for item in report["reviews"]:
        p = item["profile"]
        for attempt in range(30):
            try:
                receipt = native("sync-confirmed", p, rawTx=raw)
                break
            except RuntimeError:
                if attempt == 29:
                    raise
                time.sleep(1)
        actual_delta = btc_total(receipt) - int(report["before"][p]["btcSats"])
        if actual_delta != int(item["expectedBtcDeltaSats"]):
            raise RuntimeError("actual BTC delta mismatch")
        receipts[p] = {**receipt, "actualBtcDeltaSats": str(actual_delta)}
    for v in report["validations"]:
        actual = int(receipts[v["receiver"]]["stockBalances"].get(v["contractId"], "0"))
        previous = int(report["before"][v["receiver"]]["stockBalances"].get(v["contractId"], "0"))
        expected = previous if v["ticker"] == "KEEP" else previous + int(v["amount"])
        if actual != expected:
            raise RuntimeError("actual RGB stock amount mismatch")
    for p, receipt in receipts.items():
        j = Journal(STATE / p / "journal.sqlite")
        j.receipt(txid, True, receipt["rgbAccepted"])
        j.db.close()
    evidence = {
        "network": "regtest",
        "txid": txid,
        "scenario": report["scenario"],
        "receipts": receipts,
        "confirmed": True,
    }
    save(STATE / "settlement-evidence.json", evidence)
    return evidence


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "execute"])
    parser.add_argument("--scenario", choices=["direct", "ring"], default="ring")
    parser.add_argument("--approve")
    args = parser.parse_args()
    result = review(args.scenario) if args.command == "prepare" else execute(args.approve)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
