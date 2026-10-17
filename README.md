# palka.

A non-custodial A2A marketplace prototype for BTC and RGB assets, designed for direct swaps between two users and atomic ring swaps between three users.

Users describe their goals in plain language. An on-device QVAC assistant turns those goals and private preferences into orders for users to review. A deterministic matching engine finds compatible orders; each wallet validates the proposed exchange and requests approval before signing a shared Bitcoin transaction.

## Scope and status

- Target: direct and three-party atomic swaps on Bitcoin regtest, using BTC and two test RGB assets.
- Local AI inference, private keys and wallet state stay on the user's device.
- Fixed order amounts, full execution and explicit approval before signing.
- Public web interface, matching server, local wallet client and packaged macOS shell.

**Status:** Developer A's local QVAC, order review, deterministic matching, SQLite market, authenticated event stream, public marketplace and separate local wallet UI are implemented. Direct and three-party **matching** are tested. Real atomic Bitcoin/RGB settlement still requires developer B's adapter; mock mode cannot sign, broadcast or report blockchain success.

Hackathon resources and stack guidance are in [materials.md](materials.md).

## Run with Docker

From the repository root, with Docker Desktop / Docker Engine 25+ and Compose 2.20.2+ running:

```sh
docker compose up -d --build --wait
docker compose exec runtime node --import tsx apps/local-client/scripts/docker-pairing.ts
```

Open **http://127.0.0.1:5173/** for the public landing page or **http://127.0.0.1:5173/market** for open orders. By default, the second command displays one private real-mode profile at **http://127.0.0.1:4101/** and its pairing token. Open that profile's URL and enter its token there. The public site never asks for a pairing token. No `.env` setup is needed to see the site, but a working wallet RPC sidecar and its token are required for balances or trading.

`web` serves the public Vite build through Nginx. It can proxy only `GET /market-api/health` and `GET /market-api/orders`; the proxy strips incoming authentication headers, cookies, request bodies and queries. `runtime` supervises the market and one real-mode local client by default. That client serves its private wallet UI on the same origin as its API. Published ports bind to `127.0.0.1`; the market port is not published and remains available only on the Docker bridge. The Compose file retains loopback mappings for 4102/4103 for the opt-in mock demo, but those profiles are not started by default. Pairing/Origin/Host checks remain enabled. Missing wallet RPC credentials leave the real client visibly unavailable; they do not select a synthetic wallet. The retained telephony/Face ID utilities are not started.

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
```

The macOS package is written to `.dist/desktop/palka-darwin-arm64/palka.app`. A packaged launch loaded the local UI and the six-method `window.palkaWallet` bridge; real mode without B's RPC showed an unavailable wallet. The app keeps the market token, wallet RPC token and local API bearer in Electron's main process. Signing requires a fresh wallet preview and a native approval dialog showing amounts and fee. A `palka://offer/order-<UUID>` argument delivered to an already running second instance selected the offer for review and did not act on the trade. The macOS scheme is declared in the app bundle; delivery through LaunchServices `open` remains unverified. The public marketplace has no access to this bridge.

The default desktop config is **real** mode. On first launch the app creates `desktop-config.json` in its Electron user-data directory with owner-only permissions. Configure a market token that the market recognizes and B's loopback wallet RPC URL/token there; the file is reused across restarts. Environment variables `PALKA_OWNER_ID`, `PALKA_LOCAL_PORT`, `PALKA_MARKET_URL`, `PALKA_MARKET_TOKEN`, `PALKA_WALLET_RPC_URL`, `PALKA_WALLET_RPC_TOKEN`, `PALKA_WALLET_MODE`, and `PALKA_PUBLIC_MARKET_URL` can override those values for a run. The current repository does not provide B's sidecar. Until it exists and reports the required capabilities, the client shows an unavailable wallet and cannot trade. Use the browser-local `npm run dev:mock` path only for explicit synthetic demonstrations.

## Layout and integration

- `apps/web`: public React/Vite landing page and read-only market.
- `apps/market`: HTTP/WebSocket coordination, deterministic matcher and SQLite.
- `apps/local-client`: local wallet UI and same-origin loopback API, QVAC, private policies, approval state and wallet RPC client.
- `apps/desktop`: Electron main/preload bridge, local service launcher and macOS package script.
- `packages/contracts`: protocol v1 runtime schemas, exact BigInt quantities and synthetic JSON fixtures.
- `tools/telephony`, `tools/faceid`: retained earlier utilities, not used by the exchange or its local AI flow.

The old Expo `front/` directory was removed at the user's request. Root `node_modules/` contains shared workspace dependencies and is ignored by Git.

See [A handoff](docs/handoffs/a.md) for the complete adapter boundary and ports, [QVAC evidence](docs/handoffs/qvac-evidence.md) for actual inference checks, and [.env.example](.env.example) for local configuration names. The application does not automatically load the existing root `.env`. Never put private wallet state or pairing tokens in Git.

To connect B, start its loopback sidecar and configure a local profile with `WALLET_RPC_URL` and `WALLET_RPC_TOKEN`; real mode is already the default. Its declared capabilities must support the requested direct/ring swap. A's HTTP bridge is implemented and protocol-tested against a test double; a real B sidecar, its RGB codec and actual on-chain receipts are still missing. Unsupported rings are never replaced with sequential transfers.

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
