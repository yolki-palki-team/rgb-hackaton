#!/usr/bin/env python3
"""Restore a local private archive to a separate ignored directory; never sign."""

import argparse
import hashlib
import json
import os
import tarfile
from pathlib import Path

from regtest import BIN, ROOT, STATE, call, native


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("backup", type=Path)
    args = parser.parse_args()
    backup = args.backup.resolve()
    if backup.parent != STATE / "backups":
        raise ValueError("expected local ignored backup")
    os.umask(0o077)
    dest = STATE / ("restore-check-" + hashlib.sha256(backup.read_bytes()).hexdigest()[:16])
    if dest.exists():
        raise ValueError("restore destination already exists; preserve it and use a new backup")
    dest.mkdir(mode=0o700)
    with tarfile.open(backup, "r:gz") as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or member.issym()
                or member.islnk()
                or not (member.isfile() or member.isdir())
            ):
                raise ValueError("unsafe archive member")
        archive.extractall(dest, filter="data")
    reports = []
    for p in ("alice", "bob", "carol"):
        before = native("state", p)
        result = json.loads(
            call(
                ["rtk", "proxy", str(BIN)],
                input=json.dumps({"op": "state", "profile": p, "stateDir": str(dest)}),
            )
        )
        if before["stockBalances"] != result["stockBalances"] or before["btc"] != result["btc"]:
            raise ValueError("restored balances differ")
        call(
            ["rtk", "proxy", str(BIN)],
            input=json.dumps({"op": "check-index", "profile": p, "stateDir": str(dest)}),
        )
        reports.append(
            {
                "profile": p,
                "btcBalancesMatch": True,
                "rgbStockMatches": True,
                "sqlIndexMatches": True,
            }
        )
    report = {
        "mode": "real-local-restore",
        "network": "regtest",
        "signed": False,
        "separateIgnoredDirectory": True,
        "profiles": reports,
        "limitation": "Restores wallet/RGB/BDK/journal against the existing chain; no bitcoind disaster recovery claimed",
    }
    (ROOT / "scripts/demo/evidence/restore.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
