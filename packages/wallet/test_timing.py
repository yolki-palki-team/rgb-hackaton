"""Synthetic RPC timing checks; no wallet or settlement operations run."""

import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from server import create_server


class TimingTests(unittest.TestCase):
    def request(self, method="state", *, enabled=None, error=None, authorized=True, output=None):
        token = "synthetic-test-token-32-characters-only"
        output = io.StringIO() if output is None else output
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ):
            os.environ.pop("PALKA_TIMINGS", None)
            if enabled is not None:
                os.environ["PALKA_TIMINGS"] = enabled
            backend = SimpleNamespace(
                root=Path(tmp), handle=Mock(return_value={"fixtureOnly": True}, side_effect=error)
            )
            with (
                create_server(backend, token, 0) as server,
                patch("server.sys.stderr", output),
                patch("server.time.perf_counter", side_effect=[10, 10.125]) as timer,
            ):
                server.timeout = 5
                thread = threading.Thread(target=server.handle_request, daemon=True)
                thread.start()
                body = json.dumps(
                    {
                        "protocolVersion": 1,
                        "requestId": "private-request-id",
                        "method": method,
                        "params": {"private": "synthetic-policy-and-amount-123"},
                    }
                ).encode()
                headers = {"Authorization": "Bearer " + token} if authorized else {}
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/rpc", body, headers
                )
                try:
                    try:
                        response = urllib.request.urlopen(request, timeout=5)
                    except urllib.error.HTTPError as rejected:
                        response = rejected
                    with response:
                        result = json.load(response)
                finally:
                    thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
        return result, output.getvalue(), timer, backend.handle

    def test_disabled_by_default_and_requires_exact_opt_in(self):
        for enabled in (None, "0", "true"):
            with self.subTest(enabled=enabled):
                result, output, timer, _ = self.request(enabled=enabled)
                self.assertEqual(result["result"], {"fixtureOnly": True})
                self.assertEqual(output, "")
                timer.assert_not_called()

    def test_enabled_logs_only_fixed_method_duration_and_outcome(self):
        result, output, _, _ = self.request(enabled="1")
        self.assertEqual(result["result"], {"fixtureOnly": True})
        self.assertEqual(
            json.loads(output),
            {"event": "wallet_rpc", "method": "state", "durationMs": 125.0, "outcome": "ok"},
        )

    def test_unknown_method_and_error_text_are_redacted(self):
        for method in ("private-token\nmalicious-method", {"private": "method-object"}):
            with self.subTest(method=method):
                result, output, _, _ = self.request(
                    method, enabled="1", error=ValueError("private-path-and-exception-text")
                )
                self.assertEqual(result["error"]["code"], "WALLET_REJECTED")
                self.assertEqual(
                    json.loads(output),
                    {
                        "event": "wallet_rpc",
                        "method": "unknown",
                        "durationMs": 125.0,
                        "outcome": "WALLET_REJECTED",
                    },
                )

    def test_unauthenticated_request_has_no_timing(self):
        result, output, timer, handle = self.request(enabled="1", authorized=False)
        self.assertEqual(result, {"error": "UNAUTHORIZED"})
        self.assertEqual(output, "")
        timer.assert_not_called()
        handle.assert_not_called()

    def test_stderr_failure_does_not_change_wallet_result(self):
        output = io.StringIO()
        with patch.object(output, "write", side_effect=OSError("synthetic stderr failure")):
            result, _, _, _ = self.request(enabled="1", output=output)
        self.assertEqual(result["result"], {"fixtureOnly": True})


if __name__ == "__main__":
    unittest.main()
