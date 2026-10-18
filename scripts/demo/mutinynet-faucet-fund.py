#!/usr/bin/env python3
"""Fund three fresh Mutinynet profiles once through the official faucet."""

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from chain_profile import MUTINYNET_CHALLENGE

FAUCET = "https://faucet.mutinynet.com"
STATE_ROOT = Path(__file__).resolve().parents[2] / "packages/wallet/state/mutinynet"


def request(path: str, token: str, data: dict | None = None) -> dict:
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "palka-mutinynet-auth",
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(
            urllib.request.Request(f"{FAUCET}{path}", data=body, headers=headers), timeout=30
        ) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"Faucet request failed (HTTP {getattr(error, 'code', 'unknown')}); inspect pending records before any further action"
        ) from error


def save_new(path: Path, value: dict | list) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    directory_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def funding_plan(state: Path) -> list[dict]:
    if not state.resolve().is_relative_to(STATE_ROOT.resolve()):
        raise ValueError("State must be under packages/wallet/state/mutinynet")
    plan = []
    binding = {"network": "signetcustom", "signetChallenge": MUTINYNET_CHALLENGE}
    for profile in ("alice", "bob", "carol"):
        folder = state / profile
        if json.loads((folder / "network.json").read_text()) != binding:
            raise ValueError(f"Mutinynet binding mismatch for {profile}")
        addresses = json.loads((folder / "addresses.json").read_text())
        if addresses.get("profile") != profile or addresses.get("network") != "signetcustom":
            raise ValueError(f"Saved address identity mismatch for {profile}")
        for kind, sats in (("btcAddress", 120000), ("rgbAddress", 10000)):
            address = addresses.get(kind)
            if not isinstance(address, str) or not re.fullmatch(
                r"tb1q[ac-hj-np-z02-9]{38}", address
            ):
                raise ValueError(f"Invalid native P2WPKH address for {profile}")
            plan.append({"profile": profile, "kind": kind, "address": address, "sats": sats})
    if len({entry["address"] for entry in plan}) != 6:
        raise ValueError("Every funding destination must be distinct")
    return plan


def fund(state: Path, execute: bool) -> None:
    state = state.resolve()
    plan = funding_plan(state)
    if not execute:
        print(
            json.dumps({"network": "signetcustom", "totalSats": 390000, "requests": plan}, indent=2)
        )
        return
    folder = state / "faucet-funding"
    folder.mkdir(mode=0o700, exist_ok=True)
    plan_file = folder / "plan.json"
    if plan_file.exists():
        if json.loads(plan_file.read_text()) != plan:
            raise ValueError("Saved funding plan changed")
    else:
        save_new(plan_file, plan)
    remaining = []
    for entry in plan:
        key = f"{entry['profile']}-{entry['kind']}"
        receipt = folder / f"{key}.receipt.json"
        pending = folder / f"{key}.pending.json"
        if receipt.exists():
            saved = json.loads(receipt.read_text())
            if saved.get("request") != entry or not re.fullmatch(
                r"[0-9a-f]{64}", saved.get("txid", "")
            ):
                raise ValueError(f"Invalid saved faucet receipt: {key}")
            continue
        if pending.exists():
            raise ValueError(
                f"Uncertain faucet request: {key}; reconcile its address history before proceeding"
            )
        remaining.append((entry, pending, receipt))
    if not remaining:
        print(json.dumps({"fundingAlreadyRecorded": True, "receiptDirectory": str(folder)}))
        return
    token_file = state / "faucet-auth.token"
    if not token_file.is_file() or token_file.stat().st_mode & 0o077:
        raise ValueError("An owner-only faucet-auth.token from GitHub consent is required")
    token = token_file.read_text().strip()
    if not token:
        raise ValueError("Faucet token is empty")
    limits = request("/api/limits", token)
    if not isinstance(limits.get("remaining_sats"), int) or limits["remaining_sats"] < sum(
        entry["sats"] for entry, _, _ in remaining
    ):
        raise ValueError(
            f"Official faucet quota is insufficient ({limits.get('remaining_sats')} sats remaining); wait for the rolling window"
        )
    for entry, pending, receipt in remaining:
        save_new(pending, {"request": entry, "attemptedAt": int(time.time())})
        response = request(
            "/api/onchain", token, {"address": entry["address"], "sats": entry["sats"]}
        )
        txid = response.get("txid")
        if (
            response.get("address") != entry["address"]
            or not isinstance(txid, str)
            or not re.fullmatch(r"[0-9a-f]{64}", txid)
        ):
            raise RuntimeError(
                "Uncertain faucet response; reconcile the pending request without retrying"
            )
        save_new(receipt, {"network": "signetcustom", "request": entry, "txid": txid})
        print(json.dumps({**entry, "txid": txid}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        fund(args.state_dir, args.execute)
    except (KeyError, OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
