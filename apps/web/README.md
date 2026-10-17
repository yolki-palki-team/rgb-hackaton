# palka public web UI

React/Vite public site for the RGB A2A exchange. Start it from the repository root with `npm run dev:web`, then open `http://127.0.0.1:5173/` for the landing page or `http://127.0.0.1:5173/market` for open orders. The order book is read-only; it shows public exchange intent, not wallet balances, private policy, matched trade details or signing controls.

The browser calls only `GET /market-api/health` and `GET /market-api/orders`. In Docker, Nginx proxies those exact paths to the market over the private bridge and strips incoming authentication headers, cookies, bodies and queries. Other market and local-client APIs are not exposed by this site. The market port is not published by Compose.

Each wallet profile has a separate local UI and API at `http://127.0.0.1:4101/`, `http://127.0.0.1:4102/` or `http://127.0.0.1:4103/`. The public site's **Local wallet** link opens profile A on port 4101 in a new tab; users of B or C open their own URL from the pairing output. Enter the pairing token only on that local page. It remains in that tab's memory, and local API calls use the page's own loopback origin. QVAC goals, balances, private limits, trade validation and approval are handled there. The public site never receives the token or private wallet state.

The landing hero uses a shadcn-style component under `apps/web/src/components/ui/`, imported through `@/`. Its design uses Tailwind v4, Lucide icons and local image assets. The 21st component source was supplied by the user under an MIT license. `npm run build` at the repository root builds both the public and local UIs; `npm run build:web` builds this site alone.

The landing page uses the user-selected Velorah hero layout with the user-selected Prisma background video, centered palka copy and glass navigation, followed by the black footer. The MP4 and poster are local assets; no HLS dependency or remote media request is required. Playback pauses offscreen and for reduced motion, and a visible play/pause control permits manual playback. The imported template archive was moved out of the app source after adaptation; attribution and its MIT license remain in `public/hero/`.

An earlier browser smoke on 2026-10-17 verified the matching flow with paired mock clients A/B/C, actual local QVAC interpretation for A, manual B/C orders, a three-party ring, explicit unsupported mock preparation and disabled signing. It also checked a 390px viewport without horizontal overflow or page errors. That smoke predates the public/local UI separation and does not verify the new public site or real RGB settlement. Screenshots from that run are `/private/tmp/rgb-market-ring-full.png` and `/private/tmp/rgb-market-mobile.png`.


## Footer and catalog shortlist

`src/components/ui/halftone-wordmark-footer.tsx` renders the user-selected halftone palka footer on both public pages. It uses React and Canvas 2D only, has no remote assets, and preserves real links when canvas is unavailable. Pointer motion is disabled for reduced motion; hidden/offscreen animation sleeps.

See [21st component shortlist](21st-components.md) for the additional search, empty-state and stepper candidates, and `.21st/design.json` for the selected visual direction. The registry CLI requires authentication here; supplied component source was integrated directly. The optional `21st review` command was blocked by automatic approval review because it may upload project source; validation was performed locally instead.
