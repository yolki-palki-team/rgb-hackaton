import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


class DesktopLauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "deploy").mkdir()
        shutil.copy(Path(__file__).with_name("desktop.sh"), self.root / "deploy/desktop.sh")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.cargo_bin = self.root / "cargo/bin"
        self.cargo_bin.mkdir(parents=True)
        self.toolchain = self.root / "toolchain/bin"
        self.toolchain.mkdir(parents=True)
        self.log = self.root / "commands.log"
        self.env = {
            **os.environ,
            "PATH": str(self.bin),
            "CARGO_HOME": str(self.cargo_bin.parent),
            "COMMAND_LOG": str(self.log),
            "TOOLCHAIN_BIN": str(self.toolchain),
            "PALKA_NETWORK": "regtest",
            "PALKA_MUTINYNET_CONFIG": "",
        }
        for command in ("git", "node", "npm", "uv"):
            self.executable(self.bin / command, f'echo "{command} $*" >> "$COMMAND_LOG"')
        self.executable(self.bin / "cargo", 'echo "OLD CARGO" >> "$COMMAND_LOG"; exit 99')
        self.executable(
            self.cargo_bin / "rustup",
            """echo "rustup $*" >> "$COMMAND_LOG"
if [[ "$1" == which ]]; then echo "$TOOLCHAIN_BIN/cargo"; fi""",
        )
        for command in ("cargo", "rustc"):
            self.executable(
                self.toolchain / command, f'echo "selected {command} $*" >> "$COMMAND_LOG"'
            )

    def executable(self, path, body):
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def launch(self, *args):
        return subprocess.run(
            ["/bin/bash", str(self.root / "deploy/desktop.sh"), *args],
            env=self.env,
            capture_output=True,
            text=True,
        )

    def test_pinned_toolchain_overrides_standalone_cargo_and_reaches_launch(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text()
        self.assertNotIn("OLD CARGO", commands)
        self.assertLess(
            commands.index("rustup show active-toolchain"),
            commands.index("node deploy/desktop-dependencies.mjs"),
        )
        self.assertIn("selected cargo build --locked", commands)
        self.assertIn("npm run dev:desktop", commands)

    def test_standalone_cargo_without_rustup_has_actionable_error(self):
        (self.cargo_bin / "rustup").unlink()
        result = self.launch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("https://rustup.rs", result.stderr)
        self.assertFalse(self.log.exists())

    def test_failed_toolchain_install_stops_before_dependency_installation(self):
        self.executable(self.cargo_bin / "rustup", "exit 42")
        result = self.launch()
        self.assertEqual(result.returncode, 42)
        self.assertFalse(self.log.exists())

    def test_mutinynet_requires_explicit_endpoints_before_downloads(self):
        result = self.launch("--network", "mutinynet")
        self.assertEqual(result.returncode, 2)
        self.assertIn("PALKA_MUTINYNET_CONFIG", result.stderr)
        self.assertFalse(self.log.exists())

    def test_mutinynet_runs_sdk_preflight_before_desktop(self):
        self.env["PALKA_MUTINYNET_CONFIG"] = "/private/synthetic-endpoints.json"
        result = self.launch("--network", "mutinynet")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text()
        self.assertIn("python scripts/demo/chain_profile.py --allow-syncing", commands)
        self.assertLess(
            commands.index("python scripts/demo/chain_profile.py"),
            commands.index("npm run dev:desktop"),
        )

    def test_unknown_network_does_not_start_dependency_installation(self):
        result = self.launch("--network", "testnet3")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.log.exists())
