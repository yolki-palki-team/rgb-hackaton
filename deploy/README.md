# palka server demo

For **owlpeer.com** and desktop access without a tunnel, follow [HTTPS.md](HTTPS.md).
After configuring DNS and ports, `bash deploy/server.sh https` enables and saves
HTTPS mode. The instructions below describe the original HTTP profile.

This directory runs **public web + market + SQLite** on a separate VM.
Desktop, the local client, QVAC, and wallet sidecars run on participants' computers.
Bitcoin Core/electrs/RGB proxy and independent wallet provisioning are not included.
This does not launch distributed settlement or a mainnet deployment.
Remaining work is described in the [usage guide](../docs/usage.md#cloud-and-multiple-computers).

## Requirements and isolation

- Git, Bash, Python 3.9+, curl, Docker Engine 25+, Compose 2.20.2+.
- The user already has Docker access; these commands require neither sudo nor RTK.
- Available host ports: `80` for public web and `127.0.0.1:44100` for market.
- A separate Compose project **palka-demo**, network, and volume
  **palka-demo_market-state**. These scripts do not manage other projects'
  containers, but the machine's CPU, RAM, and disk remain shared.
- Logs are capped at three 10 MB files per service. Builds run sequentially.
- A separate `deploy/Dockerfile` and npm lockfile install only server/web
  dependencies. Electron, QVAC, WDK, and the model are not installed. Web builds
  only the public UI; the market runtime does not contain React/Vite.
- ARM64 builds were verified on a separate Docker host: approximately 258 MB for
  market and 52 MB for web (unpacked image sizes, excluding build cache and OS).
  This test does not verify the Oracle server itself. Do not add
  `platform: linux/amd64` to bypass an error without investigating the cause.

## First launch

On the server, in a separate directory:

```bash
mkdir -p ~/palka-demo
cd ~/palka-demo
git clone --branch main https://github.com/yolki-palki-team/rgb-hackaton.git repo
cd repo

bash deploy/server.sh up
bash deploy/server.sh check
```

No participant list is required: new desktop profiles register automatically.
`up` creates an empty legacy map if it is missing and preserves existing tokens.
For an existing wallet, the owner ID in market, local client, and sidecar must stay
unchanged. A private repository requires configured GitHub authentication.
If the test container `palka-netcheck` still occupies port 80, stop only that
container before starting: `docker stop palka-netcheck`.

Open `http://SERVER_IP/market` from another computer. The `check` command only tests
access on the server itself; the separate external request tests Oracle ingress
rules. An empty order list is expected with a new database.

## Participants and tokens

Alice/Bob/Carol are participant names in local test scenarios, not protocol roles.
A direct swap uses two orders, and a ring uses three; the server can serve more
participants. This deployment has no default users.

A new desktop first saves a random 256-bit token and its associated
`participant-…` ID in the local `desktop-config.json` (0600), then calls
`POST /participants`. The server stores the ID and token hash in SQLite, not the
token itself. Lost responses, retries, and restarts do not create a new participant.
HTTP and WebSocket use the same authentication. Registration does not authorize signing.

The ID is derived deterministically from the random token: desktop persists the
identity before making a network request. A client cannot request someone else's
owner ID. This is a market ID, not a seed, Bitcoin address, or proof of wallet
ownership. Closed-pilot limits: 60 new registrations per minute per process and
10000 automatically registered participants in the database.

Compose enables `MARKET_SELF_REGISTRATION=true`. To disable new registrations,
run `PALKA_SELF_REGISTRATION=false bash deploy/server.sh start`; existing
participants will continue to work. Repeat the flag on subsequent launches.
Self-registration is disabled by default when market is started directly.

**Existing wallets:** configurations without `marketRegistration: "automatic"`
remain manual. Their owner IDs, tokens, wallet RPC settings, and local state are
not rewritten. Keep the existing `deploy/.state/market.env`: the legacy map works
alongside the new table. Do not delete the desktop config to enable registration.
If the config is missing but wallet state is found, the app requires the original
credentials instead of creating a new owner.

Manual mode remains available for existing wallets:

```bash
# Legacy profile only: the ID must match its sidecar.
bash deploy/server.sh init participant-3

# Apply the updated map without rebuilding images.
bash deploy/server.sh start

# Prints one participant's secret; share it only with its owner.
bash deploy/server.sh user participant-3
```

`user` prints `PALKA_OWNER_ID` and `PALKA_MARKET_TOKEN` only from the legacy map.
An automatically generated token exists only on desktop; the server cannot recover
it. For a new desktop using an existing wallet, supply both original variables and
the wallet RPC credentials: the profile will be manual. Registration does not
create or fund wallets or issue RGB assets. Configure a new sidecar with the new
desktop's ID; do not change an existing sidecar's ID.

The map is stored in `deploy/.state/market.env` with mode `0600`; its directory has
mode `0700`. It is excluded from Git through `.state/` and from the Docker build
context. Do not send this file or the output of `user` to chats or logs. Normal
`init` prints no secrets. A damaged file is not automatically replaced with new tokens.

## Connecting desktop before HTTPS is configured

Public web is available over HTTP; private market is published only on the
server's loopback interface. Do not send a market token over plaintext HTTP across
the internet. For a closed demo, open an SSH tunnel **on the laptop**:

```bash
ssh -N \
  -L 54100:127.0.0.1:44100 \
  -L 55173:127.0.0.1:80 \
  beknur@SERVER_IP
```

Before the first launch of a new desktop profile, in another terminal on the laptop:

```bash
export PALKA_MARKET_URL=http://127.0.0.1:54100
export PALKA_PUBLIC_MARKET_URL=http://127.0.0.1:55173/market
npm run dev:desktop
```

No ID/token configuration is required. URLs and credentials persist across restarts.
An automatic identity is bound to the market origin: changing the address does not
send the old token to a different server. For another market installation, use a
separate `PALKA_DESKTOP_DATA_DIR` without reusing the previous wallet's history.
Keep the same profile for normal restarts. If the server is offline, the UI opens
and the client retries registration with the same token and bounded backoff.

Each participant opens their own tunnel using their authorized SSH access.
This connects desktop to market, but does not provide remote Bitcoin RPC transport.
Direct access without a tunnel requires a separate HTTPS market origin and WSS
`/events`, preserving Authorization. The public Nginx proxy exposes only read-only
`/market-api/health` and `/market-api/orders`; it deliberately excludes private
routes. TLS, DNS, general API rate limits, and automatic backups are not configured
in this initial HTTP profile.

## Updating and stopping

```bash
cd ~/palka-demo/repo
git pull --ff-only
bash deploy/server.sh up
bash deploy/server.sh status
bash deploy/server.sh logs

# Stop only palka-demo. The database volume is preserved.
bash deploy/server.sh down

# Restart existing images without rebuilding.
bash deploy/server.sh start
```

Tokens and the database survive updates and container recreation. Do not use
`down --volumes`, a global `docker system prune`, or volume deletion to update.
Keep a backup of credentials and a consistent SQLite copy (copying after stopping
market is simplest); wallet backups are made separately on the owner's computer.

## Migrating from compose.server.yaml commands

The previous manual instructions used `~/palka-demo/compose.server.yaml` and
`~/palka-demo/private/market.env`. Before switching, stop the old launcher and
copy the **existing** tokens without generating replacements:

```bash
cd ~/palka-demo
docker compose -p palka-demo -f compose.server.yaml down
cd repo
mkdir -p deploy/.state
chmod 700 deploy/.state
test ! -e deploy/.state/market.env && cp ../private/market.env deploy/.state/market.env
chmod 600 deploy/.state/market.env
bash deploy/server.sh up
```

If the destination file already exists, compare configurations locally before
replacing it. The Compose project and volume name are unchanged, so the existing
market database is reused. Do not run the old and new configurations together.
Root `compose.yaml` and `infra/compose.yaml` are separate modes; `server.sh` does
not start them.

## Development checks

In the developer checkout:

```bash
rtk proxy npm run test:deploy
rtk proxy uv run --locked ruff check deploy
rtk proxy uv run --locked ruff format --check deploy
rtk proxy bash -n deploy/server.sh
```

Tests cover token persistence, adding users, permissions, refusal to overwrite
corrupt credentials, and matching deployment dependency versions to the main app.
When updating dependencies, update `deploy/package.json` and its separate lockfile
alongside the root manifest.

On October 17, 2026, separate checks covered ARM64 builds of both images, 23
market/contracts tests inside the server image, and Compose startup on isolated
loopback ports. The HTTP smoke test checked public web, the read-only proxy,
rejection of unauthorized access and another owner's ID, and persistence of a
synthetic order across container recreation. This is not a real Bitcoin/RGB trade.
Oracle firewall access, HTTPS/WSS, and settlement across computers require separate
checks. CI also builds and runs the server profile on a Linux runner; it does not
test the user's external server.

Automatic registration was additionally checked with the full JS suite (86 tests),
7 deployment tests, TypeScript/ESLint/Prettier/Ruff, and web/local/desktop builds.
Two registration tests passed inside the ARM64 market image: repeated registration,
hash storage, restart persistence, legacy authentication, and limits. Desktop
integration checks saved credentials, a lost response, and HTTP/WebSocket access.
These checks do not include a manual Electron launch or real RGB settlement.

## Shared Bitcoin/RGB test network

After HTTPS is enabled, follow [NETWORK.md](NETWORK.md) to add a persistent shared
regtest chain, desktop connections, test BTC/RGB setup and WDK top-ups.
