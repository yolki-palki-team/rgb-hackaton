#!/usr/bin/env bash
# One command for the development desktop, including its local wallet runtime.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
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
