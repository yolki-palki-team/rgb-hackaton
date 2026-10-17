#!/usr/bin/env python3
"""Export an exact Git ref for integration without switching or modifying the checkout."""

import argparse
import io
import json
import subprocess
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--ref", default="origin/main")
parser.add_argument("--output", required=True)
args = parser.parse_args()
target = Path(args.output).resolve()
if target.exists():
    raise ValueError("Refusing to overwrite an existing source snapshot")
revision = subprocess.check_output(
    ["rtk", "proxy", "git", "rev-parse", "--verify", args.ref + "^{commit}"], text=True
).strip()
archive = subprocess.check_output(["rtk", "proxy", "git", "archive", revision])
target.mkdir(mode=0o700, parents=True)
tarfile.open(fileobj=io.BytesIO(archive)).extractall(target, filter="data")
(target / ".integration-source.json").write_text(
    json.dumps({"gitRevision": revision, "ref": args.ref})
)
print(json.dumps({"source": str(target), "gitRevision": revision, "checkoutChanged": False}))
