import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MarketHistorySchema,
  type MarketHistory,
  type PublicOrder,
  type TradeHistory,
} from '@rgb-exchange/contracts';
import { mergeOrderHistory, OrderHistoryRows } from '../ui/src/components/OrderHistory';

const order: PublicOrder = {
  id: 'order-failed',
  ownerId: 'owner',
  revision: 1,
  network: 'regtest',
  giveAsset: { kind: 'btc', network: 'regtest', symbol: 'BTC', precision: 8 },
  giveAmount: '100000000',
  receiveAsset: {
    kind: 'rgb',
    network: 'regtest',
    symbol: 'X',
    contractId: 'contract-x',
    precision: 2,
  },
  minReceiveAmount: '12345',
  maxFeeSats: '1000',
  createdAt: 1,
  expiresAt: 2,
  status: 'CANCELLED',
};
const failedTrade: TradeHistory = {
  status: 'REJECTED',
  reason: 'Wallet validation failed: fee exceeds the approved limit.',
  plan: {
    protocolVersion: 1,
    tradeId: 'trade-failed',
    revision: 1,
    network: 'regtest',
    orderRefs: [
      { orderId: order.id, revision: 1 },
      { orderId: 'other-order', revision: 1 },
    ],
    participants: ['owner', 'peer'],
    legs: [
      { fromOwnerId: 'owner', toOwnerId: 'peer', asset: order.giveAsset, amount: order.giveAmount },
      {
        fromOwnerId: 'peer',
        toOwnerId: 'owner',
        asset: order.receiveAsset,
        amount: order.minReceiveAmount,
      },
    ],
    fees: [
      { ownerId: 'owner', feeSats: '500' },
      { ownerId: 'peer', feeSats: '500' },
    ],
    feeState: 'final',
    createdAt: 1,
    digest: '0'.repeat(64),
  },
};

test('saved history renders exact terms and failed reasons without claiming completion', () => {
  const history = MarketHistorySchema.parse({
    myOrders: [order, { ...order, id: 'expired-order', status: 'EXPIRED' }],
    trades: [failedTrade],
    nextCursor: null,
  });
  const html = renderToStaticMarkup(createElement(OrderHistoryRows, { history }));
  assert.match(html, /100,000,000 sats/);
  assert.match(html, /123\.45 X/);
  assert.match(html, /Cancelled/);
  assert.match(html, /Expired/);
  assert.match(html, /Rejected/);
  assert.match(html, /fee exceeds the approved limit/);
  assert.doesNotMatch(html, /confirmed|Completed/);
});

test('cancelled partial order retains confirmed fills, remaining amounts, and each fill outcome', () => {
  const partialOrder: PublicOrder = {
    ...order,
    partialFill: { minGiveAmount: '25000000' },
    fillProgress: {
      filledGiveAmount: '25000000',
      receivedAmount: '3087',
      feeBudgetUsedSats: '250',
      fillCount: 1,
    },
  };
  const confirmedFill: TradeHistory = {
    ...failedTrade,
    status: 'CONFIRMED',
    reason: undefined,
    plan: {
      ...failedTrade.plan,
      tradeId: 'trade-confirmed-fill',
      legs: [
        { ...failedTrade.plan.legs[0], amount: '25000000' },
        { ...failedTrade.plan.legs[1], amount: '3087' },
      ],
    },
  };
  const html = renderToStaticMarkup(
    createElement(OrderHistoryRows, {
      history: { myOrders: [partialOrder], trades: [failedTrade, confirmedFill], nextCursor: null },
    }),
  );
  assert.match(html, /Cancelled/);
  assert.match(html, /Filled 25,000,000 sats \/ 100,000,000 sats · Remaining 75,000,000 sats/);
  assert.match(html, /Rejected/);
  assert.match(html, /BTC and RGB confirmed/);
  assert.match(html, /trade-confirmed-fill/);
  assert.match(html, /30\.87 X/);
  assert.match(html, /fee exceeds the approved limit/);
});

test('history refresh and older pages retain past orders while updating an existing trade', () => {
  const initial: MarketHistory = {
    myOrders: [order],
    trades: [failedTrade],
    nextCursor: 'order-failed',
  };
  const page: MarketHistory = {
    myOrders: [{ ...order, id: 'older', createdAt: 0, status: 'EXPIRED' }],
    trades: [],
    nextCursor: null,
  };
  const expanded = mergeOrderHistory(initial, page, true);
  const refreshed = mergeOrderHistory(
    expanded,
    {
      myOrders: [order],
      trades: [{ ...failedTrade, reason: 'Saved rejection reason' }],
      nextCursor: 'order-failed',
    },
    false,
  );
  assert.deepEqual(
    refreshed.myOrders.map((item) => item.id),
    ['order-failed', 'older'],
  );
  assert.equal(refreshed.nextCursor, null);
  assert.equal(refreshed.trades.length, 1);
  assert.equal(refreshed.trades[0].status, 'REJECTED');
  assert.equal(refreshed.trades[0].reason, 'Saved rejection reason');
  assert.equal(initial.trades[0].reason, failedTrade.reason);
  const cached = mergeOrderHistory(
    refreshed,
    {
      ...initial,
      stale: true,
      trades: [{ ...failedTrade, status: 'PREPARING', reason: undefined }],
    },
    false,
  );
  assert.equal(cached.trades[0].status, 'REJECTED');
  assert.equal(cached.trades[0].reason, 'Saved rejection reason');
  const restored = mergeOrderHistory(
    { myOrders: [], trades: [], nextCursor: null },
    { ...initial, stale: true },
    false,
  );
  assert.equal(restored.myOrders[0].id, order.id);
  assert.equal(restored.trades[0].status, 'REJECTED');
});

test('trade archive opens active orders and only opens completed orders on request', () => {
  const history: MarketHistory = {
    myOrders: [order, { ...order, id: 'active-order', status: 'OPEN' }],
    trades: [failedTrade],
    nextCursor: null,
  };
  const html = renderToStaticMarkup(createElement(OrderHistoryRows, { history }));
  assert.equal((html.match(/<details[^>]* open=""/g) ?? []).length, 1);
  assert.ok(html.indexOf('active-order') < html.indexOf('order-failed'));
  const selected = renderToStaticMarkup(
    createElement(OrderHistoryRows, {
      history,
      request: { tradeId: failedTrade.plan.tradeId, version: 1 },
    }),
  );
  assert.equal((selected.match(/<details[^>]* open=""/g) ?? []).length, 2);
  const completedAfterSelection = renderToStaticMarkup(
    createElement(OrderHistoryRows, {
      history,
      request: { tradeId: failedTrade.plan.tradeId, finished: false, version: 1 },
    }),
  );
  assert.equal((completedAfterSelection.match(/<details[^>]* open=""/g) ?? []).length, 1);
});

test('the active trade embeds the live signing view once', () => {
  const html = renderToStaticMarkup(
    createElement(OrderHistoryRows, {
      history: { myOrders: [order], trades: [failedTrade], nextCursor: null },
      liveTrade: {
        id: failedTrade.plan.tradeId,
        kind: 'direct',
        status: 'AWAITING_APPROVAL',
        participants: [],
        legs: [],
        feeSats: '500',
      },
      liveContent: createElement('div', null, 'Live validated trade'),
    }),
  );
  assert.equal((html.match(/Live validated trade/g) ?? []).length, 1);
  assert.doesNotMatch(html, /wallet-history-outcome/);
  assert.match(html, /<details[^>]* open=""/);
});

test('finished current trades render the same compact details as archived trades', () => {
  for (const status of ['CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'UNSUPPORTED'] as const) {
    const history: MarketHistory = {
      myOrders: [{ ...order, status: status === 'CONFIRMED' ? 'FILLED' : 'CANCELLED' }],
      trades: [{ ...failedTrade, status }],
      nextCursor: null,
    };
    const archived = renderToStaticMarkup(createElement(OrderHistoryRows, { history }));
    const current = renderToStaticMarkup(
      createElement(OrderHistoryRows, {
        history,
        liveTrade: {
          id: failedTrade.plan.tradeId,
          kind: 'direct',
          status,
          participants: [],
          legs: [],
          feeSats: '500',
        },
        liveContent: createElement('div', null, 'Live validated trade'),
      }),
    );
    assert.equal(current, archived);
    assert.match(current, /wallet-history-outcome/);
    assert.doesNotMatch(current, /Live validated trade/);
  }
});
