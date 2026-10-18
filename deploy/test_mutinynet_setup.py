"""Isolated node credentials, chain identity and bootstrap resource guards."""

import hashlib
import hmac
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import mutinynet


class MutinynetSetupTests(unittest.TestCase):
    def test_private_credentials_are_real_matching_rpcauth_and_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "node"
            endpoint = mutinynet.provision(state)
            original = endpoint.read_bytes()
            config = mutinynet.read_private(endpoint)
            core = (state / "bitcoin.conf").read_text()
            auth = next(
                line.split("=", 1)[1] for line in core.splitlines() if line.startswith("rpcauth=")
            )
            username, salted = auth.split(":", 1)
            salt, digest = salted.split("$", 1)
            self.assertEqual(username, config["bitcoinRpcUser"])
            self.assertEqual(
                digest,
                hmac.new(
                    salt.encode(), config["bitcoinRpcPassword"].encode(), hashlib.sha256
                ).hexdigest(),
            )
            self.assertNotIn(config["bitcoinRpcPassword"], core)
            self.assertIn("disablewallet=1", core)
            self.assertIn("signetblocktime=30", core)
            self.assertNotIn("regtest", core)
            self.assertEqual(mutinynet.provision(state), endpoint)
            self.assertEqual(endpoint.read_bytes(), original)
            self.assertEqual(endpoint.stat().st_mode & 0o777, 0o600)
            self.assertEqual((state / "bitcoin.conf").stat().st_mode & 0o777, 0o600)

    def test_incomplete_configuration_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            (state / "bitcoin.conf").write_text("original")
            with self.assertRaisesRegex(ValueError, "Incomplete"):
                mutinynet.provision(state)
            self.assertEqual((state / "bitcoin.conf").read_text(), "original")

    def test_disk_guard_stops_only_isolated_compose_project_before_rpc(self):
        with (
            patch.object(
                mutinynet.shutil,
                "disk_usage",
                return_value=SimpleNamespace(free=mutinynet.MIN_FREE - 1),
            ),
            patch.object(mutinynet, "compose") as compose,
            patch.object(mutinynet, "status") as status,
        ):
            with self.assertRaisesRegex(RuntimeError, "below 10 GiB"):
                mutinynet.monitor({}, 60)
            compose.assert_called_once_with("stop")
            status.assert_not_called()
            self.assertTrue(mutinynet.COMPOSE[-1].endswith("compose.mutinynet.yaml"))

    def test_timeout_stops_node_without_deleting_data(self):
        with (
            patch.object(mutinynet.time, "monotonic", side_effect=[0, 61]),
            patch.object(mutinynet, "compose") as compose,
        ):
            with self.assertRaisesRegex(RuntimeError, "volumes preserved"):
                mutinynet.monitor({}, 60)
            compose.assert_called_once_with("stop")

    def test_ready_requires_checkpoint_complete_core_and_txindex(self):
        info = {
            "chain": "signet",
            "signet_challenge": mutinynet.chain_profile.MUTINYNET_CHALLENGE,
            "blocks": 10,
            "headers": 10,
            "initialblockdownload": False,
            "size_on_disk": 1000,
        }
        for synced in (False, True):
            with patch.object(
                mutinynet.chain_profile,
                "_rpc",
                side_effect=[
                    info,
                    mutinynet.chain_profile.MUTINYNET_CHECKPOINT,
                    {"txindex": {"synced": synced}},
                ],
            ):
                self.assertEqual(mutinynet.status({})["ready"], synced)
        with patch.object(mutinynet.chain_profile, "_rpc", side_effect=[info, "wrong-checkpoint"]):
            with self.assertRaisesRegex(ValueError, "checkpoint"):
                mutinynet.status({})


if __name__ == "__main__":
    unittest.main()
