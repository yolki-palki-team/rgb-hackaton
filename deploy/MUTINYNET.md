# Opt-in Mutinynet development profile

Mutinynet is a **custom Signet**, not Bitcoin testnet3 or the default public Signet.
Use `PALKA_NETWORK=mutinynet`; protocol messages identify it as `signetcustom`.
Omitting the variable retains the existing regtest workflow.

This profile connects operator-supplied infrastructure to the real wallet. It
does not deploy a node, request faucet funds or mine blocks. QVAC, keys, policies
and signing remain local. Direct and three-party atomic swaps retain the same
amount, fee, ownership and approval checks. Mutinynet settlement is unverified.

## Infrastructure prerequisites

1. Run a fully synchronized Mutinynet-compatible Bitcoin Core fork with RPC and
   `txindex=1`, using its own data directory. The official
   [faucet configuration](https://faucet.mutinynet.com/) specifies the challenge
   below, peer `45.79.52.207:38333`, `dnsseed=0` and `signetblocktime=30`, and links
   the required Core fork. Follow the [upstream instructions](https://github.com/MutinyWallet/mutiny-net).
   Joining this public chain does not grant its mining/signing key.
2. Supply an indexer on that chain that passes the pinned RGB SDK's health check,
   including historical transactions and RGB witness resolution. A reachable
   Bitcoin explorer alone does not establish RGB compatibility.
3. Supply an RGB consignment proxy accepted by the SDK's `check_proxy_url`.
   The faucet and explorer are not RGB proxies. An existing separately operated
   compatible proxy may be used; this profile assumes no hosted RGB proxy.
4. Run a separate market with `MARKET_NETWORK=signetcustom`. Keep its SQLite file
   and profiles separate from regtest. All participants need the updated client,
   Python adapter and native binary.

### Optional isolated local Core and proxy

With Docker running, this opt-in command provisions new local development RPC
credentials and starts only the `palka-mutinynet` Compose project:

```sh
rtk proxy uv run --locked python deploy/mutinynet.py up --timeout 900
```

It uses the official fork release `2fda7bfc027e` from
[mutinynet-inq-template-hash](https://github.com/benthecarman/bitcoin/releases/tag/mutinynet-inq-template-hash),
with pinned ARM64/AMD64 archive checksums, and the repository's existing RGB proxy
release pinned by image digest. Core has wallets disabled and does not mine.
Separate named volumes preserve its chain/txindex and proxy data. RPC binds only
to `127.0.0.1:38332`; the new proxy binds only to `127.0.0.1:53002`. Existing regtest
services, ports and volumes are not used or changed.

Initial synchronization is bounded: at least 12 GiB host free space is required
to begin, free space is checked every 10 seconds, and the isolated services stop
below 10 GiB or after the selected 60–3600 second budget. Neither stop deletes
data. Run the same command to resume; do not remove volumes to retry. This is not
a claim that 12 GiB can hold the complete chain: a sparse block-size sample
projected about 9.9 GiB of raw blocks, excluding indexes, undo and chainstate.
Actual storage needs may be greater. The monitor stops at its limit instead of
silently exhausting the host disk. After initial synchronization succeeds,
services remain running until explicitly stopped.

```sh
rtk proxy uv run --locked python deploy/mutinynet.py status
rtk proxy uv run --locked python deploy/mutinynet.py stop
```

The generated endpoint file is `deploy/.state/mutinynet/endpoints.json` (private
and Git-ignored). Its random password matches this new Core's `rpcauth`; no
existing RPC credentials are copied or guessed. Reuse it across restarts:

```sh
export PALKA_NETWORK=mutinynet
export PALKA_MUTINYNET_CONFIG="$PWD/deploy/.state/mutinynet/endpoints.json"
```

`ready: true` requires the correct challenge/checkpoint, completed Core initial
sync and a synchronized txindex. It is not wallet funding or RGB settlement.
Run the native preflight below after the node becomes ready.

The first local run reached the current headers but was still downloading old
blocks at about 300 blocks/second in one 10-second sample. At that observed rate,
15 minutes cannot finish the approximately 3.5-million-block chain. The fork reported
`verificationprogress: 1` while `initialblockdownload` was still true; the helper
correctly kept `ready: false`. Multiple bounded sessions may be necessary.
For an immediate settlement environment, supply an already synchronized
operator-managed Mutinynet Core with txindex through HTTPS or a loopback SSH
tunnel. The public Esplora API does not replace Core signing/broadcast validation.

Core must report this exact `signet_challenge` through `getblockchaininfo`:

```text
512102f7561d208dd9ae99bf497273e16f389bdbd6c4742ddb8e6b216e64fa2928ad8f51ae
```

Core and the indexer must also report block 1 as:

```text
000002855893a0a9b24eaffc5efc770558a326fee4fc10c9da22fc19cd2954f9
```

This distinguishes Mutinynet from other Signets sharing the genesis block and
`tb1` address prefix. An address prefix cannot identify the chain.

The [official deployment source](https://github.com/MutinyWallet/mutiny-net/blob/master/docker-compose.yml)
publishes Esplora at `https://mutinynet.com/api` and Electrum at
`electrum.mutinynet.com:50001`. Read-only checks on 2026-10-18 confirmed the
checkpoint and explorer height 3,514,963. Electrum reported
`mempool-electrs 3.3.0-141215c(dirty)` and rejected verbose transactions with
`verbose transactions are currently unsupported`. The pinned RGB resolver needs
verbose transactions for Electrum, so **the public Electrum endpoint is not a
compatible RGB backend**. The SDK custom-Signet Electrum lookup also expects a
`tx_id` object from `transaction.id_from_pos`; standard Electrum compatibility
alone is insufficient. Run the native preflight on your exact configured indexer.

The native build enables the SDK's existing Esplora feature. Its read-only health
check **passed against `https://mutinynet.com/api`**, including the pinned block-1
checkpoint, with a separately running compatible local RGB proxy. Use that
Esplora URL below. This verifies SDK connectivity; wallet synchronization,
issuance and settlement were not exercised by the health check.

## Private endpoint file

If you used the isolated local setup above, reuse its generated endpoint file.
The manual example below is for separately operated infrastructure.

Create a new owner-only JSON file outside Git, for example
`$HOME/.config/palka/mutinynet.json`, with your own endpoints and credentials.
This is a schema example, not a ready-to-run hosted service:

```json
{
  "bitcoinRpcUrl": "http://127.0.0.1:38332",
  "bitcoinRpcUser": "YOUR_LOCAL_RPC_USER",
  "bitcoinRpcPassword": "YOUR_LOCAL_RPC_PASSWORD",
  "indexerUrl": "https://mutinynet.com/api",
  "rgbProxyUrl": "http://127.0.0.1:53002/json-rpc"
}
```

Set permissions to `0600`. RPC and proxy URLs accept HTTPS or loopback HTTP;
embedded URL credentials are rejected. The indexer URL goes to the SDK without
substituting regtest. No public Core RPC or deployment credential is assumed.

```sh
export PALKA_NETWORK=mutinynet
export PALKA_MUTINYNET_CONFIG="$HOME/.config/palka/mutinynet.json"
```

Do not set `PALKA_CHAIN_CONFIG`: that shared regtest invitation is rejected here.
Existing production/server configuration and regtest wallets need no changes.

## Start an isolated market and desktop

After the [desktop prerequisites](DESKTOP.md) are installed, run a separate market:

```sh
rtk proxy env MARKET_NETWORK=signetcustom MARKET_SELF_REGISTRATION=true \
  MARKET_PORT=4110 MARKET_DB_PATH=.state/market-mutinynet.sqlite npm run dev:market
```

In the desktop terminal, retain the exported variables above and select that
market. A remote market needs its own HTTPS origin configured for `signetcustom`.

```sh
export PALKA_MARKET_URL=http://127.0.0.1:4110
rtk proxy bash deploy/desktop.sh --network mutinynet
```

The launcher builds the native code and performs a read-only Core, txindex, RGB
indexer and proxy preflight before opening Electron. Its explicit
`--allow-syncing` mode accepts a correctly identified Core with txindex configured
while it is downloading the chain, and prints `ready: false` with progress.
This permits the receive/faucet UI; trading, issuance and signing still require
fully synchronized Core. The normal preflight remains strict:

```sh
rtk proxy uv run --locked python scripts/demo/chain_profile.py
```

A preflight failure means the wallet is unavailable. Do not bypass it with mock
mode, a different Signet or regtest endpoints. API liveness and unit tests do not
replace this check. No wallet is created by the preflight itself.

On macOS the default Electron configuration is in
`~/Library/Application Support/palka-mutinynet`; its native wallet is under the
ignored `packages/wallet/state/mutinynet/desktop-<participant-id>/alice` directory.
Regtest keeps its original paths. `PALKA_DESKTOP_DATA_DIR` can select another new
profile; an existing profile cannot be relabeled for another network. Keep the
same endpoint file and profile on restart. The launcher skips shared regtest
bootstrap, funding and asset issuance. To return to regtest, use a new shell
without the Mutinynet variables and follow the existing regtest instructions.

## Funding, RGB contracts and confirmation

The desktop **Top up** panel exposes the wallet's verified vanilla BTC receive
address and a manual Mutinynet faucet link. It does not create a WDK account or
claim that faucet submission is confirmed funding. RGB collateral still needs
the separate `rgbAddress` from the native wallet status below.

After successful initialization, close the desktop before inspecting its wallet:

```sh
rtk proxy uv run --locked python scripts/demo/desktop_wallet.py status \
  --desktop-data-dir "$HOME/Library/Application Support/palka-mutinynet"
```

The output includes the saved public `btcAddress` and `rgbAddress` and current
balances. Fund both addresses with test sats through the
[Mutinynet faucet](https://faucet.mutinynet.com/), checking destination, amount
and network. Reserve BTC for fees and RGB output collateral. Funding is manual;
WDK funding is disabled until its custom-Signet behavior is separately verified.

Mutinynet targets 30-second blocks. Allow several minutes for faucet delivery,
confirmation and indexer lag; there is no fixed completion deadline. Recheck the
same transaction after an uncertain response. `generatetoaddress`, `regtest.py
setup`, shared `/fund` and regtest smoke/recovery scripts are not a Mutinynet
funding or confirmation path.

RGB issuance and public contract distribution are not automated by this profile.
Participants need real compatible NIA contracts on this chain and validated,
matching contract IDs. Regtest assets cannot be copied over as balances. Native
issuance/export/import operations retain their checks, but no funded Mutinynet
contract or catalog has been verified here. BTC funding is not RGB readiness.

Completion requires one shared Bitcoin transaction, confirmation, every
participant's RGB acceptance and correct balances. A ring cannot be replaced by
sequential transfers. Faucet funding, direct/ring settlement, received-asset
re-spending and restart recovery remain unverified until an end-to-end run records
that evidence against configured infrastructure.
