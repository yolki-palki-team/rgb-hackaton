# Independent desktop wallet for owlpeer

## Automatic shared-network startup (recommended)

The operator runs `bash deploy/server.sh network` after updating the server.
On each computer with Git, Node 22.21+ (or newer LTS), uv and rustup installed:

```bash
git pull --ff-only
bash deploy/desktop.sh
```

The launcher selects Rust using the repository's `rust-toolchain.toml` (currently
1.94.0), installing that toolchain through rustup when needed. It prefers
`${CARGO_HOME:-$HOME/.cargo}/bin` over standalone Homebrew Rust, then puts the
selected toolchain first on `PATH` for the build and wallet runtime.
If Rust is installed in a custom location, export `CARGO_HOME` and
`RUSTUP_HOME` pointing to that installation before launching. These variables
are inherited by the desktop and its wallet helpers. If Rust is not installed,
install [rustup](https://rustup.rs) first; the launcher does not install system
prerequisites. It checks prerequisite commands and the Rust toolchain before installing project
dependencies. `rustc 1.86.0 is not supported` means an older standalone Rust was
used: update this checkout and rerun the launcher with rustup installed.

For a new checkout, clone the repository first. The script installs locked
dependencies and builds the local wallet; subsequent launches can use
`npm run dev:desktop`. No local Docker, invitation copy, manual init/fund/issue/sync,
or second terminal is needed. Close any manually started sidecar before switching.

Fresh desktop profiles default to owlpeer.com. Existing profiles keep their
market, identity, keys and state. Automatic startup applies only to automatic
real-mode profiles on HTTPS markets; manual and local-only profiles keep their
existing workflow. Set `PALKA_AUTO_WALLET=false` to operate sidecars manually.

Desktop enrolls with the market, obtains the shared-chain settings over HTTPS,
creates its local wallet, and receives test BTC. The first participant becomes
the X issuer, the second the DUSD issuer (1,000 units each); later participants
receive BTC. Existing catalog issuers are preserved. Verified public contracts
sync automatically while the wallet is idle, including contracts published after
it started. Restart uses the existing wallet and can recover an active trade.

Opening **Top up** creates the local WDK account and automatically requests its
one-time test BTC allowance. Moving those funds into the RGB wallet still requires
reviewing the amount/fee and approving. Trade signatures always require approval.

This is the repository development launcher. A standalone distributable still
needs the Python/native wallet runtime bundled; the old packaged app is not
automatically upgraded by this script. The first dependency/native build and
first QVAC model download can take time.

Validation: an isolated ARM64 HTTPS deployment with the real market, Core,
indexer and RGB proxy onboarded three independent participants automatically.
All three received BTC; the first two issued X/DUSD; the third imported both
contracts. Every participant restarted successfully with the same identity.
Reproduce with `uv run --locked python scripts/demo/automatic-desktop-smoke.py --execute`.
This validates the setup helper and real services, not clicks in three physical
desktop windows or a new end-to-end atomic swap.

## Manual setup and diagnostics

Market registration and wallet initialization are separate. Registration creates
the participant ID/token. The steps below create one new, empty **real regtest**
wallet on this computer and attach its authenticated loopback sidecar to that ID.
They do not fund it, issue RGB, copy another user's keys, or change existing wallets.

For the shared Oracle network, use [NETWORK.md](NETWORK.md). It provides HTTPS
chain access, per-participant test funding, shared RGB contracts and WDK funding
without local Docker or SSH tunnels. Independent local chains cannot trade with
each other merely by connecting to the same market.

## First setup on macOS

Required: Git, Node 22.21+ (or newer LTS), uv/Python 3.12+, rustup with Rust 1.94. Docker is needed only for the optional local-chain workflow.
The launcher and wallet helpers run standard commands directly; RTK is not required.
Keep all wallet state on its owner's computer.

```bash
git clone https://github.com/yolki-palki-team/rgb-hackaton.git
cd rgb-hackaton
npm ci
uv sync --locked
uv run --locked python scripts/demo/bootstrap-native.py
cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
```

For an existing checkout, update with `git pull --ff-only` rather than cloning
again. Do not reuse another participant's desktop config or wallet directory.

Launch a **new** desktop profile once to save its market identity:

```bash
export PALKA_MARKET_URL=https://api.owlpeer.com
export PALKA_PUBLIC_MARKET_URL=https://owlpeer.com/market
npm run dev:desktop
```

Close desktop before the next step. At this stage, “configure WALLET_RPC_URL and
WALLET_RPC_TOKEN” is expected because the sidecar is not configured yet.

Create the independent wallet once, with desktop closed:

```bash
uv run --locked python scripts/demo/desktop_wallet.py init \
  --desktop-data-dir "$HOME/Library/Application Support/palka"
```

If using `PALKA_DESKTOP_DATA_DIR`, pass that same directory instead. The helper
requires an automatic real-mode desktop profile; it refuses to reassign an
existing named wallet. It preserves owner ID, market token, URLs, and local history,
and saves a private `desktop-config.before-wallet.json` backup before adding the
RPC token. Repeating initialization reuses the same keys and token. Missing keys
in an initialized wallet cause an error, never automatic replacement.

Wallet state lives under ignored
`packages/wallet/state/desktop-participant-<id>/`. The native bridge currently
requires an internal storage slot called `alice`; that slot is inside the new
isolated directory. Its public owner is the generated `participant-…` ID, not
Alice from the old demo sets. No Alice/Bob/Carol multi-wallet setup is run.

## Normal startup

For the deployed shared chain, continue with [NETWORK.md](NETWORK.md) after
initialization; its desktop launcher also configures WDK for that chain.

For an optional local-only chain, keep `infra/compose.yaml` infrastructure running. In terminal 1, start the sidecar:

```bash
uv run --locked python scripts/demo/desktop_wallet.py start \
  --desktop-data-dir "$HOME/Library/Application Support/palka"
```

Leave that terminal running. In terminal 2, from the same checkout:

```bash
npm run dev:desktop
```

Desktop reuses its saved HTTPS URLs, market identity, and local wallet RPC token.
The initial BTC balance is zero and there are no issued RGB assets. Funding and
RGB setup are separate; do not treat a connected empty wallet as a funded demo.
An existing packaged app must be rebuilt after source updates.

On restart, repeat only infrastructure startup if needed, sidecar `start`, and
desktop launch. Do not repeat the old three-profile `regtest.py setup` workflow.
Stop desktop and the sidecar before backing up wallet state. Keep the full RGB
state and credentials private; a seed alone is not an RGB backup.
