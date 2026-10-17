#!/usr/bin/env python3
"""Attack the real HTTP approval boundary without authorizing another signature."""

import copy
import importlib.util
import json

from regtest import ROOT, STATE

spec = importlib.util.spec_from_file_location("adapter_demo", ROOT / "scripts/demo/adapter-demo.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)
# Loading the demo above adds packages/wallet to the import path.
from protocol import read, save, sha  # noqa: E402


def main():
    trade = "adapter-ring-repeat-v1"
    review = read(STATE / "adapter-runs" / sha(trade.encode()) / "review.json")
    package = review["package"]
    preview = review["previews"]["alice"]
    sigfile = STATE / "alice/trades" / sha(trade.encode()) / "released-signature.psbt"
    before = sha(sigfile.read_bytes())
    results = []
    approval = {
        "protocolVersion": 1,
        "approvalId": "invalid-unit-approval",
        "walletId": preview["walletId"],
        "ownerId": "alice",
        "network": "regtest",
        "tradeId": trade,
        "planRevision": review["plan"]["revision"],
        "approvedAt": 1,
        **{
            k: package[k]
            for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
        },
    }
    with demo.clients(["alice"]) as wallets:

        def reject(name, method, params):
            try:
                wallets["alice"](method, params)
            except RuntimeError:
                results.append({"check": name, "rejected": True})
            else:
                raise AssertionError(name + " was accepted")

        for key, value in [
            ("walletId", "foreign"),
            ("ownerId", "bob"),
            ("network", "mainnet"),
            ("planRevision", 999),
            ("planDigest", "0" * 64),
            ("unsignedTxDigest", "0" * 64),
            ("commitmentDigest", "0" * 64),
            ("packageId", "0" * 64),
        ]:
            reject(
                "approval binding " + key,
                "sign",
                {"package": package, "approval": {**approval, key: value}},
            )
        changed = copy.deepcopy(package)
        changed["payload"]["final"]["psbt"] = "tampered"
        reject("changed final PSBT", "sign", {"package": changed, "approval": approval})
        changed = copy.deepcopy(package)
        changed["payload"]["proofs"][0]["amount"] = "101"
        reject("changed RGB amount", "sign", {"package": changed, "approval": approval})
        reject("release after signature", "release", {"tradeId": trade})
        reject("reprepare after confirmation", "prepare", {"plan": review["plan"], "materials": []})
    if sha(sigfile.read_bytes()) != before:
        raise AssertionError("released signature changed")
    report = {
        "mode": "real-http-adapter",
        "signed": False,
        "existingSignatureUnchanged": True,
        "checks": results,
    }
    save(ROOT / "scripts/demo/evidence/adapter-negative.json", report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
