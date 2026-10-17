#!/usr/bin/env python3
"""Materialize the exact upstream source plus the reviewed local bridge."""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REV = "1eaf0024c591e41843eb80cc8834082292668871"
CONTENTS = ("Cargo.toml", "Cargo.lock", "LICENSE", "README.md", "src", "migration")
CACHE = ".project-materialization.json"


def run(*args):
    return subprocess.check_output([*args], text=True).strip()


def inventory(directory):
    result = {}
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise RuntimeError("Generated SDK must not contain symlinks")
        if path.is_file() and path.name != CACHE:
            result[str(path.relative_to(directory))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def cached_sdk(dest, digest):
    try:
        cached = json.loads((dest / CACHE).read_text())
        return (
            cached["revision"] == REV
            and cached["bridge"] == digest
            and cached["files"] == inventory(dest)
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def record_cache(dest, digest):
    (dest / CACHE).write_text(
        json.dumps({"revision": REV, "bridge": digest, "files": inventory(dest)}, sort_keys=True)
        + "\n"
    )


def verify_generated(source, dest, previous_digest):
    expected = set()
    for name in CONTENTS:
        path = source / name
        if path.is_dir():
            expected.update(
                str(item.relative_to(source)) for item in path.rglob("*") if item.is_file()
            )
        else:
            expected.add(name)
    actual = set(inventory(dest)) - {".project-bridge-sha256"}
    if actual != expected:
        raise RuntimeError("Generated SDK file inventory differs from pin; refusing refresh")
    for rel in expected:
        original = (source / rel).read_bytes()
        current = (dest / rel).read_bytes()
        if rel == "src/wallet/rust_only.rs":
            original += b"\n"
            valid = (
                current.startswith(original)
                and hashlib.sha256(current[len(original) :]).hexdigest() == previous_digest
            )
        else:
            valid = current == original
        if not valid:
            raise RuntimeError(f"Generated SDK differs from pin: {rel}")


def materialize(source, dest, extension, refresh=False):
    if run("git", "-C", str(source), "rev-parse", "HEAD") != REV or run(
        "git", "-C", str(source), "status", "--porcelain"
    ):
        raise RuntimeError("expected clean pinned upstream source")
    marker = dest / ".project-bridge-sha256"
    digest = hashlib.sha256(extension).hexdigest()
    if dest.exists():
        previous_digest = marker.read_text().strip() if marker.exists() else None
        if previous_digest is None or (previous_digest != digest and not refresh):
            raise RuntimeError("Existing vendor differs; inspect it before replacing")
        verify_generated(source, dest, previous_digest)
        if previous_digest != digest:
            original = (source / "src/wallet/rust_only.rs").read_bytes() + b"\n"
            (dest / "src/wallet/rust_only.rs").write_bytes(original + extension)
            marker.write_text(digest + "\n")
        record_cache(dest, digest)
        print("Verified pinned SDK and local bridge")
        return
    dest.mkdir(parents=True)
    for name in CONTENTS:
        src = source / name
        if src.is_dir():
            shutil.copytree(src, dest / name)
        else:
            shutil.copy2(src, dest / name)
    with (dest / "src/wallet/rust_only.rs").open("ab") as stream:
        stream.write(b"\n" + extension)
    marker.write_text(digest + "\n")
    record_cache(dest, digest)
    print(f"rgb-lib {REV}; local bridge sha256 {digest}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", type=Path)
    p.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh only a generated SDK whose existing files match the pinned source and recorded bridge",
    )
    args = p.parse_args()
    native = ROOT / "packages/wallet/native"
    extension = (native / "extension.rs").read_bytes()
    dest = native / "vendor/rgb-lib"
    digest = hashlib.sha256(extension).hexdigest()
    if args.source is None and cached_sdk(dest, digest):
        print("Verified cached SDK and bridge; no download needed")
        return
    if args.source is not None:
        materialize(args.source, dest, extension, args.refresh)
        return
    with tempfile.TemporaryDirectory(prefix="rgb-upstream-") as temporary:
        source = Path(temporary) / "rgb-lib"
        run("git", "init", str(source))
        run(
            "git",
            "-C",
            str(source),
            "remote",
            "add",
            "origin",
            "https://github.com/RGB-Tools/rgb-lib",
        )
        run("git", "-C", str(source), "fetch", "--depth=1", "origin", REV)
        run("git", "-C", str(source), "checkout", "--detach", "FETCH_HEAD")
        materialize(source, dest, extension, args.refresh)


if __name__ == "__main__":
    main()
