#!/usr/bin/env python3
"""Verify two real partial fills using only brand-new isolated local regtest wallets."""

import argparse
import contextlib
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_FILES = (
    "packages/contracts/src/index.ts",
    "apps/market/src/matcher.ts",
    "apps/market/src/store.ts",
    "apps/market/src/server.ts",
    "apps/local-client/src/service.ts",
    "apps/local-client/src/main.ts",
    "apps/local-client/src/server.ts",
    "packages/wallet/protocol.py",
    "packages/wallet/server.py",
    "packages/wallet/native/target/debug/rgb-settlement-spike",
)


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def announce(phase, **details):
    print(json.dumps({"phase": phase, **details}), flush=True)


def balances(state):
    return {item["asset"]["symbol"]: int(item["amount"]) for item in state["balances"]}


def parent_history(runtime, parent_id, filled, trade_ids):
    page = runtime.local("alice", "/history")
    parent = next(order for order in page["myOrders"] if order["id"] == parent_id)
    assert sum(order["id"] == parent_id for order in page["myOrders"]) == 1
    assert parent["giveAmount"] == "100" and parent["minReceiveAmount"] == "1000000"
    assert parent["maxFeeSats"] == "2000"
    assert parent["fillProgress"] == {
        "filledGiveAmount": str(filled),
        "receivedAmount": str(filled * 10000),
        "feeBudgetUsedSats": str(filled * 20),
        "fillCount": len(trade_ids),
    }
    assert parent["status"] == ("FILLED" if filled == 100 else "OPEN")
    assert parent["revision"] == len(trade_ids) * 2
    assert {trade["plan"]["tradeId"] for trade in page["trades"]} == set(trade_ids)
    assert all(trade["status"] == "CONFIRMED" for trade in page["trades"])
    return {
        "orderId": parent_id,
        "status": parent["status"],
        "revision": parent["revision"],
        "remainingGiveAmount": str(100 - filled),
        "fillProgress": parent["fillProgress"],
        "historyTradeIds": sorted(trade_ids),
        "historyOrderCount": len(page["myOrders"]),
    }


def reject_previous_approval(runtime, trade_id, token):
    cfg = runtime.config["profiles"]["alice"]
    url = f"http://127.0.0.1:{cfg['localPort']}/api/trades/{trade_id}/approve"
    request = urllib.request.Request(
        url,
        json.dumps({"approvalToken": token, "confirmed": True}).encode(),
        {
            "Authorization": "Bearer " + cfg["localToken"],
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{cfg['localPort']}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180):
            raise RuntimeError("Previous fill approval was accepted; stop and reconcile")
    except urllib.error.HTTPError as error:
        body = json.load(error)
        if error.code != 409 or body.get("error") != "Approval is missing or stale":
            raise RuntimeError("Unexpected approval result; stop and reconcile") from None
    progress = runtime.local("alice", f"/trades/{trade_id}/progress")
    assert not progress["signingAuthorized"] and not progress["recoveryRequired"]


def publish(runtime, person, assets, partial=False):
    policy = runtime.local(person, "/policy")
    policy.update(
        allowBtcSale=not partial, maxFeeSats="2000" if partial else "1000", protectedBalances={}
    )
    if partial:
        keep = assets["KEEP"]
        from protocol import asset_key

        policy["protectedBalances"][asset_key(keep)] = "7"
    draft = {
        "giveAsset": assets["X" if partial else "BTC"],
        "giveAmount": "100" if partial else "500000",
        "receiveAsset": assets["BTC" if partial else "X"],
        "minReceiveAmount": "1000000" if partial else "50",
        "maxFeeSats": policy["maxFeeSats"],
        "expiresAt": int(time.time() * 1000) + 1800000,
    }
    if partial:
        draft["partialFill"] = {"minGiveAmount": "50"}
    runtime.local(person, "/draft/validate", {"draft": draft, "policy": policy})
    return runtime.local(
        person,
        "/orders",
        {"draft": draft, "policy": policy, "confirmed": True, "requestId": str(uuid.uuid4())},
    )


def fill(runtime, person, parent, assets, state, previous_token=None):
    from protocol import read, save
    from regtest import rpc

    people = ("alice", person)
    before = {owner: runtime.local(owner, "/state") for owner in people}
    counterparty = publish(runtime, person, assets)
    trade = next(
        trade
        for trade in runtime.local("alice", "/snapshot")["trades"]
        if {ref["orderId"] for ref in trade["plan"]["orderRefs"]}
        == {parent["id"], counterparty["id"]}
    )
    trade_id = trade["plan"]["tradeId"]
    assert set(trade["plan"]["participants"]) == set(people)
    assert {
        (leg["fromOwnerId"], leg["asset"]["symbol"], leg["amount"]) for leg in trade["plan"]["legs"]
    } == {("alice", "X", "50"), (person, "BTC", "500000")}
    assert (
        next(fee["feeSats"] for fee in trade["plan"]["fees"] if fee["ownerId"] == "alice") == "1000"
    )
    directory = state / "services/runs" / trade_id
    save(directory / "before.json", before)
    announce("preparing", person=person, tradeId=trade_id)
    for _ in range(12):
        for owner in people:
            trade = runtime.local(owner, f"/trades/{trade_id}")
            if trade.get("settlementPackage"):
                break
            runtime.local(owner, f"/trades/{trade_id}/prepare", {})
        if trade.get("settlementPackage"):
            break
    else:
        raise RuntimeError("Cooperative preparation did not finish")
    package = trade["settlementPackage"]
    previews = {owner: runtime.local(owner, f"/trades/{trade_id}/preview", {}) for owner in people}
    assert all(
        review["preview"][key] == package[key]
        for review in previews.values()
        for key in ("packageId", "unsignedTxDigest", "commitmentDigest", "planDigest")
    )
    assert all(int(review["preview"]["feeSats"]) <= 1000 for review in previews.values())
    save(directory / "review.json", {"trade": trade, "previews": previews})
    for owner in people:
        progress = runtime.local(owner, f"/trades/{trade_id}/progress")
        assert not progress["signingAuthorized"] and not progress["recoveryRequired"]
    if previous_token:
        assert previous_token != previews["alice"]["approvalToken"]
        reject_previous_approval(runtime, trade_id, previous_token)
    announce("signing-once", person=person, tradeId=trade_id)
    for owner in people:
        # Never replay an approval after any transport or validation failure.
        save(directory / f"approval-attempt-{owner}.json", {"tradeId": trade_id, "attempted": True})
        runtime.local(
            owner,
            f"/trades/{trade_id}/approve",
            {"approvalToken": previews[owner]["approvalToken"], "confirmed": True},
        )
    txid = package["packageId"]
    tx = rpc("getrawtransaction", txid, True)
    assert tx["txid"] == txid and all(vin.get("txinwitness") for vin in tx["vin"])
    inputs = [
        item for funding in package["payload"]["funding"].values() for item in funding["inputs"]
    ]
    assert {(vin["txid"], vin["vout"]) for vin in tx["vin"]} == {
        (item["txid"], item["vout"]) for item in inputs
    }
    input_sats = sum(
        int(
            Decimal(str(rpc("getrawtransaction", vin["txid"], True)["vout"][vin["vout"]]["value"]))
            * 100000000
        )
        for vin in tx["vin"]
    )
    fee_sats = input_sats - sum(
        int(Decimal(str(output["value"])) * 100000000) for output in tx["vout"]
    )
    assert fee_sats == sum(int(review["preview"]["feeSats"]) for review in previews.values())
    if not tx.get("confirmations", 0):
        if "regtest-miner" not in rpc("listwallets"):
            rpc("loadwallet", "regtest-miner")
        rpc("generatetoaddress", 1, rpc("-rpcwallet=regtest-miner", "getnewaddress"))
    announce("checking-confirmation-and-rgb", person=person, tradeId=trade_id, txid=txid)
    receipts = {}
    raw_receipts = {}
    for owner in people:
        for _ in range(40):
            receipt = runtime.local(owner, f"/trades/{trade_id}/sync", {})
            assert receipt.get("txid") == txid
            if receipt["state"] == "confirmed":
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("RGB acceptance remains unresolved; preserve isolated state")
        assert receipt["mode"] == "real" and receipt["chainConfirmed"] and receipt["rgbAccepted"]
        receipts[owner] = receipt
        raw = read(
            state
            / owner
            / "trades"
            / hashlib.sha256(trade_id.encode()).hexdigest()
            / "receipt.json"
        )
        assert raw["txid"] == txid and raw["chainConfirmed"] and raw["rgbAccepted"]
        assert (
            raw["sdkAllocationIndexSynchronized"]
            and raw["btcBalanceDifferenceFromPreviewSats"] == "0"
        )
        raw_receipts[owner] = {
            key: raw[key]
            for key in (
                "txid",
                "chainConfirmed",
                "rgbAccepted",
                "sdkAllocationIndexSynchronized",
                "btcBalanceDifferenceFromPreviewSats",
            )
        }
    after = {owner: runtime.local(owner, "/state") for owner in people}
    deltas = {}
    for owner in people:
        expected = balances({"balances": previews[owner]["preview"]["balancesAfter"]})
        actual = balances(after[owner])
        assert actual == expected, "Wallet balances differ from immutable approved preview"
        original = balances(before[owner])
        deltas[owner] = {
            symbol: str(amount - original[symbol]) for symbol, amount in actual.items()
        }
        assert int(deltas[owner]["X"]) == (-50 if owner == "alice" else 50)
        assert int(deltas[owner]["BTC"]) == (500000 if owner == "alice" else -500000) - int(
            previews[owner]["preview"]["feeSats"]
        )
        assert all(
            amount == "0" for symbol, amount in deltas[owner].items() if symbol not in ("X", "BTC")
        )
    final = runtime.local("alice", f"/trades/{trade_id}")
    assert final["status"] == "CONFIRMED"
    signatures = [
        entry["ownerId"]
        for entry in final["messages"]
        if entry["message"]["type"] == "signature" and "signature" in entry["message"]["payload"]
    ]
    assert sorted(signatures) == sorted(people)
    tx = rpc("getrawtransaction", txid, True)
    assert tx["confirmations"] >= 1
    evidence = {
        "tradeId": trade_id,
        "counterpartyOrderId": counterparty["id"],
        "txid": txid,
        "participants": list(people),
        "marketStatus": final["status"],
        "receipts": receipts,
        "nativeReceipts": raw_receipts,
        "actualDeltas": deltas,
        "balancesBefore": {
            owner: {key: str(value) for key, value in balances(before[owner]).items()}
            for owner in people
        },
        "balancesAfter": {
            owner: {key: str(value) for key, value in balances(after[owner]).items()}
            for owner in people
        },
        "core": {
            "confirmations": tx["confirmations"],
            "blockhash": tx["blockhash"],
            "feeSats": str(fee_sats),
            "inputCount": len(tx["vin"]),
            "outputCount": len(tx["vout"]),
            "vsize": tx["vsize"],
            "allInputsWitnessSigned": True,
            "approvedInputSetMatches": True,
        },
        "aliceFeeCapSats": "1000",
        "aliceActualFeeSats": previews["alice"]["preview"]["feeSats"],
        "approvalTokenDigests": {
            owner: hashlib.sha256(review["approvalToken"].encode()).hexdigest()
            for owner, review in previews.items()
        },
        "priorFillApprovalRejected": bool(previous_token),
        "commonCommitment": {
            key: package[key] for key in ("planDigest", "unsignedTxDigest", "commitmentDigest")
        },
    }
    save(directory / "evidence.json", evidence)
    return evidence, previews["alice"]["approvalToken"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Create isolated wallets and execute two real local regtest fills",
    )
    parser.add_argument("--base-port", type=int, default=44200)
    args = parser.parse_args()
    if sys.flags.optimize:
        parser.error("Python optimization must be disabled so all validation checks run")
    if not args.execute:
        parser.error(
            "Pass --execute; this script creates new isolated wallets and signs regtest transactions"
        )
    if not 44000 <= args.base_port <= 44980 or not shutil.which("rtk"):
        parser.error("Use a free base port in 44000..44980 and put rtk with proxy support on PATH")
    if os.environ.get("PALKA_CHAIN_CONFIG") or os.environ.get("RGB_SERVICE_SOURCE"):
        parser.error("Remote chain and source overrides are forbidden for this isolated check")
    for key, expected in (
        ("RGB_INDEXER_URL", "127.0.0.1:50001"),
        ("RGB_PROXY_URL", "http://127.0.0.1:3000/json-rpc"),
    ):
        if os.environ.get(key, expected) != expected:
            parser.error(f"{key} must use the local test infrastructure")
        os.environ[key] = expected
    for offset in (0, 1, 2, 3, 11, 12, 13):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", args.base_port + offset))
    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    state = ROOT / "packages/wallet/state" / ("partial-fill-check-" + run_id)
    assert (
        state.parent.resolve() == (ROOT / "packages/wallet/state").resolve() and not state.exists()
    )
    subprocess.run(
        ["rtk", "proxy", "git", "check-ignore", "--quiet", str(state)], cwd=ROOT, check=True
    )
    os.umask(0o077)
    state.mkdir(mode=0o700)
    os.environ["RGB_DEMO_STATE"] = str(state)
    import catalog
    from service_runtime import PEOPLE, Runtime, configure, save

    import regtest

    evidence_path = ROOT / "scripts/demo/evidence" / f"service-partial-fill-{run_id}.json"
    evidence = {
        "scenario": "two independent atomic direct fills of one partial order",
        "mode": "real",
        "network": "regtest",
        "stateDirectory": str(state.relative_to(ROOT)),
        "sourceHashes": hashes(),
        "fills": [],
        "parentHistory": [],
        "phase": "setup",
        "complete": False,
        "qvac": "not invoked; explicit manual drafts",
        "guard": "new isolated wallets; local chain only; never retry approval after uncertainty",
    }
    runtime = None
    try:
        assert regtest.rpc("getblockchaininfo")["chain"] == "regtest"
        announce("isolated-setup", stateDirectory=str(state.relative_to(ROOT)))
        with (state / "setup.log").open("w") as output, contextlib.redirect_stdout(output):
            regtest.setup()
            catalog.main()
        configure(ROOT, args.base_port)
        runtime = Runtime()
        runtime.market()
        for person in PEOPLE:
            runtime.profile(person)
        runtime.ready()
        initial = {person: runtime.local(person, "/state") for person in PEOPLE}
        identities = {person: value["walletId"] for person, value in initial.items()}
        assert balances(initial["alice"])["X"] == 100
        assert balances(initial["bob"])["X"] == balances(initial["carol"])["X"] == 0
        assets = {
            balance["asset"]["symbol"]: balance["asset"] for balance in initial["alice"]["balances"]
        }
        parent = publish(runtime, "alice", assets, partial=True)
        evidence["parentOrderId"] = parent["id"]
        previous_token = None
        for index, person in enumerate(("bob", "carol"), start=1):
            evidence["phase"] = f"fill-{index}"
            save(evidence_path, evidence)
            result, previous_token = fill(runtime, person, parent, assets, state, previous_token)
            evidence["fills"].append(result)
            trade_ids = [item["tradeId"] for item in evidence["fills"]]
            history = parent_history(runtime, parent["id"], index * 50, trade_ids)
            evidence["parentHistory"].append(history)
            save(evidence_path, evidence)
            if index == 1:
                announce(
                    "restarting-isolated-services",
                    remainingGiveAmount=history["remainingGiveAmount"],
                )
                runtime.close()
                runtime = Runtime()
                runtime.market()
                for profile in PEOPLE:
                    runtime.profile(profile)
                runtime.ready()
                assert identities == {
                    profile: runtime.local(profile, "/state")["walletId"] for profile in PEOPLE
                }
                assert parent_history(runtime, parent["id"], 50, trade_ids) == history
                evidence["restartBetweenFills"] = {
                    "walletIdentitiesPreserved": True,
                    "parentAndFirstFillHistoryPreserved": True,
                }
        assert len({item["txid"] for item in evidence["fills"]}) == 2
        assert sum(int(item["aliceFeeCapSats"]) for item in evidence["fills"]) <= 2000
        assert sum(int(item["aliceActualFeeSats"]) for item in evidence["fills"]) <= 2000
        final = {person: balances(runtime.local(person, "/state")) for person in PEOPLE}
        assert (final["alice"]["X"], final["bob"]["X"], final["carol"]["X"]) == (0, 50, 50)
        assert final["alice"]["KEEP"] == 7
        assert hashes() == evidence["sourceHashes"], "Runtime source changed during validation"
        evidence.update(
            complete=True,
            phase="confirmed",
            independentBitcoinTransactions=2,
            freshApprovalPerFill=True,
            finalRgbBalances={person: str(value["X"]) for person, value in final.items()},
        )
        save(evidence_path, evidence)
        announce(
            "complete",
            evidence=str(evidence_path.relative_to(ROOT)),
            txids=[item["txid"] for item in evidence["fills"]],
        )
    except Exception as error:
        evidence.update(errorType=type(error).__name__, haltedWithoutSigningRetry=True)
        save(evidence_path, evidence)
        (state / "failure.log").write_text(traceback.format_exc())
        announce(
            "halted",
            phaseAtFailure=evidence["phase"],
            errorType=type(error).__name__,
            stateDirectory=str(state.relative_to(ROOT)),
            evidence=str(evidence_path.relative_to(ROOT)),
        )
        raise SystemExit(1) from None
    finally:
        if runtime:
            runtime.close()


if __name__ == "__main__":
    main()
