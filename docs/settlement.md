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
