#!/usr/bin/env python3
"""Actual service no-match/cancellation/idempotency checks; never signs or prepares."""
from concurrent.futures import ThreadPoolExecutor
import json
import time
import uuid
from service_runtime import Runtime, PEOPLE, ROOT, save

runtime=Runtime()
created=[]
evidence={"mode":"real","signed":False,"prepared":False}
try:
    runtime.market()
    for p in PEOPLE:runtime.profile(p)
    runtime.ready()
    states={p:runtime.local(p,"/state") for p in PEOPLE}
    assets={b["asset"]["symbol"]:b["asset"] for s in states.values() for b in s["balances"]}
    initial={t["plan"]["tradeId"] for t in runtime.local("alice","/snapshot")["trades"]}
    requests={}
    for p,give,amount,receive,minimum in [("alice","X","100","DUSD","101"),("bob","DUSD","100","BTC","100000"),("carol","BTC","100000","X","100")]:
        policy=runtime.local(p,"/policy");policy.update(allowBtcSale=give=="BTC",protectedBalances={},maxFeeSats="1000")
        body={"draft":{"giveAsset":assets[give],"giveAmount":amount,"receiveAsset":assets[receive],"minReceiveAmount":minimum,
                       "maxFeeSats":"1000","expiresAt":int(time.time()*1000)+600000},"policy":policy,"confirmed":True,"requestId":str(uuid.uuid4())}
        order=runtime.local(p,"/orders",body);created.append((p,order));requests[p]=body
    snapshot=runtime.local("alice","/snapshot")
    assert initial=={t["plan"]["tradeId"] for t in snapshot["trades"]}
    assert all(order["status"]=="OPEN" for _,order in created)
    evidence["impossibleRing101DUSD"]="no match"
    for p,order in created:runtime.local(p,f'/orders/{order["id"]}/cancel',{"revision":order["revision"]})
    for p,order in created:
        retried=runtime.local(p,"/orders",requests[p])
        assert retried["id"]==order["id"] and retried["status"]=="CANCELLED"
    evidence["cancelledPublicationReplay"]="same cancelled IDs; no resurrection"
    created.clear()
    def publish():
        body={**requests["alice"],"requestId":str(uuid.uuid4())}
        try:return runtime.local("alice","/orders",body)
        except RuntimeError:return None
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda _:publish(),range(2)))
    successful=[x for x in results if x]
    assert len(successful)==1
    created.append(("alice",successful[0]))
    assert initial=={t["plan"]["tradeId"] for t in runtime.local("alice","/snapshot")["trades"]}
    evidence["simultaneousSameOwnerPublication"]="one accepted; one rejected; cancelled counterpart not matched"
    save(ROOT/"scripts/demo/evidence/service-order-negatives.json",evidence)
    print(json.dumps(evidence))
finally:
    for p,order in created:
        try:runtime.local(p,f'/orders/{order["id"]}/cancel',{"revision":order["revision"]})
        except (OSError,RuntimeError):pass
    runtime.close()
