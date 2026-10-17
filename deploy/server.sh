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
  https              Enable persistent HTTPS for owlpeer.com + api.owlpeer.com
  network            Enable the persistent shared regtest network and faucet
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

if [[ "$action" == network ]]; then
  if [[ ! -f "$deploy_dir/.state/https.enabled" ]]; then
    echo 'Enable HTTPS first: bash deploy/server.sh https' >&2
    exit 1
  fi
  python3 "$deploy_dir/network_setup.py"
fi

if (($#)); then
  usage >&2
  exit 1
fi
if [[ ! -f "$deploy_dir/.state/market.env" ]]; then
  case "$action" in
    up|start|https) python3 "$deploy_dir/credentials.py" init ;;
    *) echo 'Run init or up first.' >&2; exit 1 ;;
  esac
fi

if [[ "$action" == https || -f "$deploy_dir/.state/https.enabled" ]]; then
  export PALKA_WEB_BIND=127.0.0.1 PALKA_WEB_PORT=44080
  compose+=(-f "$deploy_dir/compose.https.yaml")
fi
if [[ "$action" == network || -f "$deploy_dir/.state/network.enabled" ]]; then
  compose+=(-f "$deploy_dir/compose.network.yaml")
fi

case "$action" in
  network)
    "${compose[@]}" pull bitcoind electrs chain
    "${compose[@]}" build rgb-proxy
    # Persist this before startup so status/logs and retries use the same volumes.
    (umask 077; touch "$deploy_dir/.state/network.enabled")
    "${compose[@]}" up -d --wait
    "${compose[@]}" restart chain
    "${compose[@]}" up -d --wait chain
    "${compose[@]}" exec -T chain cat /state/checkpoint.json | python3 "$deploy_dir/network_setup.py" checkpoint
    "${compose[@]}" exec -T edge caddy reload --config /etc/caddy/Caddyfile
    echo 'Shared regtest is running. Copy deploy/.state/chain-invite.json privately to each desktop.'
    ;;
  https)
    # Download and validate before moving the existing web listener off port 80.
    "${compose[@]}" pull edge
    "${compose[@]}" run --rm --no-deps edge caddy validate --config /etc/caddy/Caddyfile
    (umask 077; touch "$deploy_dir/.state/https.enabled")
    "${compose[@]}" up -d --wait
    echo 'HTTPS mode saved. Certificate issuance may take a minute; run check and logs.'
    ;;
  up)
    "${compose[@]}" build runtime
    "${compose[@]}" build web
    "${compose[@]}" up -d --wait
    ;;
  start) "${compose[@]}" up -d --wait ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --tail=100 ;;
  check)
    if [[ -f "$deploy_dir/.state/https.enabled" ]]; then
      # Test the local TLS listener with real hostname/certificate validation.
      curl --fail --silent --show-error --max-time 15 --resolve owlpeer.com:443:127.0.0.1 https://owlpeer.com/health
      curl --fail --silent --show-error --max-time 15 --resolve owlpeer.com:443:127.0.0.1 https://owlpeer.com/market-api/health
      curl --fail --silent --show-error --max-time 15 --resolve owlpeer.com:443:127.0.0.1 https://owlpeer.com/market-api/orders
      curl --fail --silent --show-error --max-time 15 --resolve api.owlpeer.com:443:127.0.0.1 https://api.owlpeer.com/health
    else
      curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${PALKA_WEB_PORT:-80}/health"
      curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${PALKA_WEB_PORT:-80}/market-api/health"
      curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:${PALKA_WEB_PORT:-80}/market-api/orders"
    fi
    ;;
  down) "${compose[@]}" down ;;
  *) usage >&2; exit 1 ;;
esac
