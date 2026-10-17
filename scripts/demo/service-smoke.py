#!/usr/bin/env python3
"""Real local-client HTTP → market → cooperative RGB settlement. No mock services."""

import argparse
import json
import time
import uuid

from service_runtime import PEOPLE, ROOT, STATE, Runtime, configure, read, save

from protocol import asset_key
from regtest import rpc


def run(runtime, scenario, reverse=False, on_signed=None, evidence_name=None):
    people = PEOPLE[:2] if scenario == "direct" else PEOPLE
    before = {p: runtime.local(p, "/state") for p in people}
    assets = {b["asset"]["symbol"]: b["asset"] for s in before.values() for b in s["balances"]}
    specs = (
        [("alice", "BTC", "100000", "DUSD", "100"), ("bob", "DUSD", "100", "BTC", "100000")]
        if scenario == "direct"
        else [
            ("alice", "X", "100", "DUSD", "100"),
            ("bob", "DUSD", "100", "BTC", "100000"),
            ("carol", "BTC", "100000", "X", "100"),
        ]
    )
    if reverse:
        specs = [(p, receive, minimum, give, amount) for p, give, amount, receive, minimum in specs]
    orders = {}
    for p, give, amount, receive, minimum in specs:
        policy = runtime.local(p, "/policy")
        policy.update(allowBtcSale=give == "BTC", maxFeeSats="1000", protectedBalances={})
        # Keep the real policy path, including conservation of the unrelated KEEP allocation.
        if "KEEP" in assets:
            policy["protectedBalances"][asset_key(assets["KEEP"])] = next(
                (b["amount"] for b in before[p]["balances"] if b["asset"]["symbol"] == "KEEP"), "0"
            )
        draft = {
            "giveAsset": assets[give],
            "giveAmount": amount,
            "receiveAsset": assets[receive],
            "minReceiveAmount": minimum,
            "maxFeeSats": "1000",
            "expiresAt": int(time.time() * 1000) + 1800000,
        }
        runtime.local(p, "/draft/validate", {"draft": draft, "policy": policy})
        orders[p] = runtime.local(
            p,
            "/orders",
            {"draft": draft, "policy": policy, "confirmed": True, "requestId": str(uuid.uuid4())},
        )
    snapshot = runtime.local(people[0], "/snapshot")
    no_direct_pair = not any(
        a["ownerId"] != b["ownerId"]
        and asset_key(a["giveAsset"]) == asset_key(b["receiveAsset"])
        and asset_key(b["giveAsset"]) == asset_key(a["receiveAsset"])
        for a in orders.values()
        for b in orders.values()
    )
    if scenario == "ring":
        assert no_direct_pair
    trade = next(
        t
        for t in snapshot["trades"]
        if {r["orderId"] for r in t["plan"]["orderRefs"]} == {o["id"] for o in orders.values()}
    )
    trade_id = trade["plan"]["tradeId"]
    directory = STATE / "services/runs" / trade_id
    save(directory / "before.json", before)
    save(directory / "orders.json", orders)
    print(
        json.dumps(
            {"scenario": scenario, "reverse": reverse, "tradeId": trade_id, "phase": "preparing"}
        ),
        flush=True,
    )
    for _ in range(12):
        for p in people:
            trade = runtime.local(p, f"/trades/{trade_id}")
            if trade.get("settlementPackage"):
                break
            runtime.local(p, f"/trades/{trade_id}/prepare", {})
        if trade.get("settlementPackage"):
            break
    else:
        raise RuntimeError("Cooperative rounds did not finish")
    trade = runtime.local(people[0], f"/trades/{trade_id}")
    package = trade["settlementPackage"]
    received_inputs = {}
    if reverse:
        prior_txids = {
            t["settlementPackage"]["packageId"]
            for t in snapshot["trades"]
            if t["status"] == "CONFIRMED"
        }
        for leg in trade["plan"]["legs"]:
            if leg["asset"]["kind"] == "rgb":
                p = leg["fromOwnerId"]
                received_inputs[p] = any(
                    i["txid"] in prior_txids for i in package["payload"]["funding"][p]["inputs"]
                )
        assert received_inputs and all(received_inputs.values()), (
            "Repeat must spend a prior received RGB output"
        )
    rounds = {p: [] for p in people}
    for m in trade["messages"]:
        if m["message"]["type"] == "prepare":
            rounds[m["ownerId"]].append(m["message"]["payload"]["material"]["stage"])
    assert all(set(stages) == {"funding", "colored", "proofs"} for stages in rounds.values())
    previews = {p: runtime.local(p, f"/trades/{trade_id}/preview", {}) for p in people}
    assert all(
        v["preview"][k] == package[k]
        for v in previews.values()
        for k in ("packageId", "unsignedTxDigest", "commitmentDigest", "planDigest")
    )
    save(directory / "review.json", {"trade": trade, "previews": previews})
    for p in people:
        runtime.local(
            p,
            f"/trades/{trade_id}/approve",
            {"approvalToken": previews[p]["approvalToken"], "confirmed": True},
        )
    if on_signed:
        on_signed(runtime, trade_id, people)
    return settle(runtime, trade_id, scenario, reverse, evidence_name)


def settle(runtime, trade_id, scenario, reverse=False, evidence_name=None):
    """Finish the exact saved signed transaction; never republish, prepare or sign."""
    directory = STATE / "services/runs" / trade_id
    saved = read(directory / "review.json")
    trade = saved["trade"]
    package = trade["settlementPackage"]
    previews = saved["previews"]
    before = read(directory / "before.json")
    people = list(before)
    orders = read(directory / "orders.json")
    no_direct_pair = not any(
        a["ownerId"] != b["ownerId"]
        and asset_key(a["giveAsset"]) == asset_key(b["receiveAsset"])
        and asset_key(b["giveAsset"]) == asset_key(a["receiveAsset"])
        for a in orders.values()
        for b in orders.values()
    )
    rounds = {p: [] for p in people}
    for m in trade["messages"]:
        if m["message"]["type"] == "prepare":
            rounds[m["ownerId"]].append(m["message"]["payload"]["material"]["stage"])
    received_inputs = {}
    if reverse:
        prior = {
            t["settlementPackage"]["packageId"]
            for t in runtime.local(people[0], "/snapshot")["trades"]
            if t["status"] == "CONFIRMED" and t["plan"]["tradeId"] != trade_id
        }
        for leg in trade["plan"]["legs"]:
            if leg["asset"]["kind"] == "rgb":
                p = leg["fromOwnerId"]
                received_inputs[p] = any(
                    i["txid"] in prior for i in package["payload"]["funding"][p]["inputs"]
                )
        assert received_inputs and all(received_inputs.values())
    txid = package["packageId"]
    tx = rpc("getrawtransaction", txid, True)
    assert tx["txid"] == txid
    if not tx.get("confirmations", 0):
        if "regtest-miner" not in rpc("listwallets"):
            rpc("loadwallet", "regtest-miner")
        miner = rpc("-rpcwallet=regtest-miner", "getnewaddress")
        rpc("generatetoaddress", 1, miner)
    receipts = {}
    for p in people:
        for _ in range(40):
            receipt = runtime.local(p, f"/trades/{trade_id}/sync", {})
            if receipt["state"] == "confirmed":
                break
            time.sleep(0.5)
        else:
            raise RuntimeError(f"RGB acceptance did not complete for {p}")
        assert receipt["txid"] == txid and receipt["chainConfirmed"] and receipt["rgbAccepted"]
        receipts[p] = receipt
    after = {p: runtime.local(p, "/state") for p in people}
    deltas = {}
    for p in people:
        actual = {asset_key(b["asset"]): int(b["amount"]) for b in after[p]["balances"]}
        expected = {
            asset_key(b["asset"]): int(b["amount"]) for b in previews[p]["preview"]["balancesAfter"]
        }
        assert actual == expected, f"Actual balances differ: {p}"
        original = {asset_key(b["asset"]): int(b["amount"]) for b in before[p]["balances"]}
        deltas[p] = {k: str(v - original.get(k, 0)) for k, v in actual.items()}
    final = runtime.local(people[0], f"/trades/{trade_id}")
    assert final["status"] == "CONFIRMED"
    signatures = [
        m
        for m in final["messages"]
        if m["message"]["type"] == "signature" and "signature" in m["message"]["payload"]
    ]
    assert len(signatures) == len(people)
    evidence = {
        "scenario": scenario,
        "reverse": reverse,
        "tradeId": trade_id,
        "txid": txid,
        "mode": "real",
        "network": "regtest",
        "path": "local-client HTTP → real market HTTP/WebSocket → wallet HTTP → Bitcoin/RGB",
        "rounds": rounds,
        "commonCommitment": {
            k: package[k] for k in ("unsignedTxDigest", "commitmentDigest", "planDigest")
        },
        "signatureOwners": [m["ownerId"] for m in signatures],
        "marketStatus": final["status"],
        "receipts": receipts,
        "actualDeltas": deltas,
        "feeSats": str(sum(int(v["preview"]["feeSats"]) for v in previews.values())),
        "sharedBitcoinTransactions": 1,
        "inputCount": len(tx["vin"]),
        "outputCount": len(tx["vout"]),
        "qvac": "not invoked by this manual-draft settlement scenario",
    }
    evidence["source"] = str(runtime.source)
    evidence["noDirectPair"] = no_direct_pair
    evidence["repeatReceivedInputs"] = received_inputs
    evidence["vsize"] = tx["vsize"]
    if runtime.config.get("sourceRevision"):
        evidence["sourceRevision"] = runtime.config["sourceRevision"]
    save(directory / "evidence.json", evidence)
    save(
        ROOT
        / "scripts/demo/evidence"
        / (evidence_name or f"service-{scenario}{'-repeat' if reverse else ''}.json"),
        evidence,
    )
    print(json.dumps(evidence), flush=True)
    return evidence


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--scenario", choices=["direct", "ring"], required=True)
    parser.add_argument("--base-port", type=int, default=43100)
    parser.add_argument("--repeat", action="store_true")
    parser.add_argument(
        "--evidence-prefix",
        default="service",
        help="Public evidence basename; keep earlier runs separate",
    )
    args = parser.parse_args()
    configure(args.source, args.base_port)
    runtime = Runtime()
    try:
        runtime.market()
        for person in PEOPLE:
            runtime.profile(person)
        runtime.ready()
        run(runtime, args.scenario, evidence_name=f"{args.evidence_prefix}-{args.scenario}.json")
        if args.repeat:
            identities = {p: runtime.local(p, "/state")["walletId"] for p in PEOPLE}
            for person in PEOPLE:
                runtime.stop("local-" + person)
                runtime.stop("wallet-" + person)
            for person in PEOPLE:
                runtime.profile(person)
            runtime.ready()
            assert identities == {p: runtime.local(p, "/state")["walletId"] for p in PEOPLE}, (
                "Restart changed wallet identity"
            )
            run(
                runtime,
                args.scenario,
                True,
                evidence_name=f"{args.evidence_prefix}-{args.scenario}-repeat.json",
            )
    finally:
        runtime.close()
