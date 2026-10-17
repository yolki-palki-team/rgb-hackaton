import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AtomicAmountSchema,
  PublicOrderSchema,
  OrderDraftSchema,
  isOrderFillValid,
  orderFillFeeSats,
  orderRemainingGive,
  assertPolicy,
  assetKey,
  formatAmount,
  toAtomic,
  type AssetRef,
  type OrderDraft,
  type PrivatePolicy,
  type WalletState,
  type PublicOrder,
} from '../src/index.ts';

const btc: AssetRef = { network: 'regtest', kind: 'btc', symbol: 'BTC', precision: 8 };
const x: AssetRef = {
  network: 'regtest',
  kind: 'rgb',
  symbol: 'X',
  contractId: 'contract-x',
  precision: 0,
};
const dusd: AssetRef = {
  network: 'regtest',
  kind: 'rgb',
  symbol: 'DUSD',
  contractId: 'contract-dusd',
  precision: 0,
};
const now = Date.now();
const state: WalletState = {
  walletId: 'wallet-a',
  ownerId: 'a',
  network: 'regtest',
  mode: 'real',
  observedAt: now,
  balances: [
    { asset: btc, amount: '1000000' },
    { asset: x, amount: '100' },
    { asset: dusd, amount: '0' },
  ],
};
const policy: PrivatePolicy = {
  allowedAssetKeys: [assetKey(btc), assetKey(x), assetKey(dusd)],
  protectedBalances: { [assetKey(x)]: '50', [assetKey(btc)]: '10000' },
  maxFeeSats: '1000',
  allowBtcSale: true,
};
const draft: OrderDraft = {
  giveAsset: x,
  giveAmount: '50',
  receiveAsset: dusd,
  minReceiveAmount: '100',
  maxFeeSats: '500',
  expiresAt: now + 60000,
};

test('atomic-unit conversion is exact at u64 boundaries', () => {
  assert.equal(toAtomic('0.00000001', 8), '1');
  assert.equal(toAtomic('184467440737.09551615', 8), '18446744073709551615');
  assert.equal(formatAmount('123456789', 8), '1.23456789');
  for (const invalid of ['-1', '+1', '1e3', '1.000000001', '184467440737.09551616'])
    assert.throws(() => toAtomic(invalid, 8));
  for (const invalid of ['01', '1.5', '-1', '18446744073709551616'])
    assert.equal(AtomicAmountSchema.safeParse(invalid).success, false);
});

test('legacy private restrictions are ignored but spending and fees must be funded', () => {
  const obsolete = {
    ...policy,
    allowedAssetKeys: ['obsolete'],
    allowBtcSale: false,
    maxFeeSats: '1',
    protectedBalances: { obsolete: '999999' },
  };
  assert.doesNotThrow(() => assertPolicy({ ...draft, giveAmount: '100' }, obsolete, state, now));
  assert.doesNotThrow(() => assertPolicy({ ...draft, maxFeeSats: '1001' }, obsolete, state, now));
  assert.doesNotThrow(() =>
    assertPolicy({ ...draft, giveAsset: btc, giveAmount: '999500' }, obsolete, state, now),
  );
  assert.throws(
    () => assertPolicy({ ...draft, giveAmount: '101' }, obsolete, state, now),
    /Insufficient funds/,
  );
  assert.throws(
    () => assertPolicy({ ...draft, giveAsset: btc, giveAmount: '999501' }, obsolete, state, now),
    /Insufficient funds/,
  );
  assert.throws(
    () => assertPolicy({ ...draft, maxFeeSats: '1000001' }, obsolete, state, now),
    /Insufficient funds/,
  );
});

test('policy rejects tampered network and RGB contract IDs', () => {
  assert.throws(
    () =>
      assertPolicy(
        { ...draft, receiveAsset: { ...dusd, contractId: 'attacker' } },
        policy,
        state,
        now,
      ),
    /Unverified asset/,
  );
  assert.throws(
    () =>
      assertPolicy({ ...draft, receiveAsset: { ...dusd, network: 'signet' } }, policy, state, now),
    /Unverified asset/,
  );
  assert.throws(
    () =>
      assertPolicy(
        { ...draft, giveAsset: dusd, giveAmount: '1', receiveAsset: btc },
        policy,
        state,
        now,
      ),
    /Insufficient funds/,
  );
});

test('public order schema cannot carry private policy or a mismatched asset network', () => {
  const order = {
    ...draft,
    id: 'order-1',
    ownerId: 'a',
    revision: 0,
    network: 'regtest',
    createdAt: now,
    status: 'OPEN',
  };
  assert.equal(PublicOrderSchema.safeParse(order).success, true);
  assert.equal(
    PublicOrderSchema.safeParse({ ...order, protectedBalances: { X: '50' } }).success,
    false,
  );
  assert.equal(
    PublicOrderSchema.safeParse({ ...order, giveAsset: { ...x, network: 'signet' } }).success,
    false,
  );
});

test('partial fills preserve exact limits, minimum sizes and a cumulative fee cap', () => {
  const order: PublicOrder = {
    ...draft,
    id: 'partial',
    ownerId: 'a',
    revision: 0,
    network: 'regtest',
    createdAt: now,
    status: 'OPEN',
    giveAmount: '3',
    minReceiveAmount: '10',
    maxFeeSats: '5',
    partialFill: { minGiveAmount: '2' },
  };
  assert.equal(isOrderFillValid(order, '2', '6'), false);
  assert.equal(isOrderFillValid(order, '2', '7'), true);
  assert.equal(isOrderFillValid(order, '1', '4'), false);
  assert.equal(orderFillFeeSats(order, '2'), '3');
  const remaining = PublicOrderSchema.parse({
    ...order,
    fillProgress: {
      filledGiveAmount: '2',
      receivedAmount: '7',
      feeBudgetUsedSats: '3',
      fillCount: 1,
    },
  });
  assert.equal(orderRemainingGive(remaining), 1n);
  assert.equal(isOrderFillValid(remaining, '1', '4'), true);
  assert.equal(isOrderFillValid(remaining, '2', '7'), false);
  assert.equal(orderFillFeeSats(remaining, '1'), '2');
  assert.equal(
    OrderDraftSchema.safeParse({ ...draft, partialFill: { minGiveAmount: '51' } }).success,
    false,
  );
  assert.equal(
    PublicOrderSchema.safeParse({
      ...order,
      fillProgress: { ...remaining.fillProgress, feeBudgetUsedSats: '4' },
    }).success,
    false,
  );
  assert.equal(
    PublicOrderSchema.safeParse({
      ...order,
      partialFill: undefined,
      fillProgress: remaining.fillProgress,
    }).success,
    false,
  );
});
