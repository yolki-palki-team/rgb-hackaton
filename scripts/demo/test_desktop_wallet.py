"""Identity and recovery checks for independent desktop wallet setup."""

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import desktop_wallet
from desktop_wallet import SLOT, initialize, read_private, save_private


class DesktopWalletTests(unittest.TestCase):
    def setUp(self):
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


if __name__ == "__main__":
    unittest.main()
