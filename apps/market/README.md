# Market coordinator

This service stores public orders and private trade plans in SQLite. It accepts only `regtest` orders for this MVP. It never holds wallet keys or approves a signature. Matching is deterministic: full-amount direct pairs first, then three-owner rings, each sorted by `createdAt` and order ID. All orders in a match move from `OPEN` to `RESERVED` inside one SQLite transaction. `TradePlan.orderRefs` refer to the resulting reservation revision (`1` for a new order). No RGB or BTC settlement is performed here.

Run from the repository root:

```sh
MARKET_TOKENS_JSON='{"local-token-a":"a","local-token-b":"b","local-token-c":"c"}' npm run dev:market
```

Defaults: `MARKET_HOST=127.0.0.1`, `MARKET_PORT=4100`, `MARKET_DB_PATH=./.state/market.sqlite`. Use distinct secret tokens outside a disposable local demo. The mapping is token to owner ID and stays on the server. Do not put the token in a browser URL or public repository.

HTTP:

- `GET /health` and `GET /orders` are public. The latter returns only open orders.
- `POST /orders` accepts a full contract `PublicOrder`, with caller-owned `ownerId`, unique client-generated `id`, `revision: 0`, and `status: "OPEN"`. The server verifies `Bearer` authorization, time bounds, and one active order per owner. Retrying the same ID with identical content returns the existing order; different content returns 409.
- `POST /orders/:id/cancel` accepts `{ "revision": 0 }` and requires the owner. Reserved orders cannot be cancelled through this endpoint.
- `GET /orders/:id` exposes open orders and allows owners to inspect their closed/reserved orders.
- `GET /snapshot?afterSequence=N` and `GET /trades/:id` require `Bearer` authorization. Snapshots include public open orders, the caller's orders and trades, and visible events after the cursor.
- `POST /trades/:id/messages` accepts a contract `CoordinationMessage` from a participant. Its `messageId` makes retries idempotent. A `package` message must contain a full `SettlementPackage` matching trade ID, network, plan revision and digest. A `signature` notice must refer to that package's ID and transaction/commitment digests. `broadcast` requires a real-mode receipt with a txid. One participant's receipt cannot close a trade. The coordinator marks it `CONFIRMED` and all reserved orders `FILLED` in one SQLite transaction only after every authenticated participant reports the same real txid with `state: "confirmed"`, `chainConfirmed: true`, and `rgbAccepted: true`. Conflicting txids retain reservations in `RECONCILING`.

WebSocket `/events` requires the first message `{ "type": "authenticate", "token": "...", "afterSequence": 0 }`. It replies with `{ "type": "snapshot", ...MarketSnapshot }`, then sends contract `EventEnvelope` messages. Trade plans and coordination messages are visible only to participants. The global event sequence can have gaps for a participant because other events are private.

`TradePlan.fees` currently carries each order's maximum fee, with `feeState: "estimate"`; it is a cap, not the final transaction fee. A rejection before a signature cancels all reserved orders. Once a signature notice has been accepted, or a client reports `{signatureMayExist:true}` after an uncertain signing outcome, rejection enters `RECONCILING` and the reservations remain locked for chain/input review. `CONFIRMED` is an aggregate of participant wallet reports; this server does not independently inspect Bitcoin or validate RGB consignments. Each local client still verifies its own wallet receipt. The wallet coordinator must construct one shared transaction, finalize fee allocation, validate RGB commitments and recipient state, collect separate approvals, and reconcile uncertain broadcast results. A reserved plan alone proves none of those steps. SQLite `node:sqlite` is experimental on Node 22; the pinned workspace Node version is used for the hackathon.
