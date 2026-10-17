"""Offline verification of pinned SDK reuse and corruption handling."""

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "bootstrap_native", Path(__file__).with_name("bootstrap-native.py")
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        for name in bootstrap.CONTENTS:
            if name in ("src", "migration"):
                (self.source / name).mkdir()
            else:
                (self.source / name).write_text(name)
        (self.source / "src/wallet").mkdir()
        (self.source / "src/wallet/rust_only.rs").write_text("original-source")
        native = self.root / "packages/wallet/native"
        native.mkdir(parents=True)
        self.extension = b"reviewed-bridge"
        (native / "extension.rs").write_bytes(self.extension)
        self.dest = native / "vendor/rgb-lib"
        self.git = patch.object(
            bootstrap, "run", side_effect=lambda *args: bootstrap.REV if "rev-parse" in args else ""
        )
        self.git.start()
        self.addCleanup(self.git.stop)

    def materialize(self, extension=None):
        bootstrap.materialize(self.source, self.dest, extension or self.extension, refresh=True)

    def test_unchanged_restart_uses_verified_cache_without_git_or_download(self):
        self.materialize()
        with (
            patch.object(bootstrap, "ROOT", self.root),
            patch("sys.argv", ["bootstrap-native.py", "--refresh"]),
            patch.object(
                bootstrap, "run", side_effect=AssertionError("Unexpected Git/network use")
            ),
        ):
            bootstrap.main()

    def test_bridge_update_verifies_old_files_before_refresh(self):
        self.materialize()
        self.assertFalse(bootstrap.cached_sdk(self.dest, hashlib.sha256(b"new-bridge").hexdigest()))
        self.materialize(b"new-bridge")
        self.assertTrue(bootstrap.cached_sdk(self.dest, hashlib.sha256(b"new-bridge").hexdigest()))

    def test_changed_or_missing_vendor_files_cannot_be_trusted_or_overwritten(self):
        for damage in ("change", "delete", "extra"):
            with self.subTest(damage=damage):
                self.dest = self.root / damage
                self.materialize()
                if damage == "change":
                    (self.dest / "Cargo.toml").write_text("unexpected-edit")
                elif damage == "delete":
                    (self.dest / "Cargo.toml").unlink()
                else:
                    (self.dest / "unexpected.rs").write_text("extra")
                self.assertFalse(
                    bootstrap.cached_sdk(self.dest, hashlib.sha256(self.extension).hexdigest())
                )
                with self.assertRaises(RuntimeError):
                    self.materialize()

    def test_legacy_cache_is_verified_once_before_recording_manifest(self):
        self.materialize()
        (self.dest / bootstrap.CACHE).unlink()
        self.assertFalse(
            bootstrap.cached_sdk(self.dest, hashlib.sha256(self.extension).hexdigest())
        )
        self.materialize()
        self.assertTrue(bootstrap.cached_sdk(self.dest, hashlib.sha256(self.extension).hexdigest()))


if __name__ == "__main__":
    unittest.main()
