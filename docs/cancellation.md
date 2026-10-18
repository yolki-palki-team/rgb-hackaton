# Unilateral cancellation of a signed swap

A participant who has signed can choose **Cancel signed swap…**, review the exact
BTC fee and amount returned, and approve a separate on-chain cancellation. This
does not add a round or approval to successful swaps. It is a unilateral exit from
a stalled direct swap or three-party ring, not complete elimination of free-option
economics.

## What changes on chain

Every newly prepared swap reserves a confirmed, mature vanilla BTC input for each
participant in addition to any required RGB inputs. The same input may finance
the ordinary swap. It must have no RGB allocations and enough value for the
cancellation fee plus a 1,000-sat return output. Native signing independently
checks ownership, the full previous transaction, vanilla status, empty RGB
allocations, the owned return address, exact amount, fee and `SIGHASH_ALL`.

Cancellation spends one such input back to the same wallet. Once confirmed, the
original swap cannot spend that input again. The RGB inputs remain unspent and
their allocations remain unchanged. Only the cancelling wallet pays the separate
BTC fee. If the original swap confirms first, the normal Bitcoin confirmation and
RGB acceptance path completes instead; the application must not label it cancelled.

New swap inputs signal RBF. Historical unsigned packages retain their original
sequences; signatures and approvals are never silently rewritten. Previously
signed swaps can be cancelled only if they already contain a suitable available
vanilla input and a saved review. Otherwise cancellation fails closed.

## State and recovery

| Observation | Wallet behavior |
| --- | --- |
| Cancellation preview | No signing; show the exact fee and BTC return |
| User approves the immutable preview digest | Persist authorization before signing or broadcasting |
| Broadcast, timeout, missing response, or peer cancellation notice | Keep reservations; retry the same authorized transaction |
| Confirmed conflicting transaction, verified by Core and the native wallet's indexer | Reconcile Bitcoin state, retain original signatures/history, release reservations and report `cancelled` |
| Original swap confirmed first | Accept RGB and report `confirmed` |

`cancellationTxid` is separate from the original swap `txid`. A cancellation receipt
does not claim that the swap has Bitcoin confirmation or RGB acceptance. The market
can close orders after a participant reports a confirmed cancellation, but each
wallet independently verifies the conflict before releasing local inputs. An
unrelated or unconfirmed transaction supplied by a peer cannot release funds.

Local approval survives restart and an uncertain HTTP response. After cancellation
authorization, the local client stops relaying the original signature or initiating
finalization. Other participants may already possess it, so a race remains possible.
Cancellation signing and submission do not require the market to be online;
delivery of its status is retried when connectivity returns. Native processes and
authenticated local requests retain the existing serialization and instance locks.

The public APIs are `POST /api/trades/:id/cancel-preview` and
`POST /api/trades/:id/cancel` with `{ "approvalDigest": "…", "confirmed": true }`.
Desktop signing uses a dedicated IPC approval route; generic renderer requests
cannot invoke the cancellation signing endpoint. Mocks do not implement cancellation.

## Verified scope and limitations

This implementation is **regtest-only**, matching the current settlement backend.
It charges the original transaction's total fee plus 1,000 sats, capped at 101,000
sats, with an exact preview before approval. This is a deterministic development
fee, not a production fee estimator. One confirmation is used on regtest.

There is no automatic timeout signing, fee bumping, guaranteed confirmation time,
or general reorg recovery. A transaction already in the mempool can prevent a new
preview/signature because the selected input is no longer reported as available;
the wallet retains reservations and reconciles the original transaction. Mainnet
support requires fee/replacement policy, confirmation/reorg handling and explicit
user approval. Cancellation is not a free or instantaneous rollback.

Real evidence from 2026-10-18:

- [Direct and three-party cancellation](../scripts/demo/evidence/cancellation-regtest.json):
  one participant signed, remaining participants withheld signatures; all wallets
  restarted; RGB balances unchanged; only the cancelling wallet lost 2,000 sats;
  reservations released after confirmation.
- [Subsequent ring settlement](../scripts/demo/evidence/cancellation-followup-ring.json):
  the same retained assets were successfully exchanged after cancellation.
- [Original swap wins](../scripts/demo/evidence/cancellation-original-wins.json):
  a reviewed cancellation was overtaken by the original swap's confirmation;
  both wallets accepted the RGB settlement with no cancellation fee.
- [Peer offline before preview](../scripts/demo/evidence/cancellation-offline-peer.json):
  the unsigned wallet recovered using its saved preparation context, independently
  verified cancellation, and retained its RGB. Core rejected the old candidate for
  missing inputs after the cancellation input was confirmed spent.

Update the market, local clients and native wallet together, then restart them.
Older market versions do not recognize cancellation receipts. The initiating
wallet can still submit its cancellation, but peer notification requires the
updated coordinator. This change does not deploy or restart a shared service.

Reproduce against the local regtest services using a **new** ignored state directory:

```sh
rtk proxy uv run --locked python scripts/demo/bootstrap-native.py --refresh
rtk proxy cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/cancellation-fresh" uv run --locked python scripts/demo/service-cancellation-smoke.py --setup
```

The runner uses real authenticated local-client, market and wallet HTTP APIs. It
keeps keys, approval files and raw wallet journals in the ignored state directory;
only transaction IDs, receipts and assertions are exported as evidence. Synthetic
unit tests separately cover stale approvals, foreign/unconfirmed conflict hints,
lost responses and durable signature replay.

Suggested demo explanation: “A signer can exit a stalled swap by spending a
dedicated BTC input back to their own wallet. Once that cancellation confirms, the
old swap is invalid and the RGB assets remain with their owners. The normal swap
path has no additional approval round; cancellation costs a separate Bitcoin fee.”
