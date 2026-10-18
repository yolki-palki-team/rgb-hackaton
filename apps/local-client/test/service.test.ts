import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planDigest } from '@rgb-exchange/contracts/digest';
import { sameAsset } from '@rgb-exchange/contracts';
import type {
  CoordinationMessage,
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
  finalizeCount = 0;
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
    const give = trade.legs.find((leg) => leg.fromOwnerId === 'a')!;
    const receive = trade.legs.find((leg) => leg.toOwnerId === 'a')!;
    const btcDelta =
      (receive.asset.kind === 'btc' ? BigInt(receive.amount) : 0n) -
      (give.asset.kind === 'btc' ? BigInt(give.amount) : 0n) -
      BigInt(this.feeSats);
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
      give: { asset: give.asset, amount: give.amount },
      receive: { asset: this.previewAsset, amount: receive.amount },
      feeSats: this.feeSats,
      btcDelta: String(btcDelta),
      balancesAfter: this.stateValue.balances.map((balance) => ({
        asset: balance.asset,
        amount: String(
          BigInt(balance.amount) -
            (sameAsset(balance.asset, give.asset) ? BigInt(give.amount) : 0n) +
            (sameAsset(balance.asset, receive.asset) ? BigInt(receive.amount) : 0n) -
            (balance.asset.kind === 'btc' ? BigInt(this.feeSats) : 0n),
        ),
      })),
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
    this.finalizeCount++;
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
    return {
      sequence: 0,
      orders: [],
      myOrders: [],
      trades: this.trade ? [this.trade] : [],
      events: [],
    };
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
      if (this.trade) {
        if (message.type === 'reject')
          this.trade.status = ['SIGNING', 'RECONCILING'].includes(this.trade.status)
            ? 'RECONCILING'
            : 'REJECTED';
        if (
          !this.trade.messages.some(
            (item) => item.message.messageId === (body as CoordinationMessage).messageId,
          )
        )
          this.trade.messages.push({ ownerId: 'a', message: body as CoordinationMessage });
      }
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

async function fixture(
  store: LocalStore,
  wallet = new FakeWallet(),
  market = new FakeMarket(),
  partialFill?: { minGiveAmount: string },
) {
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
      ...(partialFill ? { partialFill } : {}),
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

async function saveCommittedIntent(service: LocalService, store: LocalStore) {
  await service.preview('trade-1');
  const { package: packageValue, approval } = store.get<{
    package: SettlementPackage;
    approval: Approval;
  }>('approval:trade-1')!;
  store.set('signing:trade-1', { package: packageValue, approval });
  store.set('signature:trade-1', { testOnly: true });
  store.set('operation:trade-1', { state: 'SIGNED' });
}

test('local record enumeration binds literal prefixes without SQL or wildcard interpretation', () => {
  const store = new LocalStore(':memory:');
  try {
    store.set('operation:trade-1', { state: 'SIGNED' });
    store.set('operation:trade-2', { state: 'PREPARING' });
    store.set('receipt:trade-1', { state: 'pending' });
    for (const prefix of ['operation_%:', "operation' OR 1=1 --", 'operation\\:', 'OPERATION:']) {
      const key = `${prefix}literal`;
      store.set(key, { marker: key });
      assert.deepEqual(store.entries(prefix), [{ key, value: { marker: key } }]);
    }
    assert.deepEqual(store.entries('operation:'), [
      { key: 'operation:trade-1', value: { state: 'SIGNED' } },
      { key: 'operation:trade-2', value: { state: 'PREPARING' } },
    ]);
  } finally {
    store.close();
  }
});

test('Mutinynet state, capability and receipt checks are bound to the isolated local profile', async () => {
  const store = new LocalStore(':memory:');
  const wallet = new FakeWallet();
  const market = new FakeMarket();
  const service = new LocalService(
    'a',
    wallet,
    market as unknown as MarketClient,
    store,
    qvac,
    'signetcustom',
  );
  try {
    assert.equal((await service.health()).network, 'signetcustom');
    assert.equal((await service.health()).wallet, null);
    await assert.rejects(service.state(), /identity\/network mismatch/);
    wallet.stateValue = {
      ...wallet.stateValue,
      network: 'signetcustom',
      balances: wallet.stateValue.balances.map((balance) => ({
        ...balance,
        asset: { ...balance.asset, network: 'signetcustom' },
      })),
    };
    const cap = await wallet.capabilities();
    Object.assign(wallet, { capabilities: async () => ({ ...cap, network: 'signetcustom' }) });
    assert.equal((await service.health()).wallet?.network, 'signetcustom');
    assert.equal((await service.state()).network, 'signetcustom');
    const policy = await service.policy();
    const published = await service.publish({
      draft: {
        giveAsset: wallet.stateValue.balances[0].asset,
        giveAmount: '100000',
        receiveAsset: wallet.stateValue.balances[1].asset,
        minReceiveAmount: '100',
        expiresAt: Date.now() + 60000,
        maxFeeSats: '1000',
      },
      policy,
      confirmed: true,
      requestId: randomUUID(),
    });
    assert.equal(published.network, 'signetcustom');
    const customPlan = {
      ...plan(published.id),
      network: 'signetcustom' as const,
      legs: plan(published.id).legs.map((leg) => ({
        ...leg,
        asset: { ...leg.asset, network: 'signetcustom' as const },
      })),
    };
    customPlan.digest = planDigest(customPlan);
    market.trade = { plan: customPlan, status: 'BROADCAST', messages: [] };
    assert.equal((await service.trade('trade-1')).plan.network, 'signetcustom');
    await assert.rejects(service.sync('trade-1'), /Receipt belongs to another trade or network/);
    Object.assign(wallet, {
      sync: async (tradeId: string) => ({
        tradeId,
        network: 'signetcustom',
        mode: 'real',
        state: 'pending',
        chainConfirmed: false,
        rgbAccepted: false,
      }),
    });
    assert.equal((await service.sync('trade-1')).network, 'signetcustom');
    assert.throws(
      () => new LocalService('a', wallet, market as unknown as MarketClient, store, qvac),
      /separate profile/,
    );
  } finally {
    store.close();
  }
});

test('Mutinynet funding API explicitly rejects WDK operations without creating an account', async () => {
  const store = new LocalStore(':memory:');
  const service = new LocalService(
    'a',
    new FakeWallet(),
    new FakeMarket() as unknown as MarketClient,
    store,
    qvac,
    'signetcustom',
  );
  const token = 'network-test-token-12345678901234567890';
  const server = createLocalServer(service, { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: base,
    'Content-Type': 'application/json',
  };
  try {
    const response = await fetch(`${base}/api/funding`, { headers });
    const funding = (await response.json()) as {
      available: boolean;
      network: string;
      reason: string;
    };
    assert.equal(funding.available, false);
    assert.equal(funding.network, 'signetcustom');
    assert.match(funding.reason, /does not support custom Signet/);
    const create = await fetch(`${base}/api/funding/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(create.status, 409);
    assert.match(await create.text(), /custom Signet is unsupported/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('native receive address remains available without indexer state and rejects another owner or network', async () => {
  const store = new LocalStore(':memory:');
  const wallet = new FakeWallet();
  let target = {
    walletId: 'wallet-a',
    ownerId: 'a',
    network: 'signetcustom',
    address: `tb1${'q'.repeat(39)}`,
  };
  Object.assign(wallet, {
    fundingTarget: async () => target,
    state: async () => {
      throw new Error('Indexer is offline');
    },
    capabilities: async () => {
      throw new Error('Indexer is offline');
    },
  });
  const service = new LocalService(
    'a',
    wallet,
    new FakeMarket() as unknown as MarketClient,
    store,
    qvac,
    'signetcustom',
  );
  const token = 'native-receive-test-token-12345678901234567890';
  const server = createLocalServer(service, { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/funding/target`)).status, 401);
    const response = await fetch(`${base}/api/funding/target`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), target);
    target = { ...target, ownerId: 'another-owner' };
    await assert.rejects(service.fundingTarget(), /another wallet profile/);
    target = { ...target, ownerId: 'a', network: 'regtest', address: `bcrt1${'q'.repeat(39)}` };
    await assert.rejects(service.fundingTarget(), /another wallet profile or network/);
    assert.equal(wallet.signCount, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('legacy local records cannot be reopened as a Mutinynet profile', () => {
  const store = new LocalStore(':memory:');
  try {
    store.set('operation:legacy', { state: 'SIGNED' });
    assert.throws(
      () =>
        new LocalService(
          'a',
          new FakeWallet(),
          new FakeMarket() as unknown as MarketClient,
          store,
          qvac,
          'signetcustom',
        ),
      /separate profile/,
    );
    assert.deepEqual(store.get('operation:legacy'), { state: 'SIGNED' });
    assert.equal(store.get('profile:network'), null);
  } finally {
    store.close();
  }
});

test('market clients verify configured chain before requests and report mismatch as disconnected', async () => {
  const store = new MarketStore(':memory:', 'signetcustom');
  const server = createMarketServer(store, new Map([['token-a', 'a']]));
  let healthRequests = 0;
  server.on('request', (request) => {
    if (request.url === '/health') healthRequests++;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const correct = new MarketClient(base, 'token-a', undefined, undefined, 'signetcustom');
  const wrong = new MarketClient(base, 'token-a', undefined, undefined, 'regtest');
  try {
    assert.deepEqual(await Promise.all([correct.request('/orders'), correct.request('/orders')]), [
      { orders: [] },
      { orders: [] },
    ]);
    assert.deepEqual(await correct.request('/orders'), { orders: [] });
    assert.equal(
      healthRequests,
      1,
      'concurrent and subsequent requests share the session network check',
    );
    assert.equal(correct.connected, true);
    wrong.connected = true;
    await assert.rejects(wrong.request('/orders', 'POST', {}), /Market network does not match/);
    assert.equal(wrong.connected, false);
    assert.equal(healthRequests, 2);
    await assert.rejects(correct.request('/missing'), /NOT_FOUND/);
    assert.equal(correct.connected, false);
    Object.assign(store, { network: 'regtest' });
    await assert.rejects(correct.request('/orders'), /Market network does not match/);
    assert.equal(healthRequests, 3, 'HTTP failures invalidate the session network check');
    assert.equal(store.listOpen().length, 0);
  } finally {
    correct.close();
    wrong.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('market reconnect rechecks the network before opening another WebSocket', async () => {
  const store = new MarketStore(':memory:', 'signetcustom');
  const server = createMarketServer(store, new Map([['token-a', 'a']]));
  let healthRequests = 0;
  let upgrades = 0;
  let disconnect = () => {};
  server.on('request', (request) => {
    if (request.url === '/health') healthRequests++;
  });
  server.on('upgrade', (_request, socket) => {
    upgrades++;
    disconnect = () => socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new MarketClient(
    `http://127.0.0.1:${address.port}`,
    'token-a',
    undefined,
    undefined,
    'signetcustom',
  );
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(condition(), 'market connection reached the expected state');
  };
  try {
    client.connect();
    await until(() => client.connected);
    await client.snapshot();
    assert.equal(healthRequests, 1);
    Object.assign(store, { network: 'regtest' });
    disconnect();
    await until(() => healthRequests >= 2);
    assert.equal(client.connected, false);
    assert.equal(upgrades, 1, 'wrong-chain reconnect must not open another socket');
    Object.assign(store, { network: 'signetcustom' });
    await until(() => client.connected && upgrades === 2);
    assert.ok(healthRequests >= 3);
  } finally {
    client.close();
    disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});

test('automatic recovery survives restart and unavailable capabilities without signing or finalizing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgb-committed-recovery-'));
  const path = join(directory, 'local.sqlite');
  let store = new LocalStore(path);
  try {
    const { service, wallet, market } = await fixture(store);
    await saveCommittedIntent(service, store);
    market.trade!.status = 'BROADCAST';
    store.close();
    store = new LocalStore(path);
    const restarted = new LocalService('a', wallet, market as unknown as MarketClient, store, qvac);
    const capabilities = await wallet.capabilities();
    let capabilityCalls = 0;
    wallet.capabilities = async () => {
      capabilityCalls++;
      return {
        ...capabilities,
        directSwap: false,
        ringSwap: false,
        signing: false,
        broadcast: false,
      };
    };
    wallet.state = async () => {
      throw new Error('Spent input needs reconciliation');
    };
    market.snapshot = async () => {
      throw new Error('Recovery must use durable operations, not the latest 50 trades');
    };
    let syncCalls = 0;
    const receipt: Receipt = {
      mode: 'real',
      tradeId: 'trade-1',
      network: 'regtest',
      state: 'confirmed',
      txid: 'a'.repeat(64),
      chainConfirmed: true,
      rgbAccepted: true,
    };
    wallet.sync = async (id) => {
      assert.equal(id, 'trade-1');
      syncCalls++;
      return receipt;
    };
    assert.equal(await restarted.recoverCommitted(), false);
    assert.equal(await restarted.recoverCommitted(), false);
    assert.equal(syncCalls, 1);
    assert.equal(capabilityCalls, 0);
    assert.equal(wallet.signCount, 0);
    assert.equal(wallet.finalizeCount, 0);
    assert.equal(wallet.releaseCount, 0);
    assert.deepEqual(store.get('receipt:trade-1'), receipt);
    assert.deepEqual(store.get('operation:trade-1'), { state: 'CONFIRMED' });
    assert.deepEqual(
      market.trade!.messages.map((item) => item.message.type),
      ['receipt'],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatic recovery ignores unsigned preparations and peer signing status', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    await service.preview('trade-1');
    store.set('operation:trade-1', { state: 'PREPARING' });
    market.trade!.status = 'SIGNING';
    let syncCalls = 0;
    wallet.sync = async () => {
      syncCalls++;
      throw new Error('Unsigned trades must not be synced automatically');
    };
    assert.equal(await service.recoverCommitted(), false);
    assert.equal(syncCalls, 0);
    assert.equal(wallet.signCount, 0);
    assert.equal(wallet.finalizeCount, 0);
    assert.equal(wallet.releaseCount, 0);
    assert.deepEqual(store.get('operation:trade-1'), { state: 'PREPARING' });
    assert.equal(market.messages.length, 0);
  } finally {
    store.close();
  }
});

test('automatic recovery reports pending receipts until local settlement is confirmed', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    await saveCommittedIntent(service, store);
    market.trade!.status = 'SIGNING';
    let receipt: Receipt = {
      mode: 'real',
      tradeId: 'trade-1',
      network: 'regtest',
      state: 'pending',
      chainConfirmed: false,
      rgbAccepted: false,
    };
    wallet.sync = async () => receipt;
    assert.equal(await service.recoverCommitted(), true);
    assert.deepEqual(store.get('operation:trade-1'), { state: 'SIGNED' });
    receipt = { ...receipt, state: 'reconciling', txid: 'a'.repeat(64) };
    assert.equal(await service.recoverCommitted(), true);
    receipt = { ...receipt, state: 'confirmed', chainConfirmed: true, rgbAccepted: true };
    assert.equal(await service.recoverCommitted(), false);
    assert.deepEqual(store.get('operation:trade-1'), { state: 'CONFIRMED' });
    assert.equal(wallet.signCount, 0);
    assert.equal(wallet.finalizeCount, 0);
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
  }
});

test('automatic recovery rejects changed or unbound packages before calling the wallet', async (t) => {
  for (const change of ['digest', 'package', 'binding'] as const) {
    await t.test(change, async () => {
      const store = new LocalStore(':memory:');
      try {
        const { service, wallet, market } = await fixture(store);
        await saveCommittedIntent(service, store);
        if (change === 'digest') market.trade!.plan.digest = 'f'.repeat(64);
        if (change === 'package') market.trade!.settlementPackage!.payload = { tampered: true };
        if (change === 'binding') store.set('signing:trade-1', null);
        let syncCalls = 0;
        wallet.sync = async () => {
          syncCalls++;
          throw new Error('Changed packages must be rejected before wallet sync');
        };
        await assert.rejects(service.recoverCommitted(), /Committed trade recovery is pending/);
        assert.equal(syncCalls, 0);
        assert.equal(wallet.signCount, 0);
        assert.equal(wallet.finalizeCount, 0);
        assert.equal(wallet.releaseCount, 0);
        assert.deepEqual(store.get('operation:trade-1'), { state: 'SIGNED' });
      } finally {
        store.close();
      }
    });
  }
});

test('automatic recovery preserves receipts and reservations on wallet failure or invalid evidence', async (t) => {
  const prior: Receipt = {
    mode: 'real',
    tradeId: 'trade-1',
    network: 'regtest',
    state: 'pending',
    txid: 'a'.repeat(64),
    chainConfirmed: false,
    rgbAccepted: false,
  };
  const invalid: Array<Receipt | Error> = [
    new Error('Wallet is unavailable'),
    { ...prior, tradeId: 'another-trade' },
    { ...prior, txid: 'b'.repeat(64) },
    { ...prior, txid: undefined },
    { ...prior, state: 'confirmed', chainConfirmed: true, rgbAccepted: false },
  ];
  for (const [index, result] of invalid.entries()) {
    await t.test(`failure ${index + 1}`, async () => {
      const store = new LocalStore(':memory:');
      try {
        const { service, wallet, market } = await fixture(store);
        await saveCommittedIntent(service, store);
        store.set('receipt:trade-1', prior);
        wallet.sync = async () => {
          if (result instanceof Error) throw result;
          return result;
        };
        await assert.rejects(service.recoverCommitted(), /Committed trade recovery is pending/);
        assert.deepEqual(store.get('receipt:trade-1'), prior);
        assert.deepEqual(store.get('operation:trade-1'), { state: 'SIGNED' });
        assert.equal(wallet.signCount, 0);
        assert.equal(wallet.finalizeCount, 0);
        assert.equal(wallet.releaseCount, 0);
        assert.equal(market.messages.length, 0);
      } finally {
        store.close();
      }
    });
  }
});

test('automatic recovery keeps a confirmed receipt when relay fails and retries without signing', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    await saveCommittedIntent(service, store);
    market.trade!.status = 'RECONCILING';
    const receipt: Receipt = {
      mode: 'real',
      tradeId: 'trade-1',
      network: 'regtest',
      state: 'confirmed',
      txid: 'a'.repeat(64),
      chainConfirmed: true,
      rgbAccepted: true,
    };
    wallet.sync = async () => receipt;
    const request = market.request.bind(market);
    let unavailable = true;
    market.request = async (path, method, body) => {
      if (method === 'POST' && unavailable) throw new Error('Receipt relay unavailable');
      return request(path, method, body);
    };
    await assert.rejects(service.recoverCommitted(), /Committed trade recovery is pending/);
    assert.deepEqual(store.get('receipt:trade-1'), receipt);
    assert.deepEqual(store.get('operation:trade-1'), { state: 'SIGNED' });
    unavailable = false;
    await service.recoverCommitted();
    assert.deepEqual(store.get('operation:trade-1'), { state: 'CONFIRMED' });
    assert.equal(wallet.signCount, 0);
    assert.equal(wallet.finalizeCount, 0);
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
  }
});

test('local progress exposes only durable recovery state and validates participant ownership', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, market, wallet } = await fixture(store);
    assert.deepEqual(await service.progress('trade-1'), {
      tradeId: 'trade-1',
      signingAuthorized: false,
      recoveryRequired: false,
      receipt: null,
    });
    await service.preview('trade-1');
    assert.equal((await service.progress('trade-1')).signingAuthorized, false);
    assert.equal(wallet.releaseCount, 0);
    const outsider = new LocalService(
      'other',
      wallet,
      market as unknown as MarketClient,
      store,
      qvac,
    );
    await assert.rejects(outsider.progress('trade-1'), /Invalid participant/);
  } finally {
    store.close();
  }
});

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

test('lost sign response recovers original durable authorization after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgb-sign-recovery-'));
  const path = join(dir, 'local.sqlite');
  let store = new LocalStore(path);
  try {
    const { service, wallet, market } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    const original = store.get<{ approval: Approval }>('approval:trade-1')!.approval;
    let calls = 0;
    wallet.sign = async (_pkg, approval) => {
      assert.deepEqual(approval, original);
      calls++;
      if (calls === 1) throw new Error('HTTP response lost after signing');
      return { status: 'signed', signature: { testOnly: true } };
    };
    await assert.rejects(
      service.approve('trade-1', { approvalToken, confirmed: true }),
      /response lost/,
    );
    store.close();
    store = new LocalStore(path);
    const restarted = new LocalService('a', wallet, market as unknown as MarketClient, store, qvac);
    market.trade!.status = 'RECONCILING';
    assert.equal((await restarted.progress('trade-1')).signingAuthorized, true);
    await restarted.sync('trade-1');
    await restarted.sync('trade-1');
    assert.equal(calls, 2); // Wallet replay once, then local cached signature only.
    assert.equal(
      market.trade!.messages.filter(
        (m) => (m.message.payload as { signature?: unknown })?.signature !== undefined,
      ).length,
      1,
    );
    assert.deepEqual(store.get('signature:trade-1'), { testOnly: true });
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lost signature relay uses saved signature without invoking sign again', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    market.failSignatureRelay = true;
    await assert.rejects(
      service.approve('trade-1', { approvalToken, confirmed: true }),
      /relay unavailable/,
    );
    market.failSignatureRelay = false;
    await service.sync('trade-1');
    assert.equal(wallet.signCount, 1);
    assert.equal(
      market.trade!.messages.filter(
        (m) => (m.message.payload as { signature?: unknown })?.signature !== undefined,
      ).length,
      1,
    );
  } finally {
    store.close();
  }
});

test('sync retries unchanged finalization after broadcast failure but not while transaction is pending', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    const packageValue = market.trade!.settlementPackage!;
    market.trade!.messages.push({
      ownerId: 'b',
      message: {
        messageId: 'other-signature',
        revision: 0,
        type: 'signature',
        payload: {
          packageId: packageValue.packageId,
          unsignedTxDigest: digest0,
          commitmentDigest: digest1,
          signature: 'test-b',
        },
      },
    });
    let calls = 0;
    wallet.finalize = async (packageInput, signatures) => {
      assert.deepEqual(packageInput, packageValue);
      assert.equal(signatures.length, 2);
      calls++;
      if (calls === 1) throw new Error('broadcast unavailable');
      return {
        mode: 'real',
        tradeId: 'trade-1',
        network: 'regtest',
        txid: 'a'.repeat(64),
        chainConfirmed: false,
        rgbAccepted: false,
        state: 'pending',
      };
    };
    await assert.rejects(
      service.approve('trade-1', { approvalToken, confirmed: true }),
      /broadcast unavailable/,
    );
    const receipt = await service.sync('trade-1');
    assert.equal(calls, 2);
    assert.equal(wallet.signCount, 1);
    wallet.sync = async () => receipt;
    await service.sync('trade-1');
    assert.equal(calls, 2);
    market.trade!.settlementPackage = { ...packageValue, payload: { tampered: true } };
    wallet.sync = async () => ({ ...receipt, state: 'reconciling' });
    await assert.rejects(service.sync('trade-1'), /Recovery package/);
    assert.equal(calls, 2);
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
  }
});

test('peer pre-sign cancellation cleans reservations on snapshot/restart and repeated reject is idempotent', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { wallet, market } = await fixture(store);
    store.set('operation:trade-1', { state: 'PREPARING' });
    market.trade!.status = 'REJECTED';
    const restarted = new LocalService('a', wallet, market as unknown as MarketClient, store, qvac);
    await restarted.snapshot();
    assert.equal(wallet.releaseCount, 1);
    assert.equal((await restarted.reject('trade-1', 'already rejected')).status, 'cancelled');
    await restarted.sync('trade-1');
    assert.equal(wallet.releaseCount, 1);
    assert.equal(market.messages.length, 0);
    assert.deepEqual(store.get('operation:trade-1'), { state: 'CANCELLED' });
  } finally {
    store.close();
  }
});

test('terminal market state never releases a possibly signed local operation', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    store.set('operation:trade-1', { state: 'SIGNING' });
    market.trade!.status = 'REJECTED';
    await assert.rejects(service.reject('trade-1', 'unsafe'), /automatic release is prohibited/);
    await assert.rejects(service.sync('trade-1'), /automatic release is prohibited/);
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
  }
});

test('sync resumes a committed authorization if process stopped before the wallet RPC', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    await service.preview('trade-1');
    const saved = store.get<{ package: SettlementPackage; approval: Approval }>(
      'approval:trade-1',
    )!;
    store.set('signing:trade-1', { package: saved.package, approval: saved.approval });
    wallet.sync = async () => ({
      mode: 'real',
      tradeId: 'trade-1',
      network: 'regtest',
      state: 'pending',
      chainConfirmed: false,
      rgbAccepted: false,
    });
    await service.sync('trade-1');
    assert.equal(wallet.signCount, 1);
    assert.equal(market.trade!.status, 'SIGNING');
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
  }
});

test('legacy lost approval recovers an existing signature without calling sign', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    store.set('operation:trade-1', { state: 'RECONCILING' });
    market.trade!.status = 'RECONCILING';
    let reads = 0;
    Object.assign(wallet, {
      recoverSignature: async (value: SettlementPackage) => {
        assert.deepEqual(value, market.trade!.settlementPackage);
        reads++;
        return { status: 'signed', signature: { testOnly: true } };
      },
    });
    await service.sync('trade-1');
    await service.sync('trade-1');
    assert.equal(wallet.signCount, 0);
    assert.equal(reads, 1);
    assert.equal(store.get('signing:trade-1'), null);
    assert.deepEqual(store.get('signature:trade-1'), { testOnly: true });
  } finally {
    store.close();
  }
});

test('an unsigned participant can approve the unchanged package while a peer is reconciling', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, wallet, market } = await fixture(store);
    const { approvalToken } = await service.preview('trade-1');
    market.trade!.status = 'RECONCILING';
    await service.approve('trade-1', { approvalToken, confirmed: true });
    assert.equal(wallet.signCount, 1);
    await assert.rejects(service.preview('trade-1'), /has sent or may have sent/);
  } finally {
    store.close();
  }
});

function partialTrade(
  market: FakeMarket,
  orderId: string,
  tradeId: string,
  revision: number,
  giveAmount: string,
  receiveAmount: string,
  feeSats: string,
  peer = 'b',
) {
  const value = plan(orderId);
  value.tradeId = tradeId;
  value.orderRefs = [
    { orderId, revision },
    { orderId: `order-${peer}`, revision: 1 },
  ];
  value.participants = ['a', peer];
  value.legs = [
    { fromOwnerId: 'a', toOwnerId: peer, asset: btc, amount: giveAmount },
    { fromOwnerId: peer, toOwnerId: 'a', asset: dusd, amount: receiveAmount },
  ];
  value.fees = [
    { ownerId: 'a', feeSats },
    { ownerId: peer, feeSats: '1000' },
  ];
  value.digest = planDigest(value);
  market.trade = {
    plan: value,
    status: 'AWAITING_APPROVAL',
    settlementPackage: { ...pkg(value), packageId: `package-${tradeId}` },
    messages: [],
  };
  return market.trade;
}

test('partial order survives restart and fills with a different peer only after a fresh approval', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rgb-partial-fill-'));
  const path = join(directory, 'local.sqlite');
  let store = new LocalStore(path);
  try {
    const wallet = new FakeWallet();
    wallet.stateValue.balances[0].amount = '101000';
    const { service, market, published } = await fixture(store, wallet, undefined, {
      minGiveAmount: '10000',
    });
    const first = partialTrade(market, published.id, 'fill-1', 1, '60000', '60', '600');
    const original = store.get(`order:${published.id}`);
    const review = await service.preview('fill-1');
    assert.equal(wallet.signCount, 0);
    await service.approve('fill-1', { approvalToken: review.approvalToken, confirmed: true });
    assert.equal(wallet.signCount, 1);
    wallet.stateValue.balances = review.preview.balancesAfter;
    wallet.sync = async (tradeId) => ({
      mode: 'real',
      tradeId,
      network: 'regtest',
      state: 'confirmed',
      txid: 'a'.repeat(64),
      chainConfirmed: true,
      rgbAccepted: true,
    });
    first.status = 'CONFIRMED';
    await service.sync('fill-1');
    await service.sync('fill-1');
    store.close();
    store = new LocalStore(path);
    const restarted = new LocalService('a', wallet, market as unknown as MarketClient, store, qvac);
    partialTrade(market, published.id, 'fill-2', 3, '40000', '40', '500', 'c');
    await assert.rejects(restarted.preview('fill-2'), /cumulative fee budget/);
    partialTrade(market, published.id, 'fill-2', 3, '40001', '41', '400', 'c');
    await assert.rejects(restarted.preview('fill-2'), /remaining quantity/);
    partialTrade(market, published.id, 'fill-2', 3, '40000', '40', '400', 'c');
    wallet.feeSats = '300';
    const next = await restarted.preview('fill-2');
    assert.equal(next.preview.give.amount, '40000');
    assert.equal(next.preview.receive.amount, '40');
    assert.equal(wallet.signCount, 1);
    await assert.rejects(
      restarted.approve('fill-2', { approvalToken: review.approvalToken, confirmed: true }),
      /Approval is missing or stale/,
    );
    await restarted.approve('fill-2', { approvalToken: next.approvalToken, confirmed: true });
    assert.equal(wallet.signCount, 2);
    await restarted.sync('fill-2');
    assert.equal(store.entries(`fill:${published.id}:`).length, 2);
    assert.deepEqual(store.get(`order:${published.id}`), original);
    partialTrade(market, published.id, 'fill-3', 5, '1', '1', '0', 'd');
    await assert.rejects(restarted.preview('fill-3'), /remaining quantity/);
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('partial fill rejects changed rates, dust, totals, revision and fee budgets before reservation', async (t) => {
  const cases = [
    { give: '50000', receive: '49', fee: '500', revision: 1, error: /confirmed limits/ },
    { give: '9999', receive: '10', fee: '99', revision: 1, error: /confirmed limits/ },
    { give: '100001', receive: '101', fee: '1000', revision: 1, error: /remaining quantity/ },
    { give: '50000', receive: '50', fee: '501', revision: 1, error: /cumulative fee budget/ },
    { give: '50000', receive: '50', fee: '500', revision: 3, error: /Stale order revision/ },
  ];
  for (const value of cases) {
    await t.test(JSON.stringify(value), async () => {
      const store = new LocalStore(':memory:');
      try {
        const { service, market, wallet, published } = await fixture(store, undefined, undefined, {
          minGiveAmount: '10000',
        });
        const trade = partialTrade(
          market,
          published.id,
          'fill-invalid',
          value.revision,
          value.give,
          value.receive,
          value.fee,
        );
        trade.status = 'RESERVED';
        let reservations = 0;
        wallet.reserve = async () => {
          reservations++;
          return { reservationId: 'unexpected' };
        };
        await assert.rejects(service.prepare('fill-invalid'), value.error);
        assert.equal(reservations, 0);
        assert.equal(wallet.signCount, 0);
        assert.equal(store.entries(`fill:${published.id}:`).length, 0);
      } finally {
        store.close();
      }
    });
  }
});

test('partial fills pin immutable plans and never trust coordinator confirmation to unlock the next fill', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, market, wallet, published } = await fixture(store, undefined, undefined, {
      minGiveAmount: '10000',
    });
    partialTrade(market, published.id, 'fill-1', 1, '50000', '50', '500');
    const { approvalToken } = await service.preview('fill-1');
    partialTrade(market, published.id, 'fill-1', 1, '60000', '60', '600');
    await assert.rejects(service.preview('fill-1'), /immutable fill plan changed/);
    partialTrade(market, published.id, 'fill-1', 1, '50000', '50', '500');
    await service.approve('fill-1', { approvalToken, confirmed: true });
    market.trade!.status = 'CONFIRMED';
    await service.sync('fill-1');
    partialTrade(market, published.id, 'fill-2', 3, '50000', '50', '500', 'c');
    await assert.rejects(service.preview('fill-2'), /Reconcile the previous fill/);
    assert.equal(wallet.signCount, 1);
    assert.equal(wallet.releaseCount, 0);
  } finally {
    store.close();
  }
});

test('rejected unsigned partial fill releases only that preparation and cannot silently restart the parent', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, market, wallet, published } = await fixture(store, undefined, undefined, {
      minGiveAmount: '10000',
    });
    partialTrade(market, published.id, 'fill-1', 1, '50000', '50', '500').status = 'RESERVED';
    await service.prepare('fill-1');
    await service.reject('fill-1', 'Stop this order');
    assert.equal(wallet.releaseCount, 1);
    assert.deepEqual(store.get('operation:fill-1'), { state: 'CANCELLED' });
    partialTrade(market, published.id, 'fill-2', 3, '50000', '50', '500', 'c');
    await assert.rejects(service.preview('fill-2'), /Reconcile the previous fill/);
    assert.equal(wallet.signCount, 0);
  } finally {
    store.close();
  }
});

test('full orders still reject partial execution and final wallet fees cannot exceed the fill allocation', async () => {
  for (const partialFill of [undefined, { minGiveAmount: '10000' }]) {
    const store = new LocalStore(':memory:');
    try {
      const { service, market, wallet, published } = await fixture(
        store,
        undefined,
        undefined,
        partialFill,
      );
      partialTrade(market, published.id, 'fill-1', 1, '50000', '50', '500');
      wallet.feeSats = '501';
      await assert.rejects(
        service.preview('fill-1'),
        partialFill ? /Final fee exceeds/ : /Plan changes the confirmed order/,
      );
      assert.equal(wallet.signCount, 0);
    } finally {
      store.close();
    }
  }
});

test('partial orders reject ring plans without changing support for full-order rings', async () => {
  const store = new LocalStore(':memory:');
  try {
    const { service, market, published } = await fixture(store, undefined, undefined, {
      minGiveAmount: '10000',
    });
    const trade = partialTrade(market, published.id, 'fill-ring', 1, '100000', '100', '1000');
    trade.plan.participants.push('c');
    trade.plan.orderRefs.push({ orderId: 'order-c', revision: 1 });
    trade.plan.fees.push({ ownerId: 'c', feeSats: '1000' });
    trade.plan.legs[1].toOwnerId = 'c';
    trade.plan.legs.push({ fromOwnerId: 'c', toOwnerId: 'a', asset: dusd, amount: '100' });
    trade.plan.digest = planDigest(trade.plan);
    trade.settlementPackage = pkg(trade.plan);
    await assert.rejects(service.preview('fill-ring'), /independent direct swaps/);
    assert.equal(store.entries(`fill:${published.id}:`).length, 0);
  } finally {
    store.close();
  }
});

test('incoming assets from a partial fill cannot finance its fee or outgoing amount', async () => {
  const store = new LocalStore(':memory:');
  try {
    const wallet = new FakeWallet();
    wallet.stateValue.balances[0].amount = '2000';
    wallet.previewAsset = btc;
    const market = new FakeMarket();
    const service = new LocalService('a', wallet, market as unknown as MarketClient, store, qvac);
    const order = await service.publish({
      draft: {
        giveAsset: dusd,
        giveAmount: '800',
        receiveAsset: btc,
        minReceiveAmount: '800000',
        maxFeeSats: '1000',
        expiresAt: Date.now() + 60000,
        partialFill: { minGiveAmount: '400' },
      },
      policy: {
        allowedAssetKeys: ['regtest:btc:btc', 'regtest:rgb:dusd-test'],
        protectedBalances: { 'regtest:btc:btc': '900', 'regtest:rgb:dusd-test': '200' },
        maxFeeSats: '1000',
        allowBtcSale: false,
      },
      confirmed: true,
      requestId: randomUUID(),
    });
    const trade = partialTrade(market, order.id, 'fill-1', 1, '400', '400000', '500');
    trade.plan.legs[0].asset = dusd;
    trade.plan.legs[1].asset = btc;
    trade.plan.digest = planDigest(trade.plan);
    trade.settlementPackage = pkg(trade.plan);
    wallet.stateValue.balances[0].amount = '499';
    await assert.rejects(service.preview('fill-1'), /Insufficient funds/);
    wallet.stateValue.balances[0].amount = '2000';
    wallet.stateValue.balances[1].amount = '399';
    await assert.rejects(service.preview('fill-1'), /balancesAfter/);
    wallet.stateValue.balances[1].amount = '590';
    await assert.doesNotReject(service.preview('fill-1'));
    wallet.stateValue.balances[1].amount = '600';
    const result = await service.preview('fill-1');
    assert.equal(result.preview.balancesAfter[1].amount, '200');
    assert.equal(wallet.signCount, 0);
  } finally {
    store.close();
  }
});
