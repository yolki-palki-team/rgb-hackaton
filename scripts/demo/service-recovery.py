#!/usr/bin/env python3
"""Real-service failure reproducers. Reports A recovery gaps without bypassing its checks."""
import argparse
import importlib.util
import json
import sqlite3
import subprocess
import time
from service_runtime import Runtime, PEOPLE, STATE, ROOT, configure, save, read
from protocol import sha, digest

spec = importlib.util.spec_from_file_location("service_smoke", ROOT / "scripts/demo/service-smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def local_record(person, key):
    with sqlite3.connect(STATE / "services" / person / "local.sqlite") as db:
        row = db.execute("SELECT value FROM local_records WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None


def journal(person, trade):
    with sqlite3.connect(STATE / person / "journal.sqlite") as db:
        row = db.execute("SELECT state,signature FROM trades WHERE id=?", (trade,)).fetchone()
        count = db.execute("SELECT COUNT(*) FROM reservations WHERE trade_id=?", (trade,)).fetchone()[0]
        return {"state": row[0], "signatureHash": sha(row[1].encode()) if row[1] else None, "reservedInputs": count}


def must_reject(action):
    try: action()
    except RuntimeError: return True
    raise AssertionError("Unsafe operation unexpectedly accepted")


parser = argparse.ArgumentParser()
parser.add_argument("--source", required=True)
parser.add_argument("--base-port", type=int, default=43100)
parser.add_argument("--fault", choices=["lost-sign-response", "broadcast-accepted", "broadcast-not-submitted"], required=True)
parser.add_argument("--scenario", choices=["direct", "ring"], default="direct")
parser.add_argument("--reverse", action="store_true")
parser.add_argument("--resume-trade", help="Resume an already injected broadcast fault without a new order or signature")
args = parser.parse_args()
configure(args.source, args.base_port)
runtime = Runtime()
people = PEOPLE[:2] if args.scenario == "direct" else PEOPLE
victim = people[0] if args.fault == "lost-sign-response" else people[-1]
evidence = {"network": "regtest", "mode": "real", "fault": args.fault,
            "faultBoundary": "real wallet HTTP socket closed after durable signature" if args.fault == "lost-sign-response" else "test-only RPC response-loss injection; real Bitcoin used",
            "source": str(runtime.source), "clientRecoveryImplemented": False}


def restart_and_check(runtime, trade_id, participants):
    evidence["tradeId"] = trade_id
    evidence["beforeRestart"] = journal(victim, trade_id)
    assert evidence["beforeRestart"]["state"] == "RECONCILING"
    runtime.stop("local-" + victim); runtime.stop("wallet-" + victim)
    runtime.profile(victim); runtime.ready([victim],wallet_state=False)
    evidence["afterRestart"] = journal(victim, trade_id)
    assert evidence["beforeRestart"] == evidence["afterRestart"]
    receipt = runtime.local(victim, f"/trades/{trade_id}/sync", {})
    evidence["syncAfterRestart"] = receipt
    if args.fault == "broadcast-not-submitted":
        assert receipt["state"] == "reconciling" and not receipt["chainConfirmed"]
        evidence["clientBlocker"] = "sync does not replay finalize for the durable finalized transaction when initial broadcast was never submitted"
        raise RuntimeError("EXPECTED_A_RECOVERY_GAP")
    evidence["clientRecoveryImplemented"] = True


try:
    runtime.market()
    for person in PEOPLE: runtime.profile(person, args.fault if person == victim else None)
    runtime.ready(wallet_state=not bool(args.resume_trade))
    initial = {t["plan"]["tradeId"] for t in runtime.local(people[0], "/snapshot")["trades"]}
    try:
        if args.resume_trade:
            if not args.fault.startswith("broadcast-"): raise ValueError("Resume is only for the persisted broadcast test")
            assert (STATE/victim/("test-"+args.fault+".json")).exists()
            restart_and_check(runtime,args.resume_trade,people)
            result=smoke.settle(runtime,args.resume_trade,args.scenario,args.reverse,evidence_name=f'service-{args.fault}-settlement.json')
        else:
            result = smoke.run(runtime, args.scenario, args.reverse, restart_and_check if args.fault != "lost-sign-response" else None,
                               evidence_name=f'service-{args.fault}-settlement.json')
        evidence["settlement"] = result
    except RuntimeError as error:
        trades = [t for t in runtime.local(people[0], "/snapshot")["trades"] if t["plan"]["tradeId"] == args.resume_trade or t["plan"]["tradeId"] not in initial]
        assert len(trades) == 1
        trade = trades[0]; trade_id = trade["plan"]["tradeId"]; evidence["tradeId"] = trade_id
        if args.fault == "lost-sign-response":
            assert (STATE / victim / "test-lost-sign-response.json").exists(), "Failure occurred before injected fault"
            before = journal(victim, trade_id)
            assert before["state"] == "SIGNED" and before["signatureHash"] and before["reservedInputs"]
            assert local_record(victim, "approval:" + trade_id) is None
            assert local_record(victim, "signature:" + trade_id) is None
            runtime.stop("local-" + victim); runtime.stop("wallet-" + victim)
            runtime.profile(victim); runtime.ready([victim])
            receipt = runtime.local(victim, f"/trades/{trade_id}/sync", {})
            folder = STATE / victim / "trades" / sha(trade_id.encode())
            # Backend replay is checked separately and is NOT relayed around local-client policy.
            result = runtime.wallet(victim, "sign", {"package": read(folder / "package.json"), "approval": read(folder / "user-approval.json")})
            assert sha(result["signature"]["psbt"].encode()) == before["signatureHash"]
            assert journal(victim, trade_id) == before
            evidence.update(beforeRestart=before, afterRestart=journal(victim, trade_id), syncAfterRestart=receipt,
                            backendOriginalApprovalReplaySameSignature=True, localApprovalLost=True, localSignatureAbsent=True,
                            clientBlocker="approve clears saved approval before wallet.sign; sync neither recovers the signature with original approval nor relays it")
        else:
            assert str(error) == "EXPECTED_A_RECOVERY_GAP", str(error)
        trade = runtime.local(victim, f"/trades/{trade_id}")
        evidence["marketStatus"] = trade["status"]
        evidence["releaseRejected"] = must_reject(lambda: runtime.wallet(victim, "release", {"tradeId": trade_id}))
        evidence["prepareRejected"] = must_reject(lambda: runtime.local(victim, f"/trades/{trade_id}/prepare", {}))
        evidence["previewRejected"] = must_reject(lambda: runtime.local(victim, f"/trades/{trade_id}/preview", {}))
        evidence["reservedOrders"] = all(o["status"] == "RESERVED" for p in people for o in runtime.local(p, "/snapshot")["myOrders"] if o["id"] in {r["orderId"] for r in trade["plan"]["orderRefs"]})
        assert evidence["reservedOrders"]
        evidence["signatureOwnersAtMarket"] = [m["ownerId"] for m in trade["messages"] if m["message"]["type"] == "signature" and "signature" in m["message"]["payload"]]
        evidence["newTradeCreated"] = False
        audit = subprocess.check_output(["rtk", "proxy", *runtime.node(str(ROOT / "scripts/demo/service-market-audit.mts")),
                                         str(runtime.source), str(STATE / "services/market.sqlite"), trade_id], text=True)
        evidence["expiryAndPrivacyAudit"] = json.loads(audit)
    save(ROOT / "scripts/demo/evidence" / f'service-{args.fault}.json', evidence)
    save(STATE / "services" / f'evidence-{args.fault}.json', evidence)
    print(json.dumps(evidence), flush=True)
finally: runtime.close()
