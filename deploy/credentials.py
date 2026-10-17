"""Provision market identities, never wallet keys. Requires Python 3.9+ on the server."""

import argparse
import fcntl
import json
import os
import re
import secrets
import shlex
import stat
import tempfile
from pathlib import Path

OWNER = re.compile(r"[a-zA-Z0-9:._-]{1,200}")
TOKEN = re.compile(r"[0-9a-f]{64}")
PREFIX = "MARKET_TOKENS_JSON="


def load_tokens(path: Path) -> dict[str, str]:
    if path.is_symlink():
        raise ValueError("Credential file must not be a symlink")
    if not path.exists():
        return {}
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise ValueError("Credential file must have owner-only permissions (chmod 600)")
    raw = path.read_text().strip()
    if not raw.startswith(PREFIX):
        raise ValueError("Invalid credential file; refusing to replace it")
    try:
        tokens = json.loads(raw[len(PREFIX) :])
    except json.JSONDecodeError:
        raise ValueError("Invalid credential JSON; refusing to replace it") from None
    if (
        not isinstance(tokens, dict)
        or any(
            not TOKEN.fullmatch(token) or not isinstance(owner, str) or not OWNER.fullmatch(owner)
            for token, owner in tokens.items()
        )
        or len(set(tokens.values())) != len(tokens)
    ):
        raise ValueError("Invalid credential mapping; refusing to replace it")
    return tokens


def save_tokens(path: Path, tokens: dict[str, str]) -> None:
    # Write atomically so an interruption cannot truncate existing credentials.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(PREFIX + json.dumps(tokens, separators=(",", ":")) + "\n")
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def provision(state: Path, owners: list[str]) -> dict[str, str]:
    if any(not OWNER.fullmatch(owner) for owner in owners):
        raise ValueError("Specify owner IDs using 1-200 letters, digits, colon, dot, _ or -")
    if state.is_symlink():
        raise ValueError("Credential directory must not be a symlink")
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    # Concurrent operator commands must not discard each other's newly added users.
    with (state / "credentials.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = state / "market.env"
        tokens = load_tokens(path)
        existing = set(tokens.values())
        for owner in owners:
            if owner not in existing:
                token = secrets.token_hex(32)
                while token in tokens:
                    token = secrets.token_hex(32)
                tokens[token] = owner
                existing.add(owner)
        save_tokens(path, tokens)
    return tokens


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("init", "user"))
    parser.add_argument("owners", nargs="*")
    parser.add_argument(
        "--state-dir", type=Path, default=Path(__file__).resolve().parent / ".state"
    )
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == "init":
            provision(args.state_dir, args.owners)
            print(
                "Server configured; existing tokens preserved. Desktop self-registration is enabled by default."
            )
        else:
            if len(args.owners) != 1:
                raise ValueError("Specify exactly one owner ID")
            tokens = load_tokens(args.state_dir / "market.env")
            owner = args.owners[0]
            token = next((key for key, value in tokens.items() if value == owner), None)
            if token is None:
                raise ValueError("Unknown participant; run init with this owner ID first")
            print("PALKA_OWNER_ID=" + shlex.quote(owner))
            print("PALKA_MARKET_TOKEN=" + shlex.quote(token))
    except (ValueError, OSError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
