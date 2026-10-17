#!/bin/sh
set -eu
umask 077
mkdir -p /run/bitcoin/regtest
printf '%s:%s' "$BTCUSER" "$BTCPASS" > /run/bitcoin/regtest/.cookie
exec /bin/electrs --network regtest --db-dir /data --jsonrpc-import \
  --daemon-rpc-addr bitcoind:18443 --daemon-dir /run/bitcoin \
  --electrum-rpc-addr 0.0.0.0:50001 --http-addr 127.0.0.1:3002
