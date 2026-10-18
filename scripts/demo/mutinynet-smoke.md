# Mutinynet settlement verifier

This runner uses the existing real local-client, market and wallet APIs. It
checks one direct swap or one three-party atomic ring. `--repeat` restarts the
market and all three local clients/sidecars, checks unchanged wallet identities,
balances and confirmed history, then reverses the trade using the received RGB
outputs. Every swap must have one shared Bitcoin transaction, the exact approved
inputs and fee, Bitcoin confirmation, all native RGB acceptance receipts and
exact balances from the approved previews.

The runner has not yet completed a live Mutinynet swap. Its offline self-check
only checks the transaction and receipt verifier; it is not settlement evidence.

## Prerequisites

Follow [the Mutinynet infrastructure guide](../../deploy/MUTINYNET.md). Use a
dedicated state directory under `packages/wallet/state/mutinynet/`, containing
fresh `alice`, `bob` and `carol` profiles on that chain. The runner does not
initialize, fund, issue or migrate wallets. Keep the endpoint JSON and all wallet
state private and ignored by Git.

Fund each wallet's vanilla and colorable addresses with confirmed Mutinynet sats.
Each BTC seller needs at least 100,000 sats plus fees and output collateral;
every participant needs fee and RGB collateral funds before receiving anything.
The exact available UTXOs must pass native preparation. Alice must own at least
100 X, Bob at least 100 DUSD. Export/import the same precision-0 NIA contracts
across all three profiles. An optional KEEP allocation is protected unchanged.
Amounts and symbols in this fixture are deliberately fixed; matching contract IDs
are verified rather than inferred from equal tickers.

The suite uses market port 4110, local clients 4131–4133 and wallet sidecars
4231–4233. Stop other owners of those ports normally before starting. The runner
only stops processes it created. Do not run another wallet process or deposit
additional funds while exact balances are being checked. Freeze source changes
for the run; it records source/native hashes and rejects changes during the test.
Put `rtk` with `proxy` support on `PATH`; the reused runtime launches children
through it.

## Run

Set these variables to the already prepared private files and state:

```sh
export PALKA_NETWORK=mutinynet
export PALKA_MUTINYNET_CONFIG="$HOME/.config/palka/mutinynet.json"
export RGB_DEMO_STATE="$PWD/packages/wallet/state/mutinynet/YOUR_ISOLATED_TEST_RUN"

rtk proxy uv run --locked python scripts/demo/mutinynet-smoke.py --selfcheck
rtk proxy uv run --locked python scripts/demo/mutinynet-smoke.py \
  --state "$RGB_DEMO_STATE" --scenario direct --execute --repeat
rtk proxy uv run --locked python scripts/demo/mutinynet-smoke.py \
  --state "$RGB_DEMO_STATE" --scenario ring --execute --repeat
```

`--execute` approves the fixed fixture's exact previews on this development
network. It never requests faucet funds, mines blocks or invokes QVAC. The first
direct trade exchanges Alice's 100,000 sats for Bob's 100 DUSD. The ring exchanges
Alice's 100 X to Carol, Carol's 100,000 sats to Bob, and Bob's 100 DUSD to Alice.
The reverse trades exchange those amounts in the opposite direction. Each
participant's fee must be at most 1,000 sats per transaction.

Confirmation polling lasts up to 900 seconds by default; `--timeout` changes
that bound. A timeout does not mean failure on chain. Every approval attempt is
journaled before dispatch and is never replayed by this runner. The saved state,
orders and reservations remain intact on any error or interruption.

## Observe an uncertain result

Use the exact trade ID from the halted progress message:

```sh
rtk proxy uv run --locked python scripts/demo/mutinynet-smoke.py \
  --state "$RGB_DEMO_STATE" --scenario direct --resume EXACT_TRADE_ID
```

Resume calls the wallet's existing-transaction synchronization API and relays
receipts only after all participants are confirmed. It cannot publish, prepare,
approve, mine or broadcast another transaction. A partially approved or
unbroadcast transaction may remain unresolved; inspect the private journal
instead of issuing another approval. If interruption happened before a saved
review, no automated resume is available. If a requested repeat never began,
confirming the first transaction still leaves that repeat unverified. The runner
does not erase markers or release reservations to make a later attempt pass.

The private run marker is `services/mutinynet-smoke.json` inside the selected
state directory; private failure details are in `services/mutinynet-failure.log`.
A completed check writes sanitized evidence to
`scripts/demo/evidence/mutinynet-<scenario>-<tradeId>.json`. It includes chain
checkpoint, approved plan digests, actual transaction/fee data, native acceptance,
exact balances, source hashes and restart/re-spend checks. Evidence records test
contract IDs and transaction IDs but contains no pairing tokens, keys, private
policies or approval tokens. Unresolved attempts are never exported as success.
