# Independent desktop wallet for owlpeer

Market registration and wallet initialization are separate. Registration creates
the participant ID/token. The steps below create one new, empty **real regtest**
wallet on this computer and attach its authenticated loopback sidecar to that ID.
They do not fund it, issue RGB, copy another user's keys, or change existing wallets.

The current native backend requires local regtest Core/electrs/proxy. Starting an
independent chain on a second computer does **not** enable cross-computer swaps:
both wallets must share a chain and RGB contract IDs. Shared infrastructure,
remote RPC transport, funding, and catalog distribution remain separate work;
see [the multi-computer guide](../docs/usage.md#shared-network-and-real-assets-remaining-work).

## First setup on macOS

Required: Git, Node 22.17+, uv/Python 3.12+, Rust 1.94, RTK, and Docker with Compose.
The native wallet helpers use RTK internally even when the commands below do not
have an RTK prefix. Keep all wallet state on its owner's computer.

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

For a machine with **no existing regtest chain**, start local infrastructure:

```bash
docker compose -f infra/compose.yaml up -d
uv run --locked python scripts/demo/chain-volumes.py pin
```

For an existing chain, use its saved volumes as described in
[the infrastructure guide](../docs/usage.md#infrastructure-initial-setup-and-restarts).
Do not reset a chain to make a wallet connect. Wait for readiness:

```bash
uv run --locked python scripts/demo/doctor.py
```

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

Keep regtest infrastructure running. In terminal 1, start the sidecar:

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
