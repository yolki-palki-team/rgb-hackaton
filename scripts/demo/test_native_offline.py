"""Receive setup must work during IBD without enabling transaction operations."""

import json
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import chain_profile
import desktop_wallet

import regtest


class NativeOfflineTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.config = {
            "indexerUrl": "https://indexer.example/api",
            "rgbProxyUrl": "https://proxy.example",
        }
        self.wrappers = (
            lambda op: regtest.native(op, "alice", network="regtest", signetChallenge="wrong"),
            lambda op: desktop_wallet.native(
                Path("/synthetic-state"), op, network="regtest", signetChallenge="wrong"
            ),
        )

    def test_receive_setup_and_sdk_health_do_not_require_synchronized_core(self):
        with (
            patch.object(chain_profile, "configuration", return_value=self.config),
            patch.object(
                chain_profile, "check_chain", side_effect=ValueError("Core is syncing")
            ) as checked,
            patch("subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="{}")) as run,
        ):
            for wrapper in self.wrappers:
                for operation in ("init", "identity", "addresses", "health", "capabilities"):
                    with self.subTest(wrapper=wrapper, operation=operation):
                        wrapper(operation)
                        request = json.loads(run.call_args.kwargs["input"])
                        self.assertEqual(request["network"], "signetcustom")
                        self.assertEqual(
                            request["signetChallenge"], chain_profile.MUTINYNET_CHALLENGE
                        )
                        if operation != "capabilities":
                            self.assertEqual(
                                run.call_args.kwargs["env"]["RGB_INDEXER_URL"],
                                self.config["indexerUrl"],
                            )
            checked.assert_not_called()

    def test_transaction_and_readiness_operations_remain_blocked_before_native_execution(self):
        with (
            patch.object(chain_profile, "configuration", return_value=self.config),
            patch.object(
                chain_profile, "check_chain", side_effect=ValueError("Core is syncing")
            ) as checked,
            patch("subprocess.run") as run,
        ):
            for wrapper in self.wrappers:
                for operation in (
                    "state",
                    "check-index",
                    "issue",
                    "preflight-sign",
                    "sign",
                    "sync-confirmed",
                    "unknown",
                ):
                    with self.subTest(wrapper=wrapper, operation=operation):
                        with self.assertRaisesRegex(ValueError, "Core is syncing"):
                            wrapper(operation)
            self.assertEqual(checked.call_count, 14)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
