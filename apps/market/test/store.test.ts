import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { MarketError, MarketStore } from '../src/store.ts';
import {
  MarketHistorySchema,
  PublicMarketHistorySchema,
  TradeHistorySchema,
  type AssetRef,
  type PublicOrder,
  type TradeSnapshot,
} from '@rgb-exchange/contracts';

const network = 'regtest' as const;
const btc: AssetRef = { network, kind: 'btc', precision: 8, symbol: 'BTC' };
const x: AssetRef = { network, kind: 'rgb', contractId: 'x', precision: 0, symbol: 'X' };
const dusd: AssetRef = { network, kind: 'rgb', contractId: 'dusd', precision: 0, symbol: 'DUSD' };
const now = Date.parse('2026-10-17T00:00:00.000Z');

function order(
  id: string,
  ownerId: string,
  giveAsset: AssetRef,
  giveAmount: string,
  receiveAsset: AssetRef,
  minReceiveAmount: string,
): PublicOrder {
  return {
    id,
    ownerId,
    revision: 0,
    network,
    giveAsset,
    giveAmount,
    receiveAsset,
    minReceiveAmount,
    maxFeeSats: '1000',
    createdAt: now,
    expiresAt: now + 86400000,
    status: 'OPEN',
  };
}

function withStore(run: (store: MarketStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'rgb-market-'));
  const path = join(dir, 'market.sqlite');
  const store = new MarketStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function signingTrade(store: MarketStore, trade: TradeSnapshot): void {
  const id = trade.plan.tradeId;
  const packageValue = {
    protocolVersion: 1,
    packageId: 'package-1',
    tradeId: id,
    planRevision: 0,
    planDigest: trade.plan.digest,
    network: 'regtest',
    unsignedTxDigest: '0'.repeat(64),
    commitmentDigest: '1'.repeat(64),
    format: 'test-only',
    payload: {},
  };
  store.relayTradeMessage(trade.plan.participants[0], id, {
    messageId: 'package',
    revision: 0,
    type: 'package',
    payload: packageValue,
  });
  store.relayTradeMessage(trade.plan.participants[0], id, {
    messageId: 'signing-intent',
    revision: 0,
    type: 'signature',
    payload: {
      packageId: packageValue.packageId,
      unsignedTxDigest: packageValue.unsignedTxDigest,
      commitmentDigest: packageValue.commitmentDigest,
      signatureMayExist: true,
    },
  });
}

function confirmedReceipt(tradeId: string, txid = 'a'.repeat(64)) {
  return {
    mode: 'real',
    tradeId,
    network: 'regtest',
    txid,
    chainConfirmed: true,
    rgbAccepted: true,
    state: 'confirmed',
  };
}

function confirmTrade(store: MarketStore, trade: TradeSnapshot, confirmedAt = now): void {
  signingTrade(store, trade);
  for (const owner of trade.plan.participants)
    store.relayTradeMessage(
      owner,
      trade.plan.tradeId,
      {
        messageId: `receipt-${owner}`,
        revision: 0,
        type: 'receipt',
        payload: confirmedReceipt(trade.plan.tradeId),
      },
      confirmedAt,
    );
}

test('partial parent fills across separate trades, persists progress and idempotently resumes with waiting sellers', () =>
  withStore((store, path) => {
    const input = {
      ...order('parent', 'buyer', dusd, '1000', btc, '1000000'),
      partialFill: { minGiveAmount: '200' },
    };
    assert.equal(store.createOrder('buyer', input, now).order.fillProgress?.fillCount, 0);
    const first = store.createOrder(
      'seller-1',
      order('seller-1', 'seller-1', btc, '300000', dusd, '300'),
      now,
    ).trade!;
    const waiting = store.createOrder(
      'seller-2',
      order('seller-2', 'seller-2', btc, '300000', dusd, '300'),
      now,
    );
    assert.equal(waiting.trade, null);
    assert.equal(store.getOrder('parent')?.fillProgress?.filledGiveAmount, '0');
    assert.equal(first.plan.fees.find((fee) => fee.ownerId === 'buyer')?.feeSats, '300');
    confirmTrade(store, first);
    assert.deepEqual(store.getOrder('parent')?.fillProgress, {
      filledGiveAmount: '300',
      receivedAmount: '300000',
      feeBudgetUsedSats: '300',
      fillCount: 1,
    });
    assert.equal(store.getOrder('parent')?.status, 'RESERVED');
    const second = store.snapshot('buyer', 0, now).trades[0];
    assert.notEqual(second.plan.tradeId, first.plan.tradeId);
    assert.equal(second.plan.orderRefs.find((ref) => ref.orderId === 'parent')?.revision, 3);
    assert.equal(store.createOrder('buyer', input, now).trade?.plan.tradeId, second.plan.tradeId);
    const reopened = new MarketStore(path);
    try {
      assert.equal(reopened.getOrder('parent')?.fillProgress?.fillCount, 1);
      reopened.relayTradeMessage(
        'seller-1',
        first.plan.tradeId,
        {
          messageId: 'receipt-seller-1',
          revision: 0,
          type: 'receipt',
          payload: confirmedReceipt(first.plan.tradeId),
        },
        now,
      );
      assert.equal(reopened.getOrder('parent')?.fillProgress?.fillCount, 1);
      assert.throws(
        () =>
          reopened.relayTradeMessage(
            'seller-1',
            first.plan.tradeId,
            {
              messageId: 'duplicate-different-id',
              revision: 0,
              type: 'receipt',
              payload: confirmedReceipt(first.plan.tradeId),
            },
            now,
          ),
        /TRADE_TERMINAL/,
      );
      confirmTrade(reopened, second);
      assert.equal(reopened.getOrder('parent')?.status, 'OPEN');
      assert.equal(reopened.getOrder('parent')?.giveAmount, '1000');
      assert.equal(reopened.getOrder('parent')?.fillProgress?.filledGiveAmount, '600');
      const publicRow = reopened
        .publicActivity(now)
        .orders.filter((row) => row.order.id === 'parent');
      assert.equal(publicRow.length, 1);
      assert.equal(publicRow[0].execution, null);
      const last = reopened.createOrder(
        'seller-3',
        order('seller-3', 'seller-3', btc, '400000', dusd, '400'),
        now,
      ).trade!;
      confirmTrade(reopened, last);
      assert.equal(reopened.getOrder('parent')?.status, 'FILLED');
      assert.deepEqual(reopened.getOrder('parent')?.fillProgress, {
        filledGiveAmount: '1000',
        receivedAmount: '1000000',
        feeBudgetUsedSats: '1000',
        fillCount: 3,
      });
      assert.equal(reopened.history('buyer').myOrders.length, 1);
      assert.equal(reopened.history('buyer').trades.length, 3);
      assert.equal(
        reopened.publicHistory().orders.filter((row) => row.order.id === 'parent').length,
        1,
      );
      assert.equal(reopened.getTrade(first.plan.tradeId, 'buyer')?.plan.digest, first.plan.digest);
    } finally {
      reopened.close();
    }
  }));

test('partial rejection stops only unexecuted remainder and uncertain signatures keep it reserved', () =>
  withStore((store) => {
    const input = {
      ...order('parent', 'buyer', dusd, '1000', btc, '1000000'),
      partialFill: { minGiveAmount: '200' },
    };
    store.createOrder('buyer', input, now);
    const first = store.createOrder(
      'one',
      order('one', 'one', btc, '300000', dusd, '300'),
      now,
    ).trade!;
    confirmTrade(store, first);
    const second = store.createOrder(
      'two',
      order('two', 'two', btc, '300000', dusd, '300'),
      now,
    ).trade!;
    store.relayTradeMessage(
      'two',
      second.plan.tradeId,
      { messageId: 'reject', revision: 0, type: 'reject', payload: { reason: 'declined' } },
      now,
    );
    assert.equal(store.getOrder('parent')?.status, 'CANCELLED');
    assert.equal(store.getOrder('parent')?.fillProgress?.filledGiveAmount, '300');
    assert.equal(store.history('buyer').trades.length, 2);
    assert.equal(
      store.createOrder('three', order('three', 'three', btc, '700000', dusd, '700'), now).trade,
      null,
    );
    assert.throws(
      () =>
        store.createOrder(
          'buyer',
          { ...input, id: 'forged', fillProgress: store.getOrder('parent')?.fillProgress },
          now,
        ),
      /INVALID_INITIAL_ORDER/,
    );
    const retry = store.createOrder(
      'buyer',
      { ...input, id: 'new-parent', giveAmount: '700', minReceiveAmount: '700000' },
      now,
    ).trade!;
    signingTrade(store, retry);
    store.relayTradeMessage(
      'three',
      retry.plan.tradeId,
      { messageId: 'reject', revision: 0, type: 'reject', payload: {} },
      now,
    );
    assert.equal(store.getOrder('new-parent')?.status, 'RESERVED');
    assert.equal(store.getOrder('new-parent')?.fillProgress?.fillCount, 0);
    assert.equal(store.getTrade(retry.plan.tradeId, 'buyer')?.status, 'RECONCILING');
  }));

test('partial cancellation and expiry retain settled amounts and never reopen expired remainder', () =>
  withStore((store) => {
    for (const mode of ['cancel', 'expire']) {
      const parentId = `parent-${mode}`;
      const input = {
        ...order(parentId, parentId, dusd, '1000', btc, '1000000'),
        partialFill: { minGiveAmount: '200' },
      };
      store.createOrder(parentId, input, now);
      const trade = store.createOrder(
        mode,
        order(mode, mode, btc, '300000', dusd, '300'),
        now,
      ).trade!;
      confirmTrade(store, trade, mode === 'expire' ? input.expiresAt : now);
      if (mode === 'cancel') store.cancelOrder(parentId, parentId, 2, now);
      const parent = store.getOrder(parentId)!;
      assert.equal(parent.status, mode === 'cancel' ? 'CANCELLED' : 'EXPIRED');
      assert.equal(parent.fillProgress?.filledGiveAmount, '300');
      assert.equal(parent.fillProgress?.feeBudgetUsedSats, '300');
    }
  }));

test('parent history keeps more than fifty immutable fills without duplicating its pagination row', () =>
  withStore((store) => {
    const parent = {
      ...order('parent', 'buyer', dusd, '52', btc, '52000'),
      maxFeeSats: '52000',
      partialFill: { minGiveAmount: '1' },
    };
    store.createOrder('buyer', parent, now);
    for (let i = 0; i < 52; i++) {
      const id = `seller-${String(i).padStart(2, '0')}`;
      const trade = store.createOrder(id, order(id, id, btc, '1000', dusd, '1'), now).trade!;
      confirmTrade(store, trade);
    }
    const history = store.history('buyer');
    assert.equal(history.myOrders.length, 1);
    assert.equal(history.trades.length, 52);
    assert.equal(history.nextCursor, null);
    assert.equal(new Set(history.trades.map((trade) => trade.plan.tradeId)).size, 52);
    assert.equal(store.getOrder('parent')?.fillProgress?.fillCount, 52);
    const firstPage = store.publicHistory();
    const secondPage = store.publicHistory(firstPage.nextCursor!);
    assert.equal(firstPage.orders.length + secondPage.orders.length, 53);
    assert.equal(
      [...firstPage.orders, ...secondPage.orders].filter((row) => row.order.id === 'parent').length,
      1,
    );
  }));

test('reserves a ring atomically, persists it, and restricts trade visibility', () =>
  withStore((store, path) => {
    const a = store.createOrder('a', order('a', 'a', x, '100', dusd, '100'), now).order;
    const b = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).order;
    const c = store.createOrder('c', order('c', 'c', btc, '100000', x, '100'), now);
    assert.equal(c.trade?.plan.participants.length, 3);
    assert.deepEqual(
      [a.id, b.id, c.order.id].map((id) => store.getOrder(id)?.status),
      ['RESERVED', 'RESERVED', 'RESERVED'],
    );
    assert.equal(store.getTrade(c.trade!.plan.tradeId, 'outsider'), null);
    assert.equal(store.snapshot('outsider').trades.length, 0);
    assert.equal(
      store.snapshot('outsider').events.some((event) => event.tradeId === c.trade?.plan.tradeId),
      false,
    );
    assert.equal(store.snapshot('a').trades.length, 1);
    assert.equal(
      store.snapshot('a').events.filter((event) => event.tradeId === c.trade?.plan.tradeId).length,
      1,
    );
    assert.equal(store.listOpen(now).length, 0);
    assert.throws(
      () => store.cancelOrder('a', a.id, 0, now),
      (error) => error instanceof MarketError && error.code === 'STALE_OR_RESERVED_ORDER',
    );
    const sequence = store.sequence();
    assert.equal(store.snapshot('a', sequence).events.length, 0);
    const reopened = new MarketStore(path);
    try {
      assert.equal(
        reopened.getTrade(c.trade!.plan.tradeId, 'b')?.plan.digest,
        c.trade?.plan.digest,
      );
    } finally {
      reopened.close();
    }
  }));

test('one owner cannot reserve twice, and order ids are idempotent', () =>
  withStore((store) => {
    const aInput = order('a', 'a', btc, '100000', dusd, '100');
    const a = store.createOrder('a', aInput, now).order;
    assert.deepEqual(store.createOrder('a', aInput, now).order, a);
    assert.throws(
      () => store.createOrder('a', { ...aInput, giveAmount: '200000' }, now),
      /ORDER_ID_CONFLICT/,
    );
    assert.throws(
      () => store.createOrder('a', order('a2', 'a', x, '100', dusd, '100'), now),
      /ACTIVE_ORDER_EXISTS/,
    );
    assert.throws(() => store.cancelOrder('b', a.id, 0, now), /ORDER_NOT_FOUND/);
    assert.equal(store.cancelOrder('a', a.id, 0, now).status, 'CANCELLED');
    assert.throws(() => store.cancelOrder('a', a.id, 0, now), /STALE_OR_RESERVED_ORDER/);
    store.createOrder('a', order('a3', 'a', x, '100', dusd, '100'), now);
  }));

test('rejects cross-network, non-atomic amount and expired order', () =>
  withStore((store) => {
    const a = order('a', 'a', btc, '100', dusd, '1');
    assert.throws(() => store.createOrder('a', { ...a, giveAmount: '1.5' }, now));
    assert.throws(() => store.createOrder('a', { ...a, network: 'signet' }, now));
    assert.throws(
      () => store.createOrder('a', { ...a, expiresAt: now - 1 }, now),
      /Invalid expiry/,
    );
  }));

test('regtest-only market rejects two otherwise compatible mainnet orders', () =>
  withStore((store) => {
    const mainnetBtc = { ...btc, network: 'mainnet' as const };
    const mainnetDusd = { ...dusd, network: 'mainnet' as const };
    const a = {
      ...order('main-a', 'a', mainnetBtc, '100000', mainnetDusd, '100'),
      network: 'mainnet' as const,
    };
    const b = {
      ...order('main-b', 'b', mainnetDusd, '100', mainnetBtc, '100000'),
      network: 'mainnet' as const,
    };
    assert.throws(() => store.createOrder('a', a, now), /UNSUPPORTED_NETWORK/);
    assert.throws(() => store.createOrder('b', b, now), /UNSUPPORTED_NETWORK/);
    assert.equal(store.listOpen(now).length, 0);
    assert.equal(store.sequence(), 0);
  }));

test('relay is participant-only, idempotent and cannot assert confirmed status', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const match = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    const id = match.plan.tradeId;
    const message = {
      messageId: 'm1',
      revision: 0,
      type: 'prepare',
      payload: { material: 'test' },
    };
    assert.throws(() => store.relayTradeMessage('outsider', id, message), /TRADE_NOT_FOUND/);
    const event = store.relayTradeMessage('a', id, message);
    assert.equal(store.relayTradeMessage('a', id, message).sequence, event.sequence);
    assert.equal(store.getTrade(id, 'a')?.messages.length, 1);
    assert.throws(
      () => store.relayTradeMessage('a', id, { ...message, payload: { material: 'different' } }),
      /MESSAGE_ID_CONFLICT/,
    );
    assert.throws(() =>
      store.relayTradeMessage('a', id, { ...message, messageId: 'm2', type: 'confirmed' }),
    );
    assert.equal(store.getTrade(id, 'a')?.status, 'PREPARING');
  }));

test('rejects tampered package and retains reservations after signature', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    const id = trade.plan.tradeId;
    const pkg = {
      protocolVersion: 1,
      packageId: 'p1',
      tradeId: id,
      planRevision: 0,
      planDigest: trade.plan.digest,
      network: 'regtest',
      unsignedTxDigest: '0'.repeat(64),
      commitmentDigest: '1'.repeat(64),
      format: 'test-only',
      payload: {},
    };
    assert.throws(
      () =>
        store.relayTradeMessage('a', id, {
          messageId: 'bad',
          revision: 0,
          type: 'package',
          payload: { ...pkg, planDigest: 'f'.repeat(64) },
        }),
      /PACKAGE_PLAN_MISMATCH/,
    );
    assert.equal(store.getTrade(id, 'a')?.settlementPackage, undefined);
    store.relayTradeMessage('a', id, {
      messageId: 'package',
      revision: 0,
      type: 'package',
      payload: pkg,
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'AWAITING_APPROVAL');
    store.relayTradeMessage('a', id, {
      messageId: 'signature',
      revision: 0,
      type: 'signature',
      payload: {
        packageId: 'p1',
        unsignedTxDigest: pkg.unsignedTxDigest,
        commitmentDigest: pkg.commitmentDigest,
        signature: 'test',
      },
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'SIGNING');
    assert.throws(
      () =>
        store.relayTradeMessage('a', id, {
          messageId: 'replace',
          revision: 0,
          type: 'package',
          payload: { ...pkg, packageId: 'p2' },
        }),
      /PACKAGE_LOCKED/,
    );
    store.relayTradeMessage('b', id, {
      messageId: 'reject',
      revision: 0,
      type: 'reject',
      payload: { reason: 'wallet refused' },
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'RECONCILING');
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.status),
      ['RESERVED', 'RESERVED'],
    );
    assert.throws(
      () => store.createOrder('a', order('a2', 'a', btc, '1', dusd, '1'), now),
      /ACTIVE_ORDER_EXISTS/,
    );
  }));

test('reject before signature releases every reserved order', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    store.relayTradeMessage('a', trade.plan.tradeId, {
      messageId: 'reject',
      revision: 0,
      type: 'reject',
      payload: { reason: 'not approved' },
    });
    assert.equal(store.getTrade(trade.plan.tradeId, 'a')?.status, 'REJECTED');
    assert.deepEqual(
      ['a', 'b'].map((id) => store.getOrder(id)?.status),
      ['CANCELLED', 'CANCELLED'],
    );
    store.createOrder('a', order('a2', 'a', btc, '1', dusd, '1'), now);
    store.createOrder('b', order('b2', 'b', dusd, '1', btc, '1'), now);
  }));

test('locally ambiguous signature notice keeps reservations even if relay was lost', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    store.relayTradeMessage('a', trade.plan.tradeId, {
      messageId: 'ambiguous',
      revision: 0,
      type: 'reject',
      payload: { reason: 'signature relay failed', signatureMayExist: true },
    });
    assert.equal(store.getTrade(trade.plan.tradeId, 'b')?.status, 'RECONCILING');
    assert.deepEqual(
      ['a', 'b'].map((id) => store.getOrder(id)?.status),
      ['RESERVED', 'RESERVED'],
    );
  }));

test('durable signing intent protects reservations before any signature relay', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    const id = trade.plan.tradeId;
    const packageValue = {
      protocolVersion: 1,
      packageId: 'p1',
      tradeId: id,
      planRevision: 0,
      planDigest: trade.plan.digest,
      network: 'regtest',
      unsignedTxDigest: '0'.repeat(64),
      commitmentDigest: '1'.repeat(64),
      format: 'test-only',
      payload: {},
    };
    store.relayTradeMessage('a', id, {
      messageId: 'package',
      revision: 0,
      type: 'package',
      payload: packageValue,
    });
    store.relayTradeMessage('a', id, {
      messageId: 'signing-intent',
      revision: 0,
      type: 'signature',
      payload: {
        packageId: 'p1',
        unsignedTxDigest: packageValue.unsignedTxDigest,
        commitmentDigest: packageValue.commitmentDigest,
        signatureMayExist: true,
      },
    });
    store.relayTradeMessage('b', id, {
      messageId: 'reject',
      revision: 0,
      type: 'reject',
      payload: { reason: 'declined' },
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'RECONCILING');
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.status),
      ['RESERVED', 'RESERVED'],
    );
  }));

test('direct trade fills only after both authenticated wallets report the same confirmed RGB txid', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    const id = trade.plan.tradeId;
    signingTrade(store, trade);
    const first = {
      messageId: 'receipt-a',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    };
    const firstEvent = store.relayTradeMessage('a', id, first);
    assert.equal(store.getTrade(id, 'a')?.status, 'SIGNING');
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.status),
      ['RESERVED', 'RESERVED'],
    );
    assert.throws(
      () => store.relayTradeMessage('outsider', id, { ...first, messageId: 'outsider' }),
      /TRADE_NOT_FOUND/,
    );
    store.relayTradeMessage('b', id, {
      messageId: 'receipt-b',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'CONFIRMED');
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.status),
      ['FILLED', 'FILLED'],
    );
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.revision),
      [2, 2],
    );
    assert.equal(store.relayTradeMessage('a', id, first).sequence, firstEvent.sequence);
    store.createOrder('a', order('a2', 'a', btc, '1', dusd, '1'), now);
  }));

test('ring requires three distinct participant receipts and never confirms mismatched txids', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', x, '100', dusd, '100'), now);
    store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now);
    const trade = store.createOrder('c', order('c', 'c', btc, '100000', x, '100'), now).trade!;
    const id = trade.plan.tradeId;
    signingTrade(store, trade);
    store.relayTradeMessage('a', id, {
      messageId: 'receipt-a',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    store.relayTradeMessage('b', id, {
      messageId: 'receipt-b',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    assert.equal(store.getTrade(id, 'c')?.status, 'SIGNING');
    store.relayTradeMessage('c', id, {
      messageId: 'receipt-c-wrong',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id, 'b'.repeat(64)),
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'RECONCILING');
    assert.deepEqual(
      ['a', 'b', 'c'].map((orderId) => store.getOrder(orderId)?.status),
      ['RESERVED', 'RESERVED', 'RESERVED'],
    );
    store.relayTradeMessage('c', id, {
      messageId: 'receipt-c-correct',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    assert.equal(store.getTrade(id, 'b')?.status, 'CONFIRMED');
    assert.deepEqual(
      ['a', 'b', 'c'].map((orderId) => store.getOrder(orderId)?.status),
      ['FILLED', 'FILLED', 'FILLED'],
    );
  }));

test('missing RGB acceptance and mock receipts cannot finish a trade', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    const id = trade.plan.tradeId;
    signingTrade(store, trade);
    assert.throws(
      () =>
        store.relayTradeMessage('a', id, {
          messageId: 'missing-rgb',
          revision: 0,
          type: 'receipt',
          payload: { ...confirmedReceipt(id), rgbAccepted: false },
        }),
      /INVALID_CONFIRMED_RECEIPT/,
    );
    assert.throws(() =>
      store.relayTradeMessage('a', id, {
        messageId: 'mock-confirmed',
        revision: 0,
        type: 'receipt',
        payload: { ...confirmedReceipt(id), mode: 'mock' },
      }),
    );
    store.relayTradeMessage('a', id, {
      messageId: 'mock-pending',
      revision: 0,
      type: 'receipt',
      payload: {
        mode: 'mock',
        tradeId: id,
        network: 'regtest',
        chainConfirmed: false,
        rgbAccepted: false,
        state: 'pending',
      },
    });
    store.relayTradeMessage('b', id, {
      messageId: 'receipt-b',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'SIGNING');
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.status),
      ['RESERVED', 'RESERVED'],
    );
  }));

test('confirmed wallet reports cannot override a different broadcast txid', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    const id = trade.plan.tradeId;
    signingTrade(store, trade);
    store.relayTradeMessage('a', id, {
      messageId: 'broadcast',
      revision: 0,
      type: 'broadcast',
      payload: {
        mode: 'real',
        tradeId: id,
        network: 'regtest',
        txid: 'b'.repeat(64),
        chainConfirmed: false,
        rgbAccepted: false,
        state: 'pending',
      },
    });
    store.relayTradeMessage('a', id, {
      messageId: 'receipt-a',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    store.relayTradeMessage('b', id, {
      messageId: 'receipt-b',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    assert.equal(store.getTrade(id, 'a')?.status, 'RECONCILING');
    assert.deepEqual(
      ['a', 'b'].map((orderId) => store.getOrder(orderId)?.status),
      ['RESERVED', 'RESERVED'],
    );
  }));

test('signature recovery in RECONCILING keeps reservations and rejects changed signatures/package', () =>
  withStore((store) => {
    store.createOrder('a', order('a', 'a', btc, '100000', dusd, '100'), now);
    const trade = store.createOrder('b', order('b', 'b', dusd, '100', btc, '100000'), now).trade!;
    signingTrade(store, trade);
    const id = trade.plan.tradeId;
    store.relayTradeMessage('a', id, {
      messageId: 'uncertain',
      revision: 0,
      type: 'reject',
      payload: { signatureMayExist: true },
    });
    const payload = {
      packageId: 'package-1',
      unsignedTxDigest: '0'.repeat(64),
      commitmentDigest: '1'.repeat(64),
      signature: 'test-only',
    };
    const message = { messageId: 'recovered', revision: 0, type: 'signature', payload };
    const first = store.relayTradeMessage('a', id, message);
    assert.equal(store.relayTradeMessage('a', id, message).sequence, first.sequence);
    assert.equal(store.getTrade(id, 'a')!.status, 'RECONCILING');
    assert.throws(
      () =>
        store.relayTradeMessage('a', id, {
          ...message,
          messageId: 'conflict',
          payload: { ...payload, signature: 'changed' },
        }),
      /SIGNATURE_CONFLICT/,
    );
    assert.throws(
      () =>
        store.relayTradeMessage('b', id, {
          ...message,
          messageId: 'wrong-package',
          payload: { ...payload, packageId: 'other' },
        }),
      /SIGNATURE_PACKAGE_MISMATCH/,
    );
    assert.equal(store.getOrder('a')!.status, 'RESERVED');
    const receipt = {
      ...confirmedReceipt(id),
      state: 'pending',
      chainConfirmed: false,
      rgbAccepted: false,
    };
    store.relayTradeMessage('a', id, {
      messageId: 'broadcast-one',
      revision: 0,
      type: 'broadcast',
      payload: receipt,
    });
    assert.throws(
      () =>
        store.relayTradeMessage('b', id, {
          messageId: 'broadcast-conflict',
          revision: 0,
          type: 'broadcast',
          payload: { ...receipt, txid: 'b'.repeat(64) },
        }),
      /BROADCAST_TXID_CONFLICT/,
    );
  }));

test('public activity retains direct orders through settlement without exposing private trade material', () =>
  withStore((store) => {
    store.createOrder('a', order('public-a', 'a', x, '100', dusd, '100'), now);
    assert.equal(store.publicActivity(now).orders[0].execution, null);
    const { trade } = store.createOrder('b', order('public-b', 'b', dusd, '100', x, '100'), now);
    assert.ok(trade);
    const id = trade.plan.tradeId;
    const check = (status: string) => {
      const entries = store.publicActivity(now + 2 * 86400000).orders;
      assert.equal(
        entries.length,
        2,
        'reserved or finished orders remain visible after order expiry',
      );
      for (const entry of entries) {
        assert.deepEqual(Object.keys(entry).sort(), ['execution', 'order']);
        assert.deepEqual(entry.execution, { status, participants: 2 });
      }
      const serialized = JSON.stringify(entries);
      for (const secret of [
        'private-prepare-proof',
        'private-rejection-reason',
        'settlementPackage',
        'messages',
        'unsignedTxDigest',
        'signatureMayExist',
      ]) {
        assert.equal(serialized.includes(secret), false);
      }
    };
    check('RESERVED');
    store.relayTradeMessage('a', id, {
      messageId: 'prepare',
      revision: 0,
      type: 'prepare',
      payload: { proof: 'private-prepare-proof' },
    });
    check('PREPARING');
    signingTrade(store, trade);
    check('SIGNING');
    store.relayTradeMessage('a', id, {
      messageId: 'receipt-a',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    check('SIGNING');
    store.relayTradeMessage('b', id, {
      messageId: 'receipt-b',
      revision: 0,
      type: 'receipt',
      payload: confirmedReceipt(id),
    });
    check('CONFIRMED');
    assert.equal(
      store.publicActivity(now).orders.every((entry) => entry.order.status === 'FILLED'),
      true,
    );
  }));

test('public activity exposes ring progress and declined outcomes but no private rejection reason', () =>
  withStore((store) => {
    store.createOrder('a', order('ring-a', 'a', x, '100', dusd, '100'), now);
    store.createOrder('b', order('ring-b', 'b', dusd, '100', btc, '100000'), now);
    const { trade } = store.createOrder('c', order('ring-c', 'c', btc, '100000', x, '100'), now);
    assert.ok(trade);
    assert.equal(store.publicActivity(now).orders.length, 3);
    assert.equal(
      store.publicActivity(now).orders.every((entry) => entry.execution?.participants === 3),
      true,
    );
    store.relayTradeMessage('c', trade.plan.tradeId, {
      messageId: 'reject',
      revision: 0,
      type: 'reject',
      payload: { reason: 'private-rejection-reason' },
    });
    const activity = store.publicActivity(now);
    assert.equal(
      activity.orders.every((entry) => entry.execution?.status === 'REJECTED'),
      true,
    );
    assert.equal(JSON.stringify(activity).includes('private-rejection-reason'), false);
  }));

test('all order outcomes remain pageable beyond 50 trades after restart, with private details restricted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgb-market-history-'));
  const path = join(dir, 'market.sqlite');
  let store = new MarketStore(path);
  const expectedIds: string[] = [];
  try {
    for (let index = 0; index < 55; index++) {
      const suffix = String(index).padStart(2, '0');
      const a = order(`a-${suffix}`, 'a', x, '100', dusd, '100');
      const b = order(`b-${suffix}`, 'b', dusd, '100', x, '100');
      expectedIds.push(a.id, b.id);
      store.createOrder('a', a, now);
      const { trade } = store.createOrder('b', b, now);
      assert.ok(trade);
      if (index % 3 === 0) {
        signingTrade(store, trade);
        for (const owner of ['a', 'b']) {
          store.relayTradeMessage(owner, trade.plan.tradeId, {
            messageId: `receipt-${owner}`,
            revision: 0,
            type: 'receipt',
            payload: confirmedReceipt(trade.plan.tradeId),
          });
        }
      } else {
        store.relayTradeMessage('a', trade.plan.tradeId, {
          messageId: 'failed',
          revision: 0,
          type: index % 3 === 1 ? 'reject' : 'unsupported',
          payload: { reason: 'private-history-failure' },
        });
      }
    }
    store.createOrder('a', order('a-cancelled', 'a', x, '100', dusd, '100'), now);
    store.cancelOrder('a', 'a-cancelled', 0, now);
    store.createOrder(
      'a',
      { ...order('a-expired', 'a', x, '100', dusd, '100'), expiresAt: now + 1000 },
      now,
    );
    store.expireOrders(now + 1000);
    store.createOrder('a', order('z-open', 'a', x, '100', dusd, '100'), now);
    expectedIds.push('a-cancelled', 'a-expired', 'z-open');

    const first = PublicMarketHistorySchema.parse(store.publicHistory());
    assert.equal(first.orders.length, 50);
    assert.ok(first.nextCursor);
    store.close();
    store = new MarketStore(path);
    const publicOrders = [...first.orders];
    let cursor: string | null = first.nextCursor;
    while (cursor) {
      const page = PublicMarketHistorySchema.parse(store.publicHistory(cursor));
      assert.ok(page.orders.length > 0 && page.orders.length <= 50);
      publicOrders.push(...page.orders);
      cursor = page.nextCursor;
    }
    assert.deepEqual(
      publicOrders.map((entry) => entry.order.id),
      expectedIds.sort().reverse(),
    );
    assert.equal(new Set(publicOrders.map((entry) => entry.order.id)).size, expectedIds.length);
    assert.equal(
      publicOrders.find((entry) => entry.order.id === 'a-expired')?.order.status,
      'EXPIRED',
    );
    assert.deepEqual(
      publicOrders.find((entry) => entry.order.id === 'a-cancelled')?.execution,
      null,
    );
    for (const status of ['CONFIRMED', 'REJECTED', 'UNSUPPORTED'])
      assert.ok(publicOrders.some((entry) => entry.execution?.status === status));
    for (const secret of [
      'private-history-failure',
      'messages',
      'reason',
      'plan',
      'settlementPackage',
      'signatureMayExist',
    ])
      assert.equal(JSON.stringify(publicOrders).includes(secret), false);

    const firstPrivate = MarketHistorySchema.parse(store.history('a'));
    assert.equal(firstPrivate.myOrders.length, 50);
    assert.ok(firstPrivate.nextCursor);
    const restPrivate = MarketHistorySchema.parse(store.history('a', firstPrivate.nextCursor));
    assert.equal(restPrivate.nextCursor, null);
    const myOrders = [...firstPrivate.myOrders, ...restPrivate.myOrders];
    const myTrades = [...firstPrivate.trades, ...restPrivate.trades];
    assert.equal(myOrders.length, 58);
    assert.equal(myTrades.length, 55);
    assert.ok(myOrders.every((entry) => entry.ownerId === 'a'));
    assert.ok(myTrades.every((entry) => entry.plan.participants.includes('a')));
    assert.ok(myTrades.some((entry) => entry.reason === 'private-history-failure'));
    assert.ok(myTrades.every((entry) => !('messages' in entry) && !('settlementPackage' in entry)));
    const confirmed = myTrades.find((entry) => entry.status === 'CONFIRMED');
    assert.ok(confirmed);
    const fullTrade = store.getTrade(confirmed.plan.tradeId, 'a');
    assert.ok(fullTrade?.messages.length && fullTrade.settlementPackage);
    assert.equal(TradeHistorySchema.safeParse(fullTrade).success, false);
    assert.deepEqual(store.history('outsider'), { myOrders: [], trades: [], nextCursor: null });
    assert.throws(
      () => store.history('b', Buffer.from('a-00').toString('base64url')),
      /INVALID_HISTORY_CURSOR/,
    );
    for (const invalid of ['', '!', 'a'.repeat(301), Buffer.from('missing').toString('base64url')])
      assert.throws(() => store.publicHistory(invalid), /INVALID_HISTORY_CURSOR/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history cursors remain stable when newer orders arrive between pages', () =>
  withStore((store) => {
    for (let index = 0; index < 51; index++) {
      const id = `order-${String(index).padStart(2, '0')}`;
      store.createOrder('a', order(id, 'a', x, '100', dusd, '100'), now);
      store.cancelOrder('a', id, 0, now);
    }
    const first = store.publicHistory();
    assert.ok(first.nextCursor);
    store.createOrder('a', order('z-new', 'a', x, '100', dusd, '100'), now);
    const last = store.publicHistory(first.nextCursor);
    assert.deepEqual(
      last.orders.map((entry) => entry.order.id),
      ['order-00'],
    );
    assert.equal(last.nextCursor, null);
    assert.equal(store.publicHistory().orders[0].order.id, 'z-new');
  }));

test('committed cancelled order history survives an ungraceful process exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgb-market-crash-'));
  const path = join(dir, 'market.sqlite');
  const input = order('crash-cancelled', 'a', x, '100', dusd, '100');
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { MarketStore } from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)};
      const store = new MarketStore(${JSON.stringify(path)});
      store.createOrder('a', ${JSON.stringify(input)}, ${now});
      store.cancelOrder('a', 'crash-cancelled', 0, ${now});
      process.kill(process.pid, 'SIGKILL');
    `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const reopened = new MarketStore(path);
    try {
      assert.equal(reopened.history('a').myOrders[0].status, 'CANCELLED');
      assert.equal(reopened.publicHistory().orders[0].order.id, input.id);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
