#!/usr/bin/env python3
"""Real regtest setup. No wallet signing: funding uses mature coinbase outputs."""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

from wallet_lifecycle import run_native

ROOT = Path(__file__).resolve().parents[2]
STATE = Path(os.environ.get("RGB_DEMO_STATE", str(ROOT / "packages/wallet/state"))).resolve()
if not STATE.is_relative_to(ROOT / "packages/wallet/state"):
    raise RuntimeError("demo state must remain in ignored packages/wallet/state")
BIN = ROOT / "packages/wallet/native/target/debug/rgb-settlement-spike"
COMPOSE = ["docker", "compose", "-f", str(ROOT / "infra/compose.yaml")]


def call(args, **kwargs):
    p = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if p.returncode:
        raise RuntimeError(p.stderr.strip() or "command failed")
    return p.stdout


def rpc(*args):
    if os.environ.get("PALKA_CHAIN_CONFIG"):
        from chain_transport import Client

        return Client.from_env().request("/rpc", {"method": args[0], "params": list(args[1:])})
    encoded = [json.dumps(a) if isinstance(a, (bool, list, dict)) else str(a) for a in args]
    raw = call(
        COMPOSE + ["exec", "-T", "-u", "blits", "bitcoind", "bitcoin-cli", "-regtest", *encoded]
    ).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def native(op, profile=None, **kwargs):
    result = run_native(
        [str(BIN)],
        input=json.dumps({"op": op, "stateDir": str(STATE), "profile": profile, **kwargs}),
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "native operation failed")
    return json.loads(result.stdout)


def setup():
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    chain = rpc("getblockchaininfo")
    if chain["chain"] != "regtest":
        raise RuntimeError("regtest required")
    profiles = [native("init", p) for p in ("alice", "bob", "carol")]
    marker = STATE / "funding.json"
    if not marker.exists():
        started = STATE / "funding-started.json"
        if started.exists():
            raise RuntimeError(
                "Interrupted funding: inspect recorded starting height before retrying"
            )
        started.write_text(json.dumps({"startingHeight": chain["blocks"]}))
        blocks = []
        for p in profiles:
            for key in ("btcAddress", "rgbAddress"):
                blocks.extend(rpc("generatetoaddress", 1, p[key]))
        # Maturation blocks belong to a separate miner. Otherwise each newly
        # mined swap block also changes Carol's settled balance independently.
        miners = rpc("listwallets")
        if "regtest-miner" not in miners:
            existing = {w["name"] for w in rpc("listwalletdir")["wallets"]}
            rpc("loadwallet" if "regtest-miner" in existing else "createwallet", "regtest-miner")
        miner = rpc("-rpcwallet=regtest-miner", "getnewaddress")
        blocks.extend(rpc("generatetoaddress", 101, miner))
        marker.write_text(json.dumps({"network": "regtest", "blocks": blocks}, indent=2))
    # Electrs readiness is verified by querying SDK state, not by sleeping a fixed duration.
    for p in profiles:
        for attempt in range(30):
            try:
                state = native("state", p["profile"])
                if any(u["utxo"]["colorable"] for u in state["unspents"]):
                    break
            except RuntimeError:
                if attempt == 29:
                    raise
            time.sleep(1)
        else:
            raise RuntimeError("indexer has not exposed colored UTXO")
    issued = {}
    for profile, ticker, amount in [
        ("alice", "X", "100"),
        ("alice", "KEEP", "7"),
        ("bob", "DUSD", "100"),
    ]:
        issued[ticker] = native("issue", profile, ticker=ticker, amount=amount)
    print(
        json.dumps(
            {
                "network": "regtest",
                "signed": False,
                "funding": "coinbase",
                "height": rpc("getblockcount"),
                "issued": issued,
            },
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["setup", "status", "capabilities"])
    args = parser.parse_args()
    if args.command == "setup":
        setup()
    elif args.command == "capabilities":
        print(json.dumps(native("capabilities"), indent=2))
    else:
        print(
            json.dumps(
                {
                    "chain": rpc("getblockchaininfo"),
                    "profiles": [native("state", p) for p in ("alice", "bob", "carol")],
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
