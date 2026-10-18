"""Signal tests use synthetic processes and temporary files, never a real wallet."""

import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class WalletLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.operation = self.root / "operation.py"
        self.operation.write_text(
            "from pathlib import Path\nimport time\n"
            "Path('rgb_runtime.lock').touch()\nPath('started').touch()\n"
            "time.sleep(0.5)\nPath('rgb_runtime.lock').unlink()\nPath('finished').touch()\n"
        )

    def spawn(self, code):
        child = subprocess.Popen(
            [sys.executable, "-c", code],
            cwd=self.root,
            env={**os.environ, "PYTHONPATH": str(HERE)},
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self.cleanup_process, child)
        for _ in range(200):
            if (self.root / "started").exists():
                return child
            if child.poll() is not None:
                self.fail(child.communicate()[1])
            time.sleep(0.01)
        self.fail("Synthetic operation did not start")

    @staticmethod
    def cleanup_process(child):
        if child.poll() is None:
            child.kill()
        child.communicate()

    def assert_finished(self, child, expected_code):
        _, error = child.communicate(timeout=10)
        self.assertEqual(child.returncode, expected_code, error)
        self.assertTrue((self.root / "finished").exists())
        self.assertFalse((self.root / "rgb_runtime.lock").exists())

    def test_terminal_interrupt_waits_for_native_cleanup(self):
        child = self.spawn(
            "import sys\nfrom wallet_lifecycle import run_native\n"
            "run_native([sys.executable, 'operation.py'], check=True)\n"
        )
        os.killpg(child.pid, signal.SIGINT)
        os.killpg(child.pid, signal.SIGINT)
        self.assert_finished(child, 130)

    def test_sigterm_waits_for_native_cleanup(self):
        child = self.spawn(
            "import sys\nfrom wallet_lifecycle import run_native\n"
            "run_native([sys.executable, 'operation.py'], check=True)\n"
        )
        child.terminate()
        self.assert_finished(child, 143)

    def test_service_shutdown_finishes_native_operation_and_journal(self):
        # This fake server follows HTTPServer's shutdown/serve_forever synchronization.
        service = self.root / "service.py"
        service.write_text(
            "import sys, threading\nfrom pathlib import Path\n"
            "from wallet_lifecycle import run_native, serve_until_stopped\n"
            "class Server:\n"
            " def __init__(self): self.stop = threading.Event(); self.done = threading.Event()\n"
            " def shutdown(self): self.stop.set(); self.done.wait()\n"
            " def serve_forever(self, **kwargs):\n"
            "  run_native([sys.executable, 'operation.py'], check=True)\n"
            "  Path('journal-saved').touch()\n"
            "  self.stop.wait(5); self.done.set()\n"
            " def server_close(self): Path('server-closed').touch()\n"
            "serve_until_stopped(Server())\n"
        )
        child = self.spawn(
            "import sys\nfrom pathlib import Path\nfrom wallet_lifecycle import run_service\n"
            "result = run_service([sys.executable, 'service.py'])\n"
            "assert Path('journal-saved').exists()\n"
            "Path('adapters-closed').touch()\nsys.exit(result)\n"
        )
        os.killpg(child.pid, signal.SIGINT)
        child.terminate()
        self.assert_finished(child, 0)
        for marker in ("journal-saved", "server-closed", "adapters-closed"):
            self.assertTrue((self.root / marker).exists())


if __name__ == "__main__":
    unittest.main()
