// Uses A's real HttpWalletAdapter and schemas against B's real loopback sidecar.
// Read-only: does not approve, sign or broadcast.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpWalletAdapter } from '../../apps/local-client/src/wallet.ts';
import {
  SettlementPackageSchema,
  WalletPreviewSchema,
  PrepareResultSchema,
  ReceiptSchema,
} from '../../packages/contracts/src/index.ts';
import { planDigest } from '../../packages/contracts/src/digest.ts';

const adapter = new HttpWalletAdapter(process.env.WALLET_RPC_URL!, process.env.WALLET_RPC_TOKEN!);
const review = JSON.parse(readFileSync(process.env.RGB_REVIEW!, 'utf8'));
const caps = await adapter.capabilities();
assert.equal(caps.mode, 'real');
assert.ok(caps.directSwap && caps.ringSwap && caps.signing && caps.broadcast);
const state = await adapter.state();
assert.equal(state.ownerId, 'alice');
assert.equal(state.network, 'regtest');
assert.equal(planDigest(review.plan), review.plan.digest);
SettlementPackageSchema.parse(review.package);
WalletPreviewSchema.parse(review.previews.alice);
PrepareResultSchema.parse({ status: 'ready', settlementPackage: review.package });
const receipt = ReceiptSchema.parse(await adapter.sync(review.plan.tradeId));
assert.equal(receipt.state, 'confirmed');
assert.ok(receipt.chainConfirmed && receipt.rgbAccepted);
console.log(
  JSON.stringify({
    realHttpWalletAdapter: true,
    protocolVersion: 1,
    schemasValidated: true,
    txid: receipt.txid,
    signed: false,
  }),
);
