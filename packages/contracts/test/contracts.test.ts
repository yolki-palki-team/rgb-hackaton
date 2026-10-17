import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AtomicAmountSchema, PublicOrderSchema, assertPolicy, assetKey, formatAmount, toAtomic, type AssetRef, type OrderDraft, type PrivatePolicy, type WalletState } from '../src/index.ts';

const btc: AssetRef = { network: 'regtest', kind: 'btc', symbol: 'BTC', precision: 8 };
const x: AssetRef = { network: 'regtest', kind: 'rgb', symbol: 'X', contractId: 'contract-x', precision: 0 };
const dusd: AssetRef = { network: 'regtest', kind: 'rgb', symbol: 'DUSD', contractId: 'contract-dusd', precision: 0 };
const now = Date.now();
const state: WalletState = { walletId: 'wallet-a', ownerId: 'a', network: 'regtest', mode: 'real', observedAt: now, balances: [{ asset: btc, amount: '1000000' }, { asset: x, amount: '100' }, { asset: dusd, amount: '0' }] };
const policy: PrivatePolicy = { allowedAssetKeys: [assetKey(btc), assetKey(x), assetKey(dusd)], protectedBalances: { [assetKey(x)]: '50', [assetKey(btc)]: '10000' }, maxFeeSats: '1000', allowBtcSale: true };
const draft: OrderDraft = { giveAsset: x, giveAmount: '50', receiveAsset: dusd, minReceiveAmount: '100', maxFeeSats: '500', expiresAt: now + 60000 };

test('atomic-unit conversion is exact at u64 boundaries', () => {
  assert.equal(toAtomic('0.00000001', 8), '1');
  assert.equal(toAtomic('184467440737.09551615', 8), '18446744073709551615');
  assert.equal(formatAmount('123456789', 8), '1.23456789');
  for (const invalid of ['-1', '+1', '1e3', '1.000000001', '184467440737.09551616']) assert.throws(() => toAtomic(invalid, 8));
  for (const invalid of ['01', '1.5', '-1', '18446744073709551616']) assert.equal(AtomicAmountSchema.safeParse(invalid).success, false);
});

test('policy protects RGB balance and BTC fee reserve with BigInt', () => {
  assert.doesNotThrow(() => assertPolicy(draft, policy, state, now));
  assert.throws(() => assertPolicy({ ...draft, giveAmount: '51' }, policy, state, now), /защищённый остаток/);
  assert.throws(() => assertPolicy({ ...draft, maxFeeSats: '1001' }, policy, state, now), /лимит комиссии/);
  assert.throws(() => assertPolicy({ ...draft, giveAsset: btc, giveAmount: '990000' }, policy, state, now), /защищённый остаток/);
});

test('policy rejects tampered network and RGB contract IDs', () => {
  assert.throws(() => assertPolicy({ ...draft, receiveAsset: { ...dusd, contractId: 'attacker' } }, policy, state, now), /Непроверенный актив/);
  assert.throws(() => assertPolicy({ ...draft, receiveAsset: { ...dusd, network: 'signet' } }, policy, state, now), /Непроверенный актив/);
  assert.throws(() => assertPolicy({ ...draft, giveAsset: dusd, giveAmount: '1', receiveAsset: btc }, policy, state, now), /Недостаточно средств/);
});

test('public order schema cannot carry private policy or a mismatched asset network', () => {
  const order = { ...draft, id: 'order-1', ownerId: 'a', revision: 0, network: 'regtest', createdAt: now, status: 'OPEN' };
  assert.equal(PublicOrderSchema.safeParse(order).success, true);
  assert.equal(PublicOrderSchema.safeParse({ ...order, protectedBalances: { X: '50' } }).success, false);
  assert.equal(PublicOrderSchema.safeParse({ ...order, giveAsset: { ...x, network: 'signet' } }).success, false);
});
