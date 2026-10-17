# palka: startup, trading, and cloud test preparation

Current for the October 17, 2026 integration. This is a regtest prototype with real
Bitcoin/RGB signatures, not a mainnet wallet. Public market, local client, and
`packages/wallet/server.py` are already connected. Older handoff sections that
say the sidecar is missing describe earlier development stages.

## What runs where

| Component | Location | Data |
| --- | --- | --- |
| Public web | Local or static HTTPS hosting | Only open orders, contract IDs, and local client links |
| Market/coordinator | Shared server | Orders, matching, participant messages, settlement packages, signatures, SQLite |
| Local client and wallet UI | Each participant's computer | Private policy, pairing, approvals, persisted signing authorization |
| Desktop | Each participant's computer | Launches local client; secrets stay in the main process; separate native dialog |
| Wallet sidecar + Rust RGB backend | Each participant's computer | Keys, BTC/RGB state, journal, consignments, reservations, and signing |
| QVAC | Each participant's computer | Local model and inference; no cloud fallback |
| Bitcoin Core/electrs/RGB proxy | Docker in the local test | Shared regtest chain and indexer; infrastructure separate from market |

Market does not store seeds, policies, or complete balances, but it sees public
trade materials and RGB proofs. Transactions are not private from the coordinator.
Publishing an order or opening a deep link never automatically authorizes signing.

## Requirements and build

Work from the repository root. You need RTK, Docker with Compose, Node 22.17,
Python 3.12+ with uv, and Rust 1.94 with rustfmt/Clippy on PATH. `.nvmrc` and
`rust-toolchain.toml` pin versions; npm installs its own Node for scripts.

```sh
rtk proxy npm ci
rtk proxy uv sync --locked
rtk proxy uv run --locked python scripts/demo/bootstrap-native.py
rtk proxy cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
rtk proxy npm run build
rtk proxy npm run build:desktop
```

Bootstrap materializes the pinned rgb-lib and reviewed local cooperative extension.
When updating the extension, use `bootstrap-native.py --refresh`, then repeat the
cargo build. This does not create or fund a wallet. QVAC downloads approximately
1.06 GB on first load; subsequent inference is local. The UI shows model readiness;
the manual form works independently.

## Infrastructure: initial setup and restarts

On a **new** machine without a previous chain:

```sh
rtk proxy docker compose -f infra/compose.yaml up -d
rtk proxy uv run --locked python scripts/demo/chain-volumes.py pin
```

For an existing chain, run `pin` first if not already done; it records existing
volume names without recreating them. For subsequent launches:

```sh
rtk proxy docker compose -f infra/compose.yaml -f infra/state/chain-volumes.compose.json up -d
rtk proxy uv run --locked python scripts/demo/chain-volumes.py verify
rtk proxy uv run --locked python scripts/demo/doctor.py
```

After a cold start, wait for doctor to succeed. Preserve containers and volumes;
do not apply `down -v`, prune, or a new chain to old RGB state. Root `compose.yaml`
is a different mode: web + runtime, without the wallet sidecar. For real swaps,
use the host launcher below instead of the root Docker quickstart.

## Creating the first test set

Choose a persistent directory under the ignored `packages/wallet/state`.
Run the following **once for a new set**, not on every launch. This example creates
Alice/Bob/Carol on one computer with independent keys.

```sh
export RGB_DEMO_STATE="$PWD/packages/wallet/state/my-direct"
rtk proxy uv run --locked python scripts/demo/regtest.py setup
rtk proxy uv run --locked python scripts/demo/catalog.py
rtk proxy uv run --locked python scripts/demo/service-profile.py configure --source "$PWD" --base-port 44100
```

`setup` creates keys, funds through regtest coinbase, waits for maturity, and issues
100 X + 7 KEEP to Alice and 100 DUSD to Bob. Carol has BTC. `catalog` imports verified
public contracts for all participants, including assets with zero balances.
DUSD is not dollar-backed and is not USDT. All test RGB assets have precision 0.
IDs come from real state; matching tickers do not imply matching contracts.
Do not copy IDs from mock fixtures or another test set.

`services/config.json` (0600) stores stable tokens and ports. You cannot arbitrarily
change source/base-port for an already configured set: the launcher will refuse.
`RGB_SERVICE_SOURCE` allows testing a new checkout against an existing set; it is
not a wallet migration. Keep configs, journals, pairing files, and backups out of Git.

## Normal startup without reinitialization

Set **the same** `RGB_DEMO_STATE` in each new terminal:

```sh
export RGB_DEMO_STATE="$PWD/packages/wallet/state/my-direct"
rtk proxy uv run --locked python scripts/demo/service-profile.py up
```

One command starts market, three sidecars, three local clients, and public Vite web.
It does not initialize, fund, or issue assets. Ctrl+C stops child processes while
preserving data. Restarting reuses the same keys, tokens, and SQLite databases.
Do not start a second instance against the same set.

| Purpose | Address with base-port 44100 |
| --- | --- |
| Public web / market | `http://127.0.0.1:5173/` / `/market` |
| Coordinator | `http://127.0.0.1:44100` |
| Alice / Bob / Carol browser wallet | `http://127.0.0.1:44101/`, `:44102/`, `:44103/` |
| Their wallet RPC | `127.0.0.1:44111–44113`, server-to-server only |

The launcher prints paths to `services/{profile}/pairing.json`. Open the file
locally, copy only `sessionToken`, click **Pair local wallet** on the corresponding
profile's page, and enter it there. Do not enter it on public web or send it to a
chat. The tab stores it only in memory; pair again after reloading. The browser
never needs the wallet RPC token.

Public web receives `MARKET_URL` and `VITE_LOCAL_WALLET_PORT` from the launcher;
all browser wallet links point to Alice in that set. Open Bob/Carol at their own
addresses. Check the full contract ID in the public order and native signing
dialog; the asset selector uses the verified wallet catalog, and validation rejects
ambiguous tickers.

For desktop Alice, stop the browser runner and run:

```sh
rtk proxy uv run --locked python scripts/demo/service-profile.py up --desktop alice
```

You can select `bob` or `carol`. Electron starts for the chosen participant instead
of a second browser local client. `PALKA_LOCAL_STATE_DIR` points it at the same local
history, so switching preserves policy/approval/recovery. Desktop connects without
manual pairing; its local API uses a separate session token in the main process.
Do not reuse browser pairing for the desktop API. Open the desktop window or an
offer deep link; browser wallet links are intended for browser mode. The other two
profiles remain in the browser.

Separate processes for diagnostics: `service-profile.py market`,
`service-profile.py run --profile bob`, `service-profile.py health --profile bob`.
Do not run these alongside `up` for the same profile. Standalone desktop commands
`npm run dev:desktop` and `npm run package:desktop` require separate
`desktop-config.json` configuration and do not start sidecars themselves.

## Orders: QVAC or the manual form

In Overview, enter a goal such as `Sell 100 X for at least 100 DUSD. Fee up to
1000 sats. Do not sell BTC.` Click **Prepare order** and review the result.
QVAC does not determine signing amounts: deterministic code revalidates the draft,
balances, protected reserves, allowed assets, fee cap, and expiry. If the response
is ambiguous or the model is unavailable, use **Fill in manually**.
In an initial check, the model inverted DUSD → X into X → DUSD; code rejected the
draft because the sender had no X. With sufficient balance, the user must catch
this error during review: AI is not the authority for intent.
After switching to short internal aliases, a real check passed with
`Sell 10 X for at least 10 DUSD. Maximum fee 1000 sats. Do not sell BTC. No protected balances or reserves.`
Use that final clarification only when you truly intend no new reserves; it does
not override an existing private policy.

Amount fields use **atomic units**: sats for BTC and contract units for RGB.
100000 sats = 0.001 BTC. Explicitly allow BTC sales in private policy only when the
order gives BTC. Each party's fee cap is 1000 sats; these tests pay 1000 sats total
for the entire trade. **Publish order** validates the draft, then publishes it.
No separate validation click is needed; trade signing is requested later.

Direct swap on the initial set:

| Participant | Give | Receive at least | BTC sale |
| --- | --- | --- | --- |
| Alice | 100000 sats BTC | 100 DUSD | Yes |
| Bob | 100 DUSD | 100000 sats BTC | No |

For a ring, create a **separate initial set** `my-ring`, for example at base-port
44200, using the setup/catalog/configure commands above. Do not assume assets
still belong to their original owners after a direct swap.

| Participant | Give | Receive at least | BTC sale |
| --- | --- | --- | --- |
| Alice | 100 X | 100 DUSD | No |
| Bob | 100 DUSD | 100000 sats BTC | No |
| Carol | 100000 sats BTC | 100 X | Yes |

Matching looks for direct swaps first, then three-party cycles; orders fill in full.
Ring directions: Alice → Carol X, Bob → Alice DUSD, Carol → Bob BTC.
This is **one shared Bitcoin transaction** with a shared RGB commitment, not three transfers.

## Preparation, approval, and results

1. After matching, the UI automatically prepares and validates the package for each
   participant. Keep all participants' apps open. **Trade** shows a loader and the
   stages Prepare → Your approval → All wallets → Confirmation. funding → colored
   → proofs proceed without repeated clicks. Work continues on Overview/Market;
   closing the app stops the UI loop, which resumes when the app opens again.
2. After wallet validation, exact Give, Receive, fee, and BTC change amounts appear.
   Check them and click **Review & sign**. Desktop opens a native dialog with the
   network, amounts, and RGB contract ID. Automatic requests do not authorize
   signing. Canceling the native dialog returns to trade review.
3. Each participant approves signing separately. The first approval does not sign
   for anyone else. Do not replace the package after the first signature.
4. After all signatures, the sidecar broadcasts the shared transaction. Regtest
   does not mine automatically. The test operator confirms it with a block
   (`regtest-miner` is created by setup):

```sh
rtk proxy docker compose -f infra/compose.yaml exec -T -u blits bitcoind bitcoin-cli -regtest -rpcwallet=regtest-miner -generate 1
```

If the miner is not loaded after a Core restart, load the existing wallet once:

```sh
rtk proxy docker compose -f infra/compose.yaml exec -T -u blits bitcoind bitcoin-cli -regtest loadwallet regtest-miner
```

5. Apps check Bitcoin confirmation and RGB acceptance themselves. Market marks
   CONFIRMED after receiving matching receipts from all parties. After restarting,
   the UI reads its saved local receipt; market status alone does not prove
   completion. **Transaction details** shows the txid and plan ID.

## Recovery and common errors

- Lost signing/broadcast response: the UI reads the saved local intent and starts
  recovery for the same trade. Local client retries only the saved, immutable
  authorization/signature/finalization. TTL does not release signed inputs.
- Preparation/validation requests run sequentially. Errors increase the delay;
  after three failures the automatic action pauses. Open **What happened?**, fix
  the cause, and click **Try again**. Waiting for a peer or block is not an error.
  The network snapshot continues updating.
- During a temporary `/state` failure, new orders and signing are disabled, but
  recovery continues. If connectivity is lost entirely, the last screen remains
  with a warning; actions using stale balances are blocked.
- Before signing, you can **Cancel swap**. Peers that have not signed release their
  reservations on the next snapshot/restart. After a possible signature, do not
  delete the journal, release reservations manually, or create a new trade instead
  of recovering the existing one.
- Wallet unavailable: check the selected state, running sidecar, matching
  owner/token/port, and doctor. Mock is not enabled automatically.
- Pairing/Origin/Host: use that profile's exact `http://127.0.0.1:PORT/`.
  Public origins and another computer's IP are not valid for wallet API access.
- EADDRINUSE: stop your previous runner; do not delete state. Port 5173 is shared
  by one public web instance, so two simultaneous `up` commands conflict there.
- Contract mismatch / no match: compare network + contract ID + precision,
  amounts, and expiry. The same ticker in different sets does not match.
- Process killed with `rgb_runtime.lock`: stop the profile first. Only then use
  `recover-sdk-lock.py --profile NAME` with the correct state; it checks project
  locks/identity/SQL-stock. It does not repair a damaged database.
- Backup: with the coordinator stopped, run `backup.py` against the same state.
  Backups contain secrets, are unencrypted, and stay locally in ignored state.
  A seed without RGB history is insufficient; chain volumes are backed up separately.

## Automated real scenarios

On a **new, separately prepared** set after setup/catalog, with no runner using
its ports:

```sh
rtk proxy uv run --locked python scripts/demo/service-smoke.py --source "$PWD" --base-port 44300 --scenario direct --repeat --evidence-prefix my-integration
```

For a separate ring set, change base-port and use `--scenario ring`. The script
uses real local-client/market/wallet APIs, explicitly approves test orders and
signatures, mines, verifies actual balance deltas and RGB acceptance, restarts
profiles, and spends received RGB back. `--evidence-prefix` stores new results
separately from historical evidence. This is service evidence, not UI clicks or
an AI scenario. Do not rerun it against an unfinished signed trade.

```sh
rtk proxy npm run check
rtk proxy npm run smoke:qvac
```

`check` includes formatting, lint, typecheck, JS/Python unit tests, and UI builds.
It does not include real transfers, native dialogs, or QVAC inference. Integration
results and exact limitations for this branch: [integration.md](integration.md).

## Cloud and multiple computers

For the initial server-only launch, use [deploy/README.md](../deploy/README.md):
Compose, automatic desktop registration, persistent tokens, and update commands
are already in Git. The default HTTP profile runs web + market with private market
access through an SSH tunnel. For direct HTTPS/WSS access, follow the separate
[owlpeer.com HTTPS instructions](../deploy/HTTPS.md). Distributed Bitcoin/RGB
infrastructure remains a separate step described below.

Public web and market can run in the cloud. Local client, QVAC, sidecar, keys,
private policy, and wallet state must remain **on each participant's computer**.
Do not present the entire root Compose stack as a cloud architecture: its runtime
also launches a local wallet. Never expose wallet RPC or pairing/API bearer credentials.

Available in code: `MARKET_HOST`, `MARKET_PORT`, `MARKET_DB_PATH`, the static
`MARKET_TOKENS_JSON` map (token → owner) for legacy profiles, and new registration
through `POST /participants` when `MARKET_SELF_REGISTRATION=true`. Local client
accepts `MARKET_URL` and `MARKET_TOKEN`; HTTPS automatically becomes WSS for `/events`.
Desktop accepts `PALKA_MARKET_URL=https://market.example.org` (root origin without
path/query) and `PALKA_PUBLIC_MARKET_URL=https://palka.example.org/market`.
A new desktop saves its ID and token in private `desktop-config.json` before
connecting. Restarts reuse those credentials; existing configs are not rewritten.
`PALKA_OWNER_ID` and `PALKA_MARKET_TOKEN` support manual connection of an existing
profile. Registration does not create or fund a wallet sidecar. The WebSocket
token is sent in the first message, not the URL. Public web never receives credentials.

Cloud deployment checklist (multi-computer settlement remains unverified):

1. Use one Node 22.17 server with persistent SQLite storage, a process supervisor,
   a separate market origin, and a TLS reverse proxy. Enable new desktop
   registration and retain the old credential map for existing wallets. The
   server stores hashes of new tokens; IDs are deterministically tied to tokens.
   There is no token refresh/revocation UI or proof of Bitcoin key ownership at
   registration. Registration is limited to 60 new participants per minute and
   10000 total. Before a public launch, add general API rate limits, connection
   limits, logging without credentials, and operational backups.
2. Start `npm run dev:market` with `MARKET_HOST=127.0.0.1`, the chosen port,
   `MARKET_DB_PATH`, `MARKET_SELF_REGISTRATION=true`, and, if needed, the original
   `MARKET_TOKENS_JSON` from the private service environment. Expose only the TLS
   reverse proxy. Proxy HTTP API and `/events`, preserving Authorization; WS needs
   HTTP/1.1, Upgrade, and Connection. Example snippet:

```nginx
location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

   This belongs inside a TLS server block; configure certificates and firewall
   separately. The client supports reconnect/replay. See the [official Nginx WS
   guide](https://nginx.org/en/docs/http/websocket.html).
3. Run `npm run build:web` and serve `apps/web/dist` from static HTTPS hosting with
   an SPA fallback. Configure **only** `/market-api/health` and `/market-api/orders`
   as read-only proxies to the shared market, without Authorization/cookies/query/body,
   following `docker/nginx.conf`. Do not proxy private market API through these
   public paths. `VITE_LOCAL_WALLET_PORT` is set at build time, usually to 4101.
4. Run local client/desktop and sidecar separately on each computer, setting the
   market URL; new desktops receive a persistent identity automatically. Configure
   sidecar separately with the same owner ID; do not change an existing wallet's
   owner. `service-profile.py up` is a single-host fixture launcher, not a
   distributed provisioner. For cloud access, use `LOCAL_OWNER_ID`,
   `LOCAL_STATE_DIR`, `LOCAL_PORT`, `MARKET_URL`, `MARKET_TOKEN`, `WALLET_MODE=real`,
   `WALLET_RPC_URL`, and `WALLET_RPC_TOKEN`, or their desktop equivalents.
5. First check TLS health, publication/cancellation of a test order, delivery of
   authorized snapshots/WS only to participants, and reconnect. Then separately
   perform the settlement scenarios below.

### Public web to local wallet navigation

A link to `http://127.0.0.1:4101/` opens the wallet on **the visitor's computer**,
not on the cloud server. This is top-level navigation to a separate tab, not a
cross-origin fetch. Top-level navigation from HTTPS is not itself mixed content;
local-access rules and browser warnings still need testing in target browsers.
See [MDN mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)
and [local network access](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Local_network_access).

Public JavaScript does not call the local API. Local API requires a bearer token,
the exact loopback Host:port, and its own Origin/Fetch Metadata. Adding the cloud
domain to `LOCAL_ALLOWED_ORIGINS` does not enable CORS: code also requires
Origin == self. This preserves the boundary between the public page and wallet.
Desktop renderer uses a narrow IPC bridge; Node local client handles HTTPS/WSS.

`palka://offer/order-UUID` carries only an order ID. It selects the order for review
without creating a counter-order or signing. The macOS bundle declares the scheme;
LaunchServices delivery and a signed/notarized distribution still require testing
before release. In dev Electron, opening the window manually is more reliable.

### Shared network and real assets: remaining work

A shared cloud market **does not connect separate regtest chains**. Every
participant must see the same chain history and RGB contract IDs. Running `setup`
independently on three unrelated chains does not make them interoperable.

The current backend intentionally targets regtest. Rust uses local electrs
`127.0.0.1:50001` and proxy `127.0.0.1:3000`; Python calls Bitcoin RPC through
`docker compose exec … bitcoin-cli`. Independent desktop wallet initialization
and sidecar startup are available through [DESKTOP.md](../deploy/DESKTOP.md), but
multi-host RPC transport and standalone funding remain separate work. `catalog.py` also
expects three local profiles. The scenario below is therefore an acceptance target
for the next stage, not a verified command to deploy everything on three computers.

Required infrastructure work:

- Make Bitcoin RPC transport configurable (a secured private network or loopback
  through an SSH tunnel), preserving Docker transport for the local demo.
  Electrs/proxy can remain on loopback through tunnels or become configurable.
  Wallet RPC must always remain local.
- Separate single-profile initialization, public funding address output, operator
  funding, and public RGB catalog import. Create wallets only on their owners'
  computers; the server must not generate or distribute seeds. Names such as
  alice/bob/carol identify distinct market participants and local wallets.
- Choose shared regtest Core + electrs and verify a common checkpoint block hash;
  only the test operator mines. Do not switch to public mainnet/signet: this needs
  wallet capability and validation changes, not just environment variables.
- Issue X to Alice and DUSD to Bob; distribute only public exported contracts and
  import them through native catalog-import. Incoming ownership appears after an
  accepted consignment, not after importing genesis.

Reproducible acceptance scenario after that stage:

| Step | 2 computers | 3 computers |
| --- | --- | --- |
| Identity / keys | Alice on PC1, Bob on PC2 | Add Carol on PC3 |
| Network | Same regtest checkpoint for everyone | Same checkpoint |
| Assets | Bob's DUSD, Alice's BTC, shared DUSD ID | Alice's X, Bob's DUSD, Carol's BTC; shared X/DUSD IDs |
| Orders | Direct table above | Ring table above, with no direct pair |
| Before signing | Shared packageId/tx/commitment digests; amounts, fees, recipient scripts | Three funding/colored/proofs contributions in one package |
| Signing | Separate approval on both computers | Separate approval on all three |
| Result | One txid, mine, both RGB acceptances, exact deltas | One txid, three receipts, KEEP unchanged |
| Recovery | Restart after signing; same intent/signature/txid; reverse swap | Same for three participants |

In the cooperative path, consignments already travel through market inside
authenticated settlement materials, not a shared participant filesystem. Tested
sizes fit the current 256 KiB market messages. Long RGB histories may require a
separate agreed transport. Proxy health does not prove remote cooperative proxy
delivery: the standard SDK proxy smoke and this cooperative transport are different scenarios.

The next safe milestone is a closed cloud market with two/three local wallets on
a shared regtest network, including the transport/onboarding changes above.
Current deterministic blinding/nonces, fixed fee estimates, lack of fee bumping/reorg
recovery, and lack of a security audit rule out a production/mainnet launch.
