#!/usr/bin/env python3
"""Ordinary SDK/proxy transfer, not an atomic swap. Local regtest only."""
import argparse
from contextlib import ExitStack
import fcntl
import json
import os
import time
from regtest import ROOT, STATE, native, rpc


def save(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as output:
        json.dump(value, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def btc(state):
    return sum(int(part["settled"]) for part in state["btc"].values())


def run(command, approved):
    if rpc("getblockchaininfo")["chain"] != "regtest":
        raise ValueError("regtest only")
    review_path = STATE / "bob/smoke-review.json"
    if command == "prepare":
        contracts = json.loads((STATE / "alice/issued-X.json").read_text())
        contract = contracts["asset_id"]
        invoice = native("smoke-receive", "carol", contractId=contract)
        review = native("smoke-prepare", "bob", contractId=contract, recipientId=invoice["recipient_id"])
        print(json.dumps({"review": str(review_path), **{k: review[k] for k in
            ("txid", "approvalDigest", "amount", "feeSats", "recipientBtcSats")}}, indent=2))
        return
    review = json.loads(review_path.read_text())
    if approved != review["approvalDigest"]:
        raise ValueError("exact prepared intent digest required")
    txid = review["txid"]
    # Lookups may fail for an unbroadcast transaction. Never infer that an
    # unsuccessful lookup permits discarding or changing the saved signature.
    try:
        tx = rpc("getrawtransaction", txid, True)
    except RuntimeError:
        tx = None
    before_path = STATE / "smoke-before.json"
    if not before_path.exists():
        if tx is not None:
            raise ValueError("missing pre-transfer evidence; cannot reconstruct deltas")
        save(before_path, {p: native("state", p) for p in ("bob", "carol")})
    before = json.loads(before_path.read_text())
    if tx is None:
        native("smoke-execute", "bob", approved=True, approvalDigest=approved)
        tx = rpc("getrawtransaction", txid, True)
    if tx.get("confirmations", 0) < 1:
        address = rpc("-rpcwallet=regtest-miner", "getnewaddress")
        rpc("generatetoaddress", 1, address)
    for attempt in range(30):
        for profile in ("bob", "carol"):
            native("smoke-refresh", profile)
        history = {p: [t for t in native("history", p) if t["txid"] == txid]
                   for p in ("bob", "carol")}
        if all(rows and all(t["status"] == "Settled" for t in rows) for rows in history.values()):
            break
        time.sleep(1)
    else:
        raise RuntimeError("SDK transfer has not settled at both wallets")
    after = {p: native("state", p) for p in ("bob", "carol")}
    expected, actual = {}, {}
    for profile, sign in (("bob", -1), ("carol", 1)):
        native("check-index", profile)
        ids = set(before[profile]["stockBalances"]) | set(after[profile]["stockBalances"])
        expected[profile] = {"BTC": str(sign * 1000 - (int(review["feeSats"]) if sign < 0 else 0)),
            **{asset: str(sign if asset == review["contractId"] else 0) for asset in sorted(ids)}}
        actual[profile] = {"BTC": str(btc(after[profile]) - btc(before[profile])),
            **{asset: str(int(after[profile]["stockBalances"].get(asset, 0)) -
                         int(before[profile]["stockBalances"].get(asset, 0))) for asset in sorted(ids)}}
    if expected != actual:
        raise ValueError("actual SDK transfer deltas differ from prepared intent")
    used_proxy = any(endpoint["used"] for transfer in history["carol"]
                     for endpoint in transfer["transport_endpoints"])
    if not used_proxy:
        raise ValueError("recipient did not use SDK proxy transport")
    evidence = {"network": "regtest", "kind": "ordinary-rgb-send-not-swap", "txid": txid,
        "feeSats": review["feeSats"], "sdkProxyTransportUsed": True,
        "bothSdkHistoriesSettled": True, "sdkAllocationIndexSynchronized": True,
        "expectedDeltas": expected, "actualDeltas": actual}
    save(STATE / "smoke-after.json", after)
    save(ROOT / "scripts/demo/evidence/sdk-smoke.json", evidence)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["prepare", "execute"])
    parser.add_argument("--approve", help="immutable prepared intent digest; development authorization is standing")
    args = parser.parse_args()
    os.umask(0o077)
    with ExitStack() as stack:
        for profile in ("bob", "carol"):
            lock = stack.enter_context((STATE / profile / ".coordinator.lock").open("a"))
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(args.command, args.approve)
