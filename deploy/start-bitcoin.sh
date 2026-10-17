#!/bin/sh
set -eu
exec bitcoind -datadir=/data -regtest -server -txindex -prune=0 \
  -rpcbind=0.0.0.0 -rpcallowip=172.16.0.0/12 -rpcallowip=192.168.0.0/16 \
  -rpcallowip=10.0.0.0/8 -rpcauth="$RPCAUTH" -fallbackfee=0.0002 \
  -printtoconsole -listen=1 -discover=0 -dnsseed=0
