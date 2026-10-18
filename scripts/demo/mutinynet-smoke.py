#!/usr/bin/env python3
"""Execute direct/ring swaps on prepared, isolated Mutinynet wallets; never mine or fund."""

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import traceback
import uuid
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NETWORK = "signetcustom"
PEOPLE = ("alice", "bob", "carol")
SOURCE_FILES = (
    "packages/contracts/src/index.ts",
    "apps/market/src/matcher.ts",
    "apps/market/src/store.ts",
    "apps/market/src/server.ts",
    "apps/market/src/main.ts",
    "apps/local-client/src/service.ts",
    "apps/local-client/src/main.ts",
    "packages/wallet/protocol.py",
    "packages/wallet/journal.py",
    "packages/wallet/server.py",
    "packages/wallet/adapter.mjs",
    "packages/wallet/native/target/debug/rgb-settlement-spike",
    "scripts/demo/chain_profile.py",
    "scripts/demo/regtest.py",
    "scripts/demo/service_runtime.py",
    "scripts/demo/mutinynet-smoke.py",
)


def announce(phase, **details):
    print(json.dumps({"phase": phase, **details}), flush=True)


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCE_FILES}


def balances(state):
    from protocol import asset_key

    result = {asset_key(item["asset"]): int(item["amount"]) for item in state["balances"]}
    assert len(result) == len(state["balances"]), "Duplicate asset balance"
    return result


def verify_transaction(tx, package, previews, previous_transactions):
    """Check the actual shared transaction, including its exact inputs and satoshi fee."""
    assert tx["txid"] == package["packageId"]
    assert tx.get("confirmations", 0) >= 1 and tx.get("blockhash")
    assert tx["vin"] and all(item.get("txinwitness") for item in tx["vin"])
    approved = [
        item for funding in package["payload"]["funding"].values() for item in funding["inputs"]
    ]
    inputs = [(item["txid"], item["vout"]) for item in tx["vin"]]
    assert len(inputs) == len(set(inputs)) == len(approved)
    assert set(inputs) == {(item["txid"], item["vout"]) for item in approved}
    input_sats = sum(
        Decimal(str(previous_transactions[txid]["vout"][vout]["value"])) * 100000000
        for txid, vout in inputs
    )
    output_sats = sum(Decimal(str(item["value"])) * 100000000 for item in tx["vout"])
    fee = input_sats - output_sats
    assert fee == int(fee) and fee >= 0
    assert fee == sum(int(review["preview"]["feeSats"]) for review in previews.values())
    return str(int(fee))


def verify_receipt(receipt, trade_id, txid):
    assert receipt["mode"] == "real" and receipt["network"] == NETWORK
    assert receipt["tradeId"] == trade_id and receipt["txid"] == txid
    assert receipt["state"] == "confirmed" and receipt["chainConfirmed"] and receipt["rgbAccepted"]


def start(runtime, recover=False):
    runtime.market()
    for person in PEOPLE:
        runtime.profile(person)
    runtime.ready(wallet_state=not recover)


def execute(runtime, state, scenario, manifest, prior_txid=None):
    from protocol import asset_key, save

    manifest.pop("tradeId", None)
    manifest.update(phase="publishing")
    save(state / "services/mutinynet-smoke.json", manifest)
    people = PEOPLE[:2] if scenario == "direct" else PEOPLE
    before = {person: runtime.local(person, "/state") for person in people}
    assets = {}
    for person, wallet in before.items():
        assert (
            wallet["network"] == NETWORK
            and wallet["mode"] == "real"
            and wallet["ownerId"] == person
        )
        for item in wallet["balances"]:
            asset = item["asset"]
            assert asset["network"] == NETWORK
            assert asset["symbol"] not in assets or assets[asset["symbol"]] == asset, (
                "Ambiguous asset ticker"
            )
            assets[asset["symbol"]] = asset
    specs = (
        [("alice", "BTC", "100000", "DUSD", "100"), ("bob", "DUSD", "100", "BTC", "100000")]
        if scenario == "direct"
        else [
            ("alice", "X", "100", "DUSD", "100"),
            ("bob", "DUSD", "100", "BTC", "100000"),
            ("carol", "BTC", "100000", "X", "100"),
        ]
    )
    if prior_txid:
        specs = [
            (person, receive, minimum, give, amount)
            for person, give, amount, receive, minimum in specs
        ]
    for person in people:
        snapshot = runtime.local(person, "/snapshot")
        assert all(trade["status"] == "CONFIRMED" for trade in snapshot["trades"]), (
            "Existing unresolved trade"
        )
        assert not any(order["status"] in ("OPEN", "RESERVED") for order in snapshot["orders"]), (
            "Existing active order"
        )
    orders = {}
    for person, give, amount, receive, minimum in specs:
        policy = runtime.local(person, "/policy")
        policy.update(allowBtcSale=give == "BTC", maxFeeSats="1000", protectedBalances={})
        if "KEEP" in assets:
            policy["protectedBalances"][asset_key(assets["KEEP"])] = str(
                balances(before[person]).get(asset_key(assets["KEEP"]), 0)
            )
        draft = {
            "giveAsset": assets[give],
            "giveAmount": amount,
            "receiveAsset": assets[receive],
            "minReceiveAmount": minimum,
            "maxFeeSats": "1000",
            "expiresAt": int(time.time() * 1000) + 3600000,
        }
        runtime.local(person, "/draft/validate", {"draft": draft, "policy": policy})
        orders[person] = runtime.local(
            person,
            "/orders",
            {"draft": draft, "policy": policy, "confirmed": True, "requestId": str(uuid.uuid4())},
        )
    matches = [
        trade
        for trade in runtime.local(people[0], "/snapshot")["trades"]
        if {ref["orderId"] for ref in trade["plan"]["orderRefs"]}
        == {order["id"] for order in orders.values()}
    ]
    assert len(matches) == 1
    trade = matches[0]
    trade_id = trade["plan"]["tradeId"]
    assert trade["plan"]["network"] == NETWORK and set(trade["plan"]["participants"]) == set(people)
    assert {
        (leg["fromOwnerId"], leg["asset"]["symbol"], leg["amount"]) for leg in trade["plan"]["legs"]
    } == {(person, give, amount) for person, give, amount, _, _ in specs}
    no_direct_pair = not any(
        a["ownerId"] != b["ownerId"]
        and asset_key(a["giveAsset"]) == asset_key(b["receiveAsset"])
        and asset_key(b["giveAsset"]) == asset_key(a["receiveAsset"])
        for a in orders.values()
        for b in orders.values()
    )
    assert scenario != "ring" or no_direct_pair
    directory = state / "services/runs" / trade_id
    manifest.update(tradeId=trade_id, phase="preparing")
    save(state / "services/mutinynet-smoke.json", manifest)
    save(directory / "before.json", before)
    save(directory / "orders.json", orders)
    announce("preparing", scenario=scenario, tradeId=trade_id)
    for _ in range(12):
        for person in people:
            trade = runtime.local(person, f"/trades/{trade_id}")
            if trade.get("settlementPackage"):
                break
            runtime.local(person, f"/trades/{trade_id}/prepare", {})
        if trade.get("settlementPackage"):
            break
    else:
        raise RuntimeError("Cooperative preparation did not finish; reservations retained")
    package = trade["settlementPackage"]
    assert package["network"] == NETWORK
    received = (
        {
            leg["fromOwnerId"]: any(
                item["txid"] == prior_txid
                for item in package["payload"]["funding"][leg["fromOwnerId"]]["inputs"]
            )
            for leg in trade["plan"]["legs"]
            if leg["asset"]["kind"] == "rgb"
        }
        if prior_txid
        else {}
    )
    assert not prior_txid or (received and all(received.values())), (
        "Repeat does not spend received RGB inputs"
    )
    previews = {
        person: runtime.local(person, f"/trades/{trade_id}/preview", {}) for person in people
    }
    assert all(
        review["preview"][key] == package[key]
        for review in previews.values()
        for key in ("packageId", "unsignedTxDigest", "commitmentDigest", "planDigest")
    )
    assert all(0 <= int(review["preview"]["feeSats"]) <= 1000 for review in previews.values())
    save(
        directory / "review.json",
        {
            "trade": trade,
            "previews": previews,
            "scenario": scenario,
            "priorTxid": prior_txid,
            "receivedInputs": received,
            "noDirectPair": no_direct_pair,
        },
    )
    assert hashes() == manifest["sourceHashes"], "Source changed before approval"
    manifest["phase"] = "signing-once"
    save(state / "services/mutinynet-smoke.json", manifest)
    announce("signing-once", scenario=scenario, tradeId=trade_id, txid=package["packageId"])
    for person in people:
        with (directory / f"mutinynet-approval-attempt-{person}.json").open("x") as marker:
            json.dump({"tradeId": trade_id, "packageId": package["packageId"]}, marker)
            marker.flush()
            os.fsync(marker.fileno())
        runtime.local(
            person,
            f"/trades/{trade_id}/approve",
            {"approvalToken": previews[person]["approvalToken"], "confirmed": True},
        )
    return trade_id


def settle(runtime, state, manifest, timeout):
    from protocol import read, save
    from regtest import rpc

    trade_id = manifest["tradeId"]
    directory = state / "services/runs" / trade_id
    saved = read(directory / "review.json")
    before = read(directory / "before.json")
    people = list(before)
    package = saved["trade"]["settlementPackage"]
    previews = saved["previews"]
    txid = package["packageId"]
    receipts = {}
    deadline = time.monotonic() + timeout
    while len(receipts) < len(people):
        for person in people:
            if person in receipts:
                continue
            # wallet.sync observes the approved tx; local /sync may resume signing and is deferred.
            receipt = runtime.wallet(person, "sync", {"tradeId": trade_id})
            assert receipt["mode"] == "real" and receipt["network"] == NETWORK
            assert receipt["tradeId"] == trade_id and receipt.get("txid") in (None, txid)
            if receipt["state"] == "confirmed":
                verify_receipt(receipt, trade_id, txid)
                receipts[person] = receipt
        announce(
            "waiting-for-bitcoin-and-rgb",
            tradeId=trade_id,
            txid=txid,
            acceptedParticipants=list(receipts),
        )
        if len(receipts) == len(people):
            break
        if time.monotonic() >= deadline:
            raise TimeoutError("Existing transaction unresolved; preserve state and use --resume")
        time.sleep(min(10, max(0, deadline - time.monotonic())))
    for person in people:
        verify_receipt(runtime.local(person, f"/trades/{trade_id}/sync", {}), trade_id, txid)
    tx = rpc("getrawtransaction", txid, True)
    previous = {item["txid"]: rpc("getrawtransaction", item["txid"], True) for item in tx["vin"]}
    fee = verify_transaction(tx, package, previews, previous)
    native_receipts = {}
    after = {person: runtime.local(person, "/state") for person in people}
    for person in people:
        assert balances(after[person]) == balances(
            {"balances": previews[person]["preview"]["balancesAfter"]}
        ), "Actual balances differ from immutable approved preview"
        raw = read(
            state
            / person
            / "trades"
            / hashlib.sha256(trade_id.encode()).hexdigest()
            / "receipt.json"
        )
        assert raw["txid"] == txid and raw["chainConfirmed"] and raw["rgbAccepted"]
        assert (
            raw["sdkAllocationIndexSynchronized"]
            and raw["btcBalanceDifferenceFromPreviewSats"] == "0"
        )
        native_receipts[person] = {
            key: raw[key]
            for key in (
                "txid",
                "chainConfirmed",
                "rgbAccepted",
                "sdkAllocationIndexSynchronized",
                "btcBalanceDifferenceFromPreviewSats",
            )
        }
    final = runtime.local(people[0], f"/trades/{trade_id}")
    assert final["status"] == "CONFIRMED"
    signatures = [
        item["ownerId"]
        for item in final["messages"]
        if item["message"]["type"] == "signature" and "signature" in item["message"]["payload"]
    ]
    assert sorted(signatures) == sorted(people)
    rounds = {
        person: [
            item["message"]["payload"]["material"]["stage"]
            for item in final["messages"]
            if item["ownerId"] == person and item["message"]["type"] == "prepare"
        ]
        for person in people
    }
    assert all(set(stages) == {"funding", "colored", "proofs"} for stages in rounds.values())
    result = {
        "mode": "real",
        "network": NETWORK,
        "profile": "mutinynet",
        "scenario": saved["scenario"],
        "tradeId": trade_id,
        "txid": txid,
        "marketStatus": final["status"],
        "participants": people,
        "sharedBitcoinTransactions": 1,
        "signatureOwners": signatures,
        "rounds": rounds,
        "commonCommitment": {
            key: package[key] for key in ("planDigest", "unsignedTxDigest", "commitmentDigest")
        },
        "nativeReceipts": native_receipts,
        "feeSats": fee,
        "balancesBefore": {
            person: {key: str(value) for key, value in balances(before[person]).items()}
            for person in people
        },
        "balancesAfter": {
            person: {key: str(value) for key, value in balances(after[person]).items()}
            for person in people
        },
        "core": {
            "confirmations": tx["confirmations"],
            "blockhash": tx["blockhash"],
            "vsize": tx["vsize"],
            "inputCount": len(tx["vin"]),
            "outputCount": len(tx["vout"]),
            "approvedInputSetMatches": True,
            "allInputsWitnessSigned": True,
        },
        "repeatReceivedInputs": saved["receivedInputs"],
        "priorTxid": saved["priorTxid"],
        "noDirectPair": saved["noDirectPair"],
    }
    save(directory / "mutinynet-evidence.json", result)
    return result


def selfcheck():
    """Synthetic verifier tests only; never presented as chain settlement evidence."""
    tx = {
        "txid": "swap",
        "confirmations": 1,
        "blockhash": "block",
        "vin": [{"txid": "fund", "vout": 0, "txinwitness": ["signature"]}],
        "vout": [{"value": "0.00009000"}],
    }
    package = {
        "packageId": "swap",
        "payload": {"funding": {"alice": {"inputs": [{"txid": "fund", "vout": 0}]}}},
    }
    previews = {"alice": {"preview": {"feeSats": "1000"}}}
    previous = {"fund": {"vout": [{"value": "0.00010000"}]}}
    assert verify_transaction(tx, package, previews, previous) == "1000"
    for patch in (
        {"txid": "other"},
        {"confirmations": 0},
        {"vin": [{"txid": "fund", "vout": 0}]},
        {"vout": [{"value": "0.00008999"}]},
    ):
        try:
            verify_transaction({**tx, **patch}, package, previews, previous)
        except AssertionError:
            pass
        else:
            raise AssertionError("Invalid transaction accepted")
    receipt = {
        "mode": "real",
        "network": NETWORK,
        "tradeId": "trade",
        "txid": "swap",
        "state": "confirmed",
        "chainConfirmed": True,
        "rgbAccepted": True,
    }
    verify_receipt(receipt, "trade", "swap")
    for patch in (
        {"mode": "mock"},
        {"network": "regtest"},
        {"rgbAccepted": False},
        {"chainConfirmed": False},
        {"txid": "other"},
    ):
        try:
            verify_receipt({**receipt, **patch}, "trade", "swap")
        except AssertionError:
            pass
        else:
            raise AssertionError("Invalid receipt accepted")
    announce("offline-selfcheck-passed", liveSettlementVerified=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--state",
        type=Path,
        help="Existing isolated Mutinynet test state; never an ordinary user profile",
    )
    parser.add_argument("--scenario", choices=("direct", "ring"))
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Authorize each fixture participant's exact reviewed test-network swap",
    )
    parser.add_argument(
        "--repeat",
        action="store_true",
        help="Reverse after restarting all services to prove received RGB can be spent",
    )
    parser.add_argument(
        "--resume",
        help="Observe this saved trade only; never replay approval or release reservations",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=900,
        help="Confirmation wait in seconds; timeout preserves all state",
    )
    parser.add_argument(
        "--selfcheck",
        action="store_true",
        help="Run offline verifier assertions, without wallet or network access",
    )
    args = parser.parse_args()
    if sys.flags.optimize:
        parser.error("Python optimization must be disabled so validation assertions run")
    if args.selfcheck:
        selfcheck()
        return
    if not shutil.which("rtk"):
        parser.error("Put rtk with proxy support on PATH before launching the service runner")
    if not args.state or not args.scenario or not 10 <= args.timeout <= 7200:
        parser.error("Provide --state, --scenario and --timeout between 10 and 7200")
    if bool(args.resume) == args.execute or (args.resume and args.repeat):
        parser.error("Use either --execute [--repeat] or --resume TRADE_ID")
    if os.environ.get("PALKA_NETWORK") not in ("mutinynet", NETWORK):
        parser.error("Explicit PALKA_NETWORK=mutinynet is required")
    if os.environ.get("RGB_SERVICE_SOURCE") or os.environ.get("PALKA_CHAIN_CONFIG"):
        parser.error("Source override and shared regtest configuration are forbidden")
    state = args.state.resolve()
    parent = (ROOT / "packages/wallet/state/mutinynet").resolve()
    if (
        state == parent
        or not state.is_relative_to(parent)
        or not all((state / person / "keys.json").is_file() for person in PEOPLE)
    ):
        parser.error(
            "Use an existing dedicated three-wallet directory under packages/wallet/state/mutinynet"
        )
    subprocess.run(
        ["rtk", "proxy", "git", "check-ignore", "--quiet", str(state)], cwd=ROOT, check=True
    )
    os.umask(0o077)
    os.environ.update(RGB_DEMO_STATE=str(state), PALKA_NETWORK="mutinynet", MARKET_NETWORK=NETWORK)
    import chain_profile
    from service_runtime import Runtime, configure

    from protocol import read, save
    from regtest import native, rpc

    (state / "services").mkdir(exist_ok=True)
    with (state / "services/mutinynet-smoke.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        marker = state / "services/mutinynet-smoke.json"
        manifest = read(marker) if marker.exists() else {}
        if args.resume:
            if (
                manifest.get("tradeId") != args.resume
                or manifest.get("scenario") != args.scenario
                or manifest.get("complete")
            ):
                parser.error("Resume must name the currently unresolved fixture trade")
        elif manifest and not manifest.get("complete"):
            parser.error(
                "Previous attempt is unresolved; preserve its state and resume its exact transaction"
            )
        for port in (4110, 4131, 4132, 4133, 4231, 4232, 4233):
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
        chain = chain_profile.check_chain()
        assert rpc("getindexinfo").get("txindex", {}).get("synced") is True
        assert native("health")["network"] == NETWORK
        for person in PEOPLE:
            assert native("identity", person)["network"] == NETWORK
        config = configure(ROOT, 4110)
        desired_ports = {
            person: (4131 + index, 4231 + index) for index, person in enumerate(PEOPLE)
        }
        for person, (local_port, wallet_port) in desired_ports.items():
            config["profiles"][person].update(localPort=local_port, walletPort=wallet_port)
        save(state / "services/config.json", config)
        evidence_path = state / "services/mutinynet-evidence.json"
        if not args.resume:
            manifest = {
                "scenario": args.scenario,
                "complete": False,
                "phase": "publishing",
                "sourceHashes": hashes(),
                "runs": [],
                "expectedRuns": 2 if args.repeat else 1,
                "network": NETWORK,
                "checkpoint": chain_profile.MUTINYNET_CHECKPOINT,
                "startingHeight": chain["blocks"],
                "qvac": "not invoked; manual fixture drafts",
            }
            save(marker, manifest)
        runtime = Runtime()
        try:
            start(runtime, recover=bool(args.resume))
            if not args.resume:
                execute(runtime, state, args.scenario, manifest)
            result = settle(runtime, state, manifest, args.timeout)
            manifest["runs"] = [
                run for run in manifest["runs"] if run["tradeId"] != result["tradeId"]
            ]
            manifest["runs"].append(result)
            save(marker, manifest)
            if args.repeat:
                identities = {
                    person: runtime.local(person, "/state")["walletId"] for person in PEOPLE
                }
                stable_balances = {
                    person: balances(runtime.local(person, "/state")) for person in PEOPLE
                }
                runtime.close()
                runtime = Runtime()
                start(runtime)
                assert identities == {
                    person: runtime.local(person, "/state")["walletId"] for person in PEOPLE
                }
                assert stable_balances == {
                    person: balances(runtime.local(person, "/state")) for person in PEOPLE
                }
                first = manifest["runs"][-1]
                assert (
                    runtime.local("alice", f"/trades/{first['tradeId']}")["status"] == "CONFIRMED"
                )
                manifest["restart"] = {
                    "walletIdentitiesPreserved": True,
                    "balancesPreserved": True,
                    "confirmedTradePreserved": True,
                }
                execute(runtime, state, args.scenario, manifest, prior_txid=first["txid"])
                manifest["runs"].append(settle(runtime, state, manifest, args.timeout))
            assert hashes() == manifest["sourceHashes"], "Source changed during validation"
            assert len(manifest["runs"]) == manifest["expectedRuns"], (
                "Existing transaction confirmed; requested repeat remains unverified"
            )
            assert len({run["txid"] for run in manifest["runs"]}) == manifest["expectedRuns"]
            manifest.update(complete=True, phase="confirmed")
            save(marker, manifest)
            save(evidence_path, manifest)
            public = (
                ROOT
                / "scripts/demo/evidence"
                / f"mutinynet-{args.scenario}-{manifest['tradeId']}.json"
            )
            save(public, manifest)
            announce(
                "complete",
                evidence=str(public.relative_to(ROOT)),
                txids=[run["txid"] for run in manifest["runs"]],
            )
        except BaseException as error:
            manifest.update(
                complete=False, errorType=type(error).__name__, haltedWithoutApprovalRetry=True
            )
            save(marker, manifest)
            save(evidence_path, manifest)
            (state / "services/mutinynet-failure.log").write_text(traceback.format_exc())
            announce(
                "halted-preserving-state",
                errorType=type(error).__name__,
                tradeId=manifest.get("tradeId"),
                liveSettlementVerified=False,
            )
            raise SystemExit(1) from None
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
