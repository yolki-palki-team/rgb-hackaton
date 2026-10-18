#!/usr/bin/env python3
"""Create one independent development wallet and run its local desktop sidecar."""

import argparse
import fcntl
import hashlib
import http.client
import json
import os
import re
import secrets
import signal
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import chain_profile

ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / "packages/wallet/native/target/debug/rgb-settlement-spike"
# The native bridge currently accepts three storage-slot names. This slot is in
# a separate per-participant directory; its public owner is the desktop ID.
SLOT = "alice"


def read_private(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("Configuration must be a private regular file")
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("Invalid configuration")
    return data


def save_private(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".wallet-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def settings(config_path, root=ROOT):
    config = read_private(config_path)
    if config.get("network", "regtest") != chain_profile.network():
        raise ValueError("Desktop network differs from PALKA_NETWORK; use its original profile")
    token = config.get("marketToken", "")
    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token):
        raise ValueError("Expected an automatic desktop profile; launch desktop first")
    owner = "participant-" + hashlib.sha256(("palka-participant-v1:" + token).encode()).hexdigest()
    if config.get("marketRegistration") != "automatic" or config.get("ownerId") != owner:
        raise ValueError("Legacy wallets require their existing sidecar; identity was not changed")
    if config.get("walletMode") != "real":
        raise ValueError("Select real wallet mode before initializing a real wallet")
    url = urlsplit(config.get("walletRpcUrl", ""))
    if (
        url.scheme != "http"
        or url.hostname not in ("127.0.0.1", "localhost")
        or url.username
        or url.password
        or url.path not in ("", "/")
        or url.query
        or url.fragment
        or url.port is None
        or not 1024 <= url.port <= 65535
        or url.port == config.get("port")
    ):
        raise ValueError("Expected a separate loopback wallet RPC port")
    state = root / "packages/wallet/state"
    if chain_profile.network() == "signetcustom":
        state /= "mutinynet"
    state /= "desktop-" + owner
    return config, state, url.port


def native(state, operation, **kwargs):
    environment = {}
    if chain_profile.network() == "signetcustom" and operation != "capabilities":
        config = chain_profile.configuration()
        # Receive setup is offline; health validates the pinned indexer and proxy itself.
        if operation not in ("init", "identity", "addresses", "health"):
            chain_profile.check_chain(config)
        environment = chain_profile.native_environment(config)
    result = subprocess.run(
        [str(BIN)],
        input=json.dumps(
            {
                "op": operation,
                "stateDir": str(state),
                "profile": SLOT,
                **kwargs,
                **chain_profile.native_context(),
            }
        ),
        env={**os.environ, **environment},
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        if "RGB runtime lock exists" in result.stderr:
            raise RuntimeError(
                "RGB_RUNTIME_LOCK: Stop wallet processes and recover the stale runtime lock before restarting"
            )
        raise RuntimeError("Native wallet operation failed; no replacement keys were requested")
    return json.loads(result.stdout)


def initialize(config_path, root=ROOT, call_native=native):
    config, state, _ = settings(config_path, root)
    if chain_profile.network() == "signetcustom":
        # Prove the operator's infrastructure is usable before creating any keys.
        if call_native(state, "health").get("network") != "signetcustom":
            raise ValueError("Rebuild the native wallet with Mutinynet support")
    marker = state / "desktop-wallet.json"
    if not marker.exists() and (config.get("walletRpcToken") or state.exists()):
        raise ValueError("Existing wallet configuration/state found; refusing to replace it")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / ".setup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if marker.exists():
            metadata = read_private(marker)
        else:
            metadata = {
                "ownerId": config["ownerId"],
                "desktopConfig": str(config_path),
                "walletRpcToken": secrets.token_hex(32),
                "initialized": False,
                "network": chain_profile.network(),
            }
            save_private(marker, metadata)
        if metadata.get("ownerId") != config["ownerId"] or metadata.get("desktopConfig") != str(
            config_path
        ):
            raise ValueError("Wallet belongs to another desktop profile")
        if metadata.get("network", "regtest") != chain_profile.network():
            raise ValueError("Wallet network changed; use its original profile")
        if config.get("walletRpcToken") not in (None, "", metadata["walletRpcToken"]):
            raise ValueError("Wallet token mismatch; original credentials were preserved")
        wallet = state / SLOT
        keys = wallet / "keys.json"
        if not keys.exists() and (
            metadata["initialized"] or (wallet.exists() and any(wallet.iterdir()))
        ):
            raise ValueError(
                "Wallet keys are missing; restore the original state instead of reinitializing"
            )
        wallet.mkdir(mode=0o700, exist_ok=True)
        with (wallet / ".coordinator.lock").open("a") as coordinator:
            fcntl.flock(coordinator, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if not metadata["initialized"]:
                call_native(state, "init")
            identity = call_native(state, "identity")
            if identity.get("network") != chain_profile.network():
                raise ValueError("Native wallet network differs from the selected profile")
            if metadata.get("fingerprint", identity["fingerprint"]) != identity["fingerprint"]:
                raise ValueError("Wallet fingerprint changed; refusing to connect")
            metadata.update(initialized=True, fingerprint=identity["fingerprint"])
            save_private(marker, metadata)
        if read_private(config_path) != config:
            raise ValueError(
                "Desktop config changed during initialization; close desktop and retry"
            )
        backup = config_path.with_name("desktop-config.before-wallet.json")
        if not backup.exists():
            with backup.open("x") as stream:
                os.chmod(backup, 0o600)
                json.dump(config, stream, indent=2)
        config["walletRpcToken"] = metadata["walletRpcToken"]
        save_private(config_path, config)
    return state


def start(config_path):
    config, state, port = settings(config_path)
    metadata = read_private(state / "desktop-wallet.json")
    if (
        not metadata.get("initialized")
        or metadata.get("ownerId") != config["ownerId"]
        or metadata.get("desktopConfig") != str(config_path)
        or not config.get("walletRpcToken")
        or metadata.get("walletRpcToken") != config["walletRpcToken"]
        or not (state / SLOT / "keys.json").is_file()
        or metadata.get("network", "regtest") != chain_profile.network()
    ):
        raise ValueError("Wallet configuration mismatch; run init only for a new profile")
    identity = native(state, "identity")
    if (
        identity.get("network") != chain_profile.network()
        or identity.get("fingerprint") != metadata["fingerprint"]
    ):
        raise ValueError("Wallet identity changed")
    environment = {
        **os.environ,
        "RGB_DEMO_STATE": str(state),
        "WALLET_RPC_TOKEN": config["walletRpcToken"],
    }
    arguments = [
        sys.executable,
        str(ROOT / "packages/wallet/server.py"),
        "--profile",
        SLOT,
        "--owner",
        config["ownerId"],
        "--port",
        str(port),
    ]
    shared = state / "shared-network.json"
    if chain_profile.network() == "signetcustom":
        if shared.exists():
            raise ValueError("A shared regtest invitation cannot be used with Mutinynet")
        if native(state, "health").get("network") != "signetcustom":
            raise ValueError("Rebuild the native wallet with Mutinynet support")
    if not shared.exists():
        os.execve(sys.executable, arguments, environment)
    from chain_transport import Adapters, Client
    from chain_transport import environment as chain_environment

    client = Client(read_private(shared))
    for attempt in range(3):
        try:
            client.health()
            break
        except (ConnectionError, OSError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2)
    adapters = Adapters(client)
    child = None
    try:
        child = subprocess.Popen(arguments, env={**environment, **chain_environment(shared)})
        signal.signal(signal.SIGTERM, lambda *_: child.terminate())
        raise SystemExit(child.wait())
    except KeyboardInterrupt:
        if child:
            child.terminate()
            child.wait(timeout=15)
    finally:
        adapters.close()


def idle_wallet(state):
    journal = state / SLOT / "journal.sqlite"
    if journal.exists():
        with sqlite3.connect(f"file:{journal}?mode=ro", uri=True) as db:
            if db.execute(
                "SELECT 1 FROM trades WHERE state NOT IN ('CONFIRMED','CANCELLED') LIMIT 1"
            ).fetchone():
                raise ValueError("Finish or reconcile the active trade first")


def network_command(config_path, args):
    if chain_profile.network() == "signetcustom":
        raise ValueError(
            "Shared regtest onboarding is unavailable on Mutinynet; see deploy/MUTINYNET.md"
        )
    from chain_transport import Adapters, Client, environment

    config, state, _ = settings(config_path)
    metadata = read_private(state / "desktop-wallet.json")
    if (
        not metadata.get("initialized")
        or metadata.get("ownerId") != config["ownerId"]
        or metadata.get("walletRpcToken") != config.get("walletRpcToken")
        or native(state, "identity")["fingerprint"] != metadata["fingerprint"]
    ):
        raise ValueError("Initialize and verify this independent wallet first")
    shared = state / "shared-network.json"
    if args.command == "fund" and args.wdk_address:
        client = Client(read_private(shared))
        client.health()
        print(
            json.dumps(
                client.request(
                    "/fund",
                    {
                        "ownerId": config["ownerId"],
                        "purpose": "wdk",
                        "address": args.wdk_address,
                    },
                )
            )
        )
        return
    if args.command == "desktop":
        Client(read_private(shared)).health()
        os.execvpe(
            "npm",
            ["npm", "run", "dev:desktop"],
            {
                **os.environ,
                **environment(shared),
                "PALKA_DESKTOP_DATA_DIR": str(config_path.parent),
            },
        )
    with (state / SLOT / ".coordinator.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError(
                "Stop the sidecar before connect/fund/issue/sync; keep desktop closed"
            ) from error
        idle_wallet(state)
        if args.command == "connect":
            if not args.invite:
                raise ValueError("Pass --invite with the private server invitation file")
            invitation = read_private(args.invite.expanduser().resolve())
            client = Client(invitation)
            info = client.health()
            if shared.exists():
                if read_private(shared)["chainId"] != invitation["chainId"]:
                    raise ValueError("Cannot switch an existing shared wallet to another chain")
            else:
                # Inspect local records without requiring a local node on a new computer.
                previous = native(state, "offline-state")
                if previous["unspents"] or previous["assets"]["nia"]:
                    raise ValueError(
                        "Existing funded/imported wallets cannot migrate chains; use a new desktop profile"
                    )
            save_private(shared, invitation)
            print(json.dumps({"connected": True, **info, "ownerId": config["ownerId"]}))
            return
        client = Client(read_private(shared))
        client.health()
        os.environ.update(environment(shared))
        adapters = Adapters(client)
        try:
            if args.command == "fund":
                addresses = json.loads((state / SLOT / "addresses.json").read_text())
                recipients = (
                    [("wdk", args.wdk_address)]
                    if args.wdk_address
                    else [("btc", addresses["btcAddress"]), ("rgb", addresses["rgbAddress"])]
                )
                for purpose, address in recipients:
                    print(
                        json.dumps(
                            client.request(
                                "/fund",
                                {
                                    "ownerId": config["ownerId"],
                                    "purpose": purpose,
                                    "address": address,
                                },
                            )
                        )
                    )
            elif args.command == "issue":
                if not isinstance(args.asset, str) or not (
                    args.asset in ("X", "DUSD")
                    or (re.fullmatch(r"T[0-9]{6}", args.asset) and args.asset != "T000000")
                ):
                    raise ValueError("Pass --asset X, DUSD or the assigned demo ticker")
                client.request("/catalog", {"ticker": args.asset, "ownerId": config["ownerId"]})
                # Wait for the confirmed colored funding output to reach electrs.
                for _attempt in range(30):
                    raw = native(state, "state")
                    if any(u["utxo"]["colorable"] for u in raw["unspents"]):
                        break
                    time.sleep(1)
                else:
                    raise ValueError(
                        "Run fund first and wait for the RGB funding output to be indexed"
                    )
                asset = native(state, "issue", ticker=args.asset, amount="1000")
                contract_id = asset["asset_id"]
                exported = native(state, "catalog-export", contractId=contract_id)
                client.request(
                    "/catalog",
                    {
                        "ticker": args.asset,
                        "ownerId": config["ownerId"],
                        "contractId": contract_id,
                        "contract": exported["contract"],
                    },
                )
                print(
                    json.dumps({"issued": args.asset, "amount": "1000", "contractId": contract_id})
                )
            elif args.command != "sync":
                raise ValueError("Unknown network command")
            for ticker, entry in client.request("/catalog", {}).items():
                if "contract" not in entry:
                    continue
                result = native(state, "catalog-import", contract=entry["contract"])
                if result["contractId"] != entry["contractId"]:
                    raise ValueError("Imported contract ID differs from the shared catalog")
                print(json.dumps({"verifiedAsset": ticker, "contractId": result["contractId"]}))
        finally:
            adapters.close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["init", "start", "status", "connect", "fund", "issue", "sync", "desktop", "auto"],
    )
    parser.add_argument("--desktop-data-dir", required=True, type=Path)
    parser.add_argument("--invite", type=Path)
    parser.add_argument("--asset", help="X, DUSD or the demo ticker assigned during enrollment")
    parser.add_argument("--wdk-address")
    args = parser.parse_args()
    config_path = args.desktop_data_dir.expanduser().resolve() / "desktop-config.json"
    if args.command == "auto":
        config, state, _ = settings(config_path)
        if chain_profile.network() == "signetcustom":
            marker = state / "desktop-wallet.json"
            metadata = read_private(marker) if marker.exists() else {}
            if (
                not metadata.get("initialized")
                or not config.get("walletRpcToken")
                or config["walletRpcToken"] != metadata.get("walletRpcToken")
            ):
                initialize(config_path)
            start(config_path)
            return
        if (state / "automatic-ready.json").exists():
            # start() verifies saved ownership, keys, token and fingerprint itself.
            # A completed profile must not repeat initialization or rewrite its config.
            start(config_path)
            return
        initialize(config_path)
        config, state, _ = settings(config_path)
        market = urlsplit(config["marketUrl"])
        if market.scheme != "https":
            raise ValueError("Automatic shared-network setup requires HTTPS")
        connection = http.client.HTTPSConnection(market.hostname, market.port or 443, timeout=30)
        try:
            connection.request(
                "POST",
                "/chain/bootstrap",
                b"{}",
                {
                    "Authorization": "Bearer " + config["marketToken"],
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            bootstrap = json.loads(response.read(8192))
            if response.status != 200 or bootstrap.get("network") != "regtest":
                raise ValueError(
                    "Server onboarding unavailable; run deploy/server.sh network on the server"
                )
        finally:
            connection.close()
        invite = state / "automatic-invite.json"
        save_private(
            invite,
            {
                "url": config["marketUrl"] + "/chain",
                "token": bootstrap["token"],
                "chainId": bootstrap["chainId"],
            },
        )
        args.invite = invite
        for command in ("connect", "fund", "issue" if bootstrap.get("asset") else "sync"):
            args.command = command
            args.asset = bootstrap.get("asset")
            network_command(config_path, args)
        save_private(
            state / "automatic-ready.json",
            {"chainId": bootstrap["chainId"], "ownerId": config["ownerId"]},
        )
        start(config_path)
        return
    if args.command == "init":
        state = initialize(config_path)
        print(
            json.dumps(
                {
                    "initialized": True,
                    "network": chain_profile.network(),
                    "stateDirectory": str(state),
                    "funded": False,
                }
            )
        )
    elif args.command == "start":
        start(config_path)
    elif args.command == "status":
        _, state, _ = settings(config_path)
        print(
            json.dumps(
                {
                    "network": chain_profile.network(),
                    "addresses": read_private(state / SLOT / "addresses.json"),
                    "wallet": native(state, "state"),
                },
                indent=2,
            )
        )
    else:
        network_command(config_path, args)


if __name__ == "__main__":
    main()
