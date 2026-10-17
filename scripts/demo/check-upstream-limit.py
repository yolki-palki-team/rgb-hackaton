#!/usr/bin/env python3
"""Minimal real-input reproducer for upstream single-wallet inspection restriction."""
import json
from regtest import STATE, native

package=json.loads((STATE/"ring-unsigned.json").read_text())
try:
    native("upstream-inspect","alice",psbt=package["final"]["psbt"],fascia=package["final"]["fascia"])
except RuntimeError as error:
    expected="found a PSBT input that does not belong to this wallet"
    if expected not in str(error): raise
    print(json.dumps({"sdk":"rgb-lib 0.3.0-beta.7","operation":"inspect_rgb_transfer","expectedLimitation":expected,"observed":True,"signed":False},indent=2))
else:
    raise RuntimeError("upstream behavior changed: inspect and update capability report")
