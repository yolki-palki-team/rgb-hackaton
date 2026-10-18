#!/usr/bin/env bash
# One command for the development desktop, including its local wallet runtime.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ "$#" -gt 0 ]]; then
  if [[ "$#" != 2 || "$1" != --network ]]; then
    echo 'Usage: deploy/desktop.sh [--network regtest|mutinynet]' >&2
    exit 2
  fi
  export PALKA_NETWORK="$2"
fi
case "${PALKA_NETWORK:-regtest}" in
  regtest) ;;
  mutinynet|signetcustom)
    export PALKA_NETWORK=mutinynet
    if [[ -z "${PALKA_MUTINYNET_CONFIG:-}" ]]; then
      echo 'Set PALKA_MUTINYNET_CONFIG to a private endpoint file. See deploy/MUTINYNET.md.' >&2
      exit 2
    fi
    ;;
  *) echo 'Unsupported network; select regtest or mutinynet.' >&2; exit 2 ;;
esac
# Prefer rustup over an older standalone Cargo (for example, Homebrew Rust).
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
for command in git node npm uv rustup; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing prerequisite: $command. See deploy/DESKTOP.md." >&2
    if [[ "$command" == rustup ]]; then
      echo 'Install rustup from https://rustup.rs; standalone Cargo does not select rust-toolchain.toml.' >&2
    fi
    exit 1
  fi
done
# Installs the repository-pinned toolchain if needed, before npm/Python downloads.
rustup show active-toolchain
cargo_executable="$(rustup which cargo)"
export PATH="${cargo_executable%/*}:$PATH"
cargo --version
rustc --version
node deploy/desktop-dependencies.mjs
uv sync --locked
uv run --locked python scripts/demo/bootstrap-native.py --refresh
cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
if [[ "${PALKA_NETWORK:-regtest}" == mutinynet ]]; then
  uv run --locked python scripts/demo/chain_profile.py --allow-syncing
fi
exec npm run dev:desktop
