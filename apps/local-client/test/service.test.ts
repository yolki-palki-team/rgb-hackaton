import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planDigest } from '@rgb-exchange/contracts/digest';
import type {
  AssetRef,
  Approval,
  PrivatePolicy,
  Receipt,
  SettlementPackage,
  TradePlan,
  TradeSnapshot,
  WalletAdapter,
  WalletPreview,
  WalletState,
} from '@rgb-exchange/contracts';
import { LocalService } from '../src/service.ts';
import { createLocalServer } from '../src/server.ts';
import { LocalStore } from '../src/store.ts';
import { MarketClient } from '../src/market-client.ts';
import { MockWalletAdapter } from '../src/wallet.ts';
import { MarketStore } from '../../market/src/store.ts';
import { createMarketServer } from '../../market/src/server.ts';

const btc: AssetRef = { network: 'regtest', kind: 'btc', precision: 8, symbol: 'BTC' };
const dusd: AssetRef = {
  network: 'regtest',
  kind: 'rgb',
  contractId: 'dusd-test',
  precision: 0,
  symbol: 'DUSD',
};
const wrongDusd: AssetRef = { ...dusd, contractId: 'other-contract' };
const now = Date.now();
const digest0 = '0'.repeat(64);
const digest1 = '1'.repeat(64);

function plan(orderId: string): TradePlan {
  const base = {
    protocolVersion: 1 as const,
    tradeId: 'trade-1',
    revision: 0,
    network: 'regtest' as const,
    orderRefs: [
      { orderId, revision: 1 },
      { orderId: 'order-b', revision: 1 },
    ],
    participants: ['a', 'b'],
    legs: [
      { fromOwnerId: 'a', toOwnerId: 'b', asset: btc, amount: '100000' },
      { fromOwnerId: 'b', toOwnerId: 'a', asset: dusd, amount: '100' },
    ],
    fees: [
      { ownerId: 'a', feeSats: '1000' },
      { ownerId: 'b', feeSats: '1000' },
    ],
    feeState: 'estimate' as const,
    createdAt: now,
  };
  return { ...base, digest: planDigest(base) };
}

function pkg(trade: TradePlan): SettlementPackage {
  return {
    protocolVersion: 1,
    packageId: 'package-1',
    tradeId: trade.tradeId,
    planRevision: trade.revision,
    planDigest: trade.digest,
    network: trade.network,
    unsignedTxDigest: digest0,
    commitmentDigest: digest1,
    format: 'test-double',
    payload: { note: 'not real Bitcoin/RGB material' },
  };
}

class FakeWallet implements WalletAdapter {
  stateValue: WalletState = {
    walletId: 'wallet-a',
    ownerId: 'a',
    network: 'regtest',
    mode: 'real',
    observedAt: now,
    balances: [
      { asset: btc, amount: '1000000' },
      { asset: dusd, amount: '1000' },
    ],
  };
  previewAsset: AssetRef = dusd;
  feeSats = '500';
  signCount = 0;
  releaseCount = 0;
  beforeSign?: () => void;
  async capabilities() {
    return {
      protocolVersion: 1 as const,
      mode: 'real' as const,
      network: 'regtest' as const,
      directSwap: true,
      ringSwap: true,
      signing: true,
      broadcast: true,
      adapterVersion: 'test-double',
    };
  }
  async state() {
    return structuredClone(this.stateValue);
  }
  async reserve(_plan: TradePlan) {
    return { reservationId: 'reservation-test' };
  }
  async release(_tradeId: string) {
    this.releaseCount++;
  }
  async prepare(_plan: TradePlan, _materials: Array<{ ownerId: string; material: unknown }>) {
    return { status: 'pending' as const };
  }
  async validate(packageValue: SettlementPackage, trade: TradePlan): Promise<WalletPreview> {
    const btcAmount = BigInt(this.stateValue.balances[0].amount) - 100000n - BigInt(this.feeSats);
    const dusdAmount = BigInt(this.stateValue.balances[1].amount) + 100n;
    return {
      walletId: 'wallet-a',
      ownerId: 'a',
      mode: 'real',
      network: 'regtest',
      packageId: packageValue.packageId,
      planDigest: trade.digest,
      unsignedTxDigest: packageValue.unsignedTxDigest,
      commitmentDigest: packageValue.commitmentDigest,
      validated: true,
      reasons: [],
      give: { asset: btc, amount: '100000' },
      receive: { asset: this.previewAsset, amount: '100' },
      feeSats: this.feeSats,
      btcDelta: (-100000n - BigInt(this.feeSats)).toString(),
      balancesAfter: [
        { asset: btc, amount: btcAmount.toString() },
        { asset: dusd, amount: dusdAmount.toString() },
      ],
    };
  }
  async sign(_packageValue: SettlementPackage, _approval: Approval) {
    this.beforeSign?.();
    this.signCount++;
    return { status: 'signed' as const, signature: { testOnly: true } };
  }
  async finalize(
    _packageValue: SettlementPackage,
    _signatures: Array<{ ownerId: string; signature: unknown }>,
  ): Promise<Receipt> {
    return this.sync('trade-1');
  }
  async sync(tradeId: string): Promise<Receipt> {
    return {
      mode: 'real',
      tradeId,
      network: 'regtest',
      chainConfirmed: false,
      rgbAccepted: false,
      state: 'reconciling',
      reason: 'test double',
    };
  }
}

class FakeMarket {
  connected = true;
  sequence = 0;
  trade?: TradeSnapshot;
  messages: unknown[] = [];
  failSignatureRelay = false;
  async snapshot() {
    return { sequence: 0, orders: [], myOrders: [], trades: [], events: [] };
  }
  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (path === '/orders' && method === 'POST') return { order: body };
    if (path.startsWith('/trades/') && path.endsWith('/messages') && method === 'POST') {
      if (
        this.failSignatureRelay &&
        (body as { type?: string; payload?: { signature?: unknown } }).type === 'signature' &&
        (body as { payload?: { signature?: unknown } }).payload?.signature !== undefined
      )
        throw new Error('relay unavailable');
      this.messages.push(body);
      const message = body as { type?: string; payload?: { signatureMayExist?: boolean } };
      if (this.trade && message.type === 'signature' && message.payload?.signatureMayExist)
        this.trade = { ...this.trade, status: 'SIGNING' };
      return { event: { sequence: this.messages.length } };
    }
    if (path.startsWith('/trades/') && this.trade) return { trade: this.trade };
    throw new Error(`Unexpected market request ${method} ${path}`);
  }
}

const qvac = {
  async health() {
    return { available: false, model: 'test-double' };
  },
  async interpret() {
    throw new Error('not used');
  },
};

async function fixture(store: LocalStore, wallet = new FakeWallet(), market = new FakeMarket()) {
  const service = new LocalService('a', wallet, market as unknown as MarketClient, store, qvac);
  const policy: PrivatePolicy = {
    allowedAssetKeys: ['regtest:btc:btc', 'regtest:rgb:dusd-test'],
    protectedBalances: {},
    maxFeeSats: '1000',
    allowBtcSale: true,
  };
  const published = await service.publish({
    draft: {
      giveAsset: btc,
      giveAmount: '100000',
      receiveAsset: dusd,
      minReceiveAmount: '100',
      maxFeeSats: '1000',
      expiresAt: now + 60000,
    },
    policy,
    confirmed: true,
    requestId: randomUUID(),
  });
  const tradePlan = plan(published.id);
  market.trade = {
    plan: tradePlan,
    status: 'AWAITING_APPROVAL',
    settlementPackage: pkg(tradePlan),
    messages: [],
  };
  return { service, wallet, market, tradePlan, published };
}

test('local preview rejects a changed RGB contract and fee above user limit', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet } = await fixture(store);
    wallet.previewAsset = wrongDusd;
    await assert.rejects(service.preview('trade-1'), /changes plan amounts or assets/);
    wallet.previewAsset = dusd;
    wallet.feeSats = '1001';
    await assert.rejects(service.preview('trade-1'), /Final fee exceeds the order limit/);
    assert.equal(wallet.signCount, 0);
  } finally {
    store.close();
  }
});

test('stale preview requires new approval before signing', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    wallet.stateValue.balances[0].amount = '999999';
    await assert.rejects(
      service.approve('trade-1', { approvalToken, confirmed: true }),
      /Terms changed/,
    );
    assert.equal(wallet.signCount, 0);
  } finally {
    store.close();
  }
});

test('local client rejects a trade for another owner even if market returns it', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, market, tradePlan } = await fixture(store);
    const otherBase = {
      ...tradePlan,
      participants: ['b', 'c'],
      legs: [
        { fromOwnerId: 'b', toOwnerId: 'c', asset: btc, amount: '100000' },
        { fromOwnerId: 'c', toOwnerId: 'b', asset: dusd, amount: '100' },
      ],
      fees: [
        { ownerId: 'b', feeSats: '1000' },
        { ownerId: 'c', feeSats: '1000' },
      ],
    };
    market.trade = {
      plan: { ...otherBase, digest: planDigest(otherBase) },
      status: 'RESERVED',
      messages: [],
    };
    await assert.rejects(service.trade('trade-1'), /Invalid participant/);
  } finally {
    store.close();
  }
});

test('uncertain signature relay persists across restart and keeps market reservation locked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgb-local-service-'));
  const path = join(dir, 'client.sqlite');
  const store = new LocalStore(path);
  let second: LocalStore | undefined;
  try {
    const { service, wallet, market } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    market.failSignatureRelay = true;
    await assert.rejects(
      service.approve('trade-1', { approvalToken, confirmed: true }),
      /relay unavailable/,
    );
    assert.equal(wallet.signCount, 1);
    assert.equal(store.get<{ state: string }>('operation:trade-1')?.state, 'RECONCILING');
    store.close();
    second = new LocalStore(path);
    const restarted = new LocalService(
      'a',
      wallet,
      market as unknown as MarketClient,
      second,
      qvac,
    );
    await assert.rejects(restarted.prepare('trade-1'), /Reconciliation is required after signing/);
    const result = await restarted.reject('trade-1', 'Relay uncertain');
    assert.equal(result.status, 'reconciling');
    assert.equal(
      (market.messages.at(-1) as { payload: { signatureMayExist?: boolean } }).payload
        .signatureMayExist,
      true,
    );
    assert.equal(wallet.releaseCount, 0);
  } finally {
    second?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('market sees durable signing intent before wallet receives sign call', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    wallet.beforeSign = () =>
      assert.equal(
        market.messages.some((message) => {
          const item = message as { type?: string; payload?: { signatureMayExist?: boolean } };
          return item.type === 'signature' && item.payload?.signatureMayExist === true;
        }),
        true,
      );
    await service.approve('trade-1', { approvalToken, confirmed: true });
    assert.equal(wallet.signCount, 1);
  } finally {
    store.close();
  }
});

test('market client deduplicates events and resumes from the last observed sequence', async () => {
  const delivered: number[] = [];
  const client = new MarketClient('http://127.0.0.1:4100', 'test-token', (event) =>
    delivered.push(event.sequence),
  );
  const event = {
    protocolVersion: 1 as const,
    eventId: 'event-5',
    sequence: 5,
    type: 'order.created' as const,
    revision: 0,
    payload: { orderId: 'order-5' },
  };
  let requestedPath = '';
  client.request = async (path) => {
    requestedPath = path;
    return { sequence: 9, orders: [], myOrders: [], trades: [], events: [event] };
  };
  assert.equal(client.accept(event), true);
  assert.equal(client.accept(event), false);
  assert.equal(client.accept({ ...event, eventId: 'event-4', sequence: 4 }), false);
  await client.snapshot();
  assert.equal(requestedPath, '/snapshot?afterSequence=5');
  assert.equal(client.sequence, 9);
  assert.equal(client.accept({ ...event, eventId: 'event-10', sequence: 10 }), true);
  assert.deepEqual(delivered, [5, 10]);
  client.close();
});

test('server confirmation cannot substitute for local wallet sync and repeated sync does not relay to a closed trade', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, market, wallet } = await fixture(store);
    market.trade = { ...market.trade!, status: 'CONFIRMED' };
    const pending = await service.sync('trade-1');
    assert.equal(pending.state, 'reconciling');
    assert.equal(pending.chainConfirmed, false);
    assert.equal(market.messages.length, 0);
    wallet.sync = async (tradeId: string) => ({
      mode: 'real',
      tradeId,
      network: 'regtest',
      txid: 'a'.repeat(64),
      chainConfirmed: true,
      rgbAccepted: true,
      state: 'confirmed',
    });
    const confirmed = await service.sync('trade-1');
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(market.messages.length, 0);
    assert.equal(store.get<{ state: string }>('operation:trade-1')?.state, 'CONFIRMED');
  } finally {
    store.close();
  }
});

test('local HTTP accepts only its own origin and requires a bearer for wallet state', async () => {
  const store = new LocalStore(':memory:');
  const { service } = await fixture(store);
  const origins: string[] = [];
  const server = createLocalServer(service, { token: 'a'.repeat(40), allowedOrigins: origins });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const self = `http://127.0.0.1:${address.port}`;
  origins.push(self);
  const url = `${self}/api/state`;
  const authorization = `Bearer ${'a'.repeat(40)}`;
  const withHost = (host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        url,
        { headers: { Host: host, Authorization: authorization } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.end();
    });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (
        await fetch(url, {
          headers: { Origin: 'http://evil.example', Authorization: authorization },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          headers: { Origin: 'http://127.0.0.1:5173', Authorization: authorization },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url, { headers: { Origin: self, Authorization: 'Bearer invalid' } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          headers: { Origin: self, Authorization: authorization, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: authorization, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
      403,
    );
    assert.equal(await withHost('evil.example'), 403);
    assert.equal(await withHost('127.0.0.1:5173'), 403);
    assert.equal((await fetch(url, { headers: { Authorization: authorization } })).status, 200);
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: authorization, 'Sec-Fetch-Site': 'same-origin' },
        })
      ).status,
      200,
    );
    const allowed = await fetch(url, { headers: { Origin: self, Authorization: authorization } });
    assert.equal(allowed.status, 200);
    assert.equal(((await allowed.json()) as { ownerId: string }).ownerId, 'a');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('local UI serves only built files and never falls back to private files or API paths', async () => {
  const store = new LocalStore(':memory:');
  const { service } = await fixture(store);
  const directory = mkdtempSync(join(tmpdir(), 'rgb-local-ui-'));
  mkdirSync(join(directory, 'assets'));
  writeFileSync(
    join(directory, 'index.html'),
    '<!doctype html><script src="/assets/app.js"></script>',
  );
  writeFileSync(join(directory, 'assets', 'app.js'), 'window.app = true;');
  writeFileSync(join(directory, '.env'), 'SECRET_SHOULD_NOT_LEAK');
  symlinkSync(join(directory, '.env'), join(directory, 'assets', 'secrets.js'));
  const server = createLocalServer(service, { token: 'a'.repeat(40), uiDirectory: directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const index = await fetch(url);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await index.text(), /assets\/app.js/);
    const asset = await fetch(`${url}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'window.app = true;');
    for (const path of [
      '/.env',
      '/assets/secrets.js',
      '/assets/%2e%2e/.env',
      '/api/no-such-route',
    ]) {
      const response = await fetch(`${url}${path}`);
      assert.notEqual(response.status, 200, path);
      assert.doesNotMatch(await response.text(), /SECRET_SHOULD_NOT_LEAK|window\.app/);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing local UI returns build guidance while private API stays available', async () => {
  const store = new LocalStore(':memory:');
  const { service } = await fixture(store);
  const directory = join(tmpdir(), `rgb-missing-ui-${randomUUID()}`);
  const server = createLocalServer(service, { token: 'a'.repeat(40), uiDirectory: directory });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const index = await fetch(url);
    assert.equal(index.status, 503);
    assert.match(await index.text(), /Local UI is not built/);
    assert.equal(
      (await fetch(`${url}/api/state`, { headers: { Authorization: `Bearer ${'a'.repeat(40)}` } }))
        .status,
      200,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('three local mock clients form one ring on the real market server without settlement claims', async () => {
  const marketStore = new MarketStore(':memory:');
  const server = createMarketServer(
    marketStore,
    new Map([
      ['token-a', 'a'],
      ['token-b', 'b'],
      ['token-c', 'c'],
    ]),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const stores = [
    new LocalStore(':memory:'),
    new LocalStore(':memory:'),
    new LocalStore(':memory:'),
  ];
  const clients = ['a', 'b', 'c'].map((owner) => new MarketClient(url, `token-${owner}`));
  try {
    const services = ['a', 'b', 'c'].map(
      (owner, index) =>
        new LocalService(owner, new MockWalletAdapter(owner), clients[index], stores[index], qvac),
    );
    const states = await Promise.all(services.map((service) => service.state()));
    const mockX = states[0].balances.find((balance) => balance.asset.symbol === 'X')!.asset;
    const mockD = states[0].balances.find((balance) => balance.asset.symbol === 'DUSD')!.asset;
    const mockB = states[0].balances.find((balance) => balance.asset.symbol === 'BTC')!.asset;
    const common = { protectedBalances: {}, maxFeeSats: '1000', allowBtcSale: true };
    const policies = states.map((state) => ({
      ...common,
      allowedAssetKeys: state.balances.map(
        (balance) =>
          `${balance.asset.network}:${balance.asset.kind}:${balance.asset.kind === 'rgb' ? balance.asset.contractId : 'btc'}`,
      ),
    }));
    const terms = [
      [mockX, '100', mockD, '100'],
      [mockD, '100', mockB, '100000'],
      [mockB, '100000', mockX, '100'],
    ] as const;
    for (let i = 0; i < 3; i++) {
      const [giveAsset, giveAmount, receiveAsset, minReceiveAmount] = terms[i];
      await services[i].publish({
        draft: {
          giveAsset,
          giveAmount,
          receiveAsset,
          minReceiveAmount,
          maxFeeSats: '1000',
          expiresAt: Date.now() + 60000,
        },
        policy: policies[i],
        confirmed: true,
        requestId: randomUUID(),
      });
    }
    const snapshot = await clients[0].snapshot();
    assert.equal(snapshot.trades.length, 1);
    assert.equal(snapshot.trades[0].plan.participants.length, 3);
    assert.equal(snapshot.trades[0].status, 'RESERVED');
    const result = await services[0].prepare(snapshot.trades[0].plan.tradeId);
    assert.equal(result.status, 'unsupported');
    assert.equal(marketStore.getTrade(snapshot.trades[0].plan.tradeId, 'b')?.status, 'UNSUPPORTED');
    assert.equal(
      marketStore.getOrder(snapshot.trades[0].plan.orderRefs[0].orderId)?.status,
      'CANCELLED',
    );
    assert.equal((await services[0].wallet.sync(snapshot.trades[0].plan.tradeId)).txid, undefined);
  } finally {
    for (const client of clients) client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const store of stores) store.close();
    marketStore.close();
  }
});
