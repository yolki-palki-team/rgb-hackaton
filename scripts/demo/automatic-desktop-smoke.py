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

from desktop_wallet import ROOT, read_private, save_private

run = (
    SourceFileLoader("shared_smoke", str(ROOT / "scripts/demo/shared-network-smoke.py"))
    .load_module()
    .run
)


def main():
    if "--execute" not in sys.argv:
        raise ValueError("Pass --execute for real isolated regtest enrollment")
    os.umask(0o077)
    folder = ROOT / "deploy/.state/auto-smoke"
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
        "palka-auto-check",
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
    for index in range(3):
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
                        if index == 2:
                            assert len(state["balances"]) == 3
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
    print("Automatic enrollment, funding, issuance, catalog and restart passed.")


if __name__ == "__main__":
    main()
