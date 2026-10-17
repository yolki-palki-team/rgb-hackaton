import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicHealth, getPublicOrders, getPublicActivity, getPublicHistory } from '../api';
import {
  formatAssetAmount,
  executionLabels,
  executionStep,
  marketLoadFailed,
  mergeHistory,
  orderStatusLabel,
  orderFillSummary,
} from '../model';
import type {
  AssetRef,
  PublicOrder,
  PublicMarketHistory,
  PublicMarketOrder,
} from '@rgb-exchange/contracts';

const btc: AssetRef = { kind: 'btc', network: 'regtest', symbol: 'BTC', precision: 8 };
const rgb: AssetRef = {
  kind: 'rgb',
  network: 'regtest',
  symbol: 'X',
  contractId: 'contract-x',
  precision: 2,
};

test('partial parent status and remaining amounts do not inherit completion from its latest fill', () => {
  const order: PublicOrder = {
    id: 'partial-order',
    ownerId: 'owner',
    revision: 2,
    network: 'regtest',
    giveAsset: btc,
    giveAmount: '100000000',
    receiveAsset: rgb,
    minReceiveAmount: '100',
    maxFeeSats: '1000',
    createdAt: 1,
    expiresAt: 2,
    status: 'OPEN',
    partialFill: { minGiveAmount: '25000000' },
    fillProgress: {
      filledGiveAmount: '25000000',
      receivedAmount: '25',
      feeBudgetUsedSats: '250',
      fillCount: 1,
    },
  };
  const entry: PublicMarketOrder = { order, execution: { status: 'CONFIRMED', participants: 2 } };
  assert.equal(orderStatusLabel(entry), 'Partially filled');
  assert.equal(orderFillSummary(order), 'Filled 0.25 BTC / 1 BTC · Remaining 0.75 BTC');
  assert.equal(
    orderStatusLabel({ ...entry, order: { ...order, status: 'CANCELLED' } }),
    'Cancelled',
  );
  assert.equal(orderStatusLabel({ ...entry, order: { ...order, status: 'EXPIRED' } }), 'Expired');
  assert.equal(orderStatusLabel({ ...entry, order: { ...order, status: 'FILLED' } }), 'Filled');
  assert.equal(
    orderStatusLabel({
      ...entry,
      order: { ...order, status: 'RESERVED' },
      execution: { status: 'AWAITING_APPROVAL', participants: 2 },
    }),
    'Awaiting approval',
  );
  assert.equal(
    orderFillSummary({ ...order, partialFill: undefined, fillProgress: undefined }),
    undefined,
  );
});

test('public client reads only the same-origin order book without credentials or stale orders', async () => {
  const now = Date.now();
  const base: PublicOrder = {
    id: 'open-1',
    ownerId: 'owner-1',
    revision: 0,
    network: 'regtest',
    giveAsset: btc,
    giveAmount: '100000000',
    receiveAsset: rgb,
    minReceiveAmount: '12345',
    maxFeeSats: '1000',
    createdAt: now - 1000,
    expiresAt: now + 60_000,
    status: 'OPEN',
  };
  const original = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        orders: [
          base,
          { ...base, id: 'reserved-1', status: 'RESERVED' },
          { ...base, id: 'expired-1', expiresAt: now - 1 },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  try {
    assert.deepEqual(
      (await getPublicOrders()).map((order) => order.id),
      ['open-1'],
    );
    assert.equal(calls[0].input, '/market-api/orders');
    assert.equal(calls[0].init?.method, 'GET');
    assert.equal(calls[0].init?.credentials, 'omit');
    assert.equal(calls[0].init?.headers, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('health is read-only and amounts preserve asset precision', async () => {
  const original = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (input, init) => {
    requested = String(input);
    assert.equal(init?.credentials, 'omit');
    return new Response(
      JSON.stringify({ ok: true, protocolVersion: 1, mode: 'coordination-only' }),
      { status: 200 },
    );
  };
  try {
    assert.equal(await getPublicHealth(), true);
    assert.equal(requested, '/market-api/health');
    assert.equal(formatAssetAmount(btc, '100000000'), '1');
    assert.equal(formatAssetAmount(rgb, '12345'), '123.45');
  } finally {
    globalThis.fetch = original;
  }
});

test('public activity keeps executing and completed orders after expiry, filters expired waiting orders, and rejects private fields', async () => {
  const original = globalThis.fetch;
  const now = Date.now();
  const order: PublicOrder = {
    id: 'public-order',
    ownerId: 'owner',
    revision: 1,
    network: 'regtest',
    giveAsset: btc,
    giveAmount: '100',
    receiveAsset: rgb,
    minReceiveAmount: '100',
    maxFeeSats: '1000',
    createdAt: now - 10000,
    expiresAt: now - 1,
    status: 'RESERVED',
  };
  const entries = [
    { order: { ...order, id: 'waiting', status: 'OPEN', expiresAt: now + 60000 }, execution: null },
    { order: { ...order, id: 'expired', status: 'OPEN' }, execution: null },
    { order, execution: { status: 'PREPARING', participants: 3 } },
    {
      order: { ...order, id: 'finished', status: 'FILLED' },
      execution: { status: 'CONFIRMED', participants: 2 },
    },
  ];
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/market-api/activity');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.headers, undefined);
    return Response.json({ orders: entries });
  };
  try {
    assert.deepEqual(
      (await getPublicActivity()).map((entry) => entry.order.id),
      ['waiting', 'public-order', 'finished'],
    );
    assert.equal(executionStep('PREPARING'), 0);
    assert.equal(executionStep('AWAITING_APPROVAL'), 1);
    assert.equal(executionStep('SIGNING'), 2);
    assert.equal(executionStep('BROADCAST'), 3);
    assert.equal(executionStep('CONFIRMED'), 4);
    assert.equal(executionStep('RECONCILING'), null);
    assert.equal(executionStep('REJECTED'), null);
    assert.equal(executionLabels.CONFIRMED, 'Completed');
    globalThis.fetch = async () =>
      Response.json({ orders: [{ ...entries[2], messages: ['private'] }] });
    await assert.rejects(getPublicActivity());
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(getPublicActivity(), /HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});

test('public history retains every terminal status and safely encodes the older-page cursor', async () => {
  const original = globalThis.fetch;
  const order: PublicOrder = {
    id: 'saved-order',
    ownerId: 'owner',
    revision: 1,
    network: 'regtest',
    giveAsset: btc,
    giveAmount: '100',
    receiveAsset: rgb,
    minReceiveAmount: '100',
    maxFeeSats: '1000',
    createdAt: 1,
    expiresAt: 2,
    status: 'CANCELLED',
  };
  const orders: PublicMarketOrder[] = [
    { order, execution: { status: 'REJECTED', participants: 2 } },
    { order: { ...order, id: 'cancelled' }, execution: null },
    { order: { ...order, id: 'expired', status: 'EXPIRED' }, execution: null },
    {
      order: { ...order, id: 'confirmed', status: 'FILLED' },
      execution: { status: 'CONFIRMED', participants: 3 },
    },
  ];
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/market-api/history?cursor=order%2Bolder%26private%3Dno');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.headers, undefined);
    return Response.json({ orders, nextCursor: 'expired' });
  };
  try {
    const result = await getPublicHistory('order+older&private=no');
    assert.deepEqual(result.orders.map(orderStatusLabel), [
      'Declined',
      'Cancelled',
      'Expired',
      'Completed',
    ]);
    assert.equal(result.orders.length, 4);
    assert.equal(result.nextCursor, 'expired');
    globalThis.fetch = async () =>
      Response.json({ orders: [{ ...orders[0], reason: 'private' }], nextCursor: null });
    await assert.rejects(getPublicHistory());
  } finally {
    globalThis.fetch = original;
  }
});

test('poll errors preserve loaded orders and history refresh updates rows without losing older failures', () => {
  const order: PublicOrder = {
    id: 'recent',
    ownerId: 'owner',
    revision: 1,
    network: 'regtest',
    giveAsset: btc,
    giveAmount: '100',
    receiveAsset: rgb,
    minReceiveAmount: '100',
    maxFeeSats: '1000',
    createdAt: 2,
    expiresAt: 3,
    status: 'RESERVED',
  };
  const current: PublicMarketHistory = {
    orders: [
      { order, execution: { status: 'BROADCAST', participants: 2 } },
      {
        order: { ...order, id: 'old-failure', createdAt: 1, status: 'CANCELLED' },
        execution: { status: 'REJECTED', participants: 3 },
      },
    ],
    nextCursor: 'older-page',
  };
  const failed = marketLoadFailed(
    { kind: 'ready', orders: current.orders, updatedAt: 123 },
    'Offline',
  );
  assert.equal(failed.kind, 'error');
  assert.strictEqual(failed.orders, current.orders);
  assert.ok('updatedAt' in failed && failed.updatedAt === 123);
  const updated = mergeHistory(
    current,
    {
      orders: [
        {
          order: { ...order, status: 'FILLED' },
          execution: { status: 'CONFIRMED', participants: 2 },
        },
      ],
      nextCursor: 'recent',
    },
    false,
  );
  assert.deepEqual(updated.orders.map(orderStatusLabel), ['Completed', 'Declined']);
  assert.equal(updated.nextCursor, 'older-page');
  const older = mergeHistory(
    updated,
    {
      orders: [
        { order: { ...order, id: 'oldest', createdAt: 0, status: 'EXPIRED' }, execution: null },
      ],
      nextCursor: null,
    },
    true,
  );
  assert.deepEqual(
    older.orders.map((entry) => entry.order.id),
    ['recent', 'old-failure', 'oldest'],
  );
  assert.equal(older.nextCursor, null);
});
