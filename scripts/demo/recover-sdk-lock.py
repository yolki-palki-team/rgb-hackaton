#!/usr/bin/env python3
"""Explicit stale SDK marker recovery with both project locks held. No signatures removed."""

import argparse
import fcntl
import json
import sys
import uuid

from regtest import ROOT, STATE, native

sys.path.insert(0, str(ROOT / "packages/wallet"))
from protocol import save

parser = argparse.ArgumentParser()
parser.add_argument("--profile", choices=["alice", "bob", "carol"], required=True)
args = parser.parse_args()
root = STATE / args.profile
# Requires all SDK access to use this project's native wrapper. Never run beside
# an external rgb-lib process which does not honor .instance.lock.
with (root / ".coordinator.lock").open("a") as coordinator:
    fcntl.flock(coordinator, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with (root / ".instance.lock").open("a") as instance:
        fcntl.flock(instance, fcntl.LOCK_EX | fcntl.LOCK_NB)
        markers = [
            p
            for p in root.glob("*/rgb_runtime.lock")
            if (p.parent / "wallet_manifest.json").is_file()
        ]
        if len(markers) != 1 or markers[0].stat().st_size != 0:
            raise ValueError("Expected one empty stale SDK runtime marker")
        # Archive the exact marker, never delete stock, journal, intents or signatures.
        markers[0].rename(markers[0].with_name("rgb_runtime.lock.recovered-" + uuid.uuid4().hex))
    identity = native("identity", args.profile)
    index = native("check-index", args.profile)
    evidence = {
        "profile": args.profile,
        "network": "regtest",
        "staleMarkerArchived": True,
        "identityOpened": bool(identity),
        "allocationIndex": index,
        "requiresProjectExclusiveAccess": True,
        "signedRecordsRemoved": False,
    }
    save(STATE / "services/sdk-lock-recovery.json", evidence)
    print(json.dumps(evidence))
