import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MarketError, MarketStore } from '../src/store.ts';
import type { AssetRef, PublicOrder, TradeSnapshot } from '@rgb-exchange/contracts';

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
