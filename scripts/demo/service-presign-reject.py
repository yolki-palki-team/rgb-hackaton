#!/usr/bin/env python3
"""Verify peer reservation cleanup after pre-sign rejection on real service APIs."""
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
    runtime.stop("local-carol")
    runtime.local("alice",f"/trades/{trade_id}/reject",{"reason":"Integration: owner rejects before any signature"})
    assert runtime.local("alice",f"/trades/{trade_id}")["status"]=="REJECTED"
    # Bob observes cancellation online; Carol was offline and must recover on restart.
    runtime.local("bob","/snapshot")
    runtime.start_local("carol");runtime.ready(["carol"])
    for p in PEOPLE:
        assert runtime.local(p,f"/trades/{trade_id}/reject",{"reason":"Idempotent acknowledgement"})["status"]=="cancelled"
        with sqlite3.connect(STATE/p/"journal.sqlite") as db:
            state,signature=db.execute("SELECT state,signature FROM trades WHERE id=?",(trade_id,)).fetchone()
            count=db.execute("SELECT COUNT(*) FROM reservations WHERE trade_id=?",(trade_id,)).fetchone()[0]
            assert signature is None and state=="CANCELLED" and count==0
            evidence[p]={"backendState":state,"reservedInputs":count}
    evidence.update(tradeId=trade_id,offlinePeerRecovered="carol",clientRecoveryImplemented=True,testOnlyUnsignedBackendCleanup=False)
finally:
    runtime.close()
save(ROOT/"scripts/demo/evidence/service-fixed-presign-reject.json",evidence)
print(json.dumps(evidence))
