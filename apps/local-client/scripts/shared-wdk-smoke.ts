/** Real shared-regtest WDK transfer; called by shared-network-smoke.py only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpWalletAdapter } from '../src/wallet.ts';
import { WdkFunding } from '../src/wdk-funding.ts';

if (!process.argv.includes('--execute'))
  throw new Error('Pass --execute for a real regtest transfer.');
const directory = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(resolve(directory, 'desktop-config.json'), 'utf8'));
const wallet = new HttpWalletAdapter(config.walletRpcUrl, config.walletRpcToken);
async function poll<T>(work: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const value = await work();
      if (ready(value)) return value;
    } catch {
      /* Wait for real chain/indexer readiness. */
    }
    await delay(1000);
  }
  throw new Error('Shared chain did not become ready.');
}
const before = await poll(
  () => wallet.state(),
  (state) => state.mode === 'real',
);
const btc = (state: typeof before) =>
  BigInt(state.balances.find((item) => item.asset.kind === 'btc')!.amount);
const rgb = before.balances.filter((item) => item.asset.kind === 'rgb');
assert.equal(rgb.length, 2);
assert.equal(rgb.find((item) => item.asset.symbol === 'X')?.amount, '1000');
assert.equal(rgb.find((item) => item.asset.symbol === 'DUSD')?.amount, '0');
const options = {
  directory: resolve(directory, 'wdk-smoke'),
  ownerId: config.ownerId,
  wallet,
  electrumPort: 51001,
};
let funding = new WdkFunding(options);
try {
  const created = await funding.create({ confirmed: true });
  assert.ok(created.available && created.address);
  execFileSync(
    resolve('.venv/bin/python'),
    [
      'scripts/demo/desktop_wallet.py',
      'fund',
      '--desktop-data-dir',
      directory,
      '--wdk-address',
      created.address,
    ],
    { stdio: 'pipe' },
  );
  await poll(
    () => funding.status(),
    (status) => BigInt(status.balanceSats ?? '0') >= 100000n,
  );
  const preview = await funding.preview({ amountSats: '50000' });
  assert.equal(preview.network, 'regtest');
  const sent = await funding.approve({ operationId: preview.id, confirmed: true });
  assert.ok(sent.txid, sent.reason);
  funding.close();
  funding = new WdkFunding(options);
  assert.equal((await funding.status()).address, created.address);
  const confirmed = await poll(
    () => funding.sync(),
    (status) => status.operation?.status === 'CONFIRMED',
  );
  const after = await poll(
    () => wallet.state(),
    (state) => btc(state) === btc(before) + 50000n,
  );
  console.log(
    JSON.stringify({
      network: 'regtest',
      transport: 'HTTPS',
      wdk: 'CONFIRMED',
      txid: confirmed.operation?.txid,
      recipientDeltaSats: String(btc(after) - btc(before)),
      feeSats: confirmed.operation?.feeSats,
      rgbContractsVerified: rgb.length,
      restartPreservedAccount: true,
    }),
  );
} finally {
  funding.close();
}
