/** Explicit real regtest funding test. No mainnet, RGB transfer, model call or canned txid. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpWalletAdapter } from '../src/wallet.ts';
import { WdkFunding } from '../src/wdk-funding.ts';
import { createLocalServer } from '../src/server.ts';
import { LocalService } from '../src/service.ts';
import { LocalStore } from '../src/store.ts';
import { MarketClient } from '../src/market-client.ts';
import type { FundingOperation, FundingStatus } from '../src/funding-types.ts';

if (!process.argv.includes('--execute'))
  throw new Error('This sends test BTC. Pass --execute to run the regtest smoke.');
const root = resolve(import.meta.dirname, '../../..');
const rgbState = resolve(process.env.RGB_DEMO_STATE ?? 'packages/wallet/state/wdk-funding-demo');
const localState = resolve('.state', `wdk-funding-${Date.now()}`);
mkdirSync(localState, { recursive: true, mode: 0o700 });
const port = Number(process.env.WDK_SMOKE_RPC_PORT ?? 4287);
const token = randomBytes(32).toString('hex');
const pairing = randomBytes(32).toString('hex');
const rpc = (...args: string[]) =>
  execFileSync(
    'rtk',
    [
      'proxy',
      'docker',
      'compose',
      '-f',
      'infra/compose.yaml',
      'exec',
      '-T',
      '-u',
      'blits',
      'bitcoind',
      'bitcoin-cli',
      '-regtest',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  ).trim();
const chain = JSON.parse(rpc('getblockchaininfo'));
assert.equal(chain.chain, 'regtest');
const python = resolve('.venv/bin/python3');
const sidecar = spawn(
  python,
  ['packages/wallet/server.py', '--profile', 'alice', '--owner', 'alice', '--port', String(port)],
  {
    cwd: root,
    env: { ...process.env, RGB_DEMO_STATE: rgbState, WALLET_RPC_TOKEN: token },
    stdio: 'ignore',
  },
);
const wallet = new HttpWalletAdapter(`http://127.0.0.1:${port}`, token);
const store = new LocalStore(resolve(localState, 'local.sqlite'));
const market = new MarketClient('http://127.0.0.1:4100', randomBytes(32).toString('hex'));
const service = new LocalService('alice', wallet, market, store, {
  health: async () => ({ available: false, model: 'not used by funding smoke' }),
  interpret: async () => {
    throw new Error('Funding smoke does not invoke AI.');
  },
});
const options = { directory: resolve(localState, 'funding'), ownerId: 'alice', wallet };
let funding = new WdkFunding(options);
let server = createLocalServer(service, { token: pairing, funding });
let base = '';
async function start() {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
}
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${pairing}`,
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  assert.ok(response.ok, result.error ?? `HTTP ${response.status}`);
  return result as T;
}
async function poll<T>(work: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 40; i++) {
    try {
      const value = await work();
      if (done(value)) return value;
    } catch {
      /* Local indexer/sidecar startup. */
    }
    await delay(500);
  }
  throw new Error('Local regtest/indexer did not become ready.');
}
try {
  const before = await poll(
    () => wallet.state(),
    (state) => state.mode === 'real',
  );
  const btcBefore = BigInt(before.balances.find((b) => b.asset.kind === 'btc')!.amount);
  await start();
  const created = await call<FundingStatus>('POST', '/api/funding/create', { confirmed: true });
  assert.ok(created.available && created.address);
  // A separate miner funds the new WDK account with uncolored test BTC.
  const initialTxid = rpc('-rpcwallet=regtest-miner', 'sendtoaddress', created.address, '0.002');
  const miningAddress = rpc('-rpcwallet=regtest-miner', 'getnewaddress');
  rpc('generatetoaddress', '1', miningAddress);
  await poll(
    () => call<FundingStatus>('GET', '/api/funding'),
    (s) => BigInt(s.balanceSats ?? '0') >= 200_000n,
  );
  const preview = await call<FundingOperation>('POST', '/api/funding/preview', {
    amountSats: '50000',
  });
  assert.equal(preview.status, 'PREVIEW');
  assert.equal(preview.network, 'regtest');
  assert.notEqual(preview.address, created.address);
  const sent = await call<FundingOperation>('POST', '/api/funding/approve', {
    operationId: preview.id,
    confirmed: true,
  });
  assert.ok(sent.txid, sent.reason);
  assert.ok(['BROADCAST', 'RECONCILING'].includes(sent.status), sent.reason);
  // Restart before confirmation: new instance must recover the same funding account and operation.
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  funding.close();
  funding = new WdkFunding(options);
  server = createLocalServer(service, { token: pairing, funding });
  await start();
  const restarted = await call<FundingStatus>('GET', '/api/funding');
  assert.equal(restarted.address, created.address);
  assert.equal(restarted.operation?.txid, sent.txid);
  rpc('generatetoaddress', '1', miningAddress);
  const confirmed = await poll(
    () => call<FundingStatus>('POST', '/api/funding/sync', {}),
    (s) => s.operation?.status === 'CONFIRMED',
  );
  const after = await poll(
    () => wallet.state(),
    (state) =>
      BigInt(state.balances.find((b) => b.asset.kind === 'btc')!.amount) === btcBefore + 50_000n,
  );
  const btcAfter = BigInt(after.balances.find((b) => b.asset.kind === 'btc')!.amount);
  const decoded = JSON.parse(rpc('getrawtransaction', sent.txid!, 'true'));
  const outputs = decoded.vout.filter(
    (v: { scriptPubKey: { address?: string } }) => v.scriptPubKey.address === preview.address,
  );
  assert.equal(outputs.length, 1);
  assert.equal(Math.round(outputs[0].value * 1e8), 50_000);
  const evidence = {
    checkedAt: new Date().toISOString(),
    network: 'regtest',
    provider: '@tetherto/wdk-wallet-btc@1.0.0-beta.17',
    path: 'authenticated local HTTP API -> WDK sign/send -> native RGB wallet state',
    initialFundingTxid: initialTxid,
    txid: sent.txid,
    operationId: sent.id,
    amountSats: '50000',
    feeSats: confirmed.operation!.feeSats,
    maxFeeSats: preview.maxFeeSats,
    status: confirmed.operation!.status,
    recipientBtcDeltaSats: String(btcAfter - btcBefore),
    accountAndTransactionPersistedAcrossRestart: true,
    confirmations: decoded.confirmations,
    limits: [
      'Funding only; no RGB asset transfer or atomic swap in this check.',
      'Unit tests cover lost broadcast responses; this live check covers restart before confirmation.',
      'Regtest private state is unencrypted, local and ignored by Git.',
    ],
  };
  writeFileSync(
    resolve('scripts/demo/evidence/wdk-funding.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(JSON.stringify(evidence));
} finally {
  if (server.listening) await new Promise<void>((done) => server.close(() => done()));
  funding.close();
  market.close();
  store.close();
  sidecar.kill('SIGTERM');
}
