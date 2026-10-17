#!/usr/bin/env python3
"""Resume an existing mined trade through local-client sync; never create/sign another trade."""
import argparse
import json
import time
from service_runtime import Runtime, PEOPLE, STATE, ROOT, save, read
from protocol import asset_key, sha

parser = argparse.ArgumentParser()
parser.add_argument("--trade-id", required=True)
args = parser.parse_args()
runtime = Runtime()
try:
    runtime.market()
    for p in PEOPLE: runtime.profile(p)
    runtime.ready(wallet_state=False)
    trade = runtime.local("alice", f"/trades/{args.trade_id}")
    people = trade["plan"]["participants"]
    evidence = {"tradeId": args.trade_id, "txid": trade["settlementPackage"]["packageId"], "newSignature": False, "newTrade": False, "receipts": {}}
    for p in people:
        for _ in range(20):
            receipt = runtime.local(p, f"/trades/{args.trade_id}/sync", {})
            if receipt["state"] == "confirmed": break
            time.sleep(.5)
        assert receipt["state"] == "confirmed", p
        evidence["receipts"][p] = receipt
    evidence["marketStatus"] = runtime.local("alice", f"/trades/{args.trade_id}")["status"]
    assert evidence["marketStatus"] == "CONFIRMED"
    evidence["btcDifferenceFromPreviewSats"] = {p: read(STATE / p / "trades" / sha(args.trade_id.encode()) / "receipt.json").get("btcBalanceDifferenceFromPreviewSats", "0") for p in people}
    save(ROOT / "scripts/demo/evidence/service-resumed.json", evidence)
    print(json.dumps(evidence))
finally: runtime.close()
