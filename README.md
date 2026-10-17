# RGB P2P Exchange

A non-custodial P2P marketplace for BTC and RGB assets, supporting direct swaps between two users and atomic ring swaps between three users.

Users describe their goals in plain language. An on-device QVAC assistant turns those goals and private preferences into orders for users to review. A deterministic matching engine finds compatible orders; each wallet validates the proposed exchange and requests approval before signing a shared Bitcoin transaction.

## MVP

- Direct and three-party swaps on Bitcoin regtest, using BTC and two test RGB assets.
- Local AI inference, private keys and wallet state stay on the user's device.
- Fixed order amounts, full execution and explicit approval before signing.
- Web interface, matching server and local wallet client.

**Status:** Developer A's local QVAC, order review, deterministic matching, SQLite market, authenticated event stream and web UI are implemented. Direct and three-party **matching** are tested. Real atomic Bitcoin/RGB settlement still requires developer B's adapter; mock mode cannot sign, broadcast or report blockchain success.

Hackathon resources and stack guidance are in [materials.md](materials.md).

## Run with Docker

From the repository root, with Docker Desktop / Docker Engine 25+ and Compose 2.20.2+ running:

```sh
docker compose up -d --build --wait
docker compose exec runtime node --import tsx apps/local-client/scripts/docker-pairing.ts
```

Open **http://127.0.0.1:5173**. The second command displays the URL and pairing token for each profile A/B/C; enter the chosen pair in the interface. No `.env` setup is needed. Existing host credentials and `node_modules` are excluded from the build and are not mounted into containers.

`web` serves the production Vite build through Nginx. `runtime` supervises the market and three local clients, each with its own SQLite state and authentication. All published ports bind to `127.0.0.1`; the market remains private inside `runtime`. Pairing/Origin/Host checks remain enabled. This is a local demo with **mock wallets and real QVAC**, not three independent wallet devices. The missing B adapter, Bitcoin/RGB settlement and the retained telephony/Face ID utilities are not started.

Named volumes keep the databases, generated tokens and QVAC model cache across container rebuilds and restarts. On first startup, one process downloads about 1.06 GB of weights and checks model loading before the three profiles start, avoiding simultaneous downloads into the shared cache. Subsequent startups reuse the cache. Each profile loads the prepared model on its first AI use; its readiness is shown in the UI. Docker runs Linux CPU inference; the native macOS Metal path is available through `npm run dev:mock` instead. The setup is intended for Docker with at least 8 GB of memory; inference speed depends on available CPUs.

```sh
docker compose ps
docker compose logs --tail=100 runtime
docker compose restart runtime
docker compose down
```

`down` stops/removes containers but preserves volumes. Do not add `--volumes` if you need to keep the demo state. To explicitly test local model inference inside the running container: `docker compose exec runtime npm run smoke:qvac`.

## Run the local demo

```sh
npm ci
npm run dev:mock
```

Open **http://127.0.0.1:5173**. The runner starts the market on port 4100 and local profiles A/B/C on 4101/4102/4103. It prints the path to a private `.state/mock-*/pairing.json` file: enter the profile's local URL and `sessionToken` in the interface. The token stays in browser memory; seed/private keys are never sent to the browser. Each invocation creates separate demo state. Stop the runner with Ctrl+C.

`mock` applies to the wallet: its labeled balances are synthetic. The market, SQLite persistence, HTTP/WebSocket authorization and QVAC inference are real. Preparing a mock trade returns `UNSUPPORTED`, without a fake transaction ID. Three profiles on this machine are a demonstration, not three independent devices.

QVAC uses **@qvac/sdk 0.21.1**, **QWEN3_1_7B_INST_Q4**, and a local Node 22.17 runtime installed with the workspace. First use downloads about 1.06 GB of public model weights; subsequent inference is local. No model API key or cloud fallback is used. A failed/ambiguous extraction leaves a manual form. Percentage constraints need particular care: the model can misread them, so invalid interpretations are rejected and all drafts require review.

Example goal: `Продать 100 X за минимум 100 DUSD. Комиссия до 1000 sats. BTC не продавать.` The order form displays **atomic units** (BTC in sats); X and test DUSD have precision 0 in the mock. DUSD is not USDT or a backed dollar.

For the ring, confirm these three independent orders, allowing BTC sale only for C:

| Profile | Gives | Receives at least |
| --- | --- | --- |
| A | 100 X | 100 DUSD |
| B | 100 DUSD | 100000 sats |
| C | 100000 sats | 100 X |

Confirming an order authorizes matching only. Signing has a separate final wallet-validated preview and approval. Real mode retains reservations after a signing attempt or an uncertain broadcast; expiry is not permission to reuse the funds.

## Layout and integration

- `apps/web`: React/Vite interface.
- `apps/market`: HTTP/WebSocket coordination, deterministic matcher and SQLite.
- `apps/local-client`: loopback API, QVAC, private policies, approval state and wallet RPC client.
- `packages/contracts`: protocol v1 runtime schemas, exact BigInt quantities and synthetic JSON fixtures.
- `tools/telephony`, `tools/faceid`: retained earlier utilities, not used by the exchange or its local AI flow.

The old Expo `front/` directory was removed at the user's request. Root `node_modules/` contains shared workspace dependencies and is ignored by Git.

See [A handoff](docs/handoffs/a.md) for the complete adapter boundary and ports, [QVAC evidence](docs/handoffs/qvac-evidence.md) for actual inference checks, and [.env.example](.env.example) for local configuration names. The application does not automatically load the existing root `.env`. Never put private wallet state or pairing tokens in Git.

To connect B, start its loopback sidecar and configure a local profile with `WALLET_MODE=real`, `WALLET_RPC_URL` and `WALLET_RPC_TOKEN`. Its declared capabilities must support the requested direct/ring swap. A's HTTP bridge is implemented and protocol-tested against a test double; a real B sidecar, its RGB codec and actual on-chain receipts are still missing. Unsupported rings are never replaced with sequential transfers.

## Checks

```sh
npm test
npm run typecheck
npm run build
npm run smoke:qvac
```

Tests cover exact amounts/limits, direct/ring/no-match, ownership, revisions, expiration, double reservation, event replay/access, local Origin/pairing, rejected AI JSON, stale final previews and recovery after uncertain signature delivery. The QVAC smoke performs actual local inference and prints only synthetic test output and runtime diagnostics. Wallet test doubles prove boundary behavior, not atomic RGB settlement.

The root documentation, initial ideas and retained utilities predate the exchange implementation. A's workspace code was created during this development session on 17 October 2026; no Git history rewrite or deployment was performed.
