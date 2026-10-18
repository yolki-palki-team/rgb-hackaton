"""Start an isolated Mutinynet client node with bounded initial synchronization."""

import argparse
import hashlib
import hmac
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts/demo"))
import chain_profile  # noqa: E402
from desktop_wallet import read_private, save_private  # noqa: E402

STATE = ROOT / "deploy/.state/mutinynet"
COMPOSE = ["docker", "compose", "-f", str(ROOT / "deploy/compose.mutinynet.yaml")]
MIN_FREE = 10 * 1024**3


def provision(state=STATE):
    if state.is_symlink() or state.parent.is_symlink():
        raise ValueError("Mutinynet state directories must not be symlinks")
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    endpoint = state / "endpoints.json"
    bitcoin = state / "bitcoin.conf"
    if endpoint.exists() or bitcoin.exists():
        if not endpoint.exists() or not bitcoin.exists():
            raise ValueError(
                "Incomplete Mutinynet setup; inspect the existing files before retrying"
            )
        config = read_private(endpoint)
        if config.get("bitcoinRpcUrl") != "http://127.0.0.1:38332":
            raise ValueError("Existing endpoint configuration belongs to another node")
        return endpoint
    password = secrets.token_hex(32)
    salt = secrets.token_hex(16)
    digest = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
    config = {
        "bitcoinRpcUrl": "http://127.0.0.1:38332",
        "bitcoinRpcUser": "palka-mutinynet",
        "bitcoinRpcPassword": password,
        "indexerUrl": "https://mutinynet.com/api",
        "rgbProxyUrl": "http://127.0.0.1:53002/json-rpc",
    }
    text = f"""signet=1
server=1
disablewallet=1
txindex=1
prune=0
dbcache=128
maxmempool=50
par=2
maxconnections=8
listen=0
discover=0
dnsseed=0
printtoconsole=1
debuglogfile=0
rpcauth=palka-mutinynet:{salt}${digest}
[signet]
signetchallenge={chain_profile.MUTINYNET_CHALLENGE}
signetblocktime=30
addnode=45.79.52.207:38333
rpcbind=0.0.0.0
rpcport=38332
rpcallowip=172.16.0.0/12
rpcallowip=192.168.0.0/16
rpcallowip=10.0.0.0/8
fallbackfee=0.0002
minrelaytxfee=0.00000100
datacarriersize=100000
"""
    save_private(endpoint, config)
    with bitcoin.open("x") as stream:
        os.chmod(bitcoin, 0o600)
        stream.write(text)
    return endpoint


def compose(*args):
    subprocess.run([*COMPOSE, *args], check=True)


def status(config):
    info = chain_profile._rpc(config, "getblockchaininfo", [])
    if (
        info.get("chain") != "signet"
        or info.get("signet_challenge") != chain_profile.MUTINYNET_CHALLENGE
    ):
        raise ValueError("Node does not report the pinned Mutinynet challenge")
    if (
        info["blocks"]
        and chain_profile._rpc(config, "getblockhash", [1]) != chain_profile.MUTINYNET_CHECKPOINT
    ):
        raise ValueError("Node does not match the pinned Mutinynet checkpoint")
    indexes = chain_profile._rpc(config, "getindexinfo", [])
    synced = indexes.get("txindex", {}).get("synced") is True
    return {
        "height": info["blocks"],
        "headers": info["headers"],
        "initialBlockDownload": info["initialblockdownload"],
        "txindexSynced": synced,
        "diskGiB": round(info["size_on_disk"] / 1024**3, 2),
        "ready": not info["initialblockdownload"] and synced,
    }


def monitor(config, timeout):
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            free = shutil.disk_usage(ROOT).free
            if free < MIN_FREE:
                raise RuntimeError(
                    "Host disk space is below 10 GiB; isolated Mutinynet services stopped"
                )
            try:
                current = status(config)
            except RuntimeError:
                current = {"ready": False, "status": "Core RPC warming up or unavailable"}
            print(json.dumps({**current, "hostFreeGiB": round(free / 1024**3, 2)}), flush=True)
            if current["ready"]:
                return
            time.sleep(10)
        raise RuntimeError(
            "Synchronization time budget exhausted; isolated services stopped, volumes preserved. Run up again to resume."
        )
    except BaseException:
        compose("stop")
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("up", "status", "stop"))
    parser.add_argument(
        "--timeout", type=int, default=900, help="Synchronization budget in seconds; 60 to 3600"
    )
    args = parser.parse_args()
    if not 60 <= args.timeout <= 3600:
        parser.error("Timeout must be between 60 and 3600 seconds")
    if args.command == "stop":
        compose("stop")
        return
    if args.command == "up":
        if shutil.disk_usage(ROOT).free < MIN_FREE + 2 * 1024**3:
            raise ValueError("At least 12 GiB free host disk is required before starting Mutinynet")
        endpoint = provision()
        compose("config", "--quiet")
        try:
            compose("up", "-d", "--build")
        except BaseException:
            compose("stop")
            raise
        monitor(read_private(endpoint), args.timeout)
        print(
            json.dumps({"ready": True, "endpointConfig": str(endpoint), "walletInitialized": False})
        )
    else:
        print(json.dumps(status(read_private(STATE / "endpoints.json")), indent=2))


if __name__ == "__main__":
    main()
