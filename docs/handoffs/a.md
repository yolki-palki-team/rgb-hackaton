# Handoff A — protocol v1

Status: A implementation, automated checks and browser smoke complete, 17 October 2026. Actual local QVAC inference passed. This is the interface handoff to developer B, not a claim of working atomic RGB settlement.

## Ownership and files

A owns apps/web, apps/market, apps/local-client, apps/desktop, packages/contracts, root package.json/package-lock.json and this document. B owns packages/wallet, infra, scripts/demo and its handoff. B has not been spawned as a sub-agent. tools/telephony and tools/faceid are retained. The previous front/ directory was deleted on the user's explicit request.

Runtime schemas: `packages/contracts/src/index.ts`. Canonical plan SHA-256 helper: `packages/contracts/src/digest.ts`. Actual JSON fixtures: `packages/contracts/fixtures/{direct,ring,no-match}.json`. Fixture contract IDs are explicitly mock identifiers, not real RGB issuance. Replace them using adapter asset state for real integration.

ProtocolVersion = 1. All atomic quantities are canonical decimal strings in [0, 2^64-1]; order quantities positive. Dates are epoch milliseconds. PublicOrder includes createdAt. Asset identity is network + kind + contractId; verified precision must also match. Display symbols carry no authority. Matching is exact full fill, direct before 3-ring, oldest createdAt/id first. No LLM in matching.

## Wallet boundary for B review

`WalletAdapter` in the contracts module is the interface for the local client only. Capabilities explicitly describe real/mock mode and supported direct/ring/sign/broadcast. Unsupported must remain unsupported. A's mock supplies balances only and cannot sign, broadcast or issue a plausible transaction id.

A will connect to a native HTTP sidecar on loopback via `POST /rpc`, Authorization Bearer `WALLET_RPC_TOKEN`, JSON `{protocolVersion:1,requestId,method,params}`. Successful response `{protocolVersion:1,result}`; error `{protocolVersion:1,error:{code,message}}`. No private keys or seed in either direction.

| method | params | result |
| --- | --- | --- |
| capabilities | {} | WalletCapabilities |
| state | {} | WalletState |
| reserve | {plan} | {reservationId} |
| release | {tradeId} | null |
| prepare | {plan,materials:[{ownerId,material}]} | PrepareResult |
| validate | {package,plan} | WalletPreview |
| sign | {package,approval} | SignatureResult |
| finalize | {package,signatures:[{ownerId,signature}]} | Receipt |
| sync | {tradeId} | Receipt |

`SettlementPackage.format/payload` and cooperative material are deliberately codec-specific opaque transport. B must agree their concrete codec before real use. A does not invent RGB primitives. B independently derives/validates the immutable unsigned transaction digest and RGB commitment digest. Approval binds wallet/owner/network/trade/plan revision/plan digest/package ID/unsignedTxDigest/commitmentDigest; foreign PSBT signatures must not invalidate those immutable digests. Final transaction fees must be checked again. All cryptographic validation, reserve safety, durable signature recovery and broadcast authority belong in B.

`WalletState.balances[].amount` means total confirmed owned units, including this wallet's own reserved units; do not subtract a reservation twice. B enforces spendability and input reservation internally. WalletPreview.balancesAfter must account for every existing asset, including untouched RGB allocations, plus the full BTC fee. Public order metadata is never authority for a contract ID or precision.

This is A's v1 proposal pending B's codec/adapter acceptance. Do not silently change v1. Breaking changes require a new protocol version and explicit migration here. The sidecar transport can be replaced by a confirmed adapter export after agreement.

## HTTP and startup

Root dependencies are pinned. `npm ci` provisions a local Node 22.17 runtime for npm scripts; host Node 22.13 is too old for current QVAC. `npm run dev:market` listens on 127.0.0.1:4100; `npm run dev:local` on 127.0.0.1:4101; `npm run dev:web` on 127.0.0.1:5173. Profiles B/C use ports 4102/4103 and separate state directories/tokens. `npm run build` builds both public and local UIs; `npm run dev:mock` builds the local UI before starting the demo.

Market config: `MARKET_PORT`, `MARKET_DB_PATH`, `MARKET_TOKENS_JSON` mapping token to ownerId. Local config: `LOCAL_PORT`, `LOCAL_OWNER_ID`, `LOCAL_SESSION_TOKEN`, `LOCAL_STATE_DIR`, `LOCAL_ALLOWED_ORIGINS`, `MARKET_URL`, `MARKET_TOKEN`, `WALLET_MODE=mock|real`, `WALLET_RPC_URL`, `WALLET_RPC_TOKEN`. `npm run dev:mock` generates isolated local tokens/state and starts the complete A stack with three mock wallets and real QVAC. It prints the private pairing-file path. Never reuse production credentials from the existing .env; no automatic root .env loading.

Market accepts authenticated full PublicOrder at POST /orders, with client idempotency ID. Ownership comes from token and must match order. GET /snapshot?afterSequence=N returns public orders, own orders, own trades, authorized events, current sequence. WS /events takes `{type:'authenticate',token,afterSequence}` as first message, never a token in URL. New messages/events cannot grant signing authority.

The public site at `http://127.0.0.1:5173/` has a landing page and `/market` read-only order book. It calls only `GET /market-api/health` and `GET /market-api/orders`; Nginx exposes those exact paths and strips incoming authentication headers, cookies, bodies and queries before proxying. It has no pairing, wallet balance, private policy, matched trade, QVAC or signing UI. The landing hero uses a shadcn-style component under `apps/web/src/components/ui/` via `@/`, Tailwind v4, Lucide and local images; its 21st MIT source was supplied by the user.

### Native client integration checkpoint

The new desktop client is an additional delivery target; the older browser-local demo is not proof of a packaged client. A's required user flow remains local QVAC interpretation → editable draft → deterministic policy validation → a separate explicit publication action. The desktop default must request a real wallet and show a blocking error if the B sidecar is unavailable. Synthetic balances and mock settlement may appear only in an explicitly selected demo mode. Neither a matched order nor a public-site click authorizes preparation, signing or broadcast.

The Electron bridge keeps wallet/market service tokens and connection settings in the main process. The renderer gets only narrow `window.palkaWallet` methods (`connect`, allowlisted `request`, native-confirmed `approveTrade`, pending-offer notification and a fixed public-market opener); secrets must not enter URL/query/hash or renderer logs. `palka://offer/order-<UUID>` carries only a published order ID and selects an offer for review. The local service and desktop config default to real mode; desktop creates a private `desktop-config.json` with mode 0600 under Electron user data and reuses it after restart. Packaged UI is served from `palka-app://local/` with a restrictive CSP. The macOS build produced `.dist/desktop/palka-darwin-arm64/palka.app`; its Info.plist declares bundle ID `com.palka.desktop` and URL scheme `palka`. The packaged app launched the local UI with title **palka — Local wallet** and only the six-method bridge; real mode without B's RPC returned a safe unavailable state. An isolated config file remained mode 0600 with unchanged modification time across restart. A second-instance `palka://offer/order-<UUID>` argument selected the offer and the UI said this does not act on the trade. OS LaunchServices `open` delivery was not proven. These are client integration results, not a claim that native signing or RGB settlement works.

Independent checks for this checkpoint: `apps/desktop/test/security-boundary.test.ts` passes with real UUID-shaped offer/trade IDs and rejects credentials in deep links, dot/path traversal and generic signing IPC routes. A browser check of the local UI without a running backend showed no initial asset quantities or orders, an unavailable network and disabled order preparation. Synthetic BTC/X/DUSD balances appeared only after clicking **Preview sample data**, with a disconnected warning and preparation still disabled. In that preview, the direct card showed A giving 100,000 sats to B and receiving 100 DUSD; the ring card showed A→C 100 X, B→A 100 DUSD, C→B 100,000 sats. These quantities/directions match `packages/contracts/fixtures/{direct,ring}.json`. Both cards said **Sample plan** and had a disabled **Signing unavailable** button; the ring card explicitly stated that sequential transfers are not an atomic swap. This confirms visible fixture presentation and the offline/mock boundary in the renderer, not a live wallet or native Electron launch.

In a separate explicitly mock packaged profile, local QVAC loaded `QWEN3_1_7B_INST_Q4`. A synthetic goal to give 100 X for at least 100 DUSD with fee cap 1,000 sats and no BTC sale produced a reviewable draft in 1,056 ms; `/api/draft/validate` returned `{valid:true}`. That smoke did not publish an order or exercise signing.

Each local client serves its own private UI and `/api/*` from the same loopback origin (`http://127.0.0.1:4101/`, `:4102/`, `:4103/`). The browser enters the pairing token only there. Every private API request requires its bearer token, a valid local Host and port, and its own exact Origin when one is present; cross-site Fetch Metadata is rejected. Origin-less same-origin browser GETs and native calls can use the bearer with those Host checks. `LOCAL_ALLOWED_ORIGINS` defaults to that client's own localhost/127.0.0.1 port, not the public site's port. `LOCAL_HOST=0.0.0.0` is an explicit container option; accepted HTTP Host values remain localhost/127.0.0.1.

Docker: root `compose.yaml` / `Dockerfile` build a non-root runtime and a static web container. The runtime holds the market and, by default, only a real-mode profile A on 4101. No B sidecar is launched; missing wallet RPC credentials produce a visible unavailable state, never a mock fallback. `PALKA_DEMO_MODE=true` explicitly starts synthetic A/B/C on 4101–4103 and preloads QVAC once. The real-default path defers model loading until actual use. Market port 4100 is reachable on the Docker bridge for the restricted public proxy but is not published on the host. Compose publishes profile and web ports on host loopback. `.state/docker/pairing.json` and SQLite files persist in `exchange-state`; QVAC cache persists in `qvac-models`. Real profile state uses `.state/docker/real-A`, separate from existing demo A/B/C directories. Legacy pairing metadata is migrated without rotating tokens. Unexpected child exit stops the supervisor so Compose can restart the runtime. `docker compose up -d --build --wait` starts the real-default path; see README for the opt-in demo command and pairing. Periodic health checks do not load the model. Previous Linux arm64 and matching evidence in qvac-evidence.md applied to the older demo-only runner; the new default needs its own Docker launch evidence.

## Integration status / needs from B

No packages/wallet, infra or B handoff was present when A began. Please provide sidecar entry point, supported codecs, true capabilities and setup/funding instructions in docs/handoffs/b.md. Real direct/ring execution and recipient acceptance cannot be certified from the A mock. A will connect to supplied capabilities without replacing a ring with sequential transfers.

## Coordination and approval details fixed for v1

- Reservation increments each participating PublicOrder revision from 0 to 1; TradePlan.orderRefs contain the reserved revision. Plan revision starts at 0. Public publication retries use the same client-generated id and exact original body.
- The initial `fees` array contains each order's maximum, with `feeState=estimate`. B derives actual fees from the final transaction and returns them in WalletPreview; A checks each against the confirmed order/policy and recomputes exact BTC deltas. No fee is deducted from a RGB leg.
- `POST /trades/:id/messages` accepts CoordinationMessage. `prepare.payload={material}`; `package.payload=SettlementPackage`; `signature.payload={packageId,unsignedTxDigest,commitmentDigest,signatureMayExist:true}` is a durable signing intent, acknowledged by the market **before** wallet.sign. The later signature message contains the same three binding fields plus opaque `signature`. Signing intent is never counted as an actual signature.
- `reject.payload={reason,signatureMayExist}` preserves all reservations if a signature may exist. Once any participant has begun signing, rejection cannot free the ring through TTL or cancellation. B must reconcile/invalidate inputs before any safe release.
- `broadcast.payload` and `receipt.payload` are Receipt. Market marks CONFIRMED and orders FILLED only after all participant reports name the same real txid and each reports chain confirmation plus RGB acceptance. This is aggregation of authenticated wallet reports, not independent server-side chain validation. The UI offers an explicit local wallet sync and displays chain/RGB results separately.
- `SettlementPackage.format/payload` remains subject to B's codec agreement; the local client performs no RGB signing or proof construction. SDK batching has not been presented as atomic ring capability.

## Actual checks and open integration boundary

The earlier A checkpoint recorded `npm test` (39 tests), `npm run typecheck` and `npm run build` passing before the public/local UI split. Vite is pinned to 6.4.4. Those tests exercised the real HTTP/WebSocket market, local pairing/Origin checks, three local mock profiles matching one ring, rejected settlement in mock, v1 wallet HTTP serialization, stale approval, and persistence of uncertain signature state across a local restart. Synthetic wallets and RPC doubles are explicitly test-only.

`npm run smoke:qvac` performs genuine local QVAC inference; see qvac-evidence.md for pinned versions, the synthetic goal, output checks and known model limitations. The earlier browser smoke passed before the public/local UI split: three paired local profiles; genuine QVAC draft for A; manual B/C orders; one three-participant ring; explicit mock UNSUPPORTED and signing disabled. Mobile width 390 px had no horizontal overflow and browser error collection was empty. Screenshots were saved in /private/tmp/rgb-market-ring-full.png and /private/tmp/rgb-market-mobile.png. These are historical matching/UI evidence, not verification of the new public site or real settlement.

Still absent: B's sidecar/codec, real RGB asset IDs and balances, cooperative direct/ring preparation, actual Bitcoin signatures/broadcast and receiver consignment acceptance. No A-only test establishes those capabilities. The bridge fails visibly if the configured sidecar is unavailable; it does not silently switch real mode to mock.
