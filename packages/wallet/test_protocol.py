"""Synthetic protocol/transport cases; these are not settlement evidence."""

import copy
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import call, patch

from errors import WalletPreparationConflict, WalletUpgradeRequired

from journal import Journal
from protocol import BTC, FORMAT, Backend, digest, plan_check, read, save, sha, units
from server import create_server


class ProtocolTests(unittest.TestCase):
    def test_outdated_native_is_rejected_before_reserving_or_publishing(self):
        backend = Backend.__new__(Backend)
        with (
            patch("protocol.native", return_value={"cooperativePrepare": True}) as native_call,
            patch.object(backend, "reserve") as reserve,
        ):
            with self.assertRaises(WalletUpgradeRequired):
                backend.prepare({}, [])
            native_call.assert_called_once_with("capabilities")
            reserve.assert_not_called()

    def test_saved_conflicting_transitions_require_a_new_unsigned_attempt(self):
        error = RuntimeError(
            json.dumps(
                {
                    "ok": False,
                    "error": "the opout is already signalled as spent by a different opid",
                }
            )
        )
        with patch("protocol.native", side_effect=error) as native_call:
            with self.assertRaises(WalletPreparationConflict):
                Backend.merge(basePsbt="synthetic", contributions=["stale"])
            self.assertEqual(native_call.call_count, 1)
        for diagnostic in ["private native detail", '{"error":"other failure"}', "[]"]:
            error = RuntimeError(diagnostic)
            with patch("protocol.native", side_effect=error):
                with self.assertRaises(RuntimeError) as caught:
                    Backend.merge(basePsbt="synthetic", contributions=[])
                self.assertIs(caught.exception, error)

    def test_balances_require_a_fresh_checked_state_and_propagate_index_failures(self):
        backend = Backend.__new__(Backend)
        backend.owner = "alice"
        backend.wallet_id = "rgb-synthetic"
        raw = {
            "btc": {"vanilla": {"settled": "10"}, "colored": {"settled": "20"}},
            "assets": {"nia": []},
            "stockBalances": {},
        }
        with (
            patch.object(backend, "sync_shared_catalog"),
            patch.object(
                backend, "call_native", side_effect=[raw, ValueError("index mismatch")]
            ) as call,
        ):
            self.assertEqual(backend.state()["balances"], [{"asset": BTC, "amount": "30"}])
            call.assert_called_once_with("state")
            with self.assertRaisesRegex(ValueError, "index mismatch"):
                backend.state()
            self.assertEqual(call.call_count, 2, "completed balance reads must not be cached")

    def test_state_uses_one_native_call_and_preserves_balances(self):
        backend = Backend.__new__(Backend)
        backend.owner = "alice"
        backend.wallet_id = "unit-wallet"
        raw = {
            "btc": {"vanilla": {"settled": "40"}, "colored": {"settled": "60"}},
            "assets": {"nia": [{"asset_id": "rgb:unit", "ticker": "X", "precision": 0}]},
            "stockBalances": {"rgb:unit": "7"},
        }
        with (
            patch.object(backend, "sync_shared_catalog") as catalog,
            patch.object(backend, "call_native", return_value=raw) as native_call,
        ):
            state = backend.state()
        catalog.assert_called_once_with()
        native_call.assert_called_once_with("state")
        self.assertEqual(state["balances"][0]["amount"], "100")
        self.assertEqual(state["balances"][1]["amount"], "7")
        self.assertEqual(
            set(state), {"walletId", "ownerId", "network", "mode", "balances", "observedAt"}
        )
        self.assertEqual(
            {k: state[k] for k in ("walletId", "ownerId", "network", "mode")},
            {"walletId": "unit-wallet", "ownerId": "alice", "network": "regtest", "mode": "real"},
        )
        self.assertIsInstance(state["observedAt"], int)
        with self.assertRaises(TypeError):
            backend.handle("state", {"raw": raw})

    def test_state_propagates_native_consistency_failure(self):
        backend = Backend.__new__(Backend)
        with (
            patch.object(backend, "sync_shared_catalog"),
            patch.object(
                backend, "call_native", side_effect=ValueError("index mismatch")
            ) as native_call,
        ):
            with self.assertRaisesRegex(ValueError, "index mismatch"):
                backend.state()
        native_call.assert_called_once_with("state")

    def test_funding_target_is_owned_vanilla_regtest_address(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = Backend.__new__(Backend)
            backend.root = Path(tmp)
            backend.owner = "alice"
            backend.wallet_id = "rgb-test-wallet"
            address = "bcrt1q" + "a" * 38
            with patch.object(
                backend, "call_native", return_value={"btcAddress": address, "rgbAddress": "hidden"}
            ) as native_call:
                self.assertEqual(
                    backend.handle("fundingTarget", {}),
                    {
                        "walletId": "rgb-test-wallet",
                        "ownerId": "alice",
                        "network": "regtest",
                        "address": address,
                    },
                )
                native_call.assert_called_once_with("addresses")
                self.assertEqual(backend.fundingTarget()["address"], address)
                native_call.assert_called_once_with("addresses")
            with patch.object(backend, "call_native") as native_call:
                self.assertEqual(backend.fundingTarget()["address"], address)
                native_call.assert_not_called()
            backend.wallet_id = "rgb-different-wallet"
            with self.assertRaisesRegex(ValueError, "identity changed"):
                backend.fundingTarget()
            backend.wallet_id = "rgb-test-wallet"
            with self.assertRaises(TypeError):
                backend.handle("fundingTarget", {"tradeId": "unexpected"})

    def test_funding_target_refuses_active_trade_and_non_regtest_address(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = Backend.__new__(Backend)
            backend.root = Path(tmp)
            backend.owner = "alice"
            backend.wallet_id = "rgb-test-wallet"
            journal = Journal(backend.root / "journal.sqlite")
            journal.reserve("unit", {"network": "regtest"}, ["synthetic:0"])
            journal.db.close()
            with patch.object(backend, "call_native") as native_call:
                with self.assertRaisesRegex(ValueError, "active trade"):
                    backend.fundingTarget()
                native_call.assert_not_called()
            journal = Journal(backend.root / "journal.sqlite")
            journal.release("unit")
            journal.db.close()
            with patch.object(backend, "call_native", return_value={"btcAddress": "bc1qwrong"}):
                with self.assertRaisesRegex(ValueError, "regtest BTC address"):
                    backend.fundingTarget()

    def plan(self):
        p = {
            "protocolVersion": 1,
            "tradeId": "unit",
            "revision": 0,
            "network": "regtest",
            "participants": ["a", "b"],
            "orderRefs": [{"orderId": "oa", "revision": 1}, {"orderId": "ob", "revision": 1}],
            "createdAt": 1,
            "feeState": "estimate",
            "fees": [{"ownerId": "a", "feeSats": "1000"}, {"ownerId": "b", "feeSats": "1000"}],
            "legs": [
                {"fromOwnerId": "a", "toOwnerId": "b", "asset": BTC, "amount": "100000"},
                {
                    "fromOwnerId": "b",
                    "toOwnerId": "a",
                    "asset": {
                        "kind": "rgb",
                        "network": "regtest",
                        "contractId": "rgb:synthetic-unit-only",
                        "precision": 0,
                        "symbol": "TEST",
                    },
                    "amount": "100",
                },
            ],
        }
        p["digest"] = digest(p)
        return p

    def test_final_fee_does_not_exceed_estimate(self):
        self.assertEqual(plan_check(self.plan(), "a"), {"a": 500, "b": 500})

    def test_preview_uses_fresh_preflight_state_and_rolls_back_rejected_snapshots(self):
        plan = self.plan()
        raw = {
            "network": "regtest",
            "btc": {"vanilla": {"settled": "200000"}, "colored": {"settled": "1000"}},
            "assets": {"nia": []},
            "stockBalances": {},
        }
        for result in ({"state": raw}, {}, {"state": {"network": "signetcustom"}}):
            with self.subTest(result=result), tempfile.TemporaryDirectory() as tmp:
                backend = Backend.__new__(Backend)
                backend.root = Path(tmp)
                backend.owner, backend.profile, backend.wallet_id = "a", "alice", "unit-wallet"
                backend.identity = {"fingerprint": "synthetic"}
                folder = backend.folder(plan["tradeId"])
                funding = {"a": {"inputs": [{"txid": "synthetic", "vout": 0}]}, "b": {}}
                save(folder / "plan.json", plan)
                save(folder / "funding.json", funding["a"])
                journal = Journal(backend.root / "journal.sqlite")
                journal.reserve_plan(plan["tradeId"], plan, ["synthetic:0"])
                final = {
                    "psbt": "synthetic-psbt",
                    "candidateTxid": "unsigned",
                    "unsignedTxHex": "00",
                    "commitmentScripts": [],
                    "feeSats": "1000",
                }
                package = {
                    "protocolVersion": 1,
                    "packageId": final["candidateTxid"],
                    "tradeId": plan["tradeId"],
                    "planRevision": plan["revision"],
                    "planDigest": plan["digest"],
                    "network": "regtest",
                    "format": FORMAT,
                    "unsignedTxDigest": sha(bytes.fromhex(final["unsignedTxHex"])),
                    "commitmentDigest": digest({"scripts": [], "proofs": []}),
                    "payload": {
                        "funding": funding,
                        "colored": {p: {"psbt": None} for p in plan["participants"]},
                        "final": final,
                        "proofs": [],
                    },
                }
                skeleton = {"base": {"psbt": "unsigned"}, "receivers": [], "assignments": {"a": {}}}
                with (
                    patch.object(backend, "sync_shared_catalog"),
                    patch.object(backend, "skeleton", return_value=skeleton),
                    patch("protocol.native", return_value=final),
                    patch.object(backend, "call_native", return_value=result) as native_call,
                ):
                    if result == {"state": raw}:
                        for _ in range(2):
                            preview = backend.validate(package, plan)
                            self.assertEqual(
                                preview["balancesAfter"], [{"asset": BTC, "amount": "100500"}]
                            )
                        self.assertEqual(
                            native_call.call_count, 2, "every preview must synchronize again"
                        )
                        self.assertEqual(
                            read(folder / "before.json")["balances"][0]["amount"], "201000"
                        )
                        self.assertEqual(
                            journal.snapshot(plan["tradeId"])["state"], "AWAITING_APPROVAL"
                        )
                    else:
                        with self.assertRaises((KeyError, ValueError)):
                            backend.validate(package, plan)
                        self.assertEqual(journal.snapshot(plan["tradeId"])["state"], "PREPARING")
                        self.assertFalse((folder / "approval-intent.json").exists())
                        self.assertFalse((folder / "review-package.json").exists())
                    self.assertTrue(
                        all(c.args[0] == "preflight-sign" for c in native_call.call_args_list)
                    )
                journal.db.close()

    def test_wrong_digest_network_owner_and_topology(self):
        original = self.plan()
        for mutate in [
            lambda p: p.update(network="mainnet"),
            lambda p: p["participants"].__setitem__(1, "a"),
            lambda p: p["legs"][0].update(toOwnerId="a"),
            lambda p: p["fees"][0].update(feeSats="499"),
        ]:
            p = copy.deepcopy(original)
            mutate(p)
            p["digest"] = digest({k: v for k, v in p.items() if k != "digest"})
            with self.assertRaises(ValueError):
                plan_check(p, "a")
        original["legs"][0]["amount"] = "1"
        with self.assertRaises(ValueError):
            plan_check(original, "a")

    def test_units_boundaries(self):
        self.assertEqual(units(str(2**64 - 1)), 2**64 - 1)
        for v in [1, "01", "-1", "1e3", "1.1", str(2**64)]:
            with self.assertRaises(ValueError):
                units(v)

    def reservation_fixture(self, tmp, owner):
        backend = Backend.__new__(Backend)
        backend.root = Path(tmp)
        backend.owner = owner
        backend.wallet_id = "unit-wallet"
        plan = self.plan()
        contract = plan["legs"][1]["asset"]["contractId"]
        raw = {
            "btc": {"vanilla": {"settled": "105000"}, "colored": {"settled": "5000"}},
            "assets": {"nia": [{"asset_id": contract, "ticker": "TEST", "precision": 0}]},
            "stockBalances": {contract: "150"},
            "unspents": [
                {
                    "utxo": {
                        "outpoint": {"txid": "btc-funding", "vout": 0},
                        "btc_amount": "105000",
                        "colorable": False,
                    },
                    "rgb_allocations": [],
                },
                {
                    "utxo": {
                        "outpoint": {"txid": "rgb-funding", "vout": 1},
                        "btc_amount": "5000",
                        "colorable": True,
                    },
                    "rgb_allocations": [
                        {"asset_id": contract, "settled": True, "assignment": {"Fungible": "150"}}
                    ],
                },
            ],
        }
        return backend, plan, raw

    def test_reserve_reuses_snapshot_and_keeps_inputs_and_plan_immutable(self):
        chain = {"confirmations": 1, "coinbase": False, "scriptPubKey": {"hex": "synthetic-script"}}
        addresses = {"btcAddress": "synthetic-btc-address", "rgbAddress": "synthetic-rgb-address"}
        for owner, txid, vout, amount in (
            ("a", "btc-funding", 0, "105000"),
            ("b", "rgb-funding", 1, "5000"),
        ):
            with self.subTest(owner=owner), tempfile.TemporaryDirectory() as tmp:
                backend, plan, raw = self.reservation_fixture(tmp, owner)
                with (
                    patch.object(backend, "sync_shared_catalog") as catalog,
                    patch.object(
                        backend, "call_native", side_effect=[raw, addresses]
                    ) as native_call,
                    patch(
                        "protocol.rpc",
                        side_effect=lambda method, *args: chain
                        if method == "gettxout"
                        else "synthetic-raw-tx",
                    ) as chain_call,
                ):
                    self.assertEqual(backend.reserve(plan), {"reservationId": "unit"})
                    self.assertEqual(backend.reserve(plan), {"reservationId": "unit"})
                    changed = copy.deepcopy(plan)
                    changed["legs"][0]["amount"] = "100001"
                    changed["digest"] = digest({k: v for k, v in changed.items() if k != "digest"})
                    with self.assertRaisesRegex(ValueError, "immutable"):
                        backend.reserve(changed)
                catalog.assert_called_once_with()
                self.assertEqual(native_call.call_args_list, [call("state"), call("addresses")])
                self.assertEqual(
                    chain_call.call_args_list,
                    [
                        call("gettxout", "btc-funding", 0),
                        call("gettxout", "rgb-funding", 1),
                        call("getrawtransaction", txid, False),
                        *(
                            [call("getrawtransaction", "btc-funding", False)]
                            if owner == "b"
                            else []
                        ),
                    ],
                )
                funding = read(backend.folder("unit") / "funding.json")
                self.assertEqual(
                    funding["inputs"],
                    [
                        {
                            "txid": txid,
                            "vout": vout,
                            "amountSats": amount,
                            "scriptPubKey": "synthetic-script",
                            "rawTx": "synthetic-raw-tx",
                            "replaceable": True,
                        },
                        *(
                            [
                                {
                                    "txid": "btc-funding",
                                    "vout": 0,
                                    "amountSats": "105000",
                                    "scriptPubKey": "synthetic-script",
                                    "rawTx": "synthetic-raw-tx",
                                    "replaceable": True,
                                }
                            ]
                            if owner == "b"
                            else []
                        ),
                    ],
                )
                self.assertEqual(
                    funding["allocations"], raw["stockBalances"] if owner == "b" else {}
                )
                self.assertEqual(read(backend.folder("unit") / "plan.json"), plan)
                journal = Journal(backend.root / "journal.sqlite")
                try:
                    self.assertEqual(journal.snapshot("unit")["state"], "PREPARING")
                    self.assertEqual(
                        journal.db.execute("SELECT outpoint,trade_id FROM reservations").fetchall(),
                        [
                            (f"{txid}:{vout}", "unit"),
                            *([("btc-funding:0", "unit")] if owner == "b" else []),
                        ],
                    )
                finally:
                    journal.db.close()

    def test_reserve_rejects_low_balance_before_input_selection(self):
        for owner in ("a", "b"):
            with self.subTest(owner=owner), tempfile.TemporaryDirectory() as tmp:
                backend, plan, raw = self.reservation_fixture(tmp, owner)
                raw["btc"]["vanilla"]["settled"] = "94999"
                raw["stockBalances"] = {key: "99" for key in raw["stockBalances"]}
                with (
                    patch.object(backend, "sync_shared_catalog"),
                    patch.object(backend, "call_native", return_value=raw) as native_call,
                    patch("protocol.rpc") as chain_call,
                ):
                    with self.assertRaisesRegex(ValueError, "insufficient give asset"):
                        backend.reserve(plan)
                native_call.assert_called_once_with("state")
                chain_call.assert_not_called()
                self.assertFalse((backend.folder("unit") / "funding.json").exists())

    def test_reserve_still_checks_chain_before_reserving_snapshot_inputs(self):
        for chain in (None, {"confirmations": 0}, {"confirmations": 100, "coinbase": True}):
            with self.subTest(chain=chain), tempfile.TemporaryDirectory() as tmp:
                backend, plan, raw = self.reservation_fixture(tmp, "b")
                with (
                    patch.object(backend, "sync_shared_catalog"),
                    patch.object(backend, "call_native", return_value=raw) as native_call,
                    patch("protocol.rpc", return_value=chain) as chain_call,
                ):
                    with self.assertRaisesRegex(ValueError, "no spendable RGB inputs"):
                        backend.reserve(plan)
                native_call.assert_called_once_with("state")
                self.assertEqual(chain_call.call_count, 2)
                journal = Journal(backend.root / "journal.sqlite")
                try:
                    self.assertIsNone(journal.snapshot("unit"))
                    self.assertEqual(
                        journal.db.execute("SELECT * FROM reservations").fetchall(), []
                    )
                finally:
                    journal.db.close()


class HttpTests(unittest.TestCase):
    def test_auth_origin_host_and_envelope(self):
        class FakeBackend:
            def handle(self, method, params):
                if method == "upgrade":
                    raise WalletUpgradeRequired()
                if method == "conflict":
                    raise WalletPreparationConflict()
                if method != "state":
                    raise ValueError("synthetic rejection")
                return {"fixtureOnly": True}

        with tempfile.TemporaryDirectory() as tmp:
            backend = FakeBackend()
            backend.root = Path(tmp)
            token = "synthetic-test-token-32-characters-only"
            server = create_server(backend, token, 0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/rpc"
            body = json.dumps(
                {"protocolVersion": 1, "requestId": "unit", "method": "state", "params": {}}
            ).encode()

            def request(headers, data=body):
                return urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=5)

            try:
                for headers, code in [
                    ({}, 401),
                    ({"Authorization": "Bearer " + token, "Origin": "null"}, 403),
                    ({"Authorization": "Bearer " + token, "Host": "evil.example"}, 403),
                ]:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        request(headers)
                    self.assertEqual(caught.exception.code, code)
                with request({"Authorization": "Bearer " + token}) as response:
                    self.assertEqual(
                        json.load(response), {"protocolVersion": 1, "result": {"fixtureOnly": True}}
                    )
                with request({"Authorization": "Bearer " + token}, b"{}") as response:
                    self.assertEqual(json.load(response)["error"]["code"], "WALLET_REJECTED")
                for method, error in [
                    ("upgrade", WalletUpgradeRequired),
                    ("conflict", WalletPreparationConflict),
                ]:
                    data = json.dumps(
                        {"protocolVersion": 1, "requestId": "unit", "method": method, "params": {}}
                    ).encode()
                    with request({"Authorization": "Bearer " + token}, data) as response:
                        self.assertEqual(
                            json.load(response)["error"],
                            {"code": error.code, "message": error.public_message},
                        )
            finally:
                server.shutdown()
                server.server_close()


class RecoveryTests(unittest.TestCase):
    """Synthetic crash-boundary regressions, not RGB settlement evidence."""

    def backend(self, tmp):
        backend = Backend.__new__(Backend)
        backend.root = Path(tmp)
        backend.owner = "alice"
        backend.wallet_id = "unit-wallet"
        folder = backend.folder("unit")
        package = {
            "protocolVersion": 1,
            "tradeId": "unit",
            "planRevision": 0,
            "packageId": "unit-tx",
            "planDigest": "plan",
            "unsignedTxDigest": "tx",
            "commitmentDigest": "rgb",
        }
        approval = {
            "protocolVersion": 1,
            "walletId": "unit-wallet",
            "ownerId": "alice",
            "network": "regtest",
            "tradeId": "unit",
            "planRevision": 0,
            **{
                k: package[k]
                for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
            },
            "approvalId": "original",
            "approvedAt": 1,
        }
        intent = {"network": "regtest", "fixture": "synthetic"}
        save(folder / "package.json", package)
        save(folder / "approval-intent.json", intent)
        journal = Journal(backend.root / "journal.sqlite")
        journal.reserve("unit", intent, ["synthetic:0"])
        journal.db.close()
        return backend, folder, package, approval

    def test_original_approval_and_signature_survive_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend, folder, package, approval = self.backend(tmp)
            with patch.object(
                backend, "call_native", return_value={"signedPsbt": "synthetic-signature"}
            ) as signer:
                original = backend.sign(package, approval)
                self.assertEqual(backend.sign(package, approval), original)
                signer.assert_called_once()
                with self.assertRaisesRegex(ValueError, "immutable"):
                    backend.sign(package, {**approval, "approvedAt": 2})
                self.assertEqual(read(folder / "user-approval.json"), approval)

    def test_read_only_recovery_never_signs_and_requires_original_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend, folder, package, approval = self.backend(tmp)
            save(folder / "user-approval.json", approval)
            with patch.object(
                backend, "call_native", return_value={"signedPsbt": "synthetic-signature"}
            ) as signer:
                with self.assertRaisesRegex(ValueError, "no durable signature"):
                    backend.recoverSignature(package)
                signer.assert_not_called()
                original = backend.sign(package, approval)
                self.assertEqual(backend.recoverSignature(package), original)
                signer.assert_called_once()
                with self.assertRaisesRegex(ValueError, "changed recovery package"):
                    backend.recoverSignature({**package, "payload": "changed"})
                self.assertEqual(read(folder / "user-approval.json"), approval)

    def test_independent_btc_credit_is_not_rgb_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend, folder, package, approval = self.backend(tmp)
            with patch.object(
                backend, "call_native", return_value={"signedPsbt": "synthetic-signature"}
            ):
                backend.sign(package, approval)
            save(folder / "preview.json", {"balancesAfter": [{"asset": BTC, "amount": "1000"}]})
            with (
                patch("protocol.rpc", return_value={"confirmations": 1, "hex": "synthetic"}),
                patch.object(
                    backend,
                    "call_native",
                    return_value={"txid": "unit-tx", "rgbAccepted": True, "chainConfirmed": True},
                ),
                patch.object(
                    backend, "state", return_value={"balances": [{"asset": BTC, "amount": "1200"}]}
                ),
            ):
                self.assertEqual(backend.sync("unit")["state"], "confirmed")
            self.assertEqual(
                read(folder / "receipt.json")["btcBalanceDifferenceFromPreviewSats"], "200"
            )


if __name__ == "__main__":
    unittest.main()
