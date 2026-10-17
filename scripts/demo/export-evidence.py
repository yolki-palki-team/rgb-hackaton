#!/usr/bin/env python3
"""Export an allowlist of public test evidence; never copy wallet state or keys."""

import json

from regtest import ROOT, STATE, rpc


def main():
    report = json.loads((STATE / "review.json").read_text())
    evidence = json.loads((STATE / "settlement-evidence.json").read_text())
    scenario = report["scenario"]
    if scenario not in ("direct", "ring") or evidence["txid"] != report["candidateTxid"]:
        raise RuntimeError("unexpected evidence")
    tx = rpc("getrawtransaction", evidence["txid"], True)
    if not evidence["confirmed"] or tx.get("confirmations", 0) < 1:
        raise RuntimeError("transaction not confirmed")
    contracts = {v["ticker"]: v["contractId"] for v in report["validations"]}
    expected_rgb = {"alice": {"DUSD": 100}, "bob": {"DUSD": -100}}
    if scenario == "ring":
        expected_rgb["alice"].update(X=-100, KEEP=0)
        expected_rgb["carol"] = {"X": 100}
    participants = {}
    for review in report["reviews"]:
        profile = review["profile"]
        receipt = evidence["receipts"][profile]
        if not receipt["chainConfirmed"] or not receipt["rgbAccepted"]:
            raise RuntimeError("incomplete receipt")
        actual_btc = receipt["actualBtcDeltaSats"]
        if actual_btc != review["expectedBtcDeltaSats"]:
            raise RuntimeError("BTC delta mismatch")
        rgb = {}
        for ticker, expected in expected_rgb[profile].items():
            contract = contracts[ticker]
            before = int(report["before"][profile]["stockBalances"].get(contract, "0"))
            after = int(receipt["stockBalances"].get(contract, "0"))
            if after - before != expected:
                raise RuntimeError(f"RGB delta mismatch: {profile}/{ticker}")
            rgb[ticker] = {"expectedDelta": str(expected), "actualDelta": str(after - before)}
            if ticker == "KEEP":
                if after != 7:
                    raise RuntimeError("KEEP not preserved")
                rgb[ticker]["preservedAmount"] = "7"
        participants[profile] = {
            "expectedBtcDeltaSats": review["expectedBtcDeltaSats"],
            "actualBtcDeltaSats": actual_btc,
            "rgb": rgb,
            "chainConfirmed": True,
            "rgbAccepted": True,
            "sdkAllocationIndexSynchronized": receipt["sdkAllocationIndexSynchronized"],
        }
    public = {
        "network": "regtest",
        "scenario": scenario,
        "mode": "real-local-sdk-extension",
        "txid": evidence["txid"],
        "blockHash": tx["blockhash"],
        "confirmationsAtExport": tx["confirmations"],
        "transactionCount": 1,
        "approvalDigest": report["approvalDigest"],
        "feeSats": report["feeSats"],
        "contracts": contracts,
        "participants": participants,
        "preSignatureRgbValidations": [
            {k: v[k] for k in ("receiver", "ticker", "contractId", "amount", "valid", "signed")}
            for v in report["validations"]
        ],
        "productionAdapterEnabled": False,
    }
    output = ROOT / "scripts/demo/evidence" / f"{scenario}.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(public, indent=2) + "\n")
    print(json.dumps({"output": str(output), "txid": evidence["txid"], "verified": True}))


if __name__ == "__main__":
    main()
