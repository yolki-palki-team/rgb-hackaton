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

    def launch(self):
        return subprocess.run(
            ["/bin/bash", str(self.root / "deploy/desktop.sh")],
            env=self.env,
            capture_output=True,
            text=True,
        )

    def test_pinned_toolchain_overrides_standalone_cargo_and_reaches_launch(self):
        result = self.launch()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text()
        self.assertNotIn("OLD CARGO", commands)
        self.assertLess(commands.index("rustup show active-toolchain"), commands.index("npm ci"))
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
