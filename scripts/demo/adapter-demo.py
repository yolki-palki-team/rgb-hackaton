#!/usr/bin/env python3
"""Real HTTP sidecar integration: prepare for review, then execute only an approved digest."""

import argparse
import fcntl
import json
import secrets
import sys
import threading
import time
import urllib.request
import uuid
from contextlib import contextmanager

from regtest import ROOT, STATE, rpc

sys.path.insert(0, str(ROOT / "packages/wallet"))
from protocol import Backend, asset_key, digest, read, save, sha
from server import create_server


@contextmanager
def clients(people):
    servers = []
    locks = []
    result = {}
    try:
        for p in people:
            backend = Backend(p)
            lock = (backend.root / ".coordinator.lock").open("a")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locks.append(lock)
            token = secrets.token_hex(32)
            server = create_server(backend, token, 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            servers.append(server)

            def call(
                method, params=None, url=f"http://127.0.0.1:{server.server_port}/rpc", token=token
            ):
                body = json.dumps(
                    {
                        "protocolVersion": 1,
                        "requestId": str(uuid.uuid4()),
                        "method": method,
                        "params": params or {},
                    }
                ).encode()
                req = urllib.request.Request(
                    url,
                    body,
                    {"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=60) as response:
                    envelope = json.load(response)
                if "error" in envelope:
                    raise RuntimeError(f"{method}: {envelope['error']['code']}")
                return envelope["result"]

            result[p] = call
        yield result
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        for lock in locks:
            lock.close()


def prepare(scenario, reverse, trade_id):
    people = ["alice", "bob"] if scenario == "direct" else ["alice", "bob", "carol"]
    directory = STATE / "adapter-runs" / sha(trade_id.encode())
    with clients(people) as wallets:
        states = {p: wallets[p]("state") for p in people}
        assets = {
            b["asset"]["symbol"]: b["asset"] for state in states.values() for b in state["balances"]
        }

        def leg(sender, receiver, ticker, amount):
            return {
                "fromOwnerId": sender,
                "toOwnerId": receiver,
                "asset": assets[ticker],
                "amount": amount,
            }

        if scenario == "direct":
            legs = (
                [leg("alice", "bob", "DUSD", "100"), leg("bob", "alice", "BTC", "100000")]
                if reverse
                else [leg("alice", "bob", "BTC", "100000"), leg("bob", "alice", "DUSD", "100")]
            )
        else:
            legs = (
                [
                    leg("alice", "carol", "DUSD", "100"),
                    leg("carol", "bob", "X", "100"),
                    leg("bob", "alice", "BTC", "100000"),
                ]
                if reverse
                else [
                    leg("alice", "carol", "X", "100"),
                    leg("carol", "bob", "BTC", "100000"),
                    leg("bob", "alice", "DUSD", "100"),
                ]
            )
        if (directory / "plan.json").exists():
            plan = read(directory / "plan.json")
        else:
            n = len(people)
            plan = {
                "protocolVersion": 1,
                "tradeId": trade_id,
                "revision": 0,
                "network": "regtest",
                "participants": people,
                "orderRefs": [{"orderId": trade_id + "-" + p, "revision": 1} for p in people],
                "legs": legs,
                "fees": [
                    {"ownerId": p, "feeSats": str(1000 // n + (1000 % n if i == n - 1 else 0))}
                    for i, p in enumerate(people)
                ],
                "feeState": "final",
                "createdAt": int(time.time() * 1000),
            }
            plan["digest"] = digest(plan)
            save(directory / "plan.json", plan)
        materials = []
        packages = {}
        for _round_index in range(8):
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
        else:
            raise RuntimeError("cooperative rounds did not finish")
        package = packages[people[0]]
        if any(p != package for p in packages.values()):
            raise RuntimeError("wallets disagree on final package")
        previews = {p: wallets[p]("validate", {"package": package, "plan": plan}) for p in people}
        review = {
            "scenario": scenario,
            "reverse": reverse,
            "plan": plan,
            "package": package,
            "previews": previews,
            "before": states,
            "transport": "authenticated-loopback-http-v1",
            "signed": False,
        }
        review["approvalDigest"] = digest(review)
        save(directory / "review.json", review)
        print(
            json.dumps(
                {
                    "review": str(directory / "review.json"),
                    "approvalDigest": review["approvalDigest"],
                    "txid": package["packageId"],
                    "legs": plan["legs"],
                    "btcDeltas": {p: previews[p]["btcDelta"] for p in people},
                    "signed": False,
                },
                indent=2,
            )
        )


def execute(trade_id, approved):
    directory = STATE / "adapter-runs" / sha(trade_id.encode())
    review = read(directory / "review.json")
    if (
        not approved
        or approved != review["approvalDigest"]
        or approved != digest({k: v for k, v in review.items() if k != "approvalDigest"})
    ):
        raise ValueError("explicit approval of this exact HTTP-adapter review required")
    plan = review["plan"]
    package = review["package"]
    people = plan["participants"]
    with clients(people) as wallets:
        signatures = []
        for p in people:
            preview = review["previews"][p]
            approval = {
                "protocolVersion": 1,
                "approvalId": approved + "-" + p,
                "walletId": preview["walletId"],
                "ownerId": p,
                "network": "regtest",
                "tradeId": trade_id,
                "planRevision": plan["revision"],
                "approvedAt": int(time.time() * 1000),
                **{
                    k: package[k]
                    for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
                },
            }
            # Exact replay of a completed/uncertain signing request. The backend
            # treats the original Approval, including its timestamp, as immutable.
            authorization = STATE / p / "trades" / sha(trade_id.encode()) / "user-approval.json"
            if authorization.exists():
                original = read(authorization)
                if any(original.get(k) != v for k, v in approval.items() if k != "approvedAt"):
                    raise ValueError("saved approval differs from this reviewed CLI authorization")
                approval = original
            signed = wallets[p]("sign", {"package": package, "approval": approval})
            signatures.append({"ownerId": p, "signature": signed["signature"]})
        save(directory / "signatures.json", signatures)
    # Restart every sidecar after signatures are durably released, before broadcast.
    with clients(people) as wallets:
        receipt = wallets[people[0]]("finalize", {"package": package, "signatures": signatures})
        tx = rpc("getrawtransaction", package["packageId"], True)
        if tx.get("confirmations", 0) < 1:
            miner = rpc("-rpcwallet=regtest-miner", "getnewaddress")
            rpc("generatetoaddress", 1, miner)
        receipts = {}
        for p in people:
            for _attempt in range(30):
                receipt = wallets[p]("sync", {"tradeId": trade_id})
                if receipt["state"] == "confirmed":
                    break
                time.sleep(1)
            else:
                raise RuntimeError(f"{p}: chain/RGB reconciliation incomplete")
            receipts[p] = receipt
        after = {p: wallets[p]("state") for p in people}
        changes = {}
        for p in people:
            before = {
                asset_key(b["asset"]): int(b["amount"]) for b in review["before"][p]["balances"]
            }
            actual = {asset_key(b["asset"]): int(b["amount"]) for b in after[p]["balances"]}
            expected = {
                asset_key(b["asset"]): int(b["amount"])
                for b in review["previews"][p]["balancesAfter"]
            }
            if actual != expected:
                raise RuntimeError("actual balance mismatch")
            changes[p] = {k: str(v - before.get(k, 0)) for k, v in actual.items()}
        evidence = {
            "network": "regtest",
            "txid": package["packageId"],
            "scenario": review["scenario"],
            "tradeId": trade_id,
            "transport": review["transport"],
            "restartAfterSignature": True,
            "approvalDigest": approved,
            "receipts": receipts,
            "actualDeltas": changes,
            "sdkAllocationIndexSynchronized": True,
        }
        save(directory / "evidence.json", evidence)
        print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "execute"])
    parser.add_argument("--scenario", choices=["direct", "ring"], default="ring")
    parser.add_argument("--reverse", action="store_true")
    parser.add_argument("--trade-id", required=True)
    parser.add_argument("--approve")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.scenario, args.reverse, args.trade_id)
    else:
        execute(args.trade_id, args.approve)
