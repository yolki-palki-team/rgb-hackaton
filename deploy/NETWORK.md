# Shared Oracle regtest network

**Recommended:** after the server `network` command below, each participant runs
`bash deploy/desktop.sh`, then uses `npm run dev:desktop` for later launches.
See [automatic startup](DESKTOP.md#automatic-shared-network-startup-recommended).
Invitation copy and manual wallet commands below are retained for diagnostics;
they are no longer required for normal desktop use. Do not run a separate sidecar
alongside automatic desktop startup.

The `/chain/bootstrap` endpoint enrolls a desktop using its existing market token.
It returns private network access over HTTPS and assigns the first two issuers
persistently. This intentionally enables automatic test funding for registered
demo participants; it is not a production admission policy.

The public market and the blockchain are separate services. This opt-in profile
adds Bitcoin Core, a persistent Electrum indexer, RGB proxy, an authenticated
HTTPS gateway, and a small test-BTC faucet to the existing `palka-demo` project.
All participants use the same chain. Wallet keys, RGB state, QVAC, WDK seeds and
signing remain on their computers. This is a private hackathon regtest network,
not mainnet or a public faucet. All invitation holders are trusted demo operators.

## Server: enable once, then preserve the volumes

Run from the existing repository directory on Oracle. HTTPS must already work:

```bash
git pull --ff-only
bash deploy/server.sh network
bash deploy/server.sh status
curl --fail https://api.owlpeer.com/chain/health
```

No additional public ports or DNS records are required. Caddy forwards `/chain/*`
over the existing HTTPS endpoint. Core RPC, Electrum, and the RGB proxy have no
host port mappings. Other Compose projects are not stopped or modified.

Bitcoin Core 30.2 and mempool-electrs images are pinned by multiarchitecture
manifest digest. The old local-infrastructure images were AMD64-only. The RGB
proxy is built from the same pinned 0.3.0 source on ARM64/AMD64; its upstream
package incorrectly places runtime imports in devDependencies, so those locked
dependencies are retained. The server does not compile Rust or download AI models.
First proxy build takes additional disk space for the build cache.

Credentials are generated once under ignored `deploy/.state/`. Named volumes
preserve Core, the indexer, proxy data, faucet receipts and the contract catalog.
`network.enabled` makes subsequent `up`, `start`, `status`, `logs`, and `down`
include these services. Never use `down --volumes` or volume pruning on this stack.
Back up all named volumes and `deploy/.state` while the stack is stopped.

The gateway mines 101 initial blocks into its **test-only faucet wallet**. It then
mines a block when there are pending transactions, approximately every five seconds.
It does not mine empty blocks continuously. A block-1 checkpoint identifies this
specific regtest chain; clients reject a replacement chain with the same genesis.

## Private invitation for each computer

After `network` succeeds, copy `deploy/.state/chain-invite.json` from the server
to each participant's repository. It contains a shared demo access secret, not
wallet keys. Do not post it in chat, commit it, or expose it through the website.
Replace `/absolute/path/to/repo` with the server checkout's actual path:

```bash
mkdir -p .state
scp beknur@129.151.210.13:/absolute/path/to/repo/deploy/.state/chain-invite.json .state/chain-invite.json
chmod 600 .state/chain-invite.json
```

Copying this small file uses SSH once; normal operation uses HTTPS and requires
no SSH forwarding, VPN or local Docker chain.

## Desktop setup and connection

Follow [DESKTOP.md](DESKTOP.md) to install dependencies and create an independent
desktop identity and wallet. For an existing checkout, update the SDK bridge too:

```bash
git pull --ff-only
npm ci
uv sync --locked
uv run --locked python scripts/demo/bootstrap-native.py --refresh
cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
```

Close desktop and stop its sidecar before initial connection or RGB maintenance.
Use the same desktop data directory as during initialization:

```bash
wallet_dir="$HOME/Library/Application Support/palka"
uv run --locked python scripts/demo/desktop_wallet.py init --desktop-data-dir "$wallet_dir"
uv run --locked python scripts/demo/desktop_wallet.py connect \
  --desktop-data-dir "$wallet_dir" --invite .state/chain-invite.json
uv run --locked python scripts/demo/desktop_wallet.py fund --desktop-data-dir "$wallet_dir"
```

`connect` keeps the participant identity, keys and market token. It refuses a
wallet with recorded funds/imported assets on another chain, or an existing shared
wallet pinned to a different chain. Create a separate desktop profile for those
cases; do not delete or reset the existing wallet to make it connect.

`fund` sends **1,000,000 sats** to the wallet's BTC address and **100,000 sats** to
its colored funding address. Each participant/purpose has one persistent receipt;
repeating the command returns the same transaction instead of paying again. A
lost Core response leaves an uncertain receipt and blocks automatic repayment.
The operator must reconcile it using the faucet wallet transaction history.

## Issue demo RGB and synchronize the catalog

With desktop and sidecars stopped, on the first participant's computer:

```bash
uv run --locked python scripts/demo/desktop_wallet.py issue \
  --desktop-data-dir "$HOME/Library/Application Support/palka" --asset X
```

On the second participant's computer:

```bash
uv run --locked python scripts/demo/desktop_wallet.py issue \
  --desktop-data-dir "$HOME/Library/Application Support/palka" --asset DUSD
```

Each command issues **1,000 atomic units**, precision 0, into that participant's
real local wallet and publishes the public contract. A ticker has one issuer in
this shared catalog; another participant cannot silently create a second asset
under that name. Repeating issuance uses the saved issuance receipt.

After both issuances, run on **every** participant, including a BTC-only third one:

```bash
uv run --locked python scripts/demo/desktop_wallet.py sync \
  --desktop-data-dir "$HOME/Library/Application Support/palka"
```

The native SDK validates imported contracts and checks their contract IDs.
Catalog import gives visibility to an asset, **not ownership of its tokens**.
Initially the X issuer owns X, the DUSD issuer owns DUSD, and a third participant
can contribute BTC. Tokens move between participants through the existing direct
or atomic ring settlement. There is no central RGB mint with users' private keys,
and no synthetic balance credit. These test assets have no backing or cash value.

## Normal startup, including WDK

Terminal 1, from the repository:

```bash
uv run --locked python scripts/demo/desktop_wallet.py start \
  --desktop-data-dir "$HOME/Library/Application Support/palka"
```

Terminal 2:

```bash
uv run --locked python scripts/demo/desktop_wallet.py desktop \
  --desktop-data-dir "$HOME/Library/Application Support/palka"
```

The first process supervises the real wallet sidecar and loopback SDK adapters on
51001 (Electrum) and 53000 (RGB proxy). Those adapters authenticate to the pinned
HTTPS chain. The second command starts desktop with **WDK on port 51001**, so its
BTC account uses the same server chain. Do not use a plain `npm run dev:desktop`
for a shared-network profile: that would leave WDK's default local-chain port.
The native wallet's Core RPC calls also use the gateway, including validation,
transaction lookup and broadcast. There is no automatic local-chain fallback.

## Top up through WDK on this same chain

In desktop, open **Top up**, create the local WDK account if requested, and copy
its **Receive** address (`bcrt1...`). While desktop and the sidecar keep running:

```bash
uv run --locked python scripts/demo/desktop_wallet.py fund \
  --desktop-data-dir "$HOME/Library/Application Support/palka" \
  --wdk-address YOUR_WDK_BCRT1_ADDRESS
```

This gives that participant's WDK account **1,000,000 test sats**, once. In
**Top up**, enter an amount (for example `50000` sats), review the recipient and
fee, and approve the separate funding transaction. WDK signs locally, broadcasts
to the shared chain, and the server confirms it automatically. The RGB wallet's
BTC balance increases after indexing. WDK does not issue RGB assets or replace
the atomic swap signer. Keep its seed/private state local, and never send mainnet
BTC to this demo.

## Diagnostics and limits

Local ARM64 integration verified two independent wallets over authenticated HTTPS,
repeat-safe BTC funding, real X/DUSD issuance and SDK catalog validation. A WDK
transfer delivered 50,000 sats to the native wallet with a 141-sat fee and retained
the account and transaction across restart. The check uses an isolated Compose
project; it does not claim that Oracle or two physical computers were tested.

To reproduce (requires Docker, the built native bridge, and installed dependencies):

```bash
uv run --locked python scripts/demo/shared-network-smoke.py --execute
```

The check preserves ignored wallet state and Docker volumes for investigation.
It is a real test transfer, not a mock or an atomic-swap verification.

```bash
# Server
bash deploy/server.sh logs
curl --fail https://api.owlpeer.com/chain/health
```

If `connect` rejects the file permissions, run `chmod 600` on the invitation.
If a maintenance command reports a coordinator lock, close desktop and stop its
sidecar first. If ports 51001/53000 are occupied, stop the earlier shared sidecar;
do not start a second adapter over another chain. Restart the sidecar after an
outage; never delete keys or volumes to fix connectivity.

The invitation authorizes all trusted demo operators, including faucet access
and catalog claims. This is not hardened multi-tenant production infrastructure.
The bridge supports request/response Electrum calls used by the native wallet
and WDK; it does not deliver unsolicited subscription notifications. Current
balance/status polling provides updates. Existing regtest-only NIA and cooperative
settlement limitations still apply. Multi-computer trades must be verified after
the operator deploys this stack and connects the actual participants.
