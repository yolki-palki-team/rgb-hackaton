# palka.

A non-custodial A2A marketplace prototype for BTC and RGB assets, designed for direct swaps between two users and atomic ring swaps between three users.

Users describe their goals in plain language. An on-device QVAC assistant turns those goals and private preferences into orders for users to review. A deterministic matching engine finds compatible orders; each wallet validates the proposed exchange and requests approval before signing a shared Bitcoin transaction.

## Scope and status

- Target: direct and three-party atomic swaps on Bitcoin regtest, using BTC and two test RGB assets.
- Local AI inference, private keys and wallet state stay on the user's device.
- Fixed order amounts, full execution and explicit approval before signing.
- Public web interface, matching server, local wallet client and packaged macOS shell.

**Status:** Public web, deterministic direct/ring matching, local QVAC, private wallet UI, Electron and the real RGB sidecar are integrated. Fresh service checks on the combined tree confirmed direct and atomic three-party swaps, plus re-spending received RGB after restart. Historical recovery evidence is retained separately. The persistent host launcher now starts the real stack together; UI preparation and recovery no longer disappear between cooperative rounds or when balance reconciliation fails. A user-operated Electron Alice and API-operated Bob also completed a direct swap with both Bitcoin confirmation and RGB acceptance, independently checked against wallet balances and Core. Three-desktop, cloud and multi-computer verification remain separate. Mock cannot sign or report blockchain success.

Separate WDK Bitcoin funding has passed a real regtest transfer and restart check; see [WDK funding](docs/handoffs/wdk-funding.md). This is a separate funding transaction, with explicit approval, and does not replace the native RGB settlement adapter.

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

`web` serves the public Vite build through Nginx. It can proxy only `GET /market-api/health` and `GET /market-api/orders`; the proxy strips incoming authentication headers, cookies, request bodies and queries. `runtime` supervises the market and one real-mode local client by default. That client serves its private wallet UI on the same origin as its API. Published ports bind to `127.0.0.1`; the market port is not published and remains available only on the Docker bridge. The Compose file retains loopback mappings for 4102/4103 for the opt-in mock demo, but those profiles are not started by default. Pairing/Origin/Host checks remain enabled. Missing wallet RPC credentials leave the real client visibly unavailable; they do not select a synthetic wallet. The retained telephony/Face ID utilities are not started.

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

QVAC uses **@qvac/sdk 0.21.1**, **QWEN3_1_7B_INST_Q4**, and a local Node 22.17 runtime installed with the workspace. First use downloads about 1.06 GB of public model weights; subsequent inference is local. No model API key or cloud fallback is used. A failed/ambiguous extraction leaves a manual form. Percentage constraints need particular care: the model can misread them, so invalid interpretations are rejected and all drafts require review.

Example goal: `Sell 100 X for at least 100 DUSD. Fee up to 1000 sats. Do not sell BTC.` The local order form displays **atomic units** (BTC in sats); X and test DUSD have precision 0 in the mock. DUSD is not USDT or a backed dollar.

For the ring, confirm these three independent orders, allowing BTC sale only for C:

| Profile | Gives | Receives at least |
| --- | --- | --- |
| A | 100 X | 100 DUSD |
| B | 100 DUSD | 100000 sats |
| C | 100000 sats | 100 X |

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

The macOS package is written to `.dist/desktop/palka-darwin-arm64/palka.app`. The `dev:desktop` command rebuilds the UI and desktop shell before opening them; rebuild the package after source changes to update the Finder app. The app keeps the market token, wallet RPC token and local API bearer in Electron's main process. Signing requires a fresh wallet preview and a native approval dialog showing amounts and fee. WDK funding uses its own native approval dialog. A `palka://offer/order-<UUID>` argument delivered to an already running second instance selected the offer for review and did not act on the trade. The macOS scheme is declared in the app bundle; delivery through LaunchServices `open` remains unverified. The public marketplace has no access to this bridge.

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
rustup (`rust-toolchain.toml` installs rustfmt and Clippy). The existing wallet
scripts also require RTK on `PATH`. Install the development dependencies and
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

| Code | Linter | Formatter |
| --- | --- | --- |
| TypeScript, TSX, JavaScript, MJS (including tests and scripts) | ESLint, typescript-eslint, React Hooks rules | Prettier |
| CSS | Stylelint recommended rules | Prettier |
| Python wallet and demo scripts | Ruff via uv | Ruff |
| Native Rust and the local SDK bridge | Clippy for the application; bridge compiled as part of the SDK | rustfmt, including `extension.rs` |
| JSON, YAML, HTML | Prettier syntax validation | Prettier |

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
