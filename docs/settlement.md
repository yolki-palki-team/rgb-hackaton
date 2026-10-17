# Protocol-v1 wallet sidecar and real settlement

The authenticated loopback sidecar now implements A's complete WalletAdapter v1:
capabilities, state, reserve/release, cooperative prepare, validate/preview,
approval-bound sign, finalize/broadcast and sync/receipt. Its Bitcoin/RGB amounts
and transaction checks are deterministic. Keys and full wallet state stay local.
The web UI and a future desktop UI can use the same local backend.

## Verified follow-up results

After the first direct/ring proofs, the SQL allocation/transfer index was rebuilt
from validated RGB stock and confirmed transaction inputs/outputs. SQL settled
and spendable balances now agree with stock, and SDK transfer history loads.
Rows are committed atomically and retries do not duplicate allocations.

Two further swaps spent RGB assets received in those first swaps, through the
real authenticated HTTP adapter. Every sidecar was restarted after all signatures
were durably saved, before finalization/broadcast. Both then confirmed:

| Scenario | Transaction | Actual BTC deltas, including fees | RGB movements |
| --- | --- | --- | --- |
| Direct repeat | `68cfdfaff9cf79a5a03d6dfea85e14cd876adfd2b48d5d6278be96d6957d585b` | Alice +99500; Bob −100500 | Alice → Bob 100 DUSD |
| Ring repeat | `1266dbbb2a47cf8cf3d9f7ed2529cb0428a0476695ca07bbf9c5dd32cd4df7d8` | Alice +99667; Bob −100333; Carol −334 | Alice → Carol 100 DUSD; Carol → Bob 100 X |

Each is one Bitcoin transaction paying 1000 sats. All unrelated asset deltas are
zero; Alice's 7 KEEP remain intact. Public evidence includes expected/actual deltas:
[direct adapter](../scripts/demo/evidence/adapter-direct.json),
[ring adapter](../scripts/demo/evidence/adapter-ring.json).
Original proof evidence remains historical and is not overwritten.

The ordinary high-level SDK/proxy smoke also settled at Bob and Carol:
`bb5164e7bf1608b271ee389c20aaeae81bf35d95738394f41cf8ea88940c77a0`.
Bob spent 1 X received from the ring, Carol received 1 X plus 1000 sats, and
Bob paid 503 sats in fees (net BTC −1503). Both SDK histories report Settled,
the recipient records proxy transport as used, and SQL matches RGB stock.
This is an ordinary transfer, separate from the atomic-swap proofs above.
See [SDK smoke evidence](../scripts/demo/evidence/sdk-smoke.json).

A's actual `HttpWalletAdapter`, `planDigest` and Zod schemas from merged PR #1
were tested against B's real sidecar: capabilities, state, package, preview,
PrepareResult and confirmed Receipt all passed. This is interface integration;
it does not claim a new end-to-end QVAC/browser test or change A's Docker runner,
which still selects its explicit mock mode.

## Start the local sidecar

Use the pinned native bootstrap/build and regtest setup below. After issuance,
run `rtk proxy python3 scripts/demo/catalog.py` to validate/import public contract
metadata into all three local wallets. This makes verified zero-balance assets
available for A's order form without inventing contract IDs or balances.

Start one sidecar per profile with a private random WALLET_RPC_TOKEN of at least
32 characters in its environment. Do not put the token in Git or a URL.

```sh
rtk proxy python3 packages/wallet/server.py --profile alice --owner alice --port 4201
rtk proxy python3 packages/wallet/server.py --profile bob --owner bob --port 4202
rtk proxy python3 packages/wallet/server.py --profile carol --owner carol --port 4203
```

`RGB_DEMO_STATE` selects a private state directory beneath `packages/wallet/state`;
use the same value for setup, catalog, sidecar and demo. Server binds 127.0.0.1,
requires Bearer authentication and an exact loopback Host, rejects browser Origin,
limits request bodies and serializes requests. A's authenticated local-client
performs user confirmation and private-policy checks before calling this trusted
server-to-server RPC. Do not give its Bearer token to market, the model or browser.

Configure A's local-client with `WALLET_MODE=real`, matching `LOCAL_OWNER_ID`,
`WALLET_RPC_URL=http://127.0.0.1:4201`, and the same `WALLET_RPC_TOKEN`.
Profile/owner mapping is fixed by server startup, never supplied by a remote plan.

For an existing generated SDK after updating this extension:

```sh
rtk proxy python3 scripts/demo/bootstrap-native.py --refresh
rtk proxy cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
```

Refresh verifies the pinned source and recorded old extension before replacing
anything; unrecorded SDK edits cause a refusal. Rust 1.94 and Python 3.12+ are the
supported toolchain for these scripts (restore uses safe tar extraction).

## Protocol codec and flow

`POST /rpc` uses A's exact v1 envelope and method arguments. Format is
`rgb-cooperative-v1`. Call reserve once, then prepare as authenticated participant
materials arrive. There are three material rounds:

1. `funding`: selected public inputs/full prevouts, selected RGB allocations and
   fresh receiving/change addresses. Full wallet balances and keys are excluded.
2. `colored`: local transition contribution bound to the common skeleton txid.
   All RGB allocations on selected inputs are conserved, including unrelated ones.
3. `proofs`: per-recipient consignments bound to the one final RGB commitment.

Each participant emits its own material before advancing. Prepare returns pending
until every round is complete, then ready plus the same SettlementPackage at every
wallet. Market only transports opaque materials. Its existing 256 KiB message
limit is sufficient for the tested NIA fixtures; larger histories may require a
separately agreed transport change and are not silently truncated.

The final payload includes funding, colored contributions, proofs and committed
PSBT/fascia. Validation independently rebuilds the skeleton and commitment,
checks received RGB amounts/scripts and own input/transition conservation, and
invokes native signer preflight. `unsignedTxDigest` hashes actual unsigned Bitcoin
transaction bytes. `commitmentDigest` binds commitment scripts and every proof hash.
Approval also binds wallet/owner/network/trade/revision/plan/package identifiers.
Changing any of those or the final package fails before signing.

One active plan per local profile; outpoints are reserved transactionally before
contribution creation. Final approval records are immutable. Native records are
isolated under `profile/trades/SHA256(tradeId)` so later trades do not overwrite
prior signatures. SIGNING is durable before crypto; the signature and parent
folder are fsynced before return. Repeated sign with the same authorized binding
returns the saved signature. After signature, release and prepare are refused.
Finalize saves the completed transaction, queries by txid before sending, and
keeps inputs pinned on uncertain RPC results. It does not mine. Sync separately
reports chain confirmation and RGB acceptance; CONFIRMED requires both.

The legacy `adapter.mjs` remains explicitly read-only for compatibility; use the
HTTP sidecar for the implemented lifecycle. Its old low-level capability flags
must not be confused with `server.py`'s protocol-v1 capabilities.

## Repeatable adapter integration

For a fresh funded/catalogued directory, omit `--reverse`. Existing confirmed
fixtures used `--reverse` to spend previously received assets, with new explicit
user approval at the time. Never reuse an old approval binding for a different package.

```sh
rtk proxy python3 scripts/demo/adapter-demo.py prepare --scenario ring --trade-id unique-ring-id
rtk proxy python3 scripts/demo/adapter-demo.py execute --trade-id unique-ring-id --approve REVIEW_DIGEST
```

Use `--scenario direct` with independent fixture state. Preparation does not sign;
execute requires the exact reviewed digest and then starts real HTTP sidecars,
signs locally, restarts them, broadcasts, mines and verifies all expected balances.

Development transfers on regtest/testnet/signet/signetcustom now have standing
user authorization under AGENTS.md; the agent need not ask on every test.
Mainnet signing still requires explicit approval. This policy does not expand
the implementation beyond regtest or remove A's product approval UI. The CLI
`--approve` digest and RPC approval fields continue to bind the exact transaction.

The ordinary SDK smoke uses Bob's X and Carol's witness invoice:

```sh
rtk proxy python3 scripts/demo/sdk-smoke.py prepare
rtk proxy python3 scripts/demo/sdk-smoke.py execute --approve REVIEW_DIGEST
```

This fixture is memoized; preserve its private review/signature files. Execution
resumes the same transaction and verifies original deltas, so run it before any
later transactions change these wallets. Use independent state for a fresh smoke.

## Verification and remaining scope

- 14 Python tests: durable journal/plan binding, amount/plan checks and HTTP
  authentication, Host and Origin rejection; 3 legacy bridge tests.
- 12 real HTTP rejection cases with unchanged saved signatures, plus the original
  17 real native negative cases. See [adapter negatives](../scripts/demo/evidence/adapter-negative.json).
- Actual A HttpWalletAdapter/schema check: `scripts/demo/check-a-boundary.ts`.
- SQL/stock agreement, SDK history, repeat spending and restart after signatures
  verified on real wallets. Backup now also locks the coordinator across native
  and Python state. A private backup restored all three wallets to a separate
  ignored directory, with matching BTC/RGB balances and SQL/stock indexes:
  [restore evidence](../scripts/demo/evidence/restore.json). This was tested
  against the existing chain and does not claim chain disaster recovery.

Support remains intentionally bounded to regtest, NIA precision 0, SegWit v0,
direct/two-party and three-party cycles, one outgoing and one incoming leg per
participant, and distinct contributing contracts. Same-contract multi-sender
inputs are rejected. Estimated fees use a deterministic 1000-sat split within
each participant's cap; final plans use their explicit fee split. General fee
bumping, reorg recovery and mainnet are outside this MVP.

Public contract import validates genesis/schema/network; it does not create an
owned allocation. Pending ordinary SDK transfers can make inputs unavailable.
The sidecar is a trusted local boundary, not protection from another process
running as the same OS user. Test blinding/entropy remain deterministic. Backups
contain secrets and full RGB state, are unencrypted, local-only and ignored.
Docker volumes are still anonymous; preserve the running chain and volumes.

A's user policy/publication/approval workflow remains authoritative for local
private limits; the wallet independently validates the resulting exact plan and
transaction. A must preserve/replay an approval binding and relay cached signatures
when recovering a client crash between wallet signature persistence and market
receipt. The tested restart case covers sidecar restart after signature delivery;
a real ambiguous-network fault and full-machine disaster recovery are not claimed.

---

# Historical feasibility milestone — PR #2

The following report describes the earlier CLI milestone. Its statements that
SQL indexing and the full adapter were unavailable are superseded by the current
status above; its original transaction evidence and stack pin remain valid.

# Real regtest settlement report

Verified on 2026-10-17 after explicit user approval of both package digests.
Both fixtures completed real signing, broadcast, mining, recipient RGB acceptance
and checks of actual Bitcoin and RGB stock balances. Each swap has exactly one
Bitcoin witness transaction. This is a feasibility implementation with a local
SDK extension; market/local-client integration remains incomplete.

## Confirmed results

| Fixture | Transaction | BTC changes, sats including fees | RGB changes |
| --- | --- | --- | --- |
| Direct | `542ce6b9ac3a44b355f6caa385f4245a2917f8f5d3ff17dd1378241a24f3ee92` | Alice −100500; Bob +99500 | Alice +100 DUSD; Bob −100 DUSD |
| Ring | `32aba60bde94c32d5191dee36d8b358059a3d8bbe0a055cf8e3a8c41c863849f` | Alice −333; Bob +99667; Carol −100334 | Alice −100 X, +100 DUSD; Bob −100 DUSD; Carol +100 X |

Each paid 1000 sats. Ring Alice retained all 7 KEEP on the input also carrying X.
KEEP change was committed and validated with the other transitions. The fixtures
use independent keys and different DUSD contracts. X/DUSD are local test NIA
assets with precision 0, not real currencies.

Public evidence: [direct](../scripts/demo/evidence/direct.json) and
[ring](../scripts/demo/evidence/ring.json). These contain contract IDs, txids,
block hashes, approval digests, expected/actual deltas and validation results;
they exclude keys, full balances, consignments and wallet databases. Public
explorers cannot resolve regtest txids; verification requires this local chain.

## Stack and SDK boundary

- rgb-lib `0.3.0-beta.7`, pinned revision
  [`1eaf0024c591e41843eb80cc8834082292668871`](https://github.com/RGB-Tools/rgb-lib/tree/1eaf0024c591e41843eb80cc8834082292668871).
- RGB / `rgb-psbt-utils` `0.11.1-rc.11`, BDK wallet `3.1.0`.
  Exact dependency graph: `packages/wallet/native/Cargo.lock`.
- Rust `1.94.0` used locally; separate native manifest, no JS dependencies.
- Bitcoin Core `30.2`, electrs `0.11.0`, RGB proxy `0.3.0`.
  Image digests in `infra/images.lock.json`, verified by `doctor.py`.
  This host used amd64 images through Docker Desktop emulation.

Upstream `Wallet::inspect_rgb_transfer` rejects the actual cooperative PSBT with
`found a PSBT input that does not belong to this wallet`. Reproduce with
`rtk proxy python3 scripts/demo/check-upstream-limit.py` after ring preparation.
High-level `send_begin` is not a cooperative swap API.

The tracked `native/extension.rs` exposes narrow internal operations: export a
consignment from an unconsumed fascia; validate an unbroadcast witness without
consuming state; reconcile confirmed Bitcoin transactions; consume known RGB
bundles; read stock on owned UTXOs. `bootstrap-native.py` appends this extension
to pinned upstream source in ignored `native/vendor` and refuses a mismatched
existing extension. This is explicitly a local SDK extension, not upstream API.

## Cooperative sequence and approval

1. Reserve actual mature outpoints in each profile's durable SQLite journal.
   Build one Bitcoin skeleton with payments/change and an OP_RETURN host.
   Include full previous transactions; use checked integers and decimal strings.
2. Each RGB sender colors that skeleton with its own transitions, conserving
   every allocation on selected inputs, including KEEP.
3. Extract transitions into a fresh common PSBT and perform one final
   `rgb_commit`. Independent committed transfers are not joined together.
4. Export incoming consignments against the final fascia. Receivers check real
   RGB history, network, contract, exact amount, witness txid and their own output
   script before signature release.
5. Each signer rechecks current owned inputs, full prevouts, its net BTC change,
   total fee, incoming consignments and its own outgoing transitions. Every input
   requires `SIGHASH_ALL`; only SegWit v0 is supported, without permissive flags.
6. Explicit approval binds a domain-separated SHA-256 of canonical JSON. Local
   intents include network, identity fingerprint, plan revision, candidate txid,
   fee/BTC delta, outgoing assignments and incoming proof expectations. Mutable
   PSBT signature fields are not the approval identity.
7. Persist SIGNING and the digest before signing; persist the released signature
   before returning it. Each native process opens only one profile's keys under
   an exclusive instance lock. The coordinator receives public PSBTs, not seeds.
8. Combine signatures, finalize, verify txid and save raw transaction before
   broadcast. Mine, accept incoming RGB, consume known transitions, update
   witnesses and check actual BTC/RGB deltas and KEEP against the approved terms.

## Reproduction

From the repo root, with Docker, Python 3.9+ and Rust. Keep the checked-in lockfile:
fresh dependency resolution can fail on a yanked transitive prerelease.

```sh
rtk proxy docker compose -f infra/compose.yaml up -d
rtk proxy python3 scripts/demo/bootstrap-native.py
rtk proxy cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
rtk proxy python3 scripts/demo/doctor.py
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/direct-run" python3 scripts/demo/regtest.py setup
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/direct-run" python3 scripts/demo/review.py prepare --scenario direct
```

Use a fresh directory under ignored `packages/wallet/state` per fixture.
For ring use `ring-run` and `--scenario ring`. Funding mines coinbases; setup and
prepare do not sign. Review `review.json`, profile intents and the package, then
obtain user approval for that exact digest before executing:

```sh
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/direct-run" python3 scripts/demo/review.py execute --approve APPROVED_DIGEST
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/direct-run" python3 scripts/demo/export-evidence.py
```

Do not prepare a new package on a signed fixture. Same-digest `execute` recovers
the same transaction. Existing main state is the confirmed ring; `state/direct-fixture`
is the confirmed direct. Exporting a new fixture replaces that scenario's public
evidence file; review that diff deliberately.

## Recovery and private state

Reservations are transactional and unique by outpoint. Release is allowed only
before signing. SIGNING/SIGNED/ambiguous-broadcast states never expire by order
TTL. A signature-start marker without a returned signature stays pinned for
same-intent recovery. Unknown broadcast results trigger txid lookup, not release.
Bitcoin confirmation and RGB acceptance are separate; CONFIRMED requires both.

Both approved executions were repeated with restarted native processes and
returned identical txids and deltas without another mined swap. Ambiguous broadcast
transitions have journal tests; a real RPC disconnect has not been injected.

Run `rtk proxy python3 scripts/demo/backup.py` with the matching `RGB_DEMO_STATE`
while the coordinator is stopped. It locks native instances and archives keys,
full RGB/BDK state, journal and approval/finalized records. Backups are local,
unencrypted, mode 0600, inside ignored state; never upload or commit them. Native
locks do not serialize a concurrent Python coordinator, so quiescence is required.
Mnemonic alone cannot restore RGB. A full restore drill remains untested.

Docker currently uses anonymous persistent volumes. Preserve the containers and
volumes: no `down -v`, volume prune or chain recreation with old wallet state.
The wallet archive excludes bitcoind/electrs; named-volume migration is open.

## Adapter boundary and remaining limits

`packages/wallet/adapter.mjs` exports `createWalletAdapter({profile,stateDir,binary})`
with `capabilities()`, `identity()`, `state()` via local JSON stdin/stdout.
`stockBalances` is the observed RGB stock view; SDK SQL balance fields are explicitly
non-authoritative. Keep this private state local, away from market and QVAC.

Production `prepare/sign/broadcast` throw `UNVERIFIED_SETTLEMENT_CAPABILITY` and
capabilities `directAtomic/ringAtomic/sign` remain false. This describes integrated
adapter readiness, not denial of the completed CLI proofs. **Low-level RGB stock
is correct, but SDK SQL allocation/transfer indexing is not synchronized**
(`sdkAllocationIndexSynchronized:false`), so generic repeat spending is unproven.

Native experimental operations are `build/color/merge/export/validate/preflight-sign/sign/sync-confirmed`.
The executable payload reference is `scripts/demo/cooperative.py` and `review.py`:
base PSBT + local contributions → final PSBT/fascia + consignments → local intents
→ signed PSBTs → receipts. These fixture-specific schemas are not the final
TradePlan API. Never expose generic native JSON to a browser or treat untrusted
`approved:true` as local authorization.

Open work before integration readiness:

- Synchronize SDK allocation/transfer indexing, then general TradePlan preparation,
  local policy/minimum checks, approval UI, market transport and adapter lifecycle.
- The CLI uses independent keys on one machine; it is not isolation against a
  compromised coordinator with filesystem access. Ownership is Alice/Bob/Carol,
  contributing contracts are distinct, amounts/fees are fixed and NIA precision is 0.
- Deterministic blinding/entropy 777 and nonce 1 are test-only, not production privacy.
- Proxy protocol health passed, but consignments used local coordination; remote
  proxy delivery has not been exercised.
- Separate ordinary high-level send/receive smoke, mid-sign crash injection,
  real ambiguous-RPC injection and a full restore drill remain unperformed.
- No mainnet, general schemas, Taproot, same-contract multi-sender merging,
  reorg handling or production security audit is claimed.
- QVAC and UI are A's scope and are not established by this settlement proof.

## Checks run

- Two confirmed swaps: incoming/outgoing RGB, BTC deltas and 7 KEEP verified.
- Same-approval execution repeated for both scenarios successfully.
- 17 SDK rejection checks: wrong amount/contract, corrupt proof, wrong/unowned
  recipient, omitted KEEP, fee/output tampering, duplicate input, invalid/overflow
  units, missing/stale approval.
- 8 journal unit tests and 3 Node adapter tests passed. Rust build/test passed
  (the Rust test harness currently contains zero unit tests).
- Doctor checked image digests, Core version, regtest, indexer and proxy;
  the upstream inspection limitation was reproduced exactly.

```sh
rtk proxy python3 -m unittest discover -s packages/wallet -p 'test_*.py'
rtk proxy node --test packages/wallet/adapter.test.mjs
rtk proxy cargo test --locked --manifest-path packages/wallet/native/Cargo.toml
rtk proxy python3 scripts/demo/check-negative.py
rtk proxy python3 scripts/demo/check-upstream-limit.py
```
