# Integration verification — 17 October 2026

This report describes new checks on the combined working tree, separately from
historical A/B evidence in [settlement.md](settlement.md). Start with the
[usage and deployment guide](usage.md).

## Changes and checkpoints

- `cd2d3f4`: README corrected and committed **before code changes**, as requested.
- `983490c`: UI retains a trade and explicit sync when wallet balance reads fail;
  stale balances cannot authorize new orders. Preparation remains available
  through PREPARING; unsigned peers can validate during SIGNING/RECONCILING.
  Local receipts expose the transaction ID and separate Bitcoin/RGB states.
- `cf2173c`: one persistent host launcher starts real sidecars, market, local
  clients and web. `up --desktop alice|bob|carol` replaces that profile's browser
  client with Electron, reusing its local database/approval history. Public
  wallet links follow the configured loopback port. No wallet initialization
  occurs during normal startup. Evidence prefixes avoid replacing prior runs.

Existing wallet keys and chain volumes were preserved. Initial chain checkpoint
at height 430 matched and current height was 653 before fresh fixtures. New test
wallets were created under ignored `integration-ring` and `integration-ui-direct`.
No signed reservation was released to hide a failure.

The subsequent QVAC checkpoint resolves short model aliases back to the verified
catalog; it does not alter matching, amounts or signing authority.

## Automated checks

`npm run check` passed with installed Rust 1.94 on PATH: Prettier/Ruff/rustfmt,
ESLint/Stylelint/Ruff/Clippy, TypeScript, 66 JS contracts/market/local/UI/desktop tests,
3 legacy wallet JS tests, 17 Python journal/protocol tests, public/local Vite builds.
`npm run build:desktop` also passed. Vite reports existing ignored `use client`
directives/source-map warnings; builds succeed.

Rust in this workstation's previous setup is under
`/private/tmp/rgb-b-rustup/toolchains/1.94.0-aarch64-apple-darwin/bin`, with
`CARGO_HOME=/private/tmp/rgb-b-cargo`, `RUSTUP_HOME=/private/tmp/rgb-b-rustup`.
The first full checks stopped at missing cargo; a full successful rerun used
that installed toolchain. A normal installation should expose Rust through PATH.
No change to dependency lockfiles was necessary.

The new UI regression is a **synthetic unit test**: a genuine in-memory market
match plus a test wallet transport; a rejected state read preserves the trade,
allows explicit sync and rejects draft validation using stale balances. It is
not an RGB settlement proof.

## Fresh real settlement

| Scenario | Transaction | Result |
| --- | --- | --- |
| Direct | `df678eea7aa5a3f3e4927c98fe1b0dda22db97dde2c9077b3aa861c1f4329278` | Both receipts + market CONFIRMED |
| Reverse direct after restart | `12ba29e7b4195637fbdc3549c6d46005c4e94c070edcaba9a8c2357f2976efa3` | Received RGB input spent by Alice; both receipts + market CONFIRMED |
| Ring | `31b36e32d8b93f412134bfa44f918a063fdced85cb5d9b46f293839862a3c59c` | All three receipts + market CONFIRMED |
| Reverse ring after restart | `6231559948dc323b304477e039fca83451f8b515f58e8251b7e1cefd69a0629d` | Received RGB inputs spent by Alice/Carol; all receipts + market CONFIRMED |

Evidence: [direct](../scripts/demo/evidence/integration-direct.json),
[reverse direct](../scripts/demo/evidence/integration-direct-repeat.json), [ring](../scripts/demo/evidence/integration-ring.json),
[reverse ring](../scripts/demo/evidence/integration-ring-repeat.json).
These traverse actual local-client HTTP → market HTTP/WebSocket → wallet HTTP →
Rust RGB/Bitcoin. Each has one Bitcoin transaction and 1000 sats total fee.
Actual balances equal the wallet previews; KEEP delta is zero. Funding, colored
and proofs contributions from all three participants were checked. These are
manual-draft service checks, not UI clicks or QVAC-to-settlement tests.
An independent Core audit also checked actual witnesses, exact input sets,
1000-sat fees and received outputs used by each reverse swap. Service execution
used `cf2173c`; the later change touches QVAC only, which these manual scenarios
do not invoke.

## Local QVAC

Actual QVAC inference on the real catalog initially confused asset identity and
was rejected by deterministic balance/policy checks. The model now receives
short per-call aliases; code maps every give/receive/reserve alias back to the
exact verified contract ID before amount/policy validation. Unknown aliases are
rejected. The original explicit no-reserve prompt example is preserved.

The final real Alice API check returned 10 X → at least 10 DUSD, fee cap 1000,
no BTC sale; `/api/draft/validate` passed. Actual QVAC / QWEN3_1_7B_INST_Q4 inference
took 3126 ms. The existing synthetic-catalog `npm run smoke:qvac` also passed
(actual inference 879 ms). Neither AI draft was published or signed. These checks
are separate from the manual-draft settlement and user-operated desktop journey.
[Evidence](../scripts/demo/evidence/integration-qvac.json) retains unsuccessful
pre-fix/intermediate attempts as well. This improves identity extraction, not a
guarantee of correct language understanding; all drafts require user review.

## UI / desktop evidence and remaining limits

The unified launcher opened a real Electron Alice and browser Bob/Carol. Public
market displayed “Market online” and the correct configured local-wallet link.
The user confirmed real Alice connection and visible BTC/X/DUSD/KEEP balances,
published a manual direct order, and reported signing through desktop. The
market received the genuine Alice signature. API-operated Bob independently
validated and signed the same package. Transaction
`948068ed4c7bd8f0182a2629098b4d0aac237c42af076236b0b302d136f7148e`
was broadcast and mined; Bob reports Bitcoin confirmed + RGB accepted. Alice's
final local Reconcile is still pending user observation at this checkpoint.
This is user-observed desktop evidence, not an automated screenshot assertion.
Computer Use could not access the native app due to macOS permissions; the user
then explicitly asked to perform desktop actions manually, so automation stopped.

Native approval, deep-link OS delivery and complete desktop settlement are not
established by merely launching Electron. The packaged/notarized distribution,
cloud TLS/WSS deployment and trading on independent computers have not been
verified. The host launcher is a development tool; root Compose still does not
launch a real wallet sidecar. See the guide for exact remote Bitcoin transport
and single-profile onboarding work required before multi-host settlement.

Scope remains regtest, precision-0 NIA, SegWit v0, distinct contributing contracts,
one active trade per wallet, deterministic test blinding/nonce and fixed fee
estimation. No mainnet, fee bumping, general reorg handling or production audit.
