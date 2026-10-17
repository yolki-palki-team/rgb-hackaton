#!/usr/bin/env python3
"""Pin existing chain volumes by external name. Never copy, delete, or recreate a chain."""

import argparse
import json
import sys

from regtest import COMPOSE, ROOT, call, rpc

sys.path.insert(0, str(ROOT / "packages/wallet"))
from protocol import read, save

record = ROOT / "infra/state/chain-volumes.json"
override = ROOT / "infra/state/chain-volumes.compose.json"
parser = argparse.ArgumentParser()
parser.add_argument("command", choices=["pin", "verify"])
args = parser.parse_args()
volumes = {}
for service in ("bitcoind", "electrs"):
    container = call(COMPOSE + ["ps", "-a", "-q", service]).strip()
    info = json.loads(call(["rtk", "proxy", "docker", "inspect", container]))[0]
    mounts = [m for m in info["Mounts"] if m["Type"] == "volume"]
    if len(mounts) != 1:
        raise ValueError("Expected exactly one existing chain/indexer volume")
    volumes[service] = {"name": mounts[0]["Name"], "target": mounts[0]["Destination"]}
if args.command == "pin" and not record.exists():
    chain = rpc("getblockchaininfo")
    if chain["chain"] != "regtest":
        raise ValueError("Regtest only")
    save(
        record, {"volumes": volumes, "height": chain["blocks"], "blockHash": chain["bestblockhash"]}
    )
    save(
        override,
        {
            "services": {
                s: {
                    "volumes": [
                        {"type": "volume", "source": s + "-existing", "target": v["target"]}
                    ]
                }
                for s, v in volumes.items()
            },
            "volumes": {
                s + "-existing": {"external": True, "name": v["name"]} for s, v in volumes.items()
            },
        },
    )
saved = read(record)
assert saved["volumes"] == volumes, "Chain/indexer mount changed"
assert rpc("getblockhash", saved["height"]) == saved["blockHash"], (
    "Saved chain checkpoint disappeared"
)
evidence = {
    "network": "regtest",
    "volumesUnchanged": True,
    "checkpointHeight": saved["height"],
    "checkpointHash": saved["blockHash"],
    "currentHeight": rpc("getblockcount"),
    "externalVolumeOverride": "infra/state/chain-volumes.compose.json",
}
if args.command == "verify":
    save(ROOT / "scripts/demo/evidence/chain-volumes.json", evidence)
print(json.dumps(evidence))
