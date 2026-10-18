#!/usr/bin/env python3
"""Real direct/ring cancellation through local HTTP, with restart and balance checks."""

import argparse
import importlib.util
import json
import sqlite3
import time

import catalog
from service_runtime import PEOPLE, Runtime, configure, read, save

from regtest import ROOT, STATE, native, rpc, setup


def mine():
    if "regtest-miner" not in rpc("listwallets"):
        rpc("loadwallet", "regtest-miner")
    rpc("generatetoaddress", 1, rpc("-rpcwallet=regtest-miner", "getnewaddress"))


def prepare(runtime, smoke, scenario, reverse=False, skip_peer_preview=False):
    class Prepared(Exception):
        pass

    local = runtime.local
    trade_id = None

    def intercept(person, path, body=None):
        nonlocal trade_id
        if skip_peer_preview and path.endswith("/preview") and person != "alice":
            # The peer goes offline after contributing proofs, before local review.
            package = local("alice", path.removesuffix("/preview"))["settlementPackage"]
            return {
                "approvalToken": "not-approved",
                "preview": {
                    k: package[k]
                    for k in ("packageId", "unsignedTxDigest", "commitmentDigest", "planDigest")
                },
            }
        if path.endswith("/approve") and person != "alice":
            trade_id = path.split("/")[2]
            raise Prepared()
        return local(person, path, body)

    runtime.local = intercept
    try:
        smoke.run(runtime, scenario, reverse)
    except Prepared:
        pass
    finally:
        runtime.local = local
    assert trade_id
    return trade_id


def run(runtime, smoke, scenario):
    trade_id = prepare(runtime, smoke, scenario, skip_peer_preview=True)
    local = runtime.local
    people = PEOPLE[:2] if scenario == "direct" else PEOPLE
    quote = local("alice", f"/trades/{trade_id}/cancel-preview", {})
    receipt = local(
        "alice",
        f"/trades/{trade_id}/cancel",
        {
            "approvalDigest": quote["approvalDigest"],
            "confirmed": True,
        },
    )
    assert receipt["state"] == "cancelling"
    assert local("alice", f"/trades/{trade_id}")["status"] == "RECONCILING"
    for p in people:
        with sqlite3.connect(STATE / p / "journal.sqlite") as db:
            assert (
                db.execute(
                    "SELECT count(*) FROM reservations WHERE trade_id=?", (trade_id,)
                ).fetchone()[0]
                > 0
            )
        runtime.stop("local-" + p)
        runtime.stop("wallet-" + p)
    for p in people:
        runtime.profile(p)
    runtime.ready(people, wallet_state=False)
    mine()
    return verify_cancelled(runtime, trade_id, scenario, quote)


def verify_cancelled(runtime, trade_id, scenario, quote):
    local = runtime.local
    people = PEOPLE[:2] if scenario == "direct" else PEOPLE
    folder = STATE / "services/runs" / trade_id
    before = read(folder / "before.json")
    review = read(folder / "review.json")
    original = review["trade"]["settlementPackage"]["packageId"]
    receipts = {}
    for p in people:
        for _ in range(30):
            try:
                receipt = local(p, f"/trades/{trade_id}/sync", {})
                if receipt["state"] == "cancelled":
                    break
            except RuntimeError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError(f"Cancellation reconciliation failed for {p}")
        receipts[p] = receipt
    after = {p: local(p, "/state") for p in people}
    for p in people:
        amounts = {b["asset"]["symbol"]: int(b["amount"]) for b in after[p]["balances"]}
        for b in before[p]["balances"]:
            expected = int(b["amount"])
            if p == "alice" and b["asset"]["kind"] == "btc":
                expected -= int(quote["feeSats"])
            assert amounts[b["asset"]["symbol"]] == expected, (p, b["asset"]["symbol"])
        with sqlite3.connect(STATE / p / "journal.sqlite") as db:
            assert (
                db.execute(
                    "SELECT count(*) FROM reservations WHERE trade_id=?", (trade_id,)
                ).fetchone()[0]
                == 0
            )
    final = local("alice", f"/trades/{trade_id}")
    assert final["status"] == "CANCELLED"
    conflict = rpc("getrawtransaction", quote["cancellationTxid"], True)
    assert conflict["confirmations"] >= 1 and len(conflict["vin"]) == 1
    point = conflict["vin"][0]
    # bitcoin-cli prints JSON null as empty output; the transport preserves that.
    assert not rpc("gettxout", point["txid"], point["vout"], False)
    original_tx = rpc(
        "decoderawtransaction",
        review["trade"]["settlementPackage"]["payload"]["final"]["unsignedTxHex"],
    )
    assert any(
        i["txid"] == point["txid"] and i["vout"] == point["vout"] for i in original_tx["vin"]
    )
    rejected = rpc(
        "testmempoolaccept",
        [review["trade"]["settlementPackage"]["payload"]["final"]["unsignedTxHex"]],
    )[0]
    assert not rejected["allowed"] and rejected.get("reject-reason") in (
        "missing-inputs",
        "bad-txns-inputs-missingorspent",
    )
    result = {
        "scenario": scenario,
        "mode": "real",
        "network": "regtest",
        "tradeId": trade_id,
        "originalTxid": original,
        "cancellationTxid": quote["cancellationTxid"],
        "feeSats": quote["feeSats"],
        "receipts": receipts,
        "allRgbBalancesUnchanged": True,
        "reservationsReleasedAfterConfirmation": True,
        "restartVerified": True,
        "unsignedPeersRecoveredWithoutPreview": True,
        "originalRejectedByCore": rejected["reject-reason"],
        "path": "local HTTP -> market -> wallet HTTP -> native -> Bitcoin",
    }
    save(folder / "cancellation-evidence.json", result)
    print(json.dumps(result), flush=True)
    return result


def original_wins(runtime, smoke):
    # After the follow-up ring Alice owns DUSD and Bob owns BTC.
    trade_id = prepare(runtime, smoke, "direct", reverse=True)
    quote = runtime.local("alice", f"/trades/{trade_id}/cancel-preview", {})
    review = read(STATE / "services/runs" / trade_id / "review.json")
    runtime.local(
        "bob",
        f"/trades/{trade_id}/approve",
        {
            "approvalToken": review["previews"]["bob"]["approvalToken"],
            "confirmed": True,
        },
    )
    mine()
    receipt = runtime.local(
        "alice",
        f"/trades/{trade_id}/cancel",
        {
            "approvalDigest": quote["approvalDigest"],
            "confirmed": True,
        },
    )
    for _ in range(30):
        if receipt["state"] == "confirmed":
            break
        time.sleep(0.5)
        receipt = runtime.local("alice", f"/trades/{trade_id}/sync", {})
    assert receipt["state"] == "confirmed" and receipt["rgbAccepted"]
    completed = smoke.settle(runtime, trade_id, "direct", True, "cancellation-original-wins.json")
    assert quote["cancellationTxid"] not in rpc("getrawmempool")
    return {"originalWonRace": True, "txid": completed["txid"], "cancellationFeePaid": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true")
    parser.add_argument("--race-only", action="store_true")
    parser.add_argument("--cancel-only", choices=["direct", "ring"])
    parser.add_argument("--verify-trade")
    parser.add_argument("--base-port", type=int, default=45600)
    parser.add_argument("--evidence", default="cancellation-regtest.json")
    args = parser.parse_args()
    if args.setup:
        if STATE == ROOT / "packages/wallet/state" or STATE.exists():
            raise ValueError("setup requires a new isolated RGB_DEMO_STATE directory")
        setup()
        catalog.main()
    assert native("capabilities")["unilateralCancellation"]
    configure(ROOT, args.base_port)
    spec = importlib.util.spec_from_file_location(
        "settlement_smoke", ROOT / "scripts/demo/service-smoke.py"
    )
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    runtime = Runtime()
    try:
        runtime.market()
        for p in PEOPLE:
            runtime.profile(p)
        runtime.ready()
        if args.verify_trade:
            import hashlib

            quote = read(
                STATE
                / "alice/trades"
                / hashlib.sha256(args.verify_trade.encode()).hexdigest()
                / "cancellation-intent.json"
            )
            result = verify_cancelled(
                runtime, args.verify_trade, args.cancel_only or "direct", quote
            )
            save(ROOT / "scripts/demo/evidence" / args.evidence, result)
            return
        if args.cancel_only:
            result = run(runtime, smoke, args.cancel_only)
            save(ROOT / "scripts/demo/evidence" / args.evidence, result)
            return
        if args.race_only:
            result = original_wins(runtime, smoke)
            save(ROOT / "scripts/demo/evidence/cancellation-race.json", result)
            print(json.dumps(result), flush=True)
            return
        evidence = [run(runtime, smoke, scenario) for scenario in ("direct", "ring")]
        # Prove that the same RGB assets are spendable after both cancellations.
        completed = smoke.run(runtime, "ring", evidence_name="cancellation-followup-ring.json")
        evidence.append({"followupRingTxid": completed["txid"], "state": completed["marketStatus"]})
        evidence.append(original_wins(runtime, smoke))
        save(ROOT / "scripts/demo/evidence" / args.evidence, evidence)
    finally:
        runtime.close()


if __name__ == "__main__":
    main()
