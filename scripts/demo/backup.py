#!/usr/bin/env python3
"""Local private backup of keys AND complete RGB/BDK/journal state. Never uploads."""

import fcntl
import json
import os
import tarfile
import time

from regtest import STATE


def main():
    os.umask(0o077)
    locks = []
    try:
        for profile in ("alice", "bob", "carol"):
            for name in (".coordinator.lock", ".instance.lock"):
                path = STATE / profile / name
                if path.parent.exists():
                    f = path.open("a")
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locks.append(f)
        folder = STATE / "backups"
        folder.mkdir(mode=0o700, exist_ok=True)
        output = folder / f"local-rgb-{time.time_ns()}.tar.gz"
        with tarfile.open(output, "x:gz") as archive:
            for profile in ("alice", "bob", "carol"):
                if (STATE / profile).exists():
                    archive.add(STATE / profile, arcname=profile)
            for name in (
                "review.json",
                "funding.json",
                "finalized.json",
                "settlement-evidence.json",
            ):
                if (STATE / name).exists():
                    archive.add(STATE / name, arcname=name)
        os.chmod(output, 0o600)
        with tarfile.open(output, "r:gz") as archive:
            members = archive.getnames()
            for profile in ("alice", "bob", "carol"):
                if (STATE / profile).exists():
                    if f"{profile}/keys.json" not in members or not any(
                        n.startswith(profile + "/") and "rgb" in n for n in members
                    ):
                        raise RuntimeError("incomplete RGB backup")
        print(
            json.dumps(
                {
                    "backup": str(output),
                    "containsKeys": True,
                    "containsFullRgbState": True,
                    "encrypted": False,
                    "mode": "0600",
                    "uploaded": False,
                }
            )
        )
    finally:
        for f in locks:
            f.close()


if __name__ == "__main__":
    main()
