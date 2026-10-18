#!/usr/bin/env python3
"""Real isolated regtest: direct swap, three-RGB ring, then spend the received RGB."""

import argparse
import contextlib
import importlib.util
import io
import json
import os
import time
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Approve isolated regtest transfers")
    args = parser.parse_args()
    if not args.execute:
        parser.error(
            "Pass --execute to create fresh isolated wallets and perform regtest transfers"
        )
    root = Path(__file__).resolve().parents[2]
    run_id = "ring-upgrade-" + uuid.uuid4().hex[:12]
    state = root / "packages/wallet/state" / run_id
    if state.exists() or os.environ.get("PALKA_CHAIN_CONFIG"):
        raise RuntimeError("This check requires fresh wallets on the local regtest infrastructure")
    os.environ["RGB_DEMO_STATE"] = str(state)
    import catalog

    from regtest import native, setup

    spec = importlib.util.spec_from_file_location(
        "adapter_demo", Path(__file__).with_name("adapter-demo.py")
    )
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    from protocol import digest, read, save, sha

    print(json.dumps({"phase": "setup", "run": run_id}), flush=True)
    with contextlib.redirect_stdout(io.StringIO()):
        setup()
        native("issue", "carol", ticker="T000003", amount="1000")
        catalog.main()
    cases = [
        ("direct", [("alice", "bob", "X", "10"), ("bob", "alice", "DUSD", "10")]),
        (
            "ring",
            [
                ("alice", "carol", "X", "10"),
                ("carol", "bob", "T000003", "10"),
                ("bob", "alice", "DUSD", "10"),
            ],
        ),
        ("respend", [("alice", "carol", "DUSD", "20"), ("carol", "alice", "T000003", "1")]),
    ]
    evidence = []
    ring_txid = None
    for scenario, specs in cases:
        people = list(dict.fromkeys(sender for sender, *_ in specs))
        trade_id = run_id + "-" + scenario
        directory = state / "adapter-runs" / sha(trade_id.encode())
        print(json.dumps({"phase": "prepare", "scenario": scenario}), flush=True)
        with adapter.clients(people) as wallets:
            before = {p: wallets[p]("state") for p in people}
            assets = {
                b["asset"]["symbol"]: b["asset"] for s in before.values() for b in s["balances"]
            }
            plan = {
                "protocolVersion": 1,
                "tradeId": trade_id,
                "revision": 0,
                "network": "regtest",
                "participants": people,
                "orderRefs": [{"orderId": trade_id + "-" + p, "revision": 1} for p in people],
                "legs": [
                    {
                        "fromOwnerId": sender,
                        "toOwnerId": receiver,
                        "asset": assets[ticker],
                        "amount": amount,
                    }
                    for sender, receiver, ticker, amount in specs
                ],
                "fees": [{"ownerId": p, "feeSats": "1000"} for p in people],
                "feeState": "estimate",
                "createdAt": int(time.time() * 1000),
            }
            plan["digest"] = digest(plan)
            materials, packages = [], {}
            for _ in range(10):
                for p in people:
                    if p in packages:
                        continue
                    result = wallets[p]("prepare", {"plan": plan, "materials": materials})
                    if "material" in result:
                        entry = {"ownerId": p, "material": result["material"]}
                        if entry not in materials:
                            materials.append(entry)
                    if "settlementPackage" in result:
                        packages[p] = result["settlementPackage"]
                if len(packages) == len(people):
                    break
            assert len(packages) == len(people), "Preparation did not finish"
            package = packages[people[0]]
            assert all(p == package for p in packages.values()), (
                "Wallets disagree on the final transaction"
            )
            funding = package["payload"]["funding"]
            contracts = [c for f in funding.values() for c in f["allocations"]]
            shared = len(contracts) - len(set(contracts))
            if scenario == "ring":
                assert shared >= 2, "Regression must exercise shared X and DUSD inputs"
                ring_txid = package["packageId"]
            if scenario == "respend":
                assert any(i["txid"] == ring_txid for i in funding["alice"]["inputs"])
            previews = {
                p: wallets[p]("validate", {"package": package, "plan": plan}) for p in people
            }
            review = {
                "scenario": scenario,
                "reverse": False,
                "plan": plan,
                "package": package,
                "previews": previews,
                "before": before,
                "transport": "authenticated-loopback-http-v1",
                "signed": False,
            }
            review["approvalDigest"] = digest(review)
            save(directory / "review.json", review)
        # The existing executor binds signatures to the review, restarts sidecars,
        # confirms one Bitcoin transaction, accepts RGB and checks exact balances.
        with contextlib.redirect_stdout(io.StringIO()):
            adapter.execute(trade_id, review["approvalDigest"])
        result = read(directory / "evidence.json")
        result["sharedContributingContracts"] = shared
        evidence.append(result)
        print(
            json.dumps({"phase": "confirmed", "scenario": scenario, "txid": result["txid"]}),
            flush=True,
        )
    output = root / "scripts/demo/evidence" / (run_id + ".json")
    save(output, {"network": "regtest", "isolatedWallets": True, "cases": evidence})
    print(json.dumps({"evidence": str(output)}), flush=True)


if __name__ == "__main__":
    main()
