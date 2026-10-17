#!/usr/bin/env python3
"""Real SDK negative checks; never produces signatures or broadcasts."""

import copy
import json

from regtest import STATE, native


def main():
    package = json.loads((STATE / "ring-unsigned.json").read_text())
    reports = []

    def rejected(name, op, profile=None, **kwargs):
        try:
            native(op, profile, **kwargs)
        except RuntimeError as error:
            reports.append({"check": name, "rejected": True, "error": str(error)})
        else:
            raise AssertionError(f"{name}: unexpectedly accepted")

    consignment = next(c for c in package["consignments"] if c["ticker"] == "DUSD")
    request = {k: v for k, v in consignment.items() if k not in ("ticker", "receiver")}
    rejected("non-matching RGB amount 101", "validate", "alice", **{**request, "amount": "101"})
    x = next(c for c in package["consignments"] if c["ticker"] == "X")
    rejected("wrong contract", "validate", "alice", **{**request, "contractId": x["contractId"]})
    rejected("corrupt consignment", "validate", "alice", **{**request, "consignment": "YWJj"})
    rejected(
        "wrong receiver address",
        "validate",
        "alice",
        **{**request, "address": package["outputs"][1]["address"]},
    )
    rejected("valid output owned by another wallet", "validate", "carol", **request)
    assignments = copy.deepcopy(package["assignments"]["alice"])
    keep = next(c["contractId"] for c in package["consignments"] if c["ticker"] == "KEEP")
    del assignments[keep]
    rejected(
        "omitted unrelated KEEP allocation",
        "color",
        "alice",
        psbt=package["base"]["psbt"],
        assignments=assignments,
    )
    for change in ("fee", "receiver"):
        outputs = copy.deepcopy(package["outputs"])
        if change == "fee":
            outputs[5]["amountSats"] = str(int(outputs[5]["amountSats"]) - 1)
        else:
            outputs[0]["address"] = outputs[1]["address"]
        base = native("build", inputs=package["inputs"], outputs=outputs)
        rejected(
            f"changed {change} after contribution",
            "merge",
            basePsbt=base["psbt"],
            contributions=[c["psbt"] for c in package["contributions"].values()],
        )
        rejected(
            f"consignment bound to original transaction after {change} tamper",
            "validate",
            "alice",
            **{**request, "psbt": base["psbt"]},
        )
    rejected(
        "duplicate input",
        "build",
        inputs=package["inputs"] + [package["inputs"][0]],
        outputs=package["outputs"],
    )
    for value in ("1e3", "-1", "1.5", "18446744073709551616"):
        outputs = copy.deepcopy(package["outputs"])
        outputs[0]["amountSats"] = value
        rejected(
            f"invalid atomic amount {value}", "build", inputs=package["inputs"], outputs=outputs
        )
    rejected("unapproved signing disabled", "sign", "alice", approvalDigest="stale")
    rejected("stale explicit approval", "sign", "alice", approved=True, approvalDigest="stale")
    report = {
        "network": "regtest",
        "mode": "real-sdk-negative-checks",
        "signed": False,
        "checks": reports,
    }
    (STATE / "negative-checks.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
