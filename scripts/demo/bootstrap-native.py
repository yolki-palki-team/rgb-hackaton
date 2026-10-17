#!/usr/bin/env python3
"""Materialize the exact upstream source plus the reviewed local bridge."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
REV = "1eaf0024c591e41843eb80cc8834082292668871"
def run(*args):
    return subprocess.check_output(["rtk", "proxy", *args], text=True).strip()

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path)
    args = p.parse_args()
    source = args.source
    if source is None:
        source = Path(tempfile.mkdtemp(prefix="rgb-upstream-")) / "rgb-lib"
        run("git", "clone", "https://github.com/RGB-Tools/rgb-lib", str(source))
        run("git", "-C", str(source), "checkout", "--detach", REV)
    if run("git", "-C", str(source), "rev-parse", "HEAD") != REV or run("git", "-C", str(source), "status", "--porcelain"):
        raise RuntimeError("expected clean pinned upstream source")
    native = ROOT / "packages/wallet/native"
    extension = (native / "extension.rs").read_bytes()
    dest = native / "vendor/rgb-lib"
    marker = dest / ".project-bridge-sha256"
    digest = hashlib.sha256(extension).hexdigest()
    if dest.exists():
        if marker.exists() and marker.read_text().strip() == digest:
            print("Pinned SDK and bridge already materialized")
            return
        raise RuntimeError("Existing vendor differs; inspect it before replacing")
    dest.mkdir(parents=True)
    for name in ("Cargo.toml", "Cargo.lock", "LICENSE", "README.md", "src", "migration"):
        src = source / name
        if src.is_dir():
            shutil.copytree(src, dest / name)
        else:
            shutil.copy2(src, dest / name)
    with (dest / "src/wallet/rust_only.rs").open("ab") as f:
        f.write(b"\n" + extension)
    marker.write_text(digest + "\n")
    print(f"rgb-lib {REV}; local bridge sha256 {digest}")

if __name__ == "__main__":
    main()
