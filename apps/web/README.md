# Orbit web UI

React/Vite interface for the RGB P2P exchange. Start from the repository root with `npm run dev:web` and open `http://127.0.0.1:5173`.

The page starts in an explicitly marked example mode. Balances, orders, and trade diagrams there are illustrative; no blockchain settlement, wallet validation, or QVAC inference is claimed. To use a local client, enter its loopback URL (default `http://127.0.0.1:4101`) and pairing token in the connection dialog. The token stays in the tab's memory and is sent only to that loopback API.

The UI reads wallet state, market snapshot, and local policy from the local client. It sends a goal to local QVAC, exposes the resulting editable draft and local policy limits, validates before explicit order publication, and shows direct or three-party plans. The final approval button appears only after a real wallet validates an immutable settlement preview. A mock wallet has no signing action or simulated successful settlement. Unsupported direct/ring capability and rejection reasons are displayed in the trade view.

Run `npm run build` from the root (or `npm run typecheck -w @rgb-market/web`) to check this package. The local HTTP routes and shared types are defined in `apps/local-client` and `packages/contracts`; no secrets or wallet state are stored in browser storage.

Browser smoke on 2026-10-17: paired mock clients A, B, and C; local QVAC interpreted A's X → DUSD goal with a BTC-sale ban and fee cap; B and C submitted manual DUSD → BTC and BTC → X orders. The market matched a three-party ring and the trade page showed all three directed legs. Mock preparation returned explicit unsupported status; the sign action stayed disabled. At a 390px viewport there was no horizontal overflow (`scrollWidth = innerWidth = 390`), and the browser reported no page errors. Screenshots: `/private/tmp/rgb-market-ring-full.png` and `/private/tmp/rgb-market-mobile.png`. This verifies UI/matching flow, not RGB settlement.
