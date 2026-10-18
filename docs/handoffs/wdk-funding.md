# WDK Bitcoin funding

The local wallet can create a separate WDK Bitcoin account and fund its native
RGB exchange wallet with regtest BTC. This is a real Bitcoin transaction before
an exchange, with independent user approval. It does not implement RGB settlement
inside WDK or replace the cooperative RGB wallet adapter.

## Runtime and approval

- Pinned provider: `@tetherto/wdk-wallet-btc@1.0.0-beta.17`, BIP84, regtest only.
- The WDK account connects only to loopback Electrum TCP, port `50001` by default.
  The standalone service accepts `WDK_ELECTRUM_PORT`; desktop uses the default.
  The Electrum genesis hash must match regtest before network operations.
- The real native sidecar supplies `fundingTarget`: owner, wallet identity,
  regtest network and its uncolored Bitcoin address. It persists that address
  across calls/restarts and blocks funding while an exchange is active.
  The renderer cannot supply or replace a recipient address.
- The user creates the account explicitly, receives plain test BTC into it,
  enters an amount, reviews the destination and fee, then approves sending.
  Desktop approval uses the **Approve & send BTC** button in the funding review,
  without a second native dialog; generic renderer IPC cannot approve.
- Amounts are integer strings, at least 1,000 sats and at most the Bitcoin supply.
  A preview lasts 120 seconds. The current development fee rate is 1 sat/vB;
  its displayed cap is the quote plus 100 sats, bounded by 10,000 sats.
  Code checks owned inputs, the exact recipient/amount, change address,
  SIGHASH_ALL and the actual fee before broadcasting.
- A saved signing intent precedes signing. Signed bytes and their txid are
  persisted before broadcast. On an unknown result, **Check status** checks or
  resends those same bytes. It never signs a replacement transaction. An
  interrupted signature without saved bytes remains blocked for inspection.

The QVAC model is not involved in funding and cannot approve it. Funding routes
exist only on the authenticated local service, not on the public marketplace.

## Run

Use Node 22.17 from this workspace. Start the native regtest environment and
initialize a wallet profile following [settlement.md](../settlement.md) and
[B's handoff](b.md). Keep existing chain volumes and wallet state; do not reset
them to run this feature. Run the Python sidecar with its private RPC token,
then configure the local client with the same owner and RPC URL/token.

For desktop, set the corresponding private `desktop-config.json` values or
`PALKA_OWNER_ID`, `PALKA_WALLET_RPC_URL` and `PALKA_WALLET_RPC_TOKEN` environment
variables. A running, authenticated market is also required for exchange orders.
Funding itself does not use the market.

```sh
rtk proxy npm run dev:desktop
# Or rebuild and open the macOS app:
rtk proxy npm run package:desktop
rtk proxy open .dist/desktop/palka-darwin-arm64/palka.app
```

In **Overview → Fund your exchange wallet**, create the WDK account, send test
BTC to its displayed address, wait for the local indexer, and review a transfer.
Its balance is separate from the BTC/RGB balances of the exchange wallet.
Without a real regtest wallet or a working indexer, the panel reports why it
is unavailable. Mock mode cannot fund a wallet.

The default root Docker stack does not launch the native sidecar or put
Electrum into the client's loopback namespace. The real check below ran on the
host with the regtest services from `infra/compose.yaml`; it is not proof of a
complete Docker deployment.

## Local storage

The standalone service stores the account in
`<LOCAL_STATE_DIR>/funding/funding.sqlite`; desktop uses
`<Electron userData>/state/<owner>/funding/funding.sqlite`.
The shared-profile launcher can override the desktop state root with
`PALKA_LOCAL_STATE_DIR`; its funding account follows that directory.
The directory is mode 0700 and the database 0600. A process guard prevents
two services from opening the same funding account concurrently.

The regtest mnemonic and signed transaction are **unencrypted on disk** in
this private database. They are never returned to the renderer, market or logs.
Keep this ignored directory when restarting; it is the account backup. This
storage is for test funds only. OS-backed secret storage and a reviewed backup
flow are required before extending the feature beyond regtest.

## Verification on 2026-10-17

The explicit smoke requires Docker, the built native SDK, an initialized
`alice` profile in `packages/wallet/state/wdk-funding-demo`, and a funded
`regtest-miner` Bitcoin Core wallet. `RGB_DEMO_STATE` can select another prepared
test directory. It creates a separate private WDK account, sends test BTC,
mines blocks and writes only public evidence. It does not initialize/reset the
chain or download models.

```sh
rtk proxy node_modules/node/bin/node --import tsx \
  apps/local-client/scripts/wdk-smoke.ts --execute
```

Actual result in [wdk-funding.json](../../scripts/demo/evidence/wdk-funding.json):

- Authenticated local HTTP API → WDK signing/broadcast → native RGB wallet.
- Amount **50,000 sats**; actual Bitcoin fee **141 sats**, below the 241-sat cap.
- Txid `a8b15b0bf2593a64a15977cff2a12d63ee25e0e3984153aed9ceaf993cef4b2f`.
- Restart before confirmation retained the account address and the same txid.
- Bitcoin Core confirmed the transaction; native Alice BTC increased by
  exactly 50,000 sats. No mock balance or canned transaction ID was used.

Contract tests cover stale/changed previews, owner and destination mismatch,
amount/fee bounds, signing uncertainty, lost broadcast responses, exact-byte
recovery after restart and renderer approval restrictions. Test doubles are
separate from the real transfer evidence.

This check funds BTC only. It does not prove a complete desktop QVAC → published
order → direct/ring RGB settlement flow or guarantee a judging bonus.
