"""Exercise automatic enrollment against real market/Core/RGB services over TLS."""

import hashlib
import http.client
import json
import os
import secrets
import subprocess
import sys
import time
from importlib.machinery import SourceFileLoader

from desktop_wallet import ROOT, native, read_private, save_private, settings

run = (
    SourceFileLoader("shared_smoke", str(ROOT / "scripts/demo/shared-network-smoke.py"))
    .load_module()
    .run
)


def main():
    if "--execute" not in sys.argv:
        raise ValueError("Pass --execute for real isolated regtest enrollment")
    os.umask(0o077)
    folder = ROOT / "deploy/.state/auto-token-smoke"
    folder.mkdir(parents=True, exist_ok=True)
    run(sys.executable, "deploy/network_setup.py")
    caddy = folder / "Caddyfile"
    caddy.write_text(
        "https://localhost {\n tls internal\n handle_path /chain/* {\n reverse_proxy chain:8090\n }\n}\n"
    )
    override = folder / "compose.json"
    save_private(
        override,
        {
            "services": {
                "runtime": {
                    "build": {
                        "context": str(ROOT),
                        "dockerfile": "deploy/Dockerfile",
                        "target": "market",
                    },
                    "environment": {"MARKET_HOST": "0.0.0.0", "MARKET_SELF_REGISTRATION": "true"},
                    "volumes": ["auto-market:/app/.state"],
                },
                "test-edge": {
                    "image": "caddy:2.11.7-alpine",
                    "ports": ["127.0.0.1:59444:443"],
                    "volumes": [str(caddy) + ":/etc/caddy/Caddyfile:ro", "auto-caddy:/data"],
                },
            },
            "volumes": {"auto-market": {}, "auto-caddy": {}},
        },
    )
    compose = [
        "docker",
        "compose",
        "-p",
        "palka-auto-token-check",
        "-f",
        "deploy/compose.network.yaml",
        "-f",
        override,
    ]
    run(*compose, "up", "-d", "--build", "--wait")
    ca = folder / "root.crt"
    ca.write_text(
        run(
            *compose, "exec", "-T", "test-edge", "cat", "/data/caddy/pki/authorities/local/root.crt"
        )
    )
    os.environ["SSL_CERT_FILE"] = str(ca)
    issued_contracts = set()
    for index in range(4):
        profile = folder / str(index)
        profile.mkdir(exist_ok=True)
        path = profile / "desktop-config.json"
        if not path.exists():
            token = secrets.token_hex(32)
            owner = (
                "participant-"
                + hashlib.sha256(("palka-participant-v1:" + token).encode()).hexdigest()
            )
            save_private(
                path,
                {
                    "ownerId": owner,
                    "marketToken": token,
                    "marketRegistration": "automatic",
                    "marketUrl": "https://localhost:59444",
                    "walletMode": "real",
                    "walletRpcUrl": "http://127.0.0.1:4295",
                    "port": 4395,
                },
            )
        identity = read_private(path)["ownerId"]
        own_contract = None
        for restart in range(2):
            child = subprocess.Popen(
                [
                    sys.executable,
                    "scripts/demo/desktop_wallet.py",
                    "auto",
                    "--desktop-data-dir",
                    str(profile),
                ],
                stdout=subprocess.DEVNULL,
            )
            try:
                for _attempt in range(120):
                    if child.poll() is not None:
                        raise RuntimeError("Automatic setup exited")
                    config = read_private(path)
                    try:
                        conn = http.client.HTTPConnection("127.0.0.1", 4295, timeout=5)
                        conn.request(
                            "POST",
                            "/rpc",
                            json.dumps(
                                {
                                    "protocolVersion": 1,
                                    "requestId": "smoke",
                                    "method": "state",
                                    "params": {},
                                }
                            ),
                            {
                                "Authorization": "Bearer " + config.get("walletRpcToken", ""),
                                "Content-Type": "application/json",
                            },
                        )
                        state = json.loads(conn.getresponse().read())["result"]
                        conn.close()
                        assert state["ownerId"] == identity
                        assert int(state["balances"][0]["amount"]) >= 1100000
                        rgb = [b for b in state["balances"] if b["asset"]["kind"] == "rgb"]
                        owned = [b for b in rgb if int(b["amount"]) > 0]
                        assert len(owned) == 1
                        assert owned[0]["amount"] == "1000"
                        assert all(b["amount"] == "0" for b in rgb if b not in owned)
                        contract = owned[0]["asset"]["contractId"]
                        assert issued_contracts.issubset({b["asset"]["contractId"] for b in rgb})
                        if restart:
                            assert contract == own_contract
                        else:
                            assert contract not in issued_contracts
                            own_contract = contract
                        if index >= 2:
                            assert owned[0]["asset"]["symbol"].startswith("T")
                        break
                    except (OSError, KeyError, AssertionError):
                        time.sleep(1)
                else:
                    raise RuntimeError("Automatic wallet did not become ready")
                print(
                    json.dumps({"participant": index + 1, "restart": bool(restart), "ready": True}),
                    flush=True,
                )
            finally:
                child.terminate()
                child.wait(timeout=20)
            if not restart:
                # Exercise the issuance receipt too; automatic fast-start skips minting.
                run(
                    sys.executable,
                    "scripts/demo/desktop_wallet.py",
                    "issue",
                    "--desktop-data-dir",
                    profile,
                    "--asset",
                    owned[0]["asset"]["symbol"],
                )
        issued_contracts.add(own_contract)
    first_profile = folder / "0"
    run(
        sys.executable,
        "scripts/demo/desktop_wallet.py",
        "sync",
        "--desktop-data-dir",
        first_profile,
    )
    _, first_state, _ = settings(first_profile / "desktop-config.json")
    imported = native(first_state, "offline-state")["assets"]["nia"]
    assert issued_contracts.issubset({asset["asset_id"] for asset in imported})
    print("Automatic enrollment, funding, issuance, catalog and restart passed.")


if __name__ == "__main__":
    main()
