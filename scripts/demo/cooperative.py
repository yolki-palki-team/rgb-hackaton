#!/usr/bin/env python3
"""Unsigned real RGB direct/ring preparation. Never signs or broadcasts."""
import argparse
import json
from regtest import STATE, native, rpc

def prepare(scenario):
    if scenario not in ("direct", "ring"):
        raise ValueError("scenario")
    people = ("alice", "bob") if scenario == "direct" else ("alice", "bob", "carol")
    states = {p:native("state",p) for p in people}
    addresses = {p:json.loads((STATE/p/"addresses.json").read_text()) for p in people}
    assets = {p:{a["ticker"]:a["asset_id"] for a in states[p]["assets"]["nia"]} for p in people}
    selected = {}
    for p in people:
        colored = (p=="bob" or (p=="alice" and scenario=="ring"))
        selected[p] = next(u for u in states[p]["unspents"] if u["utxo"]["colorable"]==colored and (not colored or bool(u["rgb_allocations"])))
    inputs = []
    for p in people:
        u = selected[p]["utxo"]
        chain = rpc("gettxout",u["outpoint"]["txid"],u["outpoint"]["vout"])
        if chain is None or chain["confirmations"] < 101:
            raise RuntimeError("funding must be unspent mature coinbase")
        raw=rpc("getrawtransaction",u["outpoint"]["txid"],False)
        inputs.append({**u["outpoint"],"amountSats":str(u["btc_amount"]),"scriptPubKey":chain["scriptPubKey"]["hex"],"rawTx":raw})
    def out(p, key, amount):
        return {"address":addresses[p][key],"amountSats":str(amount)}
    amount = {p:int(selected[p]["utxo"]["btc_amount"]) for p in people}
    if scenario=="direct":
        outputs = [out("alice","rgbAddress",1000),out("bob","btcAddress",100000),
                   out("alice","btcAddress",amount["alice"]-101500),out("bob","rgbAddress",amount["bob"]-500)]
        assignments = {"bob":{assets["bob"]["DUSD"]:{"0":"100"}}}
        receives = [("bob","alice","DUSD",0,"100")]
    else:
        outputs = [out("alice","rgbAddress",1000),out("carol","rgbAddress",1000),out("bob","btcAddress",100000),
                   out("alice","rgbAddress",amount["alice"]-1333),out("bob","rgbAddress",amount["bob"]-333),
                   out("carol","btcAddress",amount["carol"]-101334)]
        assignments = {"alice":{assets["alice"]["X"]:{"1":"100"},assets["alice"]["KEEP"]:{"3":"7"}},
                       "bob":{assets["bob"]["DUSD"]:{"0":"100"}}}
        receives = [("alice","carol","X",1,"100"),("bob","alice","DUSD",0,"100"),("alice","alice","KEEP",3,"7")]
        contracts_on_alice = {a["asset_id"] for a in selected["alice"]["rgb_allocations"]}
        if not {assets["alice"]["X"],assets["alice"]["KEEP"]}.issubset(contracts_on_alice):
            raise RuntimeError("fixture requires X and KEEP on SAME spent UTXO")
    base = native("build",inputs=inputs,outputs=outputs)
    contributions = {p:native("color",p,psbt=base["psbt"],assignments=a) for p,a in assignments.items()}
    final = native("merge",basePsbt=base["psbt"],contributions=[c["psbt"] for c in contributions.values()])
    if final["feeSats"] != "1000":
        raise RuntimeError("unexpected fee")
    validations = []
    consignments = []
    for sender,receiver,ticker,vout,n in receives:
        contract = assets[sender][ticker]
        exported = native("export",sender,fascia=final["fascia"],contractId=contract,vouts=[vout])
        check = dict(psbt=final["psbt"],contractId=contract,vout=vout,amount=n,address=outputs[vout]["address"],consignment=exported["consignment"])
        validation = native("validate",receiver,**check)
        validations.append({"receiver":receiver,"ticker":ticker,**validation})
        consignments.append({"receiver":receiver,"ticker":ticker,**check})
    package = {"scenario":scenario,"network":"regtest","phase":"unsigned-consignment-validated",
               "settled":False,"participants":list(people),"base":base,"contributions":contributions,"final":final,
               "inputs":inputs,"outputs":outputs,"assignments":assignments,"consignments":consignments,"validations":validations}
    (STATE/f"{scenario}-unsigned.json").write_text(json.dumps(package,indent=2))
    return package

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("scenario",choices=["direct","ring"])
    args=parser.parse_args()
    p=prepare(args.scenario)
    print(json.dumps({"scenario":p["scenario"],"network":"regtest","phase":p["phase"],"settled":False,
        "candidateTxid":p["final"]["candidateTxid"],"feeSats":p["final"]["feeSats"],"validations":p["validations"]},indent=2))

if __name__=="__main__":
    main()
