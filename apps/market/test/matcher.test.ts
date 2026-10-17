import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomicAmount, findMatch, type MatchOrder } from '../src/matcher.ts';
import type { AssetRef } from '@rgb-exchange/contracts';

const network = 'regtest' as const;
const btc: AssetRef = { network, kind: 'btc', precision: 8, symbol: 'BTC' };
const x: AssetRef = { network, kind: 'rgb', contractId: 'x', precision: 0, symbol: 'X' };
const dusd: AssetRef = { network, kind: 'rgb', contractId: 'dusd', precision: 0, symbol: 'DUSD' };

function order(id: string, ownerId: string, giveAsset: AssetRef, giveAmount: string, receiveAsset: AssetRef, minReceiveAmount: string, overrides: Partial<MatchOrder> = {}): MatchOrder {
  return { id, ownerId, revision: 0, network, giveAsset, giveAmount, receiveAsset, minReceiveAmount, maxFeeSats: '1000', expiresAt: Date.parse('2030-01-01T00:00:00.000Z'), status: 'OPEN', createdAt: Date.parse('2026-01-01T00:00:00.000Z'), ...overrides };
}

const now = Date.parse('2026-10-17T00:00:00.000Z');

test('matches direct before a ring and preserves full give amounts', () => {
  const a = order('a', 'a', btc, '100000', dusd, '100');
  const b = order('b', 'b', dusd, '100', btc, '100000');
  const c = order('c', 'c', x, '100', dusd, '100');
  const match = findMatch([a, b, c], now);
  assert.deepEqual(match?.orders.map((item) => item.id), ['a', 'b']);
  assert.deepEqual(match?.legs.map((leg) => leg.amount), ['100000', '100']);
});

test('matches a three-owner ring, never separate sequential settlement', () => {
  const a = order('a', 'a', x, '100', dusd, '100');
  const b = order('b', 'b', dusd, '100', btc, '100000');
  const c = order('c', 'c', btc, '100000', x, '100');
  const match = findMatch([a, b, c], now);
  assert.deepEqual(match?.orders.map((item) => item.id), ['a', 'c', 'b']);
  assert.deepEqual(match?.legs.map((leg) => [leg.fromOrderId, leg.toOrderId]), [['a', 'c'], ['c', 'b'], ['b', 'a']]);
});

test('rejects insufficient ring amount, same owner, expired, mismatched contract and network', () => {
  const a = order('a', 'a', x, '100', dusd, '101');
  const b = order('b', 'b', dusd, '100', btc, '100000');
  const c = order('c', 'c', btc, '100000', x, '100');
  assert.equal(findMatch([a, b, c], now), null);
  assert.equal(findMatch([{ ...a, minReceiveAmount: '100' }, b, { ...c, ownerId: 'b' }], now), null);
  assert.equal(findMatch([{ ...a, minReceiveAmount: '100' }, b, { ...c, expiresAt: Date.parse('2020-01-01T00:00:00.000Z') }], now), null);
  assert.equal(findMatch([{ ...a, minReceiveAmount: '100' }, b, { ...c, receiveAsset: { ...x, contractId: 'other' } }], now), null);
  assert.equal(findMatch([{ ...a, minReceiveAmount: '100' }, b, { ...c, network: 'signet' }], now), null);
});

test('atomic amounts reject fractions, signs, exponent, leading zeros and u64 overflow', () => {
  for (const invalid of ['1.1', '-1', '+1', '1e3', '01', '18446744073709551616']) assert.throws(() => atomicAmount(invalid), /INVALID_ATOMIC_AMOUNT/);
  assert.equal(atomicAmount('18446744073709551615'), 18446744073709551615n);
  assert.throws(() => atomicAmount('0', true), /INVALID_ATOMIC_AMOUNT/);
});
