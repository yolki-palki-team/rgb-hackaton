# palka.

A non-custodial A2A marketplace prototype for BTC and RGB assets, designed for direct swaps between two users and atomic ring swaps between three users.

Users describe their goals in plain language. An on-device QVAC assistant turns those goals and private preferences into orders for users to review. A deterministic matching engine finds compatible orders; each wallet validates the proposed exchange and requests approval before signing a shared Bitcoin transaction.

## Motivation: validate multilateral exchange on RGB

**Our primary research goal is to test whether cyclic exchange can unlock trades that bilateral matching cannot execute, without requiring participants to buy intermediate assets first—and whether RGB can settle those trades atomically.** The marketplace and local AI are interfaces for this experiment, not the experiment's main result.

We were inspired by Paolo Dini's [An Introduction to MTCS](https://cycles.money/blog/an-introduction-to-mtcs) (Cycles, November 27, 2023). It explains how Multilateral Trade Credit Set-off finds cycles in business obligation networks, allowing debts to be reduced without changing each firm's net position. Its graph-based approach motivates looking at a whole network of participants instead of requiring every exchange to have a reciprocal pair.

This is an adaptation of that idea, **not an implementation or proof of the MTCS algorithm**. MTCS clears existing monetary obligations; palka exchanges independently owned BTC and RGB assets with explicit amounts and consent. Different assets cannot simply be added together as equivalent debts. Our current matcher selects a feasible direct swap or three-party cycle; it does not implement MTCS's minimum-cost maximum-flow optimization or claim globally optimal liquidity savings.

### The hypothesis we want to test

Consider three participants with these proposed terms (illustrative quantities, not market prices):

| Participant | Owns and offers | Wants to receive |
| ----------- | --------------- | ---------------- |
| Alice       | 100 X           | 100 DUSD         |
| Bob         | 100 DUSD        | 100,000 sats     |
| Carol       | 100,000 sats    | 100 X            |

No two orders match directly. A ring can connect Alice's X to Carol, Carol's BTC to Bob, and Bob's DUSD to Alice in one atomic settlement. Alice need not hold or purchase BTC as an intermediate asset. Every asset offered must nevertheless exist in its sender's wallet, and Bitcoin fees require additional funding. “Trading through assets a participant does not hold” means avoiding intermediate inventory, not creating missing assets or spending an unfunded balance.

RGB makes this a concrete engineering question: can independently validated asset histories and owned inputs be coordinated into one approved Bitcoin transaction while preserving each participant's terms? Finding a graph cycle alone is insufficient. We must check conservation separately for each asset, BTC fees, ownership, private limits, signatures and RGB acceptance. Sequential transfers do not count as an atomic ring. QVAC only drafts intent locally; deterministic code checks amounts and each user approves signing.

### Planned validation campaign

The following is a **proposed experiment, not a report of 100 completed swaps**:

1. Run 100 scheduled real regtest settlement attempts: 20 direct swaps as controls and 80 three-party rings, with reproducible order fixtures and recorded starting balances. Include rings where the desired asset starts at zero in the receiving wallet and no participant needs to acquire an intermediate asset.
2. Compare direct-only matching with direct-plus-ring matching on the same order sets. Report executable orders, unmatched orders, completed settlements out of all attempts, fees, latency and failures. Measure intermediate inventory per asset; do not invent a common valuation to sum BTC and RGB quantities.
3. For each successful attempt, retain the approved plan digest, transaction ID, Bitcoin confirmation, every participant's RGB acceptance and before/after balances. Verify that received RGB can be spent again after restarting the wallets. A match or broadcast alone is not settlement evidence. Publish sanitized results without keys, tokens or private policies.
4. Run separate failure cases: insufficient balance, excessive fee, expired order, unavailable participant, conflicting inputs and restart during settlement. Reject invalid plans before signing; after broadcast, reconcile the existing transaction rather than pretending it was rolled back. No partial or unresolved result may be reported as success.
5. Extend the experiment to five-party rings only after expanding the contracts, matcher, wallet validation and settlement tests. **Current support is two or three participants; five-party swaps are a research milestone, not an existing feature.**

Success would provide bounded evidence that cyclic matching improves execution for the tested orders and that RGB can enforce the resulting exchange without prefunded intermediate inventory. It would not establish mainnet readiness, market-wide liquidity savings or a general mathematical proof. Existing settlement evidence is documented separately in [integration verification](docs/integration.md); the campaign above still needs to be run and measured.

## Scope and status

- Target: direct and three-party atomic swaps on Bitcoin regtest, using BTC and two test RGB assets.
- Local AI inference, private keys and wallet state stay on the user's device.
- Fixed total amounts, full execution by default, optional partial direct fills, and explicit approval before each signature.
- Public web interface, matching server, local wallet client and packaged macOS shell.

**Status:** Public web, deterministic direct/ring matching, local QVAC, private wallet UI, Electron and the real RGB sidecar are integrated. Fresh service checks on the combined tree confirmed direct and atomic three-party swaps, plus re-spending received RGB after restart. Historical recovery evidence is retained separately. The persistent host launcher now starts the real stack together; UI preparation and recovery no longer disappear between cooperative rounds or when balance reconciliation fails. A user-operated Electron Alice and API-operated Bob also completed a direct swap with both Bitcoin confirmation and RGB acceptance, independently checked against wallet balances and Core. Three-desktop, cloud and multi-computer verification remain separate. Mock cannot sign or report blockchain success.

Separate WDK Bitcoin funding has passed a real regtest transfer and restart check; see [WDK funding](docs/handoffs/wdk-funding.md). This is a separate funding transaction, with explicit approval, and does not replace the native RGB settlement adapter.

### Partial direct fills

Enable **Allow partial fills** in the review form to fill a larger order through separate two-party swaps. For example, an order offering 100 X for at least 1,000,000 sats can exchange 50 X for 500,000 sats with Bob, then the other 50 X for 500,000 sats with Carol. Each fill has its own transaction and approval. The whole order is not atomic: one half can finish while the other remains unmatched. Full execution remains the default; three-party rings still execute in full.

The minimum fill is expressed in the asset you give; the final remainder may be smaller. Integer checks preserve the original minimum exchange rate without rounding against either participant. Only one fill can be active for an order. Confirmed fills update its remaining amount and stay in history across restarts. A rejected or unsuccessful fill stops the remaining order while keeping its confirmed progress visible; publish a new order for that remainder if you want to continue. An uncertain signed transaction stays reserved until reconciliation, so it cannot be reused by another fill.

**The fee limit is a total order budget.** Each fill receives a proportional cap based on its share of the original give amount. Confirmed caps consume this budget even when actual fees are lower; the displayed budget used is not a claim about actual fees paid. Small fills can therefore require a larger total budget, and native minimum-output and funding checks still apply. Incoming BTC cannot fund the fill's fee or satisfy a protected pre-trade balance. Partial execution does not authorize later signatures automatically.

Update both the market backend and the wallet client before using partial fills. Older backends reject the new order terms; the client must not silently republish them as a full-only order.

**Verified on local regtest:** one 100 X order completed as two 50 X / 500,000 sat fills with Bob and Carol, using two different Bitcoin transactions. Both wallets confirmed Bitcoin settlement and RGB acceptance for each fill; exact balances matched the approved previews. Restarting the isolated services between fills preserved the parent order, remainder and history, and the first fill's approval token was rejected for the second. Alice paid 500 sats per fill within the 2,000 sat total budget and retained her protected 7 KEEP. See the [sanitized evidence](scripts/demo/evidence/service-partial-fill-20261017T175857Z-703b6af6.json). Reproduce against local regtest infrastructure with `uv run --locked python scripts/demo/service-partial-smoke.py --execute`; it creates new ignored test wallets and never reuses an existing wallet. This is service-level evidence, not a multi-desktop or load test; QVAC and stage timings were not measured in this run.

The desktop/local wallet now follows the public market's visual layout. Publishing checks the draft in one action; preparation, package validation and post-approval reconciliation run automatically while the app is open. Users still review exact amounts and approve signing separately. Repeated transport failures back off and pause with a retry action; reopening restores local approval/receipt state. The workflow and recovery checks pass. The user reviewed the updated desktop and accepted its appearance on 2026-10-17; no Computer Use was used. A new end-to-end swap through the redesigned UI remains unverified.

Start with the practical [usage and deployment guide](docs/usage.md): first setup, restart without wallet reinitialization, pairing, direct/ring orders, approval, recovery, and the concrete remaining work for two/three computers. See [current integration evidence](docs/integration.md) and [historical settlement evidence](docs/settlement.md).

For an **already initialized and configured** real profile set:

```sh
# Use the same private state directory as during setup/configure.
export RGB_DEMO_STATE="$PWD/packages/wallet/state/my-direct"
rtk proxy uv run --locked python scripts/demo/service-profile.py up
# Or, after stopping that runner, use desktop Alice and browser Bob/Carol:
rtk proxy uv run --locked python scripts/demo/service-profile.py up --desktop alice
```

The launcher runs on the host alongside `infra/compose.yaml` Bitcoin infrastructure.
It preserves wallets, pairing credentials and local approval history. The Docker
quickstart below is a separate web/runtime option and does not start real sidecars.

Hackathon resources and stack guidance are in [materials.md](materials.md).

## Server deployment

For a separate VM running **only public web and market**, use
[deploy/README.md](deploy/README.md). The tracked Compose configuration and launcher
preserve SQLite and private credentials, register new desktops automatically,
and leave desktop/QVAC/wallets on users' computers. The default profile serves HTTP;
[the owlpeer.com HTTPS profile](deploy/HTTPS.md) enables direct desktop HTTPS/WSS
access after DNS and firewall setup. The optional [shared regtest profile](deploy/NETWORK.md)
adds persistent chain infrastructure, HTTPS desktop access, participant funding,
RGB contract distribution and WDK funding on the same network.

## Run with Docker

From the repository root, with Docker Desktop / Docker Engine 25+ and Compose 2.20.2+ running:

```sh
docker compose up -d --build --wait
docker compose exec runtime node --import tsx apps/local-client/scripts/docker-pairing.ts
```

Open **http://127.0.0.1:5173/** for the public landing page or **http://127.0.0.1:5173/market** for open orders. By default, the second command displays one private real-mode profile at **http://127.0.0.1:4101/** and its pairing token. Open that profile's URL and enter its token there. The public site never asks for a pairing token. No `.env` setup is needed to see the site, but a working wallet RPC sidecar and its token are required for balances or trading.

`web` serves the public Vite build through Nginx. It can proxy only `GET /market-api/health`, `GET /market-api/orders`, `GET /market-api/activity` and `GET /market-api/history`; the proxy strips incoming authentication headers, cookies, request bodies and queries except the validated history cursor. `runtime` supervises the market and one real-mode local client by default. That client serves its private wallet UI on the same origin as its API. Published ports bind to `127.0.0.1`; the market port is not published and remains available only on the Docker bridge. The Compose file retains loopback mappings for 4102/4103 for the opt-in mock demo, but those profiles are not started by default. Pairing/Origin/Host checks remain enabled. Missing wallet RPC credentials leave the real client visibly unavailable; they do not select a synthetic wallet. The retained telephony/Face ID utilities are not started.

Published orders and trade outcomes remain in the market SQLite database, including cancelled, expired and unsuccessful attempts. The History view loads older records in pages without a 50-record total limit. Desktop and browser wallet also retain successfully viewed history pages in their private local SQLite store; if the market is unavailable after a restart, saved pages appear with a stale notice. This is not a backup against deleting the state directory or database. Private plans and failure reasons are available only to the authenticated participant; public history contains public order terms and execution status only.

Trade status polling runs independently of slower wallet balance refreshes. On startup, the local client reconciles durably recorded signed operations against their original approved package, with bounded retries; this recovery only checks settlement and relays verified receipts, never signs or broadcasts. Legacy records missing the approved package remain pending for explicit reconciliation. For performance diagnosis, start the wallet sidecar with `PALKA_TIMINGS=1`: stderr reports only an allowlisted operation name, handling duration and outcome, without request bodies or credentials. Timings exclude HTTP queue and network time.

The browser wallet on **4101** and desktop share `apps/local-client/ui`. Docker
keeps its own built copy: rebuilding desktop or the public `web` service does not
update the browser wallet. After UI changes, rebuild the `runtime` service and
reload the browser tab:

```sh
rtk proxy docker compose up -d --build --no-deps runtime
```

This briefly restarts the Docker market/local APIs and preserves their data and
model-cache volumes. Keep the same environment/mode settings used at startup.
The browser profile remains separate from the desktop wallet; matching appearance
does not connect it to the desktop's keys or balances.

The desktop opens with a skeleton while local services start and the first wallet
snapshot loads. Connection, order, signing and funding actions show a spinner in
the active button; swap and funding panels explain pending confirmation. Loading
animations respect reduced-motion settings. Rebuild the desktop UI/shell (or the
packaged app) and restart to pick up these changes; browser Docker profiles need
the runtime rebuild above. Live settlement through these loading states has not
been reverified.

Named volumes keep the databases, generated tokens and QVAC model cache across container rebuilds and restarts. The real-default path does not preload QVAC; first actual AI use downloads about 1.06 GB of public model weights, then loads them locally. Docker runs Linux CPU inference. Model readiness is shown in the local UI. Allow enough disk space and memory for the model; inference speed depends on the machine.

To run the explicit synthetic three-profile demonstration instead:

```sh
PALKA_DEMO_MODE=true docker compose up -d --build --wait
```

It starts mock A/B/C on ports 4101–4103 and preloads QVAC once for the shared cache. Mock wallets can match orders but cannot sign or report Bitcoin/RGB settlement. This setting is for demonstration only; omit it to return to the real-default path. The real wallet RPC URL is restricted to loopback, so a Docker deployment needs B's sidecar in the same container/network namespace; Compose does not launch one.

```sh
docker compose ps
docker compose logs --tail=100 runtime
docker compose restart runtime
docker compose down
```

`down` stops/removes containers but preserves volumes. Do not add `--volumes` if you need to keep wallet/demo state. To explicitly test local model inference inside the running container: `docker compose exec runtime npm run smoke:qvac`.

## Run the local demo

```sh
npm ci
npm run dev:mock
```

Open **http://127.0.0.1:5173/** for the landing page or **http://127.0.0.1:5173/market** for the public order book. The runner starts the market on port 4100 and local profiles A/B/C on 4101/4102/4103. It prints the path to a private `.state/mock-*/pairing.json` file. Open the desired profile's local URL and enter its `sessionToken` on that page; the public market cannot access local balances, policy, signing or the pairing token. The token stays in that tab's memory; seed/private keys are never sent to the browser. `npm run dev:mock` builds the local UI before starting. Each invocation creates separate demo state. Stop the runner with Ctrl+C.

`mock` applies to the wallet: its labeled balances are synthetic. The market, SQLite persistence, HTTP/WebSocket authorization and QVAC inference are real. Preparing a mock trade returns `UNSUPPORTED`, without a fake transaction ID. Three profiles on this machine are a demonstration, not three independent devices.

QVAC uses **@qvac/sdk 0.21.1**, **QWEN3_1_7B_INST_Q4**, and a local Node 22.17 runtime installed with the workspace. First use downloads about 1.06 GB of public model weights; subsequent inference is local. No model API key or cloud fallback is used. A failed or ambiguous extraction keeps the goal visible and leaves the review closed. Manual entry is a separate action with empty amount fields. Explicit English fixed orders such as `Sell 10 X for at least 10000 sats of BTC. Maximum fee 1000 sats.` are grounded against the original quantities and units; unsupported phrasing requires clarification. Percentage constraints need particular care: the model can misread them, so invalid interpretations are rejected and all drafts require review.

Example goal: `Sell 100 X for at least 100 DUSD. Fee up to 1000 sats. Do not sell BTC.` The local order form displays **atomic units** (BTC in sats); X and test DUSD have precision 0 in the mock. DUSD is not USDT or a backed dollar.

For the ring, confirm these three independent orders, allowing BTC sale only for C:

| Profile | Gives       | Receives at least |
| ------- | ----------- | ----------------- |
| A       | 100 X       | 100 DUSD          |
| B       | 100 DUSD    | 100000 sats       |
| C       | 100000 sats | 100 X             |

Confirming an order authorizes matching only. Signing has a separate final wallet-validated preview and approval. Real mode retains reservations after a signing attempt or an uncertain broadcast; expiry is not permission to reuse the funds.

## Desktop wallet client (macOS)

```sh
npm ci
npm run dev:desktop
# Or build a distributable macOS app:
npm run package:desktop
# Open the built Apple Silicon app:
open .dist/desktop/palka-darwin-arm64/palka.app
```

The macOS package is written to `.dist/desktop/palka-darwin-arm64/palka.app`. The `dev:desktop` command rebuilds the UI and desktop shell before opening them; rebuild the package after source changes to update the Finder app. The app keeps the market token, wallet RPC token and local API bearer in Electron's main process. Signing requires explicit approval of the wallet-validated amounts and fee in the swap UI. The local service revalidates the exact package before signing; regtest swaps do not show a second native confirmation dialog. WDK funding uses its own native approval dialog. A `palka://offer/order-<UUID>` argument delivered to an already running second instance selected the offer for review and did not act on the trade. The macOS scheme is declared in the app bundle; delivery through LaunchServices `open` remains unverified. The public marketplace has no access to this bridge.

The default desktop config is **real** mode. On first launch the app creates `desktop-config.json` in its Electron user-data directory with owner-only permissions. A new profile generates and saves its participant ID and secret token before connecting, then registers automatically with a market that enables `MARKET_SELF_REGISTRATION=true` (enabled by the server deployment). The file is reused across restarts; existing profiles retain their original identity and credentials without migration. Configure the matching local wallet RPC URL/token separately; registration does not create or fund a wallet. Do not delete the config to reconnect. Environment variables `PALKA_OWNER_ID`, `PALKA_LOCAL_PORT`, `PALKA_MARKET_URL`, `PALKA_MARKET_TOKEN`, `PALKA_WALLET_RPC_URL`, `PALKA_WALLET_RPC_TOKEN`, `PALKA_WALLET_MODE`, `PALKA_PUBLIC_MARKET_URL`, and `PALKA_LOCAL_STATE_DIR` can override those values for a run. The repository provides the sidecar in `packages/wallet/server.py` and persistent host profiles through `scripts/demo/service-profile.py`. Configure an initialized real profile as described in [settlement.md](docs/settlement.md); desktop launch does not initialize or start that sidecar. Missing RPC or unsupported capabilities leave the wallet unavailable. Use the browser-local `npm run dev:mock` path only for explicit synthetic demonstrations.

## Layout and integration

- `apps/web`: public React/Vite landing page and read-only market.
- `apps/market`: HTTP/WebSocket coordination, deterministic matcher and SQLite.
- `apps/local-client`: local wallet UI and same-origin loopback API, QVAC, private policies, approval state and wallet RPC client.
- `apps/desktop`: Electron main/preload bridge, local service launcher and macOS package script.
- `packages/contracts`: protocol v1 runtime schemas, exact BigInt quantities and synthetic JSON fixtures.
- `tools/telephony`, `tools/faceid`: retained earlier utilities, not used by the exchange or its local AI flow.

The old Expo `front/` directory was removed at the user's request. Root `node_modules/` contains shared workspace dependencies and is ignored by Git.

See [A handoff](docs/handoffs/a.md) for the complete adapter boundary and ports, [QVAC evidence](docs/handoffs/qvac-evidence.md) for actual inference checks, and [.env.example](.env.example) for local configuration names. The application does not automatically load the existing root `.env`. Never put private wallet state or pairing tokens in Git.

To connect the native wallet, start its loopback sidecar and configure a local profile with `WALLET_RPC_URL` and `WALLET_RPC_TOKEN`; real mode is already the default. Match `LOCAL_OWNER_ID` to the sidecar owner. Its declared capabilities must support the requested direct/ring swap. The real HTTP sidecar implements the `rgb-cooperative-v1` codec; recorded API integration checks include actual on-chain receipts for both direct and ring swaps. The supported scope is regtest, precision-0 NIA assets, SegWit v0 and distinct contributing RGB contracts, with test-only deterministic blinding. This is not production/mainnet readiness. Unsupported rings are never replaced with sequential transfers.

## Checks

Use Node 22.17 (`.nvmrc`), Python 3.12+ through uv, and Rust 1.94 through
rustup (`rust-toolchain.toml` installs rustfmt and Clippy). The desktop launcher and wallet helpers run standard commands directly; RTK is not
required for desktop setup or wallet operations. Install the development dependencies and
materialize the pinned SDK once before running the complete check:

```sh
rtk proxy npm ci
rtk proxy uv sync --locked
rtk proxy uv run --locked python scripts/demo/bootstrap-native.py
rtk proxy npm run check
```

The SDK bootstrap downloads source and adds the reviewed local Rust bridge; it
does not initialize a wallet or transfer funds. If the bridge changes after a
previous bootstrap, use `--refresh` as described in [settlement.md](docs/settlement.md).

Code style is enforced locally and by `.github/workflows/quality.yml` on pushes
and pull requests:

The separate **Tests** workflow (`.github/workflows/tests.yml`) also runs on pushes,
pull requests, and manual launches. Its JavaScript and Python jobs run independently
of the native RGB/SDK build: application and wallet-adapter tests cover the client boundary,
while Python tests cover wallet journals, protocol validation and crash recovery.
These are isolated tests with synthetic fixtures; they do not perform real transfers
or download QVAC model weights. The full quality workflow retains its existing tests.

| Code                                                           | Linter                                                         | Formatter                         |
| -------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------- |
| TypeScript, TSX, JavaScript, MJS (including tests and scripts) | ESLint, typescript-eslint, React Hooks rules                   | Prettier                          |
| CSS                                                            | Stylelint recommended rules                                    | Prettier                          |
| Python wallet and demo scripts                                 | Ruff via uv                                                    | Ruff                              |
| Native Rust and the local SDK bridge                           | Clippy for the application; bridge compiled as part of the SDK | rustfmt, including `extension.rs` |
| JSON, YAML, HTML                                               | Prettier syntax validation                                     | Prettier                          |

```sh
rtk proxy npm run format       # Apply all formatters
rtk proxy npm run format:check # Check formatting without rewriting files
rtk proxy npm run lint         # Run all linters; warnings fail the check
rtk proxy npm run lint:fix     # Apply JS/CSS/Python lint fixes, then run format
rtk proxy npm run test:python  # Isolated wallet journal/protocol unit tests
rtk proxy npm run test:wallet  # JavaScript wallet adapter unit tests
```

Individual `lint:js`, `lint:css`, `lint:python`, `lint:rust`, `format:web`,
`format:python`, and `format:rust` commands are available for focused work.
`.editorconfig` supplies basic editor defaults. Lockfiles pin the tools.
Generated SDK/vendor code, build output, private state, retained ignored tools,
and recorded settlement evidence are excluded from formatting. The checked-in
SDK bridge itself is formatted; upstream dependency lints are not enforced.
CSS specificity ordering is not enforced across independent components, and
the existing local-wallet theme override block explicitly permits repeated
selectors so its cascade is preserved.

`npm run check` includes formatting, lint, typecheck, the JS/Python unit tests
and both UI builds. It does not run live QVAC inference, Docker/regtest transfers
or mainnet signing. Those integration checks remain explicit:

```sh
npm test
npm run typecheck
npm run build
npm run smoke:qvac
```

`npm run build` builds both the public and local UIs. Tests cover exact amounts/limits, direct/ring/no-match, ownership, revisions, expiration, double reservation, event replay/access, local Origin/pairing, rejected AI JSON, stale final previews and recovery after uncertain signature delivery. The QVAC smoke performs actual local inference and prints only synthetic test output and runtime diagnostics. Wallet test doubles prove boundary behavior, not atomic RGB settlement.

The root documentation, initial ideas and retained utilities predate the exchange implementation. A's workspace code was created during this development session on 17 October 2026; no Git history rewrite or deployment was performed.
