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
    p.add_argument("--refresh", action="store_true", help="Refresh only a generated SDK whose existing files match the pinned source and recorded bridge")
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
        if args.refresh and marker.exists():
            original=(source/"src/wallet/rust_only.rs").read_bytes()+b"\n"
            current=(dest/"src/wallet/rust_only.rs").read_bytes()
            if not current.startswith(original) or hashlib.sha256(current[len(original):]).hexdigest()!=marker.read_text().strip():
                raise RuntimeError("generated bridge has unrecorded edits; refusing refresh")
            for path in dest.rglob("*"):
                if not path.is_file(): continue
                rel=path.relative_to(dest)
                if str(rel) in (".project-bridge-sha256","src/wallet/rust_only.rs"):continue
                if not (source/rel).is_file() or path.read_bytes()!=(source/rel).read_bytes():
                    raise RuntimeError(f"generated SDK differs from pin: {rel}")
            (dest/"src/wallet/rust_only.rs").write_bytes(original+extension)
            marker.write_text(digest+"\n")
            print("Refreshed verified generated bridge")
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
