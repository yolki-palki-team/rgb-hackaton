#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose --project-name palka-demo --project-directory "$deploy_dir" -f "$deploy_dir/compose.yaml")

usage() {
  cat <<'HELP'
Usage: bash deploy/server.sh COMMAND [OWNER_ID ...]
  init [OWNER_ID ...] Prepare automatic registration; optionally add legacy users
  user OWNER_ID      Print this participant's private desktop credentials
  up                 Build sequentially and start web + market
  start              Start/reconcile existing images (also applies added users)
  status             Show this project's containers
  logs               Show the last 100 log lines
  check              Check the local web and public market endpoints
  down               Stop this project, preserving its database volume
HELP
}

action="${1:-help}"
if (($#)); then shift; fi
case "$action" in
  init|user)
    exec python3 "$deploy_dir/credentials.py" "$action" "$@"
    ;;
  help|-h|--help)
    usage
    exit 0
    ;;
esac

if (($#)); then
  usage >&2
  exit 1
fi
if [[ ! -f "$deploy_dir/.state/market.env" ]]; then
  case "$action" in
    up|start) python3 "$deploy_dir/credentials.py" init ;;
    *) echo 'Run init or up first.' >&2; exit 1 ;;
  esac
fi

case "$action" in
  up)
    "${compose[@]}" build runtime
    "${compose[@]}" build web
    "${compose[@]}" up -d --wait
    ;;
  start) "${compose[@]}" up -d --wait ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=100 ;;
  check)
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1/health
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1/market-api/health
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1/market-api/orders
    ;;
  down) "${compose[@]}" down ;;
  *) usage >&2; exit 1 ;;
esac
