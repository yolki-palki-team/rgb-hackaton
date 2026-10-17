# B service integration handoff — 17 October 2026

Real service integration now passes direct and three-party atomic ring, plus
reverse/re-spend of received RGB after profile restart, through A's actual
market/local-client APIs. This is **not** desktop/UI completion. A-owned apps,
contracts, manifests and lockfiles were not changed. The current checkout lacks
A code, so the tested service source is an unmodified Git archive of
`8098d1a90f79f4dffc1d38d7c64f93f143e52219` (`origin/main` when testing).
37 A source/contract files were compared byte-for-byte with that Git ref.

| Scenario | Confirmed Bitcoin txid |
| --- | --- |
| Direct | `491306e9519b2a8ebf451c11ae8e0e7ae18bce73914f8bf8ddb9939af37c65e7` |
| Direct received-asset re-spend | `8107877ac11f9ebf0d1519a5958c406866240826c947cddc5ee7c3a1852ff289` |
| Ring | `6aff9e46090594661565cc2cef38e8b2c78e81b84fcc88e274e23a6dc349520d` |
| Ring received-asset re-spend | `a0578b5771804b591f4041de1bb883ddd293a7bc9420bebeae6111c43b09396b` |

Every swap has one transaction, fee 1000 sats, actual BTC/RGB balances matching
the final previews, all recipient RGB acceptance, market CONFIRMED, and KEEP
unchanged. See `scripts/demo/evidence/service-{direct,ring}{,-repeat}.json` and
the current section of [settlement.md](../settlement.md) for actual deltas.
Funding/colored/proofs rounds and immutable plan/tx/commitment agreement are
checked before signing. Manual explicit approvals go through A's product checks.

Actual QVAC also passed `/api/interpret` with verified real asset IDs and a valid
draft; five policy negatives passed. That inference check is separate from the
manual-draft settlement scenarios; no full AI-to-desktop success is claimed.

## A dependencies: exact recovery reproducer

`scripts/demo/service-recovery.py --source SOURCE --fault lost-sign-response --scenario direct`
on a separately initialized fixture closes the real wallet HTTP connection only
after the genuine signature has been durably saved. Local-client restart + sync
cannot deliver it at the tested ref: `approve()` nulled `approval:<tradeId>` before
wallet.sign; local `signature:<tradeId>` is absent; `sync()` only obtains a receipt.
Backend original-approval replay returns the identical signature. Market remains
RECONCILING, inputs/orders stay reserved, and TTL advanced eight days cannot free
them. No manual relay was used to conceal this client recovery gap.

A needs to persist the original Approval + exact package through SIGNING and
RECONCILING, recover from wallet.sign with that immutable authorization, save and
re-send the same signature message, then finalize the same package when all
signatures exist. Market must allow bound signature recovery in RECONCILING;
currently only AWAITING_APPROVAL/SIGNING accepts it. `approvedAt`/approvalId cannot
be minted anew: backend now explicitly rejects replacement user approval.

No cross-chat messages were sent. The user must pass these changes to A or
authorize edits to that area. Final desktop check remains pending A's readiness.

Two more service recovery findings are reproduced:

- **Broadcast accepted, response lost:** real Core accepted
  `a19a012071f946aa2b934098d4f041ace161e43571683fac79d9f4b04aca5fee`;
  a test-only RPC wrapper discarded the response and next lookup. Restart kept
  RECONCILING, the signature hash and reserved inputs. Existing local-client sync
  found it and all three wallets reached CONFIRMED after mining. Recovery must
  remain reachable even when ordinary balance reads temporarily fail because a
  mempool input is spent but RGB has not yet reconciled. Launcher now does so.
- **Broadcast never submitted:** `--fault broadcast-not-submitted` retains all
  real signatures and finalized tx but A sync never retries finalize. The same
  trade stays RECONCILING after restart/TTL+8 days. A must reuse the exact package
  and signature set for idempotent wallet.finalize, and preserve the receipt's
  uncertain status instead of calling it BROADCAST merely because it has a txid.
- **Reject before signing:** `service-presign-reject.py` shows that peer wallets
  remain PREPARING/reserved after the market becomes REJECTED. A's later reject
  hits TRADE_TERMINAL before wallet.release. Process terminal pre-sign snapshots
  to clean up local unsigned reserves; do not apply that cleanup after signing.
  Test-only cleanup used backend release only after verifying no signature.

Public results are `service-broadcast-accepted.json`,
`service-broadcast-not-submitted.json`, `service-presign-reject.json` under
`scripts/demo/evidence`. `service-order-negatives.py` also passed actual API checks
for the impossible 101-DUSD ring, cancellation/publication replay and concurrent
same-owner publication. Signed fault fixtures `service-direct` and `service-ring`
remain deliberately pinned; use `service-ring-clean` for future desktop work.

## Backend/infrastructure delivered

- Immutable approval persisted before signing; RECONCILING persisted before
  broadcast RPC; exact original signature/finalized tx preserved on uncertain results.
- BTC total deviations from unrelated coinbase maturity no longer misreport RGB
  acceptance failure. Exact signed tx identity and RGB balances remain checked.
  New fixtures mine maturity blocks to a separate miner. The affected old ring
  was resumed to CONFIRMED with its original txid, no replacement signature.
- Persistent launcher: `service-profile.py configure|market|run|health`. Private
  config/tokens, local SQLite and wallet/RGB state are reused across restart.
  Ordinary startup cannot initialize/fund/issue. Separate setup/catalog commands
  and per-profile ports are documented in settlement.md.
- `chain-volumes.py pin|verify` records existing chain/indexer volume names and
  a chain checkpoint, generating an ignored external-volume Compose override.
  Use that override for future `up`; never down-v/prune. Electrs waits for Core
  health and Compose services have restart policies.
  Actual Compose recreation with those existing volumes passed: volume names
  unchanged, original height-430 block preserved at height 650; doctor passed
  after Core/electrs startup. See `evidence/chain-volumes.json`.
- 16 wallet journal/protocol tests passed, including immutable original-approval
  replay and independent BTC credit regression. Full service evidence is real;
  the unit fixtures and response-loss injection are explicitly test-only.

Boundaries remain regtest, precision-0 NIA, SegWit v0, distinct contributing
contracts, deterministic test blinding/nonce and 1000-sat estimated fees. No
mainnet, general fee bumping, reorg handling or production privacy is claimed.

If a native process is forcibly killed while rgb-lib holds `rgb_runtime.lock`,
upstream's empty marker survives and can wait an hour on next open. Stop that
profile first; `recover-sdk-lock.py --profile NAME` exclusively holds both project
locks, archives the stale marker and checks wallet identity plus SQL/stock. Use
only when all SDK access obeys this project's instance lock. It never removes
journal, approval, signature or RGB stock; corruption still requires a real
backup restore. Normal restart after completed RPCs was tested separately.

---

# Earlier B handoff — real WalletAdapter protocol v1

Current: the full authenticated HTTP WalletAdapter v1 from A's merged PR #1 is
implemented in `packages/wallet/server.py` / `protocol.py`. No A-owned files or
root JS manifests were changed. AGENTS.md was updated at the user's request to
allow development test-network transfers without repeated confirmation. The new work is on `codex/wallet-adapter-reconciliation`.

SQL allocation/transfer indexing now agrees with validated RGB stock. Two new
HTTP-driven swaps spent assets received in the first swaps; all sidecars restarted
after durable signatures, before broadcast. Actual BTC/RGB deltas matched preview:

- Direct repeat: `68cfdfaff9cf79a5a03d6dfea85e14cd876adfd2b48d5d6278be96d6957d585b`.
- Ring repeat: `1266dbbb2a47cf8cf3d9f7ed2529cb0428a0476695ca07bbf9c5dd32cd4df7d8`.
- Fees 1000 sats each; all 7 KEEP preserved. One Bitcoin transaction per swap.

The ordinary SDK/proxy transfer also settled: Bob → Carol 1 X plus 1000 sats,
fee 503 sats, tx `bb5164e7bf1608b271ee389c20aaeae81bf35d95738394f41cf8ea88940c77a0`.
Both SDK histories and SQL/stock indexes agree. A private backup/restore check
passed for all three wallets against the existing chain.

A's real HttpWalletAdapter and Zod/plan-digest schemas passed against the live
sidecar. Package codec is `rgb-cooperative-v1`; material rounds are funding,
colored, proofs. See [settlement report](../settlement.md) for exact sequencing,
startup, recovery rules, test evidence and limits.

## Connect A / future desktop

Start one `rtk proxy python3 packages/wallet/server.py --profile alice --owner alice --port 4201`
per profile with private `WALLET_RPC_TOKEN` (at least 32 chars) and matching
`RGB_DEMO_STATE`. Bind is loopback only; browser Origin is rejected. The token
belongs to the local client, not browser/market/QVAC. On A set `WALLET_MODE=real`,
`WALLET_RPC_URL=http://127.0.0.1:4201`, matching token and owner. Bob/Carol use
4202/4203. A's Docker mock runner is unchanged; this integration runs on the host.
A future desktop client can use the same API; keys never move into its web view.

Run setup then `scripts/demo/catalog.py` so all wallets know validated contract IDs
and precisions, including zero-balance incoming assets. For the current main
fixture, ownership changed after the reverse ring; query state rather than using
A's mock fixture IDs or assuming the original owners.

Supported methods are capabilities/state/reserve/release/prepare/validate/sign/
finalize/sync with A's exact protocol-v1 shapes. `adapter.mjs` is the retained
read-only legacy bridge; use the HTTP adapter for signing. Actual sidecar capabilities
are enabled only when chain/indexer and stock/SQL checks succeed.

## Safety / boundaries

Each wallet checks its immutable final package and requires an exact approval
binding. Development test-network transfers have standing authorization under
AGENTS.md; mainnet still requires user approval. A's product approval UI is unchanged.
Released signatures never expire with order TTL. One active plan per profile,
transactional outpoint reservations, per-trade signature records and idempotent
broadcast recovery are implemented. Chain confirmation and RGB acceptance remain
separate and both are required for confirmed receipts.

A still owns private policy/order checks, pairing, approval UI and market message
relay. For a client crash between wallet signature persistence and market receipt,
A must retain the approval binding and relay the same cached signature; do not
release orders or create a different package. Sidecar restart after signature
delivery was tested. No new QVAC/browser end-to-end claim is made by B.

Regtest NIA precision 0 / SegWit v0 only; same-contract multi-sender inputs rejected.
Deterministic test blinding, fixed fee estimates and anonymous Docker chain volumes
remain documented limitations. Never commit or upload ignored wallet state/backups.
