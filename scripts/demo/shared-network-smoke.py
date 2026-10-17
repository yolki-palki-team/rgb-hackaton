"""Opt-in isolated HTTPS/regtest funding, RGB catalog and WDK integration check."""

import hashlib
import json
import os
import secrets
import subprocess
import sys
import time

from desktop_wallet import ROOT, read_private, save_private


def run(*args, **kwargs):
    result = subprocess.run(
        ["rtk", "proxy", *map(str, args)], cwd=ROOT, text=True, capture_output=True, **kwargs
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:] or result.stdout[-4000:])
    return result.stdout


def main():
    if "--execute" not in sys.argv:
        raise ValueError("Pass --execute to create an isolated real regtest test stack and wallets")
    os.umask(0o077)
    folder = ROOT / "deploy/.state/network-smoke"
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
                "test-edge": {
                    "image": "caddy:2.11.7-alpine",
                    "ports": ["127.0.0.1:59443:443"],
                    "volumes": [str(caddy) + ":/etc/caddy/Caddyfile:ro", "smoke-caddy:/data"],
                }
            },
            "volumes": {"smoke-caddy": {}},
        },
    )
    compose = [
        "docker",
        "compose",
        "-p",
        "palka-network-check",
        "-f",
        "deploy/compose.network.yaml",
        "-f",
        override,
    ]
    run(*compose, "up", "-d", "--build", "--wait")
    checkpoint = json.loads(run(*compose, "exec", "-T", "chain", "cat", "/state/checkpoint.json"))
    for _attempt in range(20):
        try:
            certificate = run(
                *compose,
                "exec",
                "-T",
                "test-edge",
                "cat",
                "/data/caddy/pki/authorities/local/root.crt",
            )
            break
        except RuntimeError:
            time.sleep(1)
    else:
        raise ValueError("Local test TLS certificate unavailable")
    ca = folder / "root.crt"
    ca.write_text(certificate)
    os.environ["SSL_CERT_FILE"] = str(ca)
    invitation = read_private(ROOT / "deploy/.state/chain-invite.json")
    invitation.update(url="https://localhost:59443/chain", **checkpoint)
    invite_path = folder / "invite.json"
    save_private(invite_path, invitation)
    profiles = []
    for index, asset in enumerate(("X", "DUSD")):
        profile = folder / asset
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
                    "marketUrl": "https://api.owlpeer.com",
                    "walletMode": "real",
                    "walletRpcUrl": f"http://127.0.0.1:{4291 + index}",
                    "port": 4391 + index,
                },
            )
        profiles.append(profile)
        for command, arguments in (
            ("init", []),
            ("connect", ["--invite", invite_path]),
            ("fund", []),
            ("issue", ["--asset", asset]),
        ):
            output = run(
                sys.executable,
                "scripts/demo/desktop_wallet.py",
                command,
                "--desktop-data-dir",
                profile,
                *arguments,
            )
            print(f"{asset}: {command} passed", flush=True)
            if command == "fund":
                repeat = run(
                    sys.executable,
                    "scripts/demo/desktop_wallet.py",
                    command,
                    "--desktop-data-dir",
                    profile,
                )
                # Catalog-import log lines can differ as other assets become available.
                receipts = [json.loads(line) for line in output.splitlines() if '"txid"' in line]
                repeated = [json.loads(line) for line in repeat.splitlines() if '"txid"' in line]
                assert receipts == repeated, "Faucet retry changed its receipt"
    for profile in profiles:
        run(sys.executable, "scripts/demo/desktop_wallet.py", "sync", "--desktop-data-dir", profile)
    sidecar = subprocess.Popen(
        [
            sys.executable,
            "scripts/demo/desktop_wallet.py",
            "start",
            "--desktop-data-dir",
            str(profiles[0]),
        ],
        stdout=subprocess.DEVNULL,
    )
    try:
        result = run(
            "node_modules/node/bin/node",
            "--import",
            "tsx",
            "apps/local-client/scripts/shared-wdk-smoke.ts",
            profiles[0],
            "--execute",
        )
        print(result, flush=True)
    finally:
        sidecar.terminate()
        sidecar.wait(timeout=20)
    print("Real HTTPS shared-network checks passed; isolated stack and wallet state are preserved.")
    print(
        "Stop only this test stack with: docker compose -p palka-network-check -f deploy/compose.network.yaml -f deploy/.state/network-smoke/compose.json down"
    )


if __name__ == "__main__":
    main()
