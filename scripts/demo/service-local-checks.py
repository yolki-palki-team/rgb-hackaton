#!/usr/bin/env python3
"""Real QVAC inference and local policy rejection through the actual paired API."""

import copy
import json

from service_runtime import ROOT, Runtime, save

runtime = Runtime()
evidence = {"mode": "real", "network": "regtest", "published": False, "signed": False}
try:
    runtime.market()
    runtime.profile("alice")
    runtime.ready(["alice"])
    health = runtime.local("alice", "/health")
    assert (
        health["wallet"]["directSwap"]
        and health["wallet"]["ringSwap"]
        and health["wallet"]["signing"]
    )
    evidence["walletCapabilities"] = health["wallet"]
    state = runtime.local("alice", "/state")
    assets = {b["asset"]["symbol"]: b["asset"] for b in state["balances"]}
    # Synthetic task goal, no keys or portfolio passed to the model.
    try:
        result = runtime.local(
            "alice",
            "/interpret",
            {"goal": "Отдаю 10 X за минимум 10 DUSD. BTC не продавать. Комиссия до 1000 sats."},
        )
        assert (
            result["draft"]
            and result["draft"]["giveAsset"] == assets["X"]
            and result["draft"]["receiveAsset"] == assets["DUSD"]
        )
        assert result["draft"]["giveAmount"] == "10" and result["draft"]["minReceiveAmount"] == "10"
        assert result["policy"]["allowBtcSale"] is False and result["draft"]["maxFeeSats"] == "1000"
        assert result["diagnostics"]["provider"] == "qvac"
        runtime.local(
            "alice", "/draft/validate", {"draft": result["draft"], "policy": result["policy"]}
        )
        evidence["qvac"] = {
            "actualInference": True,
            "validatedDraft": True,
            "diagnostics": result["diagnostics"],
        }
    except (RuntimeError, AssertionError) as error:
        evidence["qvac"] = {"actualInference": False, "error": str(error)}
    import time

    draft = {
        "giveAsset": assets["X"],
        "giveAmount": "10",
        "receiveAsset": assets["DUSD"],
        "minReceiveAmount": "10",
        "maxFeeSats": "1000",
        "expiresAt": int(time.time() * 1000) + 600000,
    }
    policy = runtime.local("alice", "/policy")
    policy.update(allowBtcSale=False, protectedBalances={}, maxFeeSats="1000")
    cases = {}
    for name in (
        "fee-limit",
        "protected-balance",
        "btc-sale-forbidden",
        "expired-order",
        "unverified-contract",
    ):
        d, p = copy.deepcopy(draft), copy.deepcopy(policy)
        if name == "fee-limit":
            d["maxFeeSats"] = "1001"
        if name == "protected-balance":
            from protocol import asset_key

            p["protectedBalances"][asset_key(assets["X"])] = "100"
        if name == "btc-sale-forbidden":
            d["giveAsset"] = assets["BTC"]
        if name == "expired-order":
            d["expiresAt"] = int(time.time() * 1000) - 1
        if name == "unverified-contract":
            d["giveAsset"]["contractId"] = "rgb:unverified-integration-negative"
        try:
            runtime.local("alice", "/draft/validate", {"draft": d, "policy": p})
        except RuntimeError:
            cases[name] = "rejected"
        else:
            raise AssertionError("Invalid draft accepted: " + name)
    evidence["policyRejections"] = cases
    save(ROOT / "scripts/demo/evidence/service-local-checks.json", evidence)
    print(json.dumps(evidence), flush=True)
finally:
    runtime.close()
