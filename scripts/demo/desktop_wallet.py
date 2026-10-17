#!/usr/bin/env python3
"""Create one independent regtest wallet and run its local desktop sidecar."""

import argparse
import fcntl
import hashlib
import json
import os
import secrets
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

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
    state = root / "packages/wallet/state" / ("desktop-" + owner)
    return config, state, url.port


def native(state, operation):
    result = subprocess.run(
        ["rtk", "proxy", str(BIN)],
        input=json.dumps({"op": operation, "stateDir": str(state), "profile": SLOT}),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError("Native wallet operation failed; no replacement keys were requested")
    return json.loads(result.stdout)


def initialize(config_path, root=ROOT, call_native=native):
    config, state, _ = settings(config_path, root)
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
            }
            save_private(marker, metadata)
        if metadata.get("ownerId") != config["ownerId"] or metadata.get("desktopConfig") != str(
            config_path
        ):
            raise ValueError("Wallet belongs to another desktop profile")
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
            if identity.get("network") != "regtest":
                raise ValueError("Regtest wallet required")
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
    ):
        raise ValueError("Wallet configuration mismatch; run init only for a new profile")
    identity = native(state, "identity")
    if (
        identity.get("network") != "regtest"
        or identity.get("fingerprint") != metadata["fingerprint"]
    ):
        raise ValueError("Wallet identity changed")
    environment = {
        **os.environ,
        "RGB_DEMO_STATE": str(state),
        "WALLET_RPC_TOKEN": config["walletRpcToken"],
    }
    os.execve(
        sys.executable,
        [
            sys.executable,
            str(ROOT / "packages/wallet/server.py"),
            "--profile",
            SLOT,
            "--owner",
            config["ownerId"],
            "--port",
            str(port),
        ],
        environment,
    )


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["init", "start"])
    parser.add_argument("--desktop-data-dir", required=True, type=Path)
    args = parser.parse_args()
    config_path = args.desktop_data_dir.expanduser().resolve() / "desktop-config.json"
    if args.command == "init":
        state = initialize(config_path)
        print(
            json.dumps(
                {
                    "initialized": True,
                    "network": "regtest",
                    "stateDirectory": str(state),
                    "funded": False,
                }
            )
        )
    else:
        start(config_path)


if __name__ == "__main__":
    main()
