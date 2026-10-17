"""Generate persistent regtest gateway credentials without printing secrets."""

import hashlib
import hmac
import json
import os
import secrets
import sys
from pathlib import Path


def main():
    os.umask(0o077)
    state = Path(__file__).resolve().parent / ".state"
    state.mkdir(exist_ok=True, mode=0o700)
    env = state / "chain.env"
    if not env.exists():
        password, salt = secrets.token_hex(32), secrets.token_hex(16)
        digest = hmac.new(salt.encode(), password.encode(), hashlib.sha256).hexdigest()
        with env.open("x") as stream:
            stream.write(
                f"NETWORK=regtest\nBTCUSER=palka\nBTCPASS={password}\n"
                # Single quotes prevent Compose from interpolating the RPC hash separator.
                f"RPCAUTH='palka:{salt}${digest}'\n"
                f"CHAIN_TOKEN={secrets.token_hex(32)}\n"
            )
    values = dict(line.split("=", 1) for line in env.read_text().splitlines())
    invitation = state / "chain-invite.json"
    # The checkpoint is added by server.sh after the gateway is healthy.
    if not invitation.exists():
        with invitation.open("x") as stream:
            json.dump(
                {"url": "https://api.owlpeer.com/chain", "token": values["CHAIN_TOKEN"]}, stream
            )
    if sys.argv[1:] == ["checkpoint"]:
        checkpoint = json.load(sys.stdin)["chainId"]
        saved = json.loads(invitation.read_text())
        if saved.get("chainId", checkpoint) != checkpoint:
            raise ValueError("Invitation checkpoint changed; restore the original chain volume")
        saved["chainId"] = checkpoint
        temporary = invitation.with_suffix(".tmp")
        temporary.write_text(json.dumps(saved, indent=2) + "\n")
        temporary.replace(invitation)
    print("Private network credentials prepared in deploy/.state (never commit or publish).")


if __name__ == "__main__":
    main()
