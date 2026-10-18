"""Identity and recovery checks for independent desktop wallet setup."""

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import desktop_wallet
from desktop_wallet import SLOT, initialize, read_private, save_private


class DesktopWalletTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"PALKA_NETWORK": "regtest"})
        environment.start()
        self.addCleanup(environment.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config_path = self.root / "desktop-config.json"
        token = "a" * 64
        self.config = {
            "ownerId": "participant-"
            + hashlib.sha256(("palka-participant-v1:" + token).encode()).hexdigest(),
            "marketToken": token,
            "marketRegistration": "automatic",
            "marketIdentityOrigin": "https://api.owlpeer.com",
            "marketUrl": "https://api.owlpeer.com",
            "walletRpcUrl": "http://127.0.0.1:4201",
            "walletRpcToken": "",
            "walletMode": "real",
            "port": 4211,
        }
        save_private(self.config_path, self.config)
        self.initializations = 0

    def native(self, state, operation):
        if operation == "init":
            self.initializations += 1
            (state / SLOT / "keys.json").write_text("synthetic-keys")
            return {}
        self.assertEqual(operation, "identity")
        return {"network": "regtest", "fingerprint": "synthetic-fingerprint"}

    def initialize(self):
        return initialize(self.config_path, self.root, self.native)

    def test_restart_keeps_keys_tokens_identity_and_original_config_backup(self):
        state = self.initialize()
        saved = read_private(self.config_path)
        self.assertEqual(len(saved["walletRpcToken"]), 64)
        self.assertEqual(saved | {"walletRpcToken": ""}, self.config)
        self.assertEqual(self.initialize(), state)
        self.assertEqual(read_private(self.config_path), saved)
        self.assertEqual(self.initializations, 1)
        self.assertEqual((state / SLOT / "keys.json").read_text(), "synthetic-keys")
        self.assertEqual(
            read_private(self.config_path.with_name("desktop-config.before-wallet.json")),
            self.config,
        )
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)

    def test_lost_keys_never_create_replacement_wallet(self):
        state = self.initialize()
        (state / SLOT / "keys.json").unlink()
        with self.assertRaisesRegex(ValueError, "keys are missing"):
            self.initialize()
        self.assertEqual(self.initializations, 1)

    def test_legacy_identity_and_existing_sidecar_are_not_reassigned(self):
        save_private(self.config_path, self.config | {"ownerId": "alice"})
        with self.assertRaisesRegex(ValueError, "Legacy wallets"):
            self.initialize()
        save_private(self.config_path, self.config | {"walletRpcToken": "original-token"})
        with self.assertRaisesRegex(ValueError, "refusing to replace"):
            self.initialize()
        self.assertEqual(self.initializations, 0)

    def test_interrupted_config_update_reuses_initialized_wallet_and_token(self):
        state = self.initialize()
        token = read_private(self.config_path)["walletRpcToken"]
        save_private(self.config_path, self.config)
        self.assertEqual(self.initialize(), state)
        self.assertEqual(read_private(self.config_path)["walletRpcToken"], token)
        self.assertEqual(self.initializations, 1)

    def test_changed_fingerprint_fails_without_replacing_config(self):
        self.initialize()
        saved = self.config_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "fingerprint changed"):
            initialize(
                self.config_path,
                self.root,
                lambda *_: {"network": "regtest", "fingerprint": "other-wallet"},
            )
        self.assertEqual(self.config_path.read_bytes(), saved)

    def test_completed_automatic_profile_uses_verified_start_without_reinitialization(self):
        state = self.initialize()
        save_private(state / "automatic-ready.json", {"ownerId": self.config["ownerId"]})
        saved = self.config_path.read_bytes()
        with (
            patch.object(desktop_wallet.os, "umask"),
            patch("sys.argv", ["desktop_wallet.py", "auto", "--desktop-data-dir", str(self.root)]),
            patch.object(
                desktop_wallet,
                "settings",
                return_value=(read_private(self.config_path), state, 4201),
            ),
            patch.object(
                desktop_wallet, "initialize", side_effect=AssertionError("Unexpected setup")
            ),
            patch.object(desktop_wallet, "start") as start,
        ):
            desktop_wallet.main()
            start.assert_called_once_with(self.config_path.resolve())
        self.assertEqual(self.config_path.read_bytes(), saved)

    def test_fast_start_still_rejects_wrong_fingerprint_or_missing_keys(self):
        state = self.initialize()
        config = read_private(self.config_path)
        with (
            patch.object(desktop_wallet, "settings", return_value=(config, state, 4201)),
            patch.object(
                desktop_wallet,
                "native",
                return_value={"network": "regtest", "fingerprint": "wrong"},
            ),
        ):
            with self.assertRaisesRegex(ValueError, "identity changed"):
                desktop_wallet.start(self.config_path)
            (state / SLOT / "keys.json").unlink()
            with self.assertRaisesRegex(ValueError, "configuration mismatch"):
                desktop_wallet.start(self.config_path)

    def test_assigned_token_is_issued_locally_and_published_on_retry(self):
        state = self.initialize()
        config = read_private(self.config_path)
        save_private(state / "shared-network.json", {"synthetic": True})
        args = SimpleNamespace(command="issue", asset="T000001")
        calls = []
        publication = {"contractId": "rgb:unique", "contract": "eA=="}

        def native(_state, operation, **kwargs):
            calls.append((operation, kwargs))
            if operation == "identity":
                return {"fingerprint": "synthetic-fingerprint"}
            if operation == "state":
                return {"unspents": [{"utxo": {"colorable": True}}]}
            if operation == "issue":
                self.assertEqual(kwargs, {"ticker": "T000001", "amount": "1000"})
                return {"asset_id": "rgb:unique"}
            if operation == "catalog-export":
                return {"contract": "eA=="}
            if operation == "catalog-import":
                return {"contractId": "rgb:unique"}
            raise AssertionError(operation)

        with (
            patch.object(desktop_wallet, "settings", return_value=(config, state, 4201)),
            patch.object(desktop_wallet, "native", side_effect=native),
            patch("chain_transport.Client") as client_class,
            patch("chain_transport.Adapters"),
            patch("chain_transport.environment", return_value={}),
            patch("builtins.print"),
        ):
            client = client_class.return_value
            client.request.side_effect = lambda _path, request: (
                {"T000001": publication} if not request else {}
            )
            for _ in range(2):
                desktop_wallet.network_command(self.config_path, args)
            client.request.assert_any_call(
                "/catalog", {"ticker": "T000001", "ownerId": config["ownerId"], **publication}
            )
            calls.clear()
            client.request.side_effect = ValueError("This asset already has an issuer")
            with self.assertRaisesRegex(ValueError, "issuer"):
                desktop_wallet.network_command(self.config_path, args)
            self.assertNotIn("issue", [operation for operation, _ in calls])

    def test_mutinynet_has_separate_state_and_never_uses_shared_regtest_onboarding(self):
        regtest_state = desktop_wallet.settings(self.config_path, self.root)[1]
        save_private(self.config_path, {**self.config, "network": "signetcustom"})
        with patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"}):
            state = desktop_wallet.settings(self.config_path, self.root)[1]
            self.assertNotEqual(state, regtest_state)
            self.assertEqual(state.parent.name, "mutinynet")
            with self.assertRaisesRegex(ValueError, "Shared regtest onboarding"):
                desktop_wallet.network_command(self.config_path, SimpleNamespace(command="fund"))
            with patch.object(
                desktop_wallet, "native", side_effect=RuntimeError("RGB indexer unavailable")
            ):
                with self.assertRaisesRegex(RuntimeError, "RGB indexer unavailable"):
                    initialize(self.config_path, self.root, desktop_wallet.native)
            self.assertFalse(state.exists())

    def test_mutinynet_auto_starts_existing_wallet_without_bootstrap_or_reinitialization(self):
        save_private(
            self.config_path,
            {**self.config, "network": "signetcustom", "walletRpcToken": "synthetic-token"},
        )
        with patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"}):
            config, state, _ = desktop_wallet.settings(self.config_path, self.root)
            state.mkdir(parents=True)
            save_private(
                state / "desktop-wallet.json",
                {"initialized": True, "walletRpcToken": "synthetic-token"},
            )
            with (
                patch(
                    "sys.argv", ["desktop_wallet.py", "auto", "--desktop-data-dir", str(self.root)]
                ),
                patch.object(desktop_wallet, "settings", return_value=(config, state, 4201)),
                patch.object(desktop_wallet, "initialize") as initialize_wallet,
                patch.object(desktop_wallet, "start") as start,
                patch.object(desktop_wallet.http.client, "HTTPSConnection") as connection,
            ):
                desktop_wallet.main()
                initialize_wallet.assert_not_called()
                connection.assert_not_called()
                start.assert_called_once_with(self.config_path.resolve())

    def test_mutinynet_auto_recovers_interrupted_config_write(self):
        save_private(self.config_path, {**self.config, "network": "signetcustom"})
        with patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"}):
            config, state, _ = desktop_wallet.settings(self.config_path, self.root)
            state.mkdir(parents=True)
            save_private(
                state / "desktop-wallet.json",
                {"initialized": True, "walletRpcToken": "synthetic-token"},
            )
            with (
                patch(
                    "sys.argv", ["desktop_wallet.py", "auto", "--desktop-data-dir", str(self.root)]
                ),
                patch.object(desktop_wallet, "settings", return_value=(config, state, 4201)),
                patch.object(desktop_wallet, "initialize") as initialize_wallet,
                patch.object(desktop_wallet, "start") as start,
                patch.object(desktop_wallet.http.client, "HTTPSConnection") as connection,
            ):
                desktop_wallet.main()
                initialize_wallet.assert_called_once_with(self.config_path.resolve())
                start.assert_called_once_with(self.config_path.resolve())
                connection.assert_not_called()

    def test_mutinynet_initialization_checks_sdk_before_keys_and_preserves_network(self):
        save_private(self.config_path, {**self.config, "network": "signetcustom"})
        operations = []

        def native(state, operation):
            operations.append(operation)
            if operation == "health":
                self.assertFalse((state / SLOT / "keys.json").exists())
                return {"network": "signetcustom"}
            return {**self.native(state, operation), "network": "signetcustom"}

        with patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"}):
            state = initialize(self.config_path, self.root, native)
            self.assertEqual(operations, ["health", "init", "identity"])
            self.assertEqual(read_private(state / "desktop-wallet.json")["network"], "signetcustom")
            self.assertEqual(read_private(self.config_path)["network"], "signetcustom")

    def test_mutinynet_rejects_unrebuilt_regtest_binary_before_creating_keys(self):
        save_private(self.config_path, {**self.config, "network": "signetcustom"})
        with patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"}):
            state = desktop_wallet.settings(self.config_path, self.root)[1]
            with self.assertRaisesRegex(ValueError, "Rebuild the native wallet"):
                initialize(self.config_path, self.root, lambda *_: {"network": "regtest"})
            self.assertFalse(state.exists())

    def test_network_mismatch_preserves_existing_desktop_configuration(self):
        saved = self.config_path.read_bytes()
        with patch.dict(os.environ, {"PALKA_NETWORK": "mutinynet"}):
            with self.assertRaisesRegex(ValueError, "Desktop network differs"):
                self.initialize()
        self.assertEqual(self.config_path.read_bytes(), saved)


if __name__ == "__main__":
    unittest.main()
