# Recovery fixes — 17 October 2026

This section supersedes the three A recovery gaps documented in the historical
service-integration sections below. The user authorized changes to local-client,
market, the optional wallet interface and B's sidecar. UI/desktop code and root
build manifests remain outside this change.

The pre-fix work was committed first as `857d2bb` on
`codex/settlement-recovery`. Recovery changes use an editable source snapshot
based on `8098d1a`; only the changed source/test paths are added to the PR tree.
The shared checkout, its index and the other developer's worktree stay untouched.
Before the final commit, main advanced to `49568fa335a29d65bee4788e23dae72874ceaf14`. The recovery patch was
three-way integrated onto that tree; desktop/web/build files are byte-identical
to the new main. The service conflict preserves wallet-first health and English
messages while retaining recovery states. This merge preserves both histories;
no rebase, amend or force-push is used. Final validation on this integrated tree:
64 tests (including desktop/web boundaries) and typecheck passed; Python has 17
passing tests. Native settlement evidence below was produced before integration;
legacy signature delivery and offline-peer cancellation were also rerun through
the integrated same-origin API. The harness uses each local service's own origin.

`RGB_SERVICE_SOURCE` selects this source for an existing private runtime config;
the override is not represented as the unmodified base revision in evidence.

- Approval is persisted in `signing:<tradeId>` before market/sign RPCs. Retry
  preserves the exact approval, package and signature, including `approvedAt`.
  `sync` relays the saved signature with the same content-derived message ID.
- For old clients that deleted their local approval, optional
  `recoverSignature(package)` reads an already saved backend signature. It checks
  the complete package, original approval and intent digest, requires a signed
  journal state, and never invokes signing. It cannot recover an operation for
  which no durable signature and no local authorization survived.
- `sync` repeats `finalize` only for an unresolved unconfirmed operation with all
  participant signatures bound to the original package. A transaction already
  observed pending or confirmed is reconciled without unnecessary finalization.
  The market accepts signature recovery in RECONCILING without unlocking orders,
  rejects conflicting signatures and rejects conflicting broadcast txids.
- An unsigned peer can still preview/approve the unchanged package while another
  participant is RECONCILING; full policy, expiry, balance and fee checks remain.
- Terminal pre-sign cancellation is reconciled on local snapshots and a serialized
  five-second background check. Offline peers recover on restart. A signing
  notice, saved authorization, signature or unsafe local operation prevents
  automatic release. Already committed wallet cancellation is idempotent.
  Background cleanup never initiates signing or broadcast.

Real regtest recovery evidence:

| Case | Result | Evidence |
| --- | --- | --- |
| Persisted broadcast never submitted | Original ring tx `eab1d2e8319528f30785c5a8a0a200996b78d53048d23a84ffd7aa258558ecf0` reached Core, all three RGB receipts and market CONFIRMED; original signatures retained | [recovery](../scripts/demo/evidence/service-fixed-broadcast-not-submitted.json) |
| Legacy lost signature response | Original Alice signature hash `0566762fadf139f42026bd61750e125545f5a6f5d5ffa808132129c15938e205` restored and delivered once without signing; reservations retained while waiting for Bob | [legacy](../scripts/demo/evidence/service-fixed-lost-sign-response-legacy.json) |
| New lost signature response | Original approval/signature retained across restart; direct tx `e3973222a444f5b2f031e975be1cf39ed1fb54c0d64c6846e23f2a95190f109c` reached both RGB receipts and market CONFIRMED | [settlement](../scripts/demo/evidence/service-recovered-signature-settlement.json) |
| Re-spend after recovered direct swap | Reverse tx `3d191fbc3bb94aa39a5b64d23ec1b5a08fb48df5fab6c06104ff8677affb60cb` spent the received RGB, both receipts and market CONFIRMED | [repeat](../scripts/demo/evidence/service-recovered-signature-repeat.json) |
| Pre-sign peer rejection | Alice, Bob and offline/restarted Carol all CANCELLED with zero reserved inputs through service APIs; no test-only backend release | [cancellation](../scripts/demo/evidence/service-fixed-presign-reject.json) |

Validation: 50 contracts/market/local-client tests, 17 Python protocol/journal
tests and TypeScript `tsc --noEmit` passed. Synthetic tests explicitly use test
doubles; real settlement evidence is recorded separately above.

The original unsubmitted-broadcast recovery passed before the verification harness
found the existing miner wallet unloaded after Core restart. The harness loaded
that existing wallet and resumed the same transaction for confirmation; evidence
marks that continuation as already known. No chain reset or new signature was used.

`rgb-python-lib` is not used. Python provides the authenticated RPC/coordinator
and journals; settlement uses the Rust `rgb-lib` dependency pinned at
`1eaf0024c591e41843eb80cc8834082292668871` (0.3.0-beta.7) with the documented
local cooperative extension. These are real regtest settlement checks, not
production/mainnet readiness or a completed desktop flow.

# Service integration — 17 October 2026

This section supersedes integration/recovery limitations below where explicitly
verified. Historical evidence is retained. Desktop/UI integration is still A's
work and is not certified by these service checks.

The current checkout lacks A's apps/contracts. Integration uses an unmodified
Git archive of `origin/main` at `8098d1a90f79f4dffc1d38d7c64f93f143e52219`, with
its locked npm dependencies, in `/private/tmp/rgb-service-source-8098d1a`.
No branch/worktree switch, merge, A source edit, or root lockfile edit was made.
These results must be rerun against A's later recovery/desktop changes.

`service-smoke.py` drives authenticated local-client HTTP APIs, the actual market
HTTP/WebSocket coordinator, and the real HTTP wallet. It validates/publishes
explicitly confirmed private policy + public orders, gets the market's match,
relays all funding/colored/proofs rounds, checks a common final commitment,
requests immutable previews, confirms approvals, then verifies actual signatures,
one Bitcoin tx, mining, all RGB acceptance reports, final market CONFIRMED, and
exact actual balances. `--repeat` restarts all profiles and reverses the trade to
spend received RGB through that same service path. It never constructs a fake
market, signs through a mock, or replaces a ring with sequential transfers.

Confirmed direct: `491306e9519b2a8ebf451c11ae8e0e7ae18bce73914f8bf8ddb9939af37c65e7`.
Confirmed direct repeat: `8107877ac11f9ebf0d1519a5958c406866240826c947cddc5ee7c3a1852ff289`.
Both paid 1000 sats and matched the complete previews; see
[direct service evidence](../scripts/demo/evidence/service-direct.json) and
[repeat](../scripts/demo/evidence/service-direct-repeat.json).

Confirmed clean ring: `6aff9e46090594661565cc2cef38e8b2c78e81b84fcc88e274e23a6dc349520d`.
Confirmed ring repeat: `a0578b5771804b591f4041de1bb883ddd293a7bc9420bebeae6111c43b09396b`.
Both had all three funding/colored/proofs contributions, one common commitment,
three real signatures, one Bitcoin transaction, exact actual balances and all
RGB acceptances. No direct pair existed. The repeat spent received RGB outputs
at both Alice and Carol. Original ring BTC deltas: Alice −333, Bob +99666,
Carol −100333 sats; Alice −100 X/+100 DUSD, Bob −100 DUSD, Carol +100 X.
All 7 KEEP remained at Alice. Evidence:
[ring](../scripts/demo/evidence/service-ring.json),
[repeat](../scripts/demo/evidence/service-ring-repeat.json).
`service-evidence-audit.py --scenario direct|ring` independently checks actual
confirmed witness transactions, exact input sets, fee and prior received RGB
outpoints against Core plus saved reviews. Actual sizes: direct 313/449 vB,
ring 443/646 vB; every fee 1000 sats.

`service-local-checks.py` separately exercised real on-device QVAC through
`POST /api/interpret` with actual verified contract metadata. A valid 10 X →
10 DUSD draft, no BTC sale, and 1000-sat cap passed deterministic validation.
Provider QVAC / QWEN3_1_7B_INST_Q4, actual inference duration 50516 ms (including
remaining model preparation). This draft was not published: the settlement
fixtures use explicit manual drafts. The same API rejected excessive fees,
protected-balance violation, forbidden BTC sale, expired order and unknown RGB
contract. See [local checks](../scripts/demo/evidence/service-local-checks.json).
This is real inference plus real manual settlement, not a claim of a single
QVAC-to-settlement/UI journey.

## Reproducible service setup and persistent profiles

Python 3.12+, the built native backend, pinned Docker images and A's npm runtime
are required. If A is missing locally, export a ref without disturbing the checkout:

```sh
rtk proxy python3 scripts/demo/service-source.py --ref 8098d1a90f79f4dffc1d38d7c64f93f143e52219 --output /private/tmp/rgb-service-source-new
rtk proxy npm ci --prefix /private/tmp/rgb-service-source-new --no-audit --no-fund
```

Shared infrastructure and initialization are separate from normal profile startup.
For an existing chain first pin its actual mounts, then use the external-volume
override on future Compose up operations. The pin command refuses mismatched
existing metadata, never migrates or deletes data, and verifies a saved block hash.

```sh
rtk proxy python3 scripts/demo/chain-volumes.py pin
rtk proxy docker compose -f infra/compose.yaml -f infra/state/chain-volumes.compose.json up -d
rtk proxy python3 scripts/demo/chain-volumes.py verify
rtk proxy python3 scripts/demo/doctor.py
```

On a brand-new host first run `rtk proxy docker compose -f infra/compose.yaml up -d`,
then pin those created volumes. Never use `down -v` or prune the chain volumes.
The ignored override gives explicit external names to the *existing* anonymous
volumes. Electrs now waits for bitcoind health; all services have restart policies.

Select one persistent `RGB_DEMO_STATE` under `packages/wallet/state`, e.g.
`$PWD/packages/wallet/state/my-service-direct`. Use that same environment value
for every command below. A separate state directory is required for the initial
ring fixture because the direct exchange changes asset ownership.

```sh
rtk proxy python3 scripts/demo/regtest.py setup
rtk proxy python3 scripts/demo/catalog.py
rtk proxy python3 scripts/demo/service-profile.py configure --source /private/tmp/rgb-service-source-new --base-port 43100
rtk proxy python3 scripts/demo/service-smoke.py --source /private/tmp/rgb-service-source-new --base-port 43100 --scenario direct --repeat
```

For ring use a fresh state directory, the same setup/catalog commands, base port
43200 and `--scenario ring --repeat`. Setup mines maturation blocks to the
separate `regtest-miner`, not a participant: coinbase maturity must not be mistaken
for swap income. Funding/issuance are memoized and are not normal startup actions.

For persistent desktop-ready processes run these in separate terminals (same state):

```sh
rtk proxy python3 scripts/demo/service-profile.py market
rtk proxy python3 scripts/demo/service-profile.py run --profile alice
rtk proxy python3 scripts/demo/service-profile.py run --profile bob
rtk proxy python3 scripts/demo/service-profile.py run --profile carol
rtk proxy python3 scripts/demo/service-profile.py health --profile alice
```

At base port 43100, market is 43100, local clients 43101–43103, wallet RPC
43111–43113. `services/config.json` under the selected ignored state directory
holds private wallet/market/pairing tokens and source path; mode 0600. Each local
profile has its own persistent SQLite directory and wallet keys/RGB state.
Normal restart reuses all of them and refuses missing keys; it cannot fund,
issue, or recreate a wallet. Use the paired Origin `http://127.0.0.1:5173` and
local token for local-client APIs; wallet Bearer stays server-to-server.
Health returns actual wallet capabilities and QVAC availability. A desktop can
connect to this API; its integration and final UX checks remain separate.

## Recovery findings and backend fixes

`service-recovery.py --fault lost-sign-response --scenario direct --source SOURCE`
uses a **real HTTP socket close after the backend saved its actual signature**.
The same fixture trade, native signature and two reserved inputs survived both
sidecar and local-client restart. Original backend approval replay returned the
identical saved signature. Release, prepare and preview were rejected; advancing
the real market's expiry clock by eight days did not release signed orders or
create another trade. Market DB field audit found no private policy, protected
balances, prompt, seed or private-key fields. Evidence:
[lost response](../scripts/demo/evidence/service-lost-sign-response.json).

**A blocker, reproduced at the pinned ref:** `LocalService.approve` sets
`approval:<tradeId>` to null before `wallet.sign`. When the HTTP response is lost,
the wallet has the signature but the local client has neither the original
approval nor a signature. `sync` only calls wallet.sync and sends a receipt;
it cannot recover/re-send the signature. It leaves the market RECONCILING.
Required A change: durably keep the exact package/approval and signing intent;
on recovery retry wallet.sign with that same authorization, save the returned
signature before relay, retry the content-derived signature message, and gather
the existing signatures to finalize that same package. Market currently only
accepts signature messages in AWAITING_APPROVAL/SIGNING, so replay in RECONCILING
also needs an explicitly bound recovery transition. Do not create another order,
change the transaction, reset approval, or free inputs on TTL. No A files were edited.

Backend changes in this integration:

The `broadcast-accepted` recovery test sent the genuine transaction to Core,
then deliberately discarded that RPC response and failed the next lookup in a
test-only RPC wrapper. Backend persisted RECONCILING and the exact finalized tx.
Restart retained the same signature hash and reserved inputs; the local-client
sync API found the existing mempool tx, then all recipients confirmed after
mining. Txid `a19a012071f946aa2b934098d4f041ace161e43571683fac79d9f4b04aca5fee`.
Evidence: [broadcast accepted](../scripts/demo/evidence/service-broadcast-accepted.json).
This is an injected loss at the RPC boundary with real Core/crypto, not a claim
of an actual TCP outage between Docker and bitcoind. The first harness attempt
incorrectly waited for full wallet.state after restart: pending mempool spends
can temporarily fail rgb-lib's ordinary consistency check. The launcher now
keeps sync available independently of balance readiness. The same saved trade
was resumed using `--resume-trade`; no re-signing or replacement order occurred.

The real no-match/cancel/concurrent-publication API checks passed:
[order negatives](../scripts/demo/evidence/service-order-negatives.json).
Requiring 101 DUSD prevents the ring; cancelled publication retries keep the same
cancelled IDs; simultaneous publications from one owner accept exactly one.

**Additional A blocker:** rejection before signing cancels the market trade but
does not release the other participants' wallet reservations. Their subsequent
local reject hits `TRADE_TERMINAL` before `wallet.release`. Reproducer:
`service-presign-reject.py` on a fresh/restored initial ring fixture. It observed
Alice CANCELLED/zero reserves while Bob and Carol remained PREPARING/two inputs
each. A must process terminal pre-sign snapshots and release local reserves only
after proving no participant began signing; terminal signed/reconciling cases
must remain pinned. The test explicitly cleaned up only the verified unsigned
backend reservations, and does not count that cleanup as successful product
recovery. Evidence: [pre-sign reject](../scripts/demo/evidence/service-presign-reject.json).

Implementation changes:

The complementary `broadcast-not-submitted` injection prevented the send from
reaching Core while reporting an uncertain RPC result. All three real signatures
and finalized tx `eab1d2e8319528f30785c5a8a0a200996b78d53048d23a84ffd7aa258558ecf0`
remain durable. After restart local-client sync stays RECONCILING: it does not
retry finalize even though the exact package and all signatures are available.
This is another **A recovery dependency**, not a completed broadcast. The
backend correctly refuses release/new preparation and keeps the same signature
and inputs; market TTL+8 days leaves all orders reserved. A should call
wallet.finalize on the existing immutable package/signature set after checking
the current receipt; backend already queries by txid and reuses the saved bytes.
Market should also preserve a reconciling broadcast receipt as RECONCILING,
instead of labeling every receipt with a txid BROADCAST before chain knowledge.
Evidence: [not submitted](../scripts/demo/evidence/service-broadcast-not-submitted.json).

The old `service-direct` and `service-ring` private fixtures deliberately retain
these signed recovery cases. Do not reset them or reuse their reserved inputs.
`service-ring-clean` has both successful settlements and completed unsigned
negative-case cleanup, and remains the available profile fixture. Harnesses stop
their own processes on exit; wallet/market/token state is preserved.

Actual full-service command runs (all with `rtk proxy`; the source was the pinned
archive above):

```sh
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-direct" python3 scripts/demo/service-smoke.py --source /private/tmp/rgb-service-source-8098d1a --scenario direct --repeat
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-ring-clean" python3 scripts/demo/service-smoke.py --source /private/tmp/rgb-service-source-8098d1a --base-port 43300 --scenario ring --repeat
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-direct" python3 scripts/demo/service-local-checks.py
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-direct" python3 scripts/demo/service-recovery.py --source /private/tmp/rgb-service-source-8098d1a --fault lost-sign-response --scenario direct
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-ring" python3 scripts/demo/service-recovery.py --source /private/tmp/rgb-service-source-8098d1a --base-port 43200 --fault broadcast-accepted --scenario ring --reverse --resume-trade 61e5c080-5d62-4b01-bc19-3445903d03f7
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-ring" python3 scripts/demo/service-recovery.py --source /private/tmp/rgb-service-source-8098d1a --base-port 43200 --fault broadcast-not-submitted --scenario ring
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-ring-clean" python3 scripts/demo/service-order-negatives.py
rtk proxy env RGB_DEMO_STATE="$PWD/packages/wallet/state/service-ring-clean" python3 scripts/demo/service-presign-reject.py
rtk proxy python3 -m unittest discover -s packages/wallet -p 'test_*.py'
```

Setup/catalog were run separately for each fresh fixture. Normal smoke commands
create trades and are not idempotent transaction recovery commands; use existing
trade sync/resume for a saved signed fixture. 16 Python tests passed; new/modified
Python scripts compiled. The four main txs passed independent Core witness/input/
fee checks and wallet identities matched across restart. Public evidence field
scan passed (no keys/tokens/PSBT/consignments/full balances/private policy).

Infrastructure was actually recreated with the external-volume override via
`docker compose ... up -d`, then `chain-volumes.py verify` confirmed unchanged
bitcoind/electrs volume names and the original height-430 block hash at height
650. After Core health/electrs startup completed, `doctor.py` passed all pinned
image, Core 30.2, indexer and RGB proxy checks. The first immediate doctor during
startup correctly failed while electrs was not yet started; it did not signal
lost chain data. See [volume evidence](../scripts/demo/evidence/chain-volumes.json).

For durable deployment beyond this integration session, export the service
source into a persistent ignored directory (for example
`packages/wallet/state/service-source-8098d1a`) rather than `/private/tmp`, install
its locked dependencies and configure the profile against that path. The code
snapshot is not a Git worktree; wallet/profile data remain separate. A's eventual
real checkout can be used as the source once present. Do not commit the private
state/config or copied dependencies.

The earlier ring `40673d08a73a976954deec8d8f9aa12ad07e0db538a99860068d276329eccc3a`
was resumed with the same signatures and txid to market CONFIRMED; see
[resume evidence](../scripts/demo/evidence/service-resumed.json). Its large BTC
deviation is separately recorded as unrelated legacy coinbase maturation and is
not counted as swap income. A forcibly interrupted diagnostic native call exposed
an upstream empty `rgb_runtime.lock` marker that survives process death. It was
archived only after holding both coordinator and instance locks; identity and
SQL/stock checks then passed. `recover-sdk-lock.py --profile NAME` implements this
explicit recovery for a stopped profile. It requires all SDK access to obey the
project instance lock and never removes keys, journal, signature or RGB stock.
Stock corruption is not repaired by removing a marker; use the real backup
restore workflow if validation fails.

Backend implementation changes:

- Save original protocol Approval durably before crypto; reject changes to it
  during replay, including a different approvalId/approvedAt. A must retain those
  exact values instead of minting replacement authorization.
- Save RECONCILING before external broadcast RPC, retaining the finalized bytes,
  txid, reservations and signature on failures/process interruption.
- Keep native exact-tx confirmation/RGB acceptance separate from independent BTC
  deposits/coinbase maturity. Record BTC deviation from total preview privately;
  retain exact RGB balance checks and report private sync errors for diagnosis.
  The confirmed txid is bound to the BTC delta already independently validated
  before signing. This is not a waiver of the signed amounts or fees.
- Fix regtest setup to use a separate miner for maturity blocks. The original
  full ring exposed this issue: Carol's RGB was accepted but unrelated coinbase
  maturity made the total BTC equality check fail. The saved transaction is
  reconciled via `service-resume.py --trade-id ID`; no replacement trade/signature.

Fixed fee estimation remains a deliberately bounded regtest policy: 1000 sats
split deterministically within each published cap; final previews recheck the
actual allocation and Core checks mempool acceptance. No dynamic fee selection,
RBF/CPFP, mainnet, arbitrary schemas or production privacy is claimed. Native
blinding/entropy 777 and nonce 1 remain deterministic test-only settings. They
are unsuitable for mainnet/privacy; changing them needs coordinated persisted
per-trade randomness and common commitment construction, not independent random
values at every prepare/validate call. All tested runtime is explicitly regtest.

---


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
participant. Shared-contract inputs use separate proof outputs as described below.
Estimated fees use a deterministic 1000-sat split within
each participant's cap; final plans use their explicit fee split. General fee
bumping, reorg recovery and mainnet are outside this MVP.

### Shared-contract inputs

A prior swap can leave outgoing change and received RGB on the same Bitcoin
output. A later ring can therefore consume one contract from multiple wallets,
even when every participant offers a different asset. The adapter now isolates
coloring to each wallet's owned inputs and gives each sender/contract/recipient
its own RGB output. This preserves proof routing without consuming another
wallet's known contract history. Signing checks require the exact local
consumers and transitions inside the combined bundle. Unordered SDK transition
sets are sorted for deterministic package comparison.

The confirmed SQL index records net incoming amounts even when the wallet also
spends collateral of that contract; validated RGB stock remains authoritative.
The isolated regtest run confirmed a direct swap, a three-party ring with two
shared contributing contracts, then a direct re-spend requiring the ring's
received RGB. Each restarted all sidecars after signing and checked exact final
BTC/RGB balances. See [recorded receipts](../scripts/demo/evidence/shared-contract-ring.json).
This verifies the adapter locally, not coordination between three updated remote
desktop installations.

The subsequent desktop failure used an old native executable despite updated
Python sources. Its persisted colored contributions conflicted even after the
executable was rebuilt (`the opout is already signalled as spent by a different
opid`). Rebuilding does not replace materials already published for a trade.
The unsigned attempt must be cancelled and new orders published; signed attempts
must retain their original approval and recovery records.

The Python adapter now checks the native owned-input-coloring capability before
preparation. Known stale-contribution failures have a public, allowlisted error
with recovery instructions; the UI pauses instead of calling them reconnections.
Use `npm run build:wallet` on every participant's machine before restarting.

The reproducible isolated regression is
`uv run --locked python scripts/demo/shared-contract-ring-smoke.py --execute`
against the local infrastructure. It creates new wallets, completes an X/DUSD
direct swap, then an X/DUSD/T000003 atomic ring with two shared input contracts,
and spends the RGB received from that ring. All three transactions confirmed,
all recipients accepted RGB, and exact balances matched after sidecar restarts.
The ring txid is `8d6c28f2db168181de481ac7efe5dbf59356ba24fa6298b1f3626f4a0b6dfda6`;
see [upgrade regression receipts](../scripts/demo/evidence/ring-upgrade-0a531c741d3b.json).
This is real local regtest evidence, not a completed three-remote-desktop trade.

All participants must update both the Python adapter and compiled native binary.
Historical transactions with distinct contributing contracts keep their original
output layout. Each separate RGB output holds 1000 sats, charged to its owner;
insufficient Bitcoin change is rejected. No extra signing authority is granted.

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
before signing, or after independently verifying a confirmed conflicting
[on-chain cancellation](cancellation.md). SIGNING/SIGNED/ambiguous-broadcast states never expire by order
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
