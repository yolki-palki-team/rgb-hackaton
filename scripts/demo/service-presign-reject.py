#!/usr/bin/env python3
"""Reproduce peer reservation cleanup after pre-sign rejection on real service APIs."""
import json
import sqlite3
import time
import uuid
from service_runtime import Runtime, PEOPLE, STATE, ROOT, save

runtime=Runtime(); trade_id=None
evidence={"mode":"real","signed":False,"fault":"pre-sign peer rejection"}
try:
    runtime.market()
    for p in PEOPLE:runtime.profile(p)
    runtime.ready()
    assets={b["asset"]["symbol"]:b["asset"] for b in runtime.local("alice","/state")["balances"]}
    ids=set()
    for p,give,amount,receive,minimum in [("alice","X","100","DUSD","100"),("bob","DUSD","100","BTC","100000"),("carol","BTC","100000","X","100")]:
        policy=runtime.local(p,"/policy");policy.update(allowBtcSale=give=="BTC",protectedBalances={},maxFeeSats="1000")
        order=runtime.local(p,"/orders",{"draft":{"giveAsset":assets[give],"giveAmount":amount,"receiveAsset":assets[receive],"minReceiveAmount":minimum,
                         "maxFeeSats":"1000","expiresAt":int(time.time()*1000)+600000},"policy":policy,"confirmed":True,"requestId":str(uuid.uuid4())})
        ids.add(order["id"])
    trade=next(t for t in runtime.local("alice","/snapshot")["trades"] if {r["orderId"] for r in t["plan"]["orderRefs"]}==ids)
    trade_id=trade["plan"]["tradeId"]
    for p in PEOPLE:runtime.local(p,f"/trades/{trade_id}/prepare",{})
    runtime.local("alice",f"/trades/{trade_id}/reject",{"reason":"Integration: owner rejects before any signature"})
    assert runtime.local("alice",f"/trades/{trade_id}")["status"]=="REJECTED"
    for p in PEOPLE:
        with sqlite3.connect(STATE/p/"journal.sqlite") as db:
            state,signature=db.execute("SELECT state,signature FROM trades WHERE id=?",(trade_id,)).fetchone()
            assert signature is None
            evidence[p]={"backendState":state,"reservedInputs":db.execute("SELECT COUNT(*) FROM reservations WHERE trade_id=?",(trade_id,)).fetchone()[0]}
    assert evidence["alice"]["backendState"]=="CANCELLED"
    for p in ("bob","carol"):
        try:runtime.local(p,f"/trades/{trade_id}/reject",{"reason":"Acknowledge peer pre-sign cancellation"})
        except RuntimeError as error:evidence[p]["localCleanupError"]=str(error)
        else:raise AssertionError("Pinned A implementation changed; inspect new recovery behavior")
        assert evidence[p]["backendState"]=="PREPARING" and evidence[p]["reservedInputs"]>0
    evidence["tradeId"]=trade_id
    evidence["clientBlocker"]="Peer wallet reservations remain PREPARING after market REJECTED; retry reject hits TRADE_TERMINAL before wallet.release"
finally:
    # Explicit test cleanup is safe ONLY after checking actual journals have no
    # signature and remain pre-sign. It is not counted as product recovery.
    if trade_id:
        for p in PEOPLE:
            with sqlite3.connect(STATE/p/"journal.sqlite") as db:
                row=db.execute("SELECT state,signature FROM trades WHERE id=?",(trade_id,)).fetchone()
            if row and row[0] in ("PREPARING","AWAITING_APPROVAL") and row[1] is None:runtime.wallet(p,"release",{"tradeId":trade_id})
    runtime.close()
evidence["testOnlyUnsignedBackendCleanup"]=True
save(ROOT/"scripts/demo/evidence/service-presign-reject.json",evidence)
print(json.dumps(evidence))
