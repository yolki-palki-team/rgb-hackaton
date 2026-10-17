#!/usr/bin/env bash
# One command for the development desktop, including its local wallet runtime.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Rustup may be installed without its shell environment being loaded.
if ! command -v cargo >/dev/null 2>&1; then
  cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin"
  if [[ -x "$cargo_bin/cargo" ]]; then
    export PATH="$cargo_bin:$PATH"
  else
    echo 'Missing prerequisite: cargo. Install Rust with rustup, or set CARGO_HOME (and RUSTUP_HOME for a custom rustup installation). See deploy/DESKTOP.md.' >&2
    exit 1
  fi
fi
for command in node npm uv cargo rtk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing prerequisite: $command. See deploy/DESKTOP.md." >&2
    exit 1
  fi
done
npm ci --no-audit --no-fund
uv sync --locked
uv run --locked python scripts/demo/bootstrap-native.py --refresh
cargo build --locked --manifest-path packages/wallet/native/Cargo.toml
exec npm run dev:desktop
