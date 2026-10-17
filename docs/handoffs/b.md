# B handoff — real WalletAdapter protocol v1

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
