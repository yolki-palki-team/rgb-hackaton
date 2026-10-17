#!/usr/bin/env python3
"""Independently check saved full-service tx evidence against Bitcoin Core and private reviews."""
import argparse
from decimal import Decimal
import json
import subprocess
from pathlib import Path
from regtest import ROOT, STATE, rpc
from service_runtime import read, save
from protocol import asset_key

parser=argparse.ArgumentParser()
parser.add_argument("--scenario", choices=["direct","ring"], required=True)
parser.add_argument("--source-ref", default="origin/main")
args=parser.parse_args()
revision=subprocess.check_output(["rtk","proxy","git","rev-parse",args.source_ref+"^{commit}"],text=True).strip()
source=Path(read(STATE/"services/config.json")["source"])
paths=subprocess.check_output(["rtk","proxy","git","ls-tree","-r","--name-only",revision,"apps/market","apps/local-client","packages/contracts"],text=True).splitlines()
assert paths and all((source/p).read_bytes()==subprocess.check_output(["rtk","proxy","git","show",revision+":"+p]) for p in paths), "A source differs from claimed revision"
previous=None
identities=None
for suffix in ("", "-repeat"):
    path=ROOT/"scripts/demo/evidence"/f"service-{args.scenario}{suffix}.json"
    evidence=read(path)
    review=read(STATE/"services/runs"/evidence["tradeId"]/"review.json")
    trade=review["trade"]; package=trade["settlementPackage"]
    current_identities={p:v["preview"]["walletId"] for p,v in review["previews"].items()}
    if identities is not None: assert identities==current_identities, "Profile restart changed wallet identity"
    identities=current_identities
    tx=rpc("getrawtransaction",evidence["txid"],True)
    assert tx["confirmations"]>=1 and tx["txid"]==package["packageId"]
    assert all(v["txinwitness"] for v in tx["vin"]), "Real witness signatures required"
    inputs=[i for f in package["payload"]["funding"].values() for i in f["inputs"]]
    assert {(v["txid"],v["vout"]) for v in tx["vin"]}=={(i["txid"],i["vout"]) for i in inputs}
    fee=sum(int(i["amountSats"]) for i in inputs)-sum(int(Decimal(str(v["value"]))*100000000) for v in tx["vout"])
    assert fee==int(evidence["feeSats"])
    no_direct=not any(a["fromOwnerId"]==b["toOwnerId"] and a["toOwnerId"]==b["fromOwnerId"] for a in trade["plan"]["legs"] for b in trade["plan"]["legs"])
    if args.scenario=="ring":assert no_direct
    respent={}
    if previous:
        for leg in trade["plan"]["legs"]:
            if leg["asset"]["kind"]=="rgb":
                p=leg["fromOwnerId"]
                respent[p]=any(i["txid"]==previous for i in package["payload"]["funding"][p]["inputs"])
        assert respent and all(respent.values())
    evidence.update(independentBitcoinVerification=True,sourceRevision=revision,
                    vsize=tx["vsize"],feeSats=str(fee),noDirectPair=no_direct,repeatReceivedInputs=respent,
                    walletIdentityPreservedOnRestart=bool(suffix))
    save(path,evidence)
    previous=evidence["txid"]
    print(json.dumps({"scenario":args.scenario,"repeat":bool(suffix),"txid":tx["txid"],"actualFeeSats":fee,"vsize":tx["vsize"],"receivedRgbInputsRespent":respent}))
