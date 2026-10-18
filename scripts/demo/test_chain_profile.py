"""Isolated Mutinynet selection, RPC guards and endpoint privacy checks."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import chain_profile

import regtest


class ChainProfileTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "mutinynet.json"
        self.config = {
            "bitcoinRpcUrl": "http://127.0.0.1:38332",
            "bitcoinRpcUser": "test-user",
            "bitcoinRpcPassword": "synthetic-password",
            "indexerUrl": "127.0.0.1:51002",
            "rgbProxyUrl": "http://127.0.0.1:53002/json-rpc",
        }
        self.path.write_text(json.dumps(self.config))
        self.path.chmod(0o600)
        self.env = patch.dict(
            os.environ,
            {"PALKA_NETWORK": "mutinynet", "PALKA_MUTINYNET_CONFIG": str(self.path)},
            clear=True,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.chain = {
            "chain": "signet",
            "signet_challenge": chain_profile.MUTINYNET_CHALLENGE,
            "initialblockdownload": False,
            "blocks": 100,
        }

    def test_explicit_custom_signet_and_unchanged_regtest_default(self):
        self.assertEqual(
            chain_profile.native_context(),
            {"network": "signetcustom", "signetChallenge": chain_profile.MUTINYNET_CHALLENGE},
        )
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(chain_profile.native_context(), {"network": "regtest"})
            self.assertEqual(chain_profile.native_environment(), {})
        with patch.dict(os.environ, {"PALKA_NETWORK": "testnet"}):
            with self.assertRaisesRegex(ValueError, "PALKA_NETWORK"):
                chain_profile.network()

    def test_endpoint_configuration_is_private_explicit_and_no_regtest_invitation(self):
        self.assertEqual(chain_profile.configuration(), self.config)
        self.assertEqual(
            chain_profile.native_environment()["RGB_INDEXER_URL"], self.config["indexerUrl"]
        )
        self.path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "private regular file"):
            chain_profile.configuration()
        self.path.chmod(0o600)
        with patch.dict(os.environ, {"PALKA_CHAIN_CONFIG": "regtest-invite.json"}):
            with self.assertRaisesRegex(ValueError, "regtest invitation"):
                chain_profile.configuration()
        for url in ("http://remote.example/rpc", "https://user:secret@example.com"):
            self.path.write_text(json.dumps({**self.config, "bitcoinRpcUrl": url}))
            with self.assertRaisesRegex(ValueError, "HTTPS or loopback HTTP"):
                chain_profile.configuration()

    def test_default_signet_wrong_checkpoint_and_unsynced_core_are_rejected(self):
        for change in (
            {"chain": "regtest"},
            {"signet_challenge": "default-signet"},
            {"initialblockdownload": True},
        ):
            with patch.object(
                chain_profile, "_rpc", return_value={**self.chain, **change}
            ) as request:
                with self.assertRaises(ValueError):
                    chain_profile.check_chain(self.config)
                self.assertEqual(request.call_count, 1)
        with patch.object(chain_profile, "_rpc", side_effect=[self.chain, "wrong-checkpoint"]):
            with self.assertRaisesRegex(ValueError, "checkpoint mismatch"):
                chain_profile.check_chain(self.config)

    def test_receive_only_preflight_allows_syncing_but_still_checks_exact_chain(self):
        syncing = {**self.chain, "initialblockdownload": True}
        with patch.object(
            chain_profile, "_rpc", side_effect=[syncing, chain_profile.MUTINYNET_CHECKPOINT]
        ):
            self.assertEqual(chain_profile.check_chain(self.config, allow_syncing=True), syncing)
        with patch.object(chain_profile, "_rpc", side_effect=[syncing, "another-signet"]):
            with self.assertRaisesRegex(ValueError, "checkpoint mismatch"):
                chain_profile.check_chain(self.config, allow_syncing=True)
        with (
            patch("sys.argv", ["chain_profile.py", "--allow-syncing"]),
            patch.object(
                chain_profile,
                "_rpc",
                side_effect=[
                    syncing,
                    chain_profile.MUTINYNET_CHECKPOINT,
                    {"txindex": {"synced": False}},
                ],
            ),
            patch.object(regtest, "native", return_value={"network": "signetcustom"}),
            patch("builtins.print") as output,
        ):
            chain_profile.main()
            result = json.loads(output.call_args.args[0])
            self.assertFalse(result["ready"])
            self.assertTrue(result["initialBlockDownload"])
            self.assertFalse(result["txindexSynced"])

    def test_receive_only_preflight_still_requires_configured_txindex(self):
        with (
            patch("sys.argv", ["chain_profile.py", "--allow-syncing"]),
            patch.object(
                chain_profile,
                "_rpc",
                side_effect=[
                    {**self.chain, "initialblockdownload": True},
                    chain_profile.MUTINYNET_CHECKPOINT,
                    {},
                ],
            ),
        ):
            with self.assertRaisesRegex(ValueError, "txindex=1"):
                chain_profile.main()

    def test_broadcast_follows_chain_validation_once_and_never_retries(self):
        with patch.object(
            chain_profile,
            "_rpc",
            side_effect=[self.chain, chain_profile.MUTINYNET_CHECKPOINT, RuntimeError("uncertain")],
        ) as request:
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                chain_profile.rpc("sendrawtransaction", "synthetic-tx")
            self.assertEqual(
                [c.args[1] for c in request.call_args_list],
                ["getblockchaininfo", "getblockhash", "sendrawtransaction"],
            )
        with patch.object(
            chain_profile, "_rpc", return_value={**self.chain, "signet_challenge": "wrong"}
        ) as request:
            with self.assertRaises(ValueError):
                chain_profile.rpc("sendrawtransaction", "synthetic-tx")
            self.assertEqual(request.call_count, 1)

    def test_mining_and_regtest_setup_fail_before_any_rpc_or_native_call(self):
        with (
            patch.object(chain_profile, "_rpc") as request,
            patch.object(regtest, "native") as native,
        ):
            for method in ("generatetoaddress", "createwallet", "-rpcwallet=regtest-miner"):
                with self.assertRaisesRegex(ValueError, "faucet"):
                    chain_profile.rpc(method)
            with self.assertRaisesRegex(ValueError, "cannot fund Mutinynet"):
                regtest.setup()
            request.assert_not_called()
            native.assert_not_called()

    def test_native_receives_selected_network_and_validated_endpoints(self):
        with (
            patch.object(chain_profile, "check_chain") as checked,
            patch.object(regtest, "call", return_value="{}") as call,
        ):
            regtest.native("sign", "alice", network="regtest", signetChallenge="wrong")
            checked.assert_called_once_with(self.config)
            request = json.loads(call.call_args.kwargs["input"])
            self.assertEqual(request["network"], "signetcustom")
            self.assertEqual(request["signetChallenge"], chain_profile.MUTINYNET_CHALLENGE)
            self.assertEqual(
                call.call_args.kwargs["env"]["RGB_INDEXER_URL"], self.config["indexerUrl"]
            )

    def test_rpc_transport_never_redirects_or_exposes_error_body(self):
        connection = Mock()
        response = connection.getresponse.return_value
        response.status = 302
        response.read.return_value = b"synthetic-secret-error-body"
        with patch.object(chain_profile.http.client, "HTTPConnection", return_value=connection):
            with self.assertRaisesRegex(RuntimeError, r"failed \(302\)") as error:
                chain_profile._rpc(self.config, "getblockchaininfo", [])
            self.assertNotIn("synthetic-secret", str(error.exception))
            connection.request.assert_called_once()
            connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
