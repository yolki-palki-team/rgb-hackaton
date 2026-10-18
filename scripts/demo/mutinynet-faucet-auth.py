#!/usr/bin/env python3
"""Authenticate the official Mutinynet faucet without changing global credentials."""

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

FAUCET = "https://faucet.mutinynet.com"
STATE_ROOT = Path(__file__).resolve().parents[2] / "packages/wallet/state/mutinynet"


def request(url: str, data: dict | None = None, *, form: bool = False) -> dict:
    body = None
    headers = {"Accept": "application/json", "User-Agent": "palka-mutinynet-auth"}
    if data is not None:
        body = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
        headers["Content-Type"] = (
            "application/x-www-form-urlencoded" if form else "application/json"
        )
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=body, headers=headers), timeout=20
        ) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        # OAuth response bodies can contain credentials; never include them in errors.
        raise RuntimeError(
            f"Authentication request failed at {urllib.parse.urlsplit(url).hostname}"
        ) from error


def login(token_file: Path) -> None:
    token_file = token_file.resolve()
    if not token_file.is_relative_to(STATE_ROOT.resolve()) or token_file.exists():
        raise ValueError("Choose a new token file under packages/wallet/state/mutinynet")
    token_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    client_id = request(f"{FAUCET}/auth/github/client_id")["client_id"]
    device = request(
        "https://github.com/login/device/code",
        {"client_id": client_id, "scope": "user:email"},
        form=True,
    )
    if device.get("verification_uri") != "https://github.com/login/device":
        raise RuntimeError("GitHub returned an unexpected device authorization URL")
    interval = max(5, int(device["interval"]))
    expires = int(device["expires_in"])
    deadline = time.monotonic() + expires
    print(
        json.dumps(
            {
                "verificationUri": device["verification_uri"],
                "userCode": device["user_code"],
                "expiresInSeconds": expires,
                "scope": "user:email",
                "tokenFile": str(token_file),
            }
        ),
        flush=True,
    )
    while time.monotonic() < deadline:
        time.sleep(interval)
        result = request(
            "https://github.com/login/oauth/access_token",
            {
                "client_id": client_id,
                "device_code": device["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            form=True,
        )
        if "access_token" in result:
            token = request(f"{FAUCET}/auth/github/device", {"code": result["access_token"]}).get(
                "token"
            )
            if not isinstance(token, str) or not token:
                raise RuntimeError("Faucet did not return an authentication token")
            fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(token)
            print(json.dumps({"authenticated": True, "tokenFile": str(token_file)}), flush=True)
            return
        if result.get("error") == "authorization_pending":
            continue
        if result.get("error") == "slow_down":
            interval += 5
            continue
        raise RuntimeError("GitHub device authorization was denied, expired or failed")
    raise RuntimeError("GitHub device authorization expired")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        login(args.token_file)
    except (KeyError, OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
