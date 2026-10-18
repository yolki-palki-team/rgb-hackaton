"""Regtest unilateral cancellation. A timeout is never evidence of cancellation."""

import re

from journal import Journal, digest


def preview(backend, trade):
    from protocol import read, save

    folder = backend.folder(trade)
    j = Journal(backend.root / "journal.sqlite")
    try:
        row = j.snapshot(trade)
        if not row or row["state"] not in ("SIGNING", "SIGNED", "RECONCILING", "BROADCAST"):
            raise ValueError("only an unresolved signed swap can be cancelled on chain")
        if (folder / "cancellation-approval.json").exists():
            raise ValueError("cancellation already authorized; sync instead")
        original = read(folder / "package.json")["packageId"]
        if chain_transaction(original).get("confirmations", 0) > 0:
            raise ValueError("swap already confirmed; sync instead")
        quote = backend.call_native("cancel-preview", trade)
        intent = {
            "network": "regtest",
            "profile": backend.profile,
            "fingerprint": backend.identity["fingerprint"],
            "tradeId": trade,
            "walletId": backend.wallet_id,
            "ownerId": backend.owner,
            "originalTxid": original,
            **quote,
        }
        save(folder / "cancellation-intent.json", intent)
        return {
            k: intent[k]
            for k in (
                "tradeId",
                "walletId",
                "ownerId",
                "network",
                "originalTxid",
                "cancellationTxid",
                "input",
                "address",
                "returnSats",
                "feeSats",
            )
        } | {"approvalDigest": digest(intent)}
    finally:
        j.db.close()


def chain_transaction(txid):
    from protocol import rpc

    try:
        return rpc("getrawtransaction", txid, True)
    except RuntimeError:
        # An unavailable node must never release reservations.
        return {}


def cancel(backend, trade, approvalDigest, confirmed):
    from protocol import read, save

    folder = backend.folder(trade)
    intent = read(folder / "cancellation-intent.json")
    if confirmed is not True or digest(intent) != approvalDigest or intent["tradeId"] != trade:
        raise ValueError("explicit immutable cancellation approval required")
    if intent["network"] != "regtest" or intent["walletId"] != backend.wallet_id:
        raise ValueError("wrong cancellation wallet/network")
    authorization = folder / "cancellation-approval.json"
    approval = {"approvalDigest": approvalDigest, "confirmed": True}
    if authorization.exists() and read(authorization) != approval:
        raise ValueError("cancellation approval changed")
    if not authorization.exists():
        j = Journal(backend.root / "journal.sqlite")
        try:
            row = j.snapshot(trade)
            if row and row["state"] == "CONFIRMED":
                return backend.sync(trade)
            j.begin_cancellation(trade)
            save(authorization, approval)
        finally:
            j.db.close()
    return backend.sync(trade)


def reconcile(backend, trade, hint=None):
    from protocol import read, rpc, save

    folder = backend.folder(trade)
    authorization = folder / "cancellation-approval.json"
    evidence = folder / "cancellation-confirmed.json"
    if hint is not None and (not isinstance(hint, str) or not re.fullmatch("[a-f0-9]{64}", hint)):
        raise ValueError("invalid cancellation transaction ID")
    candidates = [hint] if hint else []
    if evidence.exists():
        candidates.insert(0, read(evidence)["txid"])
    intent = read(folder / "cancellation-intent.json") if authorization.exists() else None
    if intent:
        approval = read(authorization)
        if approval != {"approvalDigest": digest(intent), "confirmed": True}:
            raise ValueError("cancellation authorization changed")
        candidates.insert(0, intent["cancellationTxid"])
    for txid in dict.fromkeys(candidates):
        chain = chain_transaction(txid)
        if chain.get("confirmations", 0) < 1:
            continue
        # Peer hints are not authority. Native verifies a distinct confirmed
        # transaction spending a pinned input and reconciles Bitcoin state.
        result = backend.call_native("cancel-sync", trade, rawTx=chain["hex"])
        if result.get("cancellationTxid") != txid or result.get("cancelled") is not True:
            raise ValueError("unverified cancellation result")
        save(evidence, {"txid": txid})
        j = Journal(backend.root / "journal.sqlite")
        try:
            j.confirm_cancellation(trade)
        finally:
            j.db.close()
        return {
            **backend.receipt(trade, "cancelled", False, False, result["originalTxid"]),
            "cancellationTxid": txid,
            "reason": "Confirmed conflicting transaction invalidated the swap; reservations released.",
        }
    if not intent:
        return None
    if chain_transaction(intent["originalTxid"]).get("confirmations", 0) > 0:
        return None
    final_path = folder / "cancellation-finalized.json"
    if not final_path.exists():
        signed = backend.call_native(
            "cancel-sign", trade, approved=True, approvalDigest=digest(intent)
        )
        final = rpc("finalizepsbt", signed["signedPsbt"])
        if (
            not final["complete"]
            or rpc("decoderawtransaction", final["hex"])["txid"] != intent["cancellationTxid"]
        ):
            raise ValueError("cancellation finalization mismatch")
        save(final_path, {"hex": final["hex"], "txid": intent["cancellationTxid"]})
    final = read(final_path)
    if final["txid"] != intent["cancellationTxid"]:
        raise ValueError("saved cancellation changed")
    reason = "Cancellation submitted; reserves stay locked until confirmation. The original swap may still win."
    try:
        rpc("sendrawtransaction", final["hex"])
    except RuntimeError:
        reason = "Cancellation broadcast is unconfirmed or unavailable; reserves remain locked. Sync to retry the same transaction."
    return {
        **backend.receipt(trade, "cancelling", False, False, intent["originalTxid"]),
        "cancellationTxid": intent["cancellationTxid"],
        "reason": reason,
    }
