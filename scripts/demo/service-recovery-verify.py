#!/usr/bin/env python3
"""Verify recovery fixes through real services. Fault injection is test-only."""
import argparse
import importlib.util
import json
import sqlite3
from service_runtime import Runtime, PEOPLE, STATE, ROOT, read, save
from protocol import sha
from regtest import rpc

spec=importlib.util.spec_from_file_location('service_smoke',ROOT/'scripts/demo/service-smoke.py')
smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)

def journal(person,trade):
    with sqlite3.connect(STATE/person/'journal.sqlite') as db:
        state,signature=db.execute('SELECT state,signature FROM trades WHERE id=?',(trade,)).fetchone()
        count=db.execute('SELECT COUNT(*) FROM reservations WHERE trade_id=?',(trade,)).fetchone()[0]
    return {'state':state,'signatureHash':sha(signature.encode()) if signature else None,'reservedInputs':count}

def local_record(person,key):
    with sqlite3.connect(STATE/'services'/person/'local.sqlite') as db:
        row=db.execute('SELECT value FROM local_records WHERE key=?',(key,)).fetchone()
        return json.loads(row[0]) if row else None

parser=argparse.ArgumentParser()
parser.add_argument('--case',choices=['lost-sign-response','broadcast-not-submitted'],required=True)
parser.add_argument('--resume-trade')
args=parser.parse_args()
runtime=Runtime()
evidence={'network':'regtest','mode':'real','case':args.case,'source':str(runtime.source),'baseSourceRevision':runtime.config.get('baseSourceRevision')}
def recover_new_signature(trade_id, resumed=False):
    before=journal('alice',trade_id)
    assert before['state']=='SIGNED' and before['signatureHash']
    intent=local_record('alice','signing:'+trade_id)
    assert intent
    if not resumed:assert local_record('alice','signature:'+trade_id) is None
    original=read(STATE/'alice/trades'/sha(trade_id.encode())/'user-approval.json')
    assert intent['approval']==original
    runtime.stop('local-alice');runtime.stop('wallet-alice')
    runtime.profile('alice');runtime.ready(['alice'],wallet_state=False)
    runtime.local('alice',f'/trades/{trade_id}/sync',{})
    runtime.local('alice',f'/trades/{trade_id}/sync',{})
    after=journal('alice',trade_id)
    assert after==before
    signature=local_record('alice','signature:'+trade_id)
    assert signature and sha(signature['psbt'].encode())==before['signatureHash']
    trade=runtime.local('alice',f'/trades/{trade_id}')
    delivered=[m for m in trade['messages'] if m['ownerId']=='alice' and m['message']['type']=='signature' and 'signature' in m['message']['payload']]
    assert len(delivered)==1
    evidence.update(beforeRestart=before,afterRecovery=after,exactApprovalPreserved=True,sameSignature=True,signatureDeliveries=1)
    save(STATE/'services/recovery-signature-progress.json',evidence)
    review=read(STATE/'services/runs'/trade_id/'review.json')
    runtime.local('bob',f'/trades/{trade_id}/approve',{'approvalToken':review['previews']['bob']['approvalToken'],'confirmed':True})
    evidence['settlement']=smoke.settle(runtime,trade_id,'direct',evidence_name='service-recovered-signature-settlement.json')
    evidence['reverseSettlement']=smoke.run(runtime,'direct',True,evidence_name='service-recovered-signature-repeat.json')

try:
    runtime.market()
    for p in PEOPLE:runtime.profile(p,'lost-sign-response' if args.case=='lost-sign-response' and p=='alice' else None)
    runtime.ready(wallet_state=not bool(args.resume_trade))
    if args.case=='lost-sign-response' and args.resume_trade and local_record('alice','signing:'+args.resume_trade):
        trade_id=args.resume_trade
        recover_new_signature(trade_id,True)
    elif args.case=='lost-sign-response' and args.resume_trade:
        trade_id=args.resume_trade
        before=journal('alice',trade_id)
        assert before['signatureHash'] and local_record('alice','signing:'+trade_id) is None
        package=runtime.local('alice',f'/trades/{trade_id}')['settlementPackage']
        runtime.local('alice',f'/trades/{trade_id}/sync',{})
        runtime.local('alice',f'/trades/{trade_id}/sync',{})
        after=journal('alice',trade_id)
        assert after==before
        signature=local_record('alice','signature:'+trade_id)
        assert sha(signature['psbt'].encode())==before['signatureHash']
        trade=runtime.local('alice',f'/trades/{trade_id}')
        deliveries=[m for m in trade['messages'] if m['ownerId']=='alice' and m['message']['type']=='signature' and 'signature' in m['message']['payload']]
        assert len(deliveries)==1
        evidence.update(beforeRecovery=before,afterRecovery=after,sameSignature=True,signatureDeliveries=1,
                        legacyApprovalMissing=True,recoveryOperation='read-only cached signature',newSigning=False,
                        marketStatus=trade['status'],settlement='Awaiting counterparty approval; existing reservation preserved')
    elif args.case=='broadcast-not-submitted':
        assert args.resume_trade
        trade_id=args.resume_trade
        before={p:journal(p,trade_id) for p in PEOPLE}
        assert all(j['signatureHash'] for j in before.values())
        package=runtime.local('carol',f'/trades/{trade_id}')['settlementPackage']
        try:rpc('getrawtransaction',package['packageId'],True)
        except RuntimeError:pass
        else:evidence['alreadyKnownOnResumedVerification']=True
        receipt=runtime.local('carol',f'/trades/{trade_id}/sync',{})
        assert receipt['txid']==package['packageId'] and receipt['state']=='pending'
        assert rpc('getrawtransaction',package['packageId'],True)['txid']==package['packageId']
        after={p:journal(p,trade_id) for p in PEOPLE}
        assert all(after[p]['signatureHash']==before[p]['signatureHash'] for p in PEOPLE)
        evidence.update(beforeRestart=before,afterRecovery=after,newApproval=False,originalTransactionRebroadcast=True)
        save(STATE/'services/recovery-broadcast-progress.json',evidence)
        evidence['settlement']=smoke.settle(runtime,trade_id,'ring',evidence_name='service-recovered-broadcast-settlement.json')
    else:
        previous={t['plan']['tradeId'] for t in runtime.local('alice','/snapshot')['trades']}
        try:smoke.run(runtime,'direct',evidence_name='service-recovered-signature-settlement.json')
        except RuntimeError:
            trades=[t for t in runtime.local('alice','/snapshot')['trades'] if t['plan']['tradeId'] not in previous]
            assert len(trades)==1
            trade_id=trades[0]['plan']['tradeId']
            assert (STATE/'alice/test-lost-sign-response.json').exists()
            recover_new_signature(trade_id)
        else:raise AssertionError('Fault injection did not trigger')
    evidence['tradeId']=trade_id
    save(ROOT/'scripts/demo/evidence'/f'service-fixed-{args.case}{"-legacy" if evidence.get("legacyApprovalMissing") else ""}.json',evidence)
    print(json.dumps(evidence),flush=True)
finally:runtime.close()
