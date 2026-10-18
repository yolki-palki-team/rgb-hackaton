"""Protocol-v1 local wallet backend. Market materials are never signing authority."""

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from journal import Journal, canonical
from journal import digest as approval_digest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts/demo"))
from regtest import STATE, native, rpc

ROOT = Path(__file__).resolve().parents[2]

MAX = 2**64 - 1
BTC = {"kind": "btc", "network": "regtest", "symbol": "BTC", "precision": 8}
FORMAT = "rgb-cooperative-v1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def digest(value):
    # Exact protocol-v1 JS localeCompare ordering, not Python's different key ordering.
    return subprocess.check_output(
        ["node", str(ROOT / "packages/wallet/digest.mjs"), "--stdin"],
        input=json.dumps(value),
        text=True,
    ).strip()


def units(value):
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value)
        or int(value) > MAX
    ):
        raise ValueError("invalid atomic amount")
    return int(value)


def asset_key(asset):
    if asset.get("network") != "regtest" or asset.get("kind") not in ("btc", "rgb"):
        raise ValueError("unsupported asset/network")
    if asset["kind"] == "btc":
        if asset.get("precision") != 8:
            raise ValueError("BTC precision")
        return "regtest:btc:btc"
    if (
        asset.get("precision") != 0
        or not isinstance(asset.get("contractId"), str)
        or not asset["contractId"].startswith("rgb:")
    ):
        raise ValueError("only verified precision-0 NIA is supported")
    return "regtest:rgb:" + asset["contractId"]


def save(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as f:
        os.chmod(temp, 0o600)
        f.write(canonical(value))
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(path):
    return json.loads(Path(path).read_text())


def plan_check(plan, owner):
    if (
        plan.get("protocolVersion") != 1
        or plan.get("network") != "regtest"
        or plan.get("digest") != digest({k: v for k, v in plan.items() if k != "digest"})
    ):
        raise ValueError("invalid plan digest/network")
    people = plan["participants"]
    n = len(people)
    if (
        n not in (2, 3)
        or len(set(people)) != n
        or owner not in people
        or len(plan["legs"]) != n
        or len(plan["fees"]) != n
    ):
        raise ValueError("invalid participants")
    if (
        not isinstance(plan["revision"], int)
        or plan["revision"] < 0
        or not isinstance(plan["tradeId"], str)
        or len(plan["tradeId"]) > 200
    ):
        raise ValueError("invalid plan identity")
    if len(plan["orderRefs"]) != n or len({r["orderId"] for r in plan["orderRefs"]}) != n:
        raise ValueError("invalid order references")
    if {f["ownerId"] for f in plan["fees"]} != set(people):
        raise ValueError("invalid fee owners")
    for leg in plan["legs"]:
        asset_key(leg["asset"])
        if (
            units(leg["amount"]) == 0
            or leg["fromOwnerId"] == leg["toOwnerId"]
            or leg["fromOwnerId"] not in people
            or leg["toOwnerId"] not in people
        ):
            raise ValueError("invalid leg")
    for p in people:
        if (
            sum(leg["fromOwnerId"] == p for leg in plan["legs"]) != 1
            or sum(leg["toOwnerId"] == p for leg in plan["legs"]) != 1
        ):
            raise ValueError("not a direct swap or three-party cycle")
        outgoing = next(leg for leg in plan["legs"] if leg["fromOwnerId"] == p)
        incoming = next(leg for leg in plan["legs"] if leg["toOwnerId"] == p)
        if asset_key(outgoing["asset"]) == asset_key(incoming["asset"]):
            raise ValueError("same-asset exchange")
    caps = {f["ownerId"]: units(f["feeSats"]) for f in plan["fees"]}
    if plan["feeState"] == "final":
        fees = caps
    elif plan["feeState"] == "estimate":
        fees = {p: 1000 // n + (1000 % n if i == n - 1 else 0) for i, p in enumerate(people)}
    else:
        raise ValueError("invalid fee state")
    if any(fees[p] > caps[p] for p in people) or not 1 <= sum(fees.values()) <= 100000:
        raise ValueError("fee limits")
    return fees


class Backend:
    def __init__(self, profile, owner=None):
        if profile not in ("alice", "bob", "carol"):
            raise ValueError("profile")
        self.profile = profile
        self.owner = owner or profile
        self.root = STATE / profile
        self.identity = native("identity", profile)
        self.wallet_id = "rgb-" + self.identity["fingerprint"]
        self.catalog_checked = 0

    def sync_shared_catalog(self):
        if not os.environ.get("PALKA_CHAIN_CONFIG") or time.monotonic() - self.catalog_checked < 15:
            return
        journal = Journal(self.root / "journal.sqlite")
        try:
            if journal.db.execute(
                "SELECT 1 FROM trades WHERE state NOT IN ('CONFIRMED','CANCELLED') LIMIT 1"
            ).fetchone():
                return
        finally:
            journal.db.close()
        from chain_transport import Client

        known = {a["asset_id"] for a in self.call_native("offline-state")["assets"]["nia"]}
        for entry in Client.from_env().request("/catalog", {}).values():
            if "contract" in entry and entry["contractId"] not in known:
                imported = self.call_native("catalog-import", contract=entry["contract"])
                if imported["contractId"] != entry["contractId"]:
                    raise ValueError("Shared catalog contract mismatch")
        self.catalog_checked = time.monotonic()

    def folder(self, trade):
        return self.root / "trades" / sha(trade.encode())

    def call_native(self, op, trade=None, **kwargs):
        if trade is not None:
            kwargs["contextKey"] = sha(trade.encode())
        return native(op, self.profile, **kwargs)

    def state(self):
        self.sync_shared_catalog()
        return self._state_from_raw(self.call_native("state"))

    def _state_from_raw(self, raw):
        balances = [
            {
                "asset": BTC,
                "amount": str(sum(int(raw["btc"][k]["settled"]) for k in ("vanilla", "colored"))),
            }
        ]
        for a in raw["assets"]["nia"]:
            balances.append(
                {
                    "asset": {
                        "kind": "rgb",
                        "network": "regtest",
                        "symbol": a["ticker"],
                        "precision": a["precision"],
                        "contractId": a["asset_id"],
                    },
                    "amount": raw["stockBalances"].get(a["asset_id"], "0"),
                }
            )
        return {
            "walletId": self.wallet_id,
            "ownerId": self.owner,
            "network": "regtest",
            "mode": "real",
            "balances": balances,
            "observedAt": int(time.time() * 1000),
        }

    def capabilities(self):
        try:
            native("health")
            self.call_native("check-index")
            ready = True
            reason = "Regtest NIA; SegWit v0; one active trade per profile; fixed deterministic fee allocation"
        except Exception:
            ready = False
            reason = (
                "Local chain/indexer or allocation index is unavailable; reconciliation required"
            )
        return {
            "protocolVersion": 1,
            "mode": "real",
            "network": "regtest",
            "directSwap": ready,
            "ringSwap": ready,
            "signing": ready,
            "broadcast": ready,
            "adapterVersion": FORMAT,
            "reason": reason,
        }

    def fundingTarget(self):
        """Return only this wallet's vanilla regtest BTC receive address."""
        journal_path = self.root / "journal.sqlite"
        if journal_path.exists():
            db = sqlite3.connect(f"file:{journal_path}?mode=ro", uri=True)
            try:
                active = db.execute(
                    "SELECT 1 FROM trades WHERE state NOT IN ('CONFIRMED','CANCELLED') LIMIT 1"
                ).fetchone()
            finally:
                db.close()
            if active:
                raise ValueError("finish or reconcile the active trade before funding")
        # get_address derives a NEW address. Persist one target so preview and
        # approval bind to the same destination, including after restart.
        target_path = self.root / "funding-target.json"
        if target_path.exists():
            target = read(target_path)
            if target.get("walletId") != self.wallet_id:
                raise ValueError("funding target wallet identity changed")
            address = target["address"]
        else:
            address = self.call_native("addresses")["btcAddress"]
        if not isinstance(address, str) or not re.fullmatch(
            r"bcrt1[ac-hj-np-z02-9]{8,87}", address
        ):
            raise ValueError("native wallet did not return a regtest BTC address")
        if not target_path.exists():
            save(target_path, {"walletId": self.wallet_id, "address": address})
        return {
            "walletId": self.wallet_id,
            "ownerId": self.owner,
            "network": "regtest",
            "address": address,
        }

    def reserve(self, plan):
        fees = plan_check(plan, self.owner)
        folder = self.folder(plan["tradeId"])
        j = Journal(self.root / "journal.sqlite")
        try:
            row = j.snapshot(plan["tradeId"])
            if row:
                if (
                    row["state"] not in ("PREPARING", "AWAITING_APPROVAL")
                    or read(folder / "plan.json") != plan
                ):
                    raise ValueError("existing plan immutable or already signed")
                return {"reservationId": plan["tradeId"]}
            # A validates its saved publication/private policy locally before this authenticated RPC.
            self.sync_shared_catalog()
            raw = self.call_native("state")
            state = self._state_from_raw(raw)
            known = {asset_key(b["asset"]): b for b in state["balances"]}
            give = next(leg for leg in plan["legs"] if leg["fromOwnerId"] == self.owner)
            receive = next(leg for leg in plan["legs"] if leg["toOwnerId"] == self.owner)
            for leg in (give, receive):
                if asset_key(leg["asset"]) not in known:
                    raise ValueError("contract must be imported and verified locally first")
            if int(known[asset_key(give["asset"])]["amount"]) < units(give["amount"]):
                raise ValueError("insufficient give asset")
            selected = []
            allocated = {}
            total = 0
            reserved = {r[0] for r in j.db.execute("SELECT outpoint FROM reservations")}
            candidates = []
            for u in raw["unspents"]:
                point = u["utxo"]["outpoint"]
                key = f"{point['txid']}:{point['vout']}"
                if (
                    key in reserved
                    or u.get("pending_blinded", 0)
                    or any(not a["settled"] for a in u["rgb_allocations"])
                ):
                    continue
                chain = rpc("gettxout", point["txid"], point["vout"])
                if (
                    not chain
                    or chain["confirmations"] < 1
                    or (chain["coinbase"] and chain["confirmations"] < 101)
                ):
                    continue
                candidates.append((u, chain))

            def take(pair):
                nonlocal total
                u, chain = pair
                point = u["utxo"]["outpoint"]
                selected.append(
                    {
                        **point,
                        "amountSats": str(u["utxo"]["btc_amount"]),
                        "scriptPubKey": chain["scriptPubKey"]["hex"],
                        "rawTx": rpc("getrawtransaction", point["txid"], False),
                        "replaceable": True,
                    }
                )
                total += int(u["utxo"]["btc_amount"])
                for a in u["rgb_allocations"]:
                    if set(a["assignment"]) != {"Fungible"} or not a["asset_id"]:
                        raise ValueError("non-NIA allocation")
                    allocated[a["asset_id"]] = allocated.get(a["asset_id"], 0) + int(
                        a["assignment"]["Fungible"]
                    )
                candidates.remove(pair)

            if give["asset"]["kind"] == "rgb":
                contract = give["asset"]["contractId"]
                for pair in list(candidates):
                    if allocated.get(contract, 0) >= units(give["amount"]):
                        break
                    if any(a["asset_id"] == contract for a in pair[0]["rgb_allocations"]):
                        take(pair)
                if allocated.get(contract, 0) < units(give["amount"]):
                    raise ValueError("no spendable RGB inputs")
            needed = (
                2000
                + fees[self.owner]
                + (units(give["amount"]) if give["asset"]["kind"] == "btc" else 0)
            )
            # Every new swap has a vanilla input that its owner can spend to self
            # to invalidate the whole swap without consuming an RGB seal.
            cancel_fee = sum(fees.values()) + 1000
            cancellable = next(
                (
                    pair
                    for pair in candidates
                    if not pair[0]["utxo"]["colorable"]
                    and not pair[0]["rgb_allocations"]
                    and int(pair[0]["utxo"]["btc_amount"]) >= cancel_fee + 1000
                ),
                None,
            )
            if cancellable is None:
                raise ValueError(
                    "a confirmed vanilla BTC input is required for unilateral cancellation"
                )
            take(cancellable)
            for pair in list(candidates):
                if total >= needed:
                    break
                if not pair[0]["rgb_allocations"]:
                    take(pair)
            if total < needed:
                raise ValueError("not enough spendable BTC for payments, change and fee")
            addresses = self.call_native("addresses")
            funding = {
                "stage": "funding",
                "ownerId": self.owner,
                "planDigest": plan["digest"],
                "inputs": selected,
                "allocations": {k: str(v) for k, v in allocated.items()},
                **addresses,
            }
            points = [f"{i['txid']}:{i['vout']}" for i in selected]
            save(folder / "plan.json", plan)
            save(folder / "funding.json", funding)
            j.reserve_plan(plan["tradeId"], plan, points)
        finally:
            j.db.close()
        return {"reservationId": plan["tradeId"]}

    def release(self, tradeId):
        j = Journal(self.root / "journal.sqlite")
        try:
            j.release(tradeId)
        finally:
            j.db.close()

    def collect(self, plan, materials, stage):
        found = {}
        for item in materials:
            m = item.get("material")
            if not isinstance(m, dict) or m.get("stage") != stage:
                continue
            owner = item["ownerId"]
            if (
                owner not in plan["participants"]
                or m.get("ownerId") != owner
                or m.get("planDigest") != plan["digest"]
            ):
                raise ValueError("foreign contribution")
            if owner in found and found[owner] != m:
                raise ValueError("conflicting contribution")
            found[owner] = m
        return found

    def skeleton(self, plan, funding):
        fees = plan_check(plan, self.owner)
        people = plan["participants"]
        contracts = [contract for p in people for contract in funding[p]["allocations"]]
        separate = len(contracts) != len(set(contracts))
        inputs = [item for p in people for item in funding[p]["inputs"]]
        outputs = []
        output_owners = []
        assignments = {p: {} for p in people}
        receivers = []
        # Preserve historical skeletons; shared contracts need isolated proof endpoints.
        if not separate:
            for p in people:
                outputs.append({"address": funding[p]["rgbAddress"], "amountSats": "1000"})
                output_owners.append(p)
        for p in people:
            give = next(leg for leg in plan["legs"] if leg["fromOwnerId"] == p)
            if (
                give["asset"]["kind"] == "rgb"
                and give["asset"]["contractId"] not in funding[p]["allocations"]
            ):
                raise ValueError("missing outgoing allocation")
            allocation_keys = (
                sorted(funding[p]["allocations"]) if separate else funding[p]["allocations"]
            )
            for contract in allocation_keys:
                amount = units(funding[p]["allocations"][contract])
                assigned = {}

                def assign(receiver, value, assigned=assigned):
                    if separate:
                        index = len(outputs)
                        outputs.append(
                            {"address": funding[receiver]["rgbAddress"], "amountSats": "1000"}
                        )
                        output_owners.append(receiver)
                    else:
                        index = people.index(receiver)
                    assigned[str(index)] = str(value)

                if give["asset"]["kind"] == "rgb" and give["asset"]["contractId"] == contract:
                    send = units(give["amount"])
                    if send > amount:
                        raise ValueError("RGB overspend")
                    assign(give["toOwnerId"], send)
                    amount -= send
                if amount:
                    assign(p, amount)
                assignments[p][contract] = assigned
                for vout, n in assigned.items():
                    receivers.append(
                        {
                            "sender": p,
                            "receiver": output_owners[int(vout)],
                            "contractId": contract,
                            "vout": int(vout),
                            "amount": n,
                            "address": outputs[int(vout)]["address"],
                        }
                    )
        for p in people:
            own = sum(units(i["amountSats"]) for i in funding[p]["inputs"])
            change = own + self.btc_delta(plan, p, fees) - 1000 * output_owners.count(p)
            if change < 546 or change > MAX:
                raise ValueError("invalid change")
            outputs.append({"address": funding[p]["btcAddress"], "amountSats": str(change)})
        base = native("build", inputs=inputs, outputs=outputs)
        return {
            "inputs": inputs,
            "outputs": outputs,
            "assignments": assignments,
            "receivers": receivers,
            "base": base,
            "fees": fees,
        }

    @staticmethod
    def btc_delta(plan, owner, fees):
        return (
            sum(
                (1 if leg["toOwnerId"] == owner else -1 if leg["fromOwnerId"] == owner else 0)
                * units(leg["amount"])
                for leg in plan["legs"]
                if leg["asset"]["kind"] == "btc"
            )
            - fees[owner]
        )

    def prepare(self, plan, materials):
        # Python and the native executable are deployed separately. Fail before reserving
        # or publishing a contribution when an older executable is still installed.
        if native("capabilities").get("unilateralCancellation") is not True:
            raise ValueError("native wallet upgrade required for unilateral cancellation")
        self.reserve(plan)
        folder = self.folder(plan["tradeId"])
        n = len(plan["participants"])
        funding = self.collect(plan, materials, "funding")
        published = self.owner in funding
        funding[self.owner] = read(folder / "funding.json")
        if not published or len(funding) < n:
            return {"status": "pending", "material": funding[self.owner]}
        skeleton = self.skeleton(plan, funding)
        colored = self.collect(plan, materials, "colored")
        path = folder / "colored.json"
        if not path.exists():
            own = skeleton["assignments"][self.owner]
            contribution = (
                self.call_native("color", psbt=skeleton["base"]["psbt"], assignments=own)["psbt"]
                if own
                else None
            )
            save(
                path,
                {
                    "stage": "colored",
                    "ownerId": self.owner,
                    "planDigest": plan["digest"],
                    "baseTxid": skeleton["base"]["candidateTxid"],
                    "psbt": contribution,
                },
            )
        published = self.owner in colored
        colored[self.owner] = read(path)
        if any(c["baseTxid"] != skeleton["base"]["candidateTxid"] for c in colored.values()):
            raise ValueError("different skeleton")
        if not published or len(colored) < n:
            return {"status": "pending", "material": colored[self.owner]}
        final = native(
            "merge",
            basePsbt=skeleton["base"]["psbt"],
            contributions=[colored[p]["psbt"] for p in plan["participants"] if colored[p]["psbt"]],
        )
        if units(final["feeSats"]) != sum(skeleton["fees"].values()):
            raise ValueError("fee changed")
        # Persist before publishing proofs: a peer may sign while this wallet is
        # offline, and cancellation must be verifiable without a local preview.
        save(folder / "cancellation-context.json", {"psbt": final["psbt"]})
        proofs = self.collect(plan, materials, "proofs")
        path = folder / "proofs.json"
        if not path.exists():
            own = []
            for receive in skeleton["receivers"]:
                if receive["sender"] != self.owner:
                    continue
                proof = self.call_native(
                    "export",
                    fascia=final["fascia"],
                    contractId=receive["contractId"],
                    vouts=[receive["vout"]],
                )
                own.append({**receive, "consignment": proof["consignment"]})
            save(
                path,
                {
                    "stage": "proofs",
                    "ownerId": self.owner,
                    "planDigest": plan["digest"],
                    "txid": final["candidateTxid"],
                    "proofs": own,
                },
            )
        published = self.owner in proofs
        proofs[self.owner] = read(path)
        if any(p["txid"] != final["candidateTxid"] for p in proofs.values()):
            raise ValueError("different committed transaction")
        if not published or len(proofs) < n:
            return {"status": "pending", "material": proofs[self.owner]}
        all_proofs = [proof for p in plan["participants"] for proof in proofs[p]["proofs"]]
        if [{k: v for k, v in p.items() if k != "consignment"} for p in all_proofs] != skeleton[
            "receivers"
        ]:
            raise ValueError("incomplete or changed proofs")
        package = {
            "protocolVersion": 1,
            "packageId": final["candidateTxid"],
            "tradeId": plan["tradeId"],
            "planRevision": plan["revision"],
            "planDigest": plan["digest"],
            "network": "regtest",
            "unsignedTxDigest": sha(bytes.fromhex(final["unsignedTxHex"])),
            "commitmentDigest": digest(
                {
                    "scripts": final["commitmentScripts"],
                    "proofs": [sha(p["consignment"].encode()) for p in all_proofs],
                }
            ),
            "format": FORMAT,
            "payload": {
                "funding": funding,
                "colored": colored,
                "proofs": all_proofs,
                "final": final,
            },
        }
        return {"status": "ready", "material": proofs[self.owner], "settlementPackage": package}

    def validate(self, package, plan):
        fees = plan_check(plan, self.owner)
        trade = plan["tradeId"]
        folder = self.folder(trade)
        if read(folder / "plan.json") != plan:
            raise ValueError("unreserved plan")
        for k, v in {
            "protocolVersion": 1,
            "tradeId": trade,
            "planRevision": plan["revision"],
            "planDigest": plan["digest"],
            "network": "regtest",
            "format": FORMAT,
        }.items():
            if package.get(k) != v:
                raise ValueError("package identity mismatch")
        payload = package["payload"]
        funding = payload["funding"]
        if funding[self.owner] != read(folder / "funding.json"):
            raise ValueError("own funding replaced")
        if set(funding) != set(plan["participants"]) or set(payload["colored"]) != set(
            plan["participants"]
        ):
            raise ValueError("participant materials missing")
        skeleton = self.skeleton(plan, funding)
        final = native(
            "merge",
            basePsbt=skeleton["base"]["psbt"],
            contributions=[
                payload["colored"][p]["psbt"]
                for p in plan["participants"]
                if payload["colored"][p]["psbt"]
            ],
        )
        if (
            final != payload["final"]
            or package["packageId"] != final["candidateTxid"]
            or package["unsignedTxDigest"] != sha(bytes.fromhex(final["unsignedTxHex"]))
        ):
            raise ValueError("transaction/commitment changed")
        proofs = payload["proofs"]
        if [{k: v for k, v in p.items() if k != "consignment"} for p in proofs] != skeleton[
            "receivers"
        ]:
            raise ValueError("proof routing changed")
        if package["commitmentDigest"] != digest(
            {
                "scripts": final["commitmentScripts"],
                "proofs": [sha(p["consignment"].encode()) for p in proofs],
            }
        ):
            raise ValueError("proof commitment changed")
        receives = []
        # preflight-sign validates these together in one synchronized native wallet session.
        for p in proofs:
            if p["receiver"] == self.owner:
                check = {
                    k: p[k] for k in ("contractId", "vout", "amount", "address", "consignment")
                }
                receives.append(check)
        self.sync_shared_catalog()
        give = next(leg for leg in plan["legs"] if leg["fromOwnerId"] == self.owner)
        receive = next(leg for leg in plan["legs"] if leg["toOwnerId"] == self.owner)
        intent = {
            "network": "regtest",
            "profile": self.profile,
            "fingerprint": self.identity["fingerprint"],
            "tradeId": trade,
            "planRevision": plan["revision"],
            "candidateTxid": final["candidateTxid"],
            "feeSats": final["feeSats"],
            "expectedBtcDeltaSats": str(self.btc_delta(plan, self.owner, fees)),
            "assignments": skeleton["assignments"][self.owner],
            "receives": receives,
            "sighash": "ALL",
            "ownedInputs": [f"{i['txid']}:{i['vout']}" for i in funding[self.owner]["inputs"]],
            "protocolBinding": {
                k: package[k]
                for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
            },
        }
        j = Journal(self.root / "journal.sqlite")
        try:
            row = j.snapshot(trade)
            if row["state"] not in ("PREPARING", "AWAITING_APPROVAL"):
                raise ValueError("signature may exist; sync instead")
            # Refuse replacing approved review bytes even before a signature is released.
            if (folder / "approval-intent.json").exists() and read(
                folder / "approval-intent.json"
            ) != intent:
                raise ValueError("immutable review changed")
            review_files = [folder / "review-package.json", folder / "approval-intent.json"]
            previous = {path: path.read_bytes() if path.exists() else None for path in review_files}
            try:
                save(review_files[0], {"final": final})
                save(review_files[1], intent)
                preflight = self.call_native(
                    "preflight-sign", trade, approvalDigest=approval_digest(intent)
                )
                state = self._state_from_raw(preflight["state"])
                j.bind_approval(trade, plan, intent)
                save(folder / "cancellation-context.json", {"psbt": final["psbt"]})
            except Exception:
                # A rejected proof must not freeze an invalid review for subsequent retries.
                for path, content in previous.items():
                    if content is None:
                        path.unlink(missing_ok=True)
                    else:
                        path.write_bytes(content)
                raise
        finally:
            j.db.close()
        after = []
        for b in state["balances"]:
            value = int(b["amount"])
            if asset_key(b["asset"]) == asset_key(give["asset"]):
                value -= units(give["amount"])
            if asset_key(b["asset"]) == asset_key(receive["asset"]):
                value += units(receive["amount"])
            if b["asset"]["kind"] == "btc":
                value -= fees[self.owner]
            if not 0 <= value <= MAX:
                raise ValueError("balance limit")
            after.append({"asset": b["asset"], "amount": str(value)})
        preview = {
            "walletId": self.wallet_id,
            "ownerId": self.owner,
            "mode": "real",
            "network": "regtest",
            **intent["protocolBinding"],
            "validated": True,
            "reasons": [],
            "give": {"asset": give["asset"], "amount": give["amount"]},
            "receive": {"asset": receive["asset"], "amount": receive["amount"]},
            "feeSats": str(fees[self.owner]),
            "btcDelta": intent["expectedBtcDeltaSats"],
            "balancesAfter": after,
        }
        save(folder / "package.json", package)
        save(folder / "preview.json", preview)
        save(folder / "before.json", state)
        return preview

    def sign(self, package, approval):
        trade = package["tradeId"]
        folder = self.folder(trade)
        if (folder / "cancellation-approval.json").exists():
            raise ValueError("cancellation authorized; original signing is disabled")
        if package != read(folder / "package.json"):
            raise ValueError("unreviewed package")
        expected = {
            "protocolVersion": 1,
            "walletId": self.wallet_id,
            "ownerId": self.owner,
            "network": "regtest",
            "tradeId": trade,
            "planRevision": package["planRevision"],
            **{
                k: package[k]
                for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
            },
        }
        if (
            any(approval.get(k) != v for k, v in expected.items())
            or not approval.get("approvalId")
            or not isinstance(approval.get("approvedAt"), int)
        ):
            raise ValueError("stale or foreign approval")
        # Recovery must replay the original authorization, not invent another approval
        # after an uncertain response. Persist it before crypto can begin.
        authorization = folder / "user-approval.json"
        if authorization.exists() and read(authorization) != approval:
            raise ValueError("saved user approval is immutable; replay the original authorization")
        if not authorization.exists():
            save(authorization, approval)
        intent = read(folder / "approval-intent.json")
        h = approval_digest(intent)
        j = Journal(self.root / "journal.sqlite")
        try:
            signed = j.begin_signing(trade, h, True)
            if signed is None:
                signed = self.call_native("sign", trade, approved=True, approvalDigest=h)[
                    "signedPsbt"
                ]
                j.record_signature(trade, signed)
            return {
                "status": "signed",
                "signature": {
                    "ownerId": self.owner,
                    "packageId": package["packageId"],
                    "psbt": signed,
                },
            }
        finally:
            j.db.close()

    def recoverSignature(self, package):
        """Read an existing signature only; never start signing or change approval."""
        trade = package["tradeId"]
        folder = self.folder(trade)
        if (folder / "cancellation-approval.json").exists():
            raise ValueError("cancellation authorized; original signature relay is disabled")
        if package != read(folder / "package.json"):
            raise ValueError("changed recovery package")
        approval = read(folder / "user-approval.json")
        expected = {
            "walletId": self.wallet_id,
            "ownerId": self.owner,
            "network": "regtest",
            "tradeId": trade,
            "planRevision": package["planRevision"],
            **{
                k: package[k]
                for k in ("packageId", "planDigest", "unsignedTxDigest", "commitmentDigest")
            },
        }
        if any(approval.get(k) != v for k, v in expected.items()):
            raise ValueError("saved approval binding mismatch")
        j = Journal(self.root / "journal.sqlite")
        try:
            row = j.snapshot(trade)
            if (
                not row
                or row["state"] not in ("SIGNED", "RECONCILING", "BROADCAST", "CONFIRMED")
                or not row["signature"]
            ):
                raise ValueError("no durable signature to recover")
            if row["digest"] != approval_digest(read(folder / "approval-intent.json")) or row[
                "digest"
            ] != approval_digest(json.loads(row["intent"])):
                raise ValueError("saved intent mismatch")
            return {
                "status": "signed",
                "signature": {
                    "ownerId": self.owner,
                    "packageId": package["packageId"],
                    "psbt": row["signature"],
                },
            }
        finally:
            j.db.close()

    def finalize(self, package, signatures):
        trade = package["tradeId"]
        folder = self.folder(trade)
        if (folder / "cancellation-approval.json").exists():
            return self.sync(trade)
        plan = read(folder / "plan.json")
        if package != read(folder / "package.json"):
            raise ValueError("changed package")
        j = Journal(self.root / "journal.sqlite")
        try:
            row = j.snapshot(trade)
            if not row["signature"]:
                raise ValueError("no local signature")
            if not (folder / "finalized.json").exists():
                if len(signatures) != len(plan["participants"]) or {
                    s["ownerId"] for s in signatures
                } != set(plan["participants"]):
                    raise ValueError("incomplete signatures")
                psbts = []
                for item in signatures:
                    s = item["signature"]
                    if s["ownerId"] != item["ownerId"] or s["packageId"] != package["packageId"]:
                        raise ValueError("signature identity")
                    if item["ownerId"] == self.owner and s["psbt"] != row["signature"]:
                        raise ValueError("local signature replaced")
                    psbts.append(s["psbt"])
                final = rpc("finalizepsbt", rpc("combinepsbt", psbts))
                if (
                    not final["complete"]
                    or rpc("decoderawtransaction", final["hex"])["txid"] != package["packageId"]
                ):
                    raise ValueError("incomplete/changed transaction")
                save(folder / "finalized.json", {"hex": final["hex"], "txid": package["packageId"]})
            final = read(folder / "finalized.json")
            # Persist ambiguity before any external RPC. A process kill/network failure
            # cannot leave an apparently cancellable operation behind.
            if row["state"] != "CONFIRMED":
                j.broadcast_result(trade, final["txid"], False)
            try:
                known = rpc("getrawtransaction", final["txid"], True)
            except RuntimeError:
                known = None
            if known is None:
                if not rpc("testmempoolaccept", [final["hex"]])[0].get("allowed"):
                    raise ValueError("mempool rejected; inputs remain pinned")
                try:
                    rpc("sendrawtransaction", final["hex"])
                except RuntimeError:
                    try:
                        rpc("getrawtransaction", final["txid"], True)
                    except RuntimeError:
                        j.broadcast_result(trade, final["txid"], False)
                        return self.receipt(trade, "reconciling", False, False, final["txid"])
            if row["state"] != "CONFIRMED":
                j.broadcast_result(trade, final["txid"], True)
        finally:
            j.db.close()
        return self.sync(trade)

    @staticmethod
    def receipt(trade, state, chain, rgb, txid=None):
        return {
            "mode": "real",
            "tradeId": trade,
            "network": "regtest",
            "state": state,
            "chainConfirmed": chain,
            "rgbAccepted": rgb,
            **({"txid": txid} if txid else {}),
        }

    def previewCancellation(self, tradeId):
        from cancellation import preview

        return preview(self, tradeId)

    def cancel(self, tradeId, approvalDigest, confirmed):
        from cancellation import cancel

        return cancel(self, tradeId, approvalDigest, confirmed)

    def sync(self, tradeId, cancellationTxid=None):
        from cancellation import reconcile

        cancelled = reconcile(self, tradeId, cancellationTxid)
        if cancelled is not None:
            return cancelled
        folder = self.folder(tradeId)
        j = Journal(self.root / "journal.sqlite")
        try:
            row = j.snapshot(tradeId)
            if not row:
                raise ValueError("unknown trade")
            released = folder / "released-signature.psbt"
            if not row["signature"] and row["state"] == "CANCELLING" and released.exists():
                # Crypto may have completed before Python saved its result. Read
                # only the already released signature; cancellation cannot sign a swap.
                if (folder / "signature-intent.txt").read_text() != row["digest"]:
                    raise ValueError("saved signature intent mismatch")
                j.record_signature(tradeId, released.read_text())
                row = j.snapshot(tradeId)
            if not row["signature"]:
                return self.receipt(tradeId, "pending", False, False)
            package = read(folder / "package.json")
            txid = package["packageId"]
            try:
                chain = rpc("getrawtransaction", txid, True)
            except RuntimeError:
                return self.receipt(tradeId, "reconciling", False, False, txid)
            if row["state"] != "CONFIRMED":
                j.broadcast_result(tradeId, txid, True)
            if chain.get("confirmations", 0) < 1:
                return self.receipt(tradeId, "pending", False, False, txid)
            if row["state"] == "CONFIRMED" and (folder / "receipt.json").exists():
                return self.receipt(tradeId, "confirmed", True, True, txid)
            try:
                result = self.call_native("sync-confirmed", tradeId, rawTx=chain["hex"])
                state = self.state()
                expected = read(folder / "preview.json")["balancesAfter"]
                actual = {asset_key(b["asset"]): b["amount"] for b in state["balances"]}
                # Native validation binds the exact confirmed tx to the signed BTC
                # delta. Other deposits/coinbase maturation can change total BTC
                # independently; they must not be reported as RGB acceptance failure.
                if (
                    result.get("txid") != txid
                    or not result.get("rgbAccepted")
                    or not result.get("chainConfirmed")
                ):
                    raise ValueError("native confirmation/acceptance incomplete")
                if any(
                    actual.get(asset_key(b["asset"])) != b["amount"]
                    for b in expected
                    if b["asset"]["kind"] == "rgb"
                ):
                    raise ValueError("actual settled RGB balances differ from preview")
                expected_btc = next(b["amount"] for b in expected if b["asset"]["kind"] == "btc")
                result["btcBalanceDifferenceFromPreviewSats"] = str(
                    int(actual[asset_key(BTC)]) - int(expected_btc)
                )
            except Exception as error:
                save(
                    folder / "last-sync-error.json",
                    {"type": type(error).__name__, "message": str(error)},
                )
                j.receipt(tradeId, True, False)
                return self.receipt(tradeId, "reconciling", True, False, txid)
            j.receipt(tradeId, True, True)
            save(folder / "receipt.json", result)
            return self.receipt(tradeId, "confirmed", True, True, txid)
        finally:
            j.db.close()

    def handle(self, method, params):
        if method not in (
            "capabilities",
            "state",
            "fundingTarget",
            "reserve",
            "release",
            "prepare",
            "validate",
            "sign",
            "recoverSignature",
            "previewCancellation",
            "cancel",
            "finalize",
            "sync",
        ):
            raise ValueError("unknown operation")
        if "package" in params:
            params = {**params, "package": params["package"]}
        return getattr(self, method)(**params)
