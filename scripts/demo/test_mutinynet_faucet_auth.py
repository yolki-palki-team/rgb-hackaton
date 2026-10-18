"""Faucet consent, private storage and no-replay funding checks without network calls."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


auth = load("mutinynet-faucet-auth")
funding = load("mutinynet-faucet-fund")


class FaucetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = self.root / "run"
        self.state.mkdir()
        for module in (auth, funding):
            patcher = patch.object(module, "STATE_ROOT", self.root)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
        self.token = self.state / "faucet-auth.token"

    def device(self):
        return {
            "verification_uri": "https://github.com/login/device",
            "device_code": "private-device",
            "user_code": "USER-CODE",
            "interval": 5,
            "expires_in": 900,
        }

    def test_consent_polling_backoff_private_storage_and_no_secret_output(self):
        responses = [
            {"client_id": "client"},
            self.device(),
            {"error": "authorization_pending"},
            {"error": "slow_down"},
            {"access_token": "private-github"},
            {"token": "private-faucet"},
        ]
        with (
            patch.object(auth, "request", side_effect=responses) as request,
            patch.object(auth.time, "sleep") as sleep,
        ):
            auth.login(self.token)
        self.assertEqual(request.call_args_list[1].args[1]["scope"], "user:email")
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 5, 10])
        self.assertEqual(self.token.read_text(), "private-faucet")
        self.assertEqual(self.token.stat().st_mode & 0o777, 0o600)
        for secret in ("private-device", "private-github", "private-faucet"):
            self.assertNotIn(secret, self.output.getvalue())

    def test_denial_does_not_create_credentials_and_existing_tokens_are_preserved(self):
        with (
            patch.object(
                auth,
                "request",
                side_effect=[{"client_id": "client"}, self.device(), {"error": "access_denied"}],
            ),
            patch.object(auth.time, "sleep"),
        ):
            with self.assertRaisesRegex(RuntimeError, "denied"):
                auth.login(self.token)
        self.assertFalse(self.token.exists())
        self.token.write_text("existing")
        with patch.object(auth, "request") as request:
            for target in (self.token, self.root.parent / "outside-token"):
                with self.assertRaises(ValueError):
                    auth.login(target)
            request.assert_not_called()
        self.assertEqual(self.token.read_text(), "existing")

    def wallets(self):
        for index, profile in enumerate(("alice", "bob", "carol")):
            folder = self.state / profile
            folder.mkdir()
            (folder / "network.json").write_text(
                json.dumps(
                    {"network": "signetcustom", "signetChallenge": funding.MUTINYNET_CHALLENGE}
                )
            )
            (folder / "addresses.json").write_text(
                json.dumps(
                    {
                        "profile": profile,
                        "network": "signetcustom",
                        "btcAddress": "tb1q" + "q" * 37 + str(index + 2),
                        "rgbAddress": "tb1q" + "p" * 37 + str(index + 2),
                    }
                )
            )
        self.token.write_text("private-faucet")
        self.token.chmod(0o600)

    def test_six_exact_claims_have_pending_markers_and_completed_receipts_are_not_replayed(self):
        self.wallets()
        sent = []

        def request(path, token, data=None):
            if path == "/api/limits":
                return {"remaining_sats": 1000000}
            entry = funding.funding_plan(self.state)[len(sent)]
            marker = (
                self.state / "faucet-funding" / f"{entry['profile']}-{entry['kind']}.pending.json"
            )
            self.assertEqual(json.loads(marker.read_text())["request"], entry)
            sent.append(data)
            return {"address": data["address"], "txid": f"{len(sent):064x}"}

        with patch.object(funding, "request", side_effect=request) as calls:
            funding.fund(self.state, True)
            self.assertEqual(len(sent), 6)
            self.assertEqual(sum(item["sats"] for item in sent), 390000)
            calls.reset_mock()
            funding.fund(self.state, True)
            calls.assert_not_called()
        self.assertNotIn("private-faucet", self.output.getvalue())

    def test_uncertain_claim_stops_batch_and_blocks_replay(self):
        self.wallets()
        with patch.object(
            funding, "request", side_effect=[{"remaining_sats": 1000000}, RuntimeError("uncertain")]
        ) as calls:
            with self.assertRaisesRegex(RuntimeError, "uncertain"):
                funding.fund(self.state, True)
            self.assertEqual(calls.call_count, 2)
        with patch.object(funding, "request") as calls:
            with self.assertRaisesRegex(ValueError, "Uncertain"):
                funding.fund(self.state, True)
            calls.assert_not_called()

    def test_wrong_chain_or_insufficient_quota_never_dispatches_funds(self):
        self.wallets()
        with patch.object(funding, "request", return_value={"remaining_sats": 389999}) as calls:
            with self.assertRaisesRegex(ValueError, "quota"):
                funding.fund(self.state, True)
            self.assertEqual(calls.call_count, 1)
            self.assertEqual(calls.call_args.args[0], "/api/limits")
        (self.state / "alice/network.json").write_text('{"network":"regtest"}')
        with patch.object(funding, "request") as calls:
            with self.assertRaisesRegex(ValueError, "binding"):
                funding.fund(self.state, True)
            calls.assert_not_called()


if __name__ == "__main__":
    unittest.main()
