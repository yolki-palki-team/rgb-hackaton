import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atomicAmount, findMatch, type MatchOrder } from '../src/matcher.ts';
import type { AssetRef } from '@rgb-exchange/contracts';

const network = 'regtest' as const;
const btc: AssetRef = { network, kind: 'btc', precision: 8, symbol: 'BTC' };
const x: AssetRef = { network, kind: 'rgb', contractId: 'x', precision: 0, symbol: 'X' };
const dusd: AssetRef = { network, kind: 'rgb', contractId: 'dusd', precision: 0, symbol: 'DUSD' };

function order(
  id: string,
  ownerId: string,
  giveAsset: AssetRef,
  giveAmount: string,
  receiveAsset: AssetRef,
  minReceiveAmount: string,
  overrides: Partial<MatchOrder> = {},
): MatchOrder {
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
    expiresAt: Date.parse('2030-01-01T00:00:00.000Z'),
    status: 'OPEN',
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const now = Date.parse('2026-10-17T00:00:00.000Z');

test('matches direct before a ring and preserves full give amounts', () => {
  const a = order('a', 'a', btc, '100000', dusd, '100');
  const b = order('b', 'b', dusd, '100', btc, '100000');
  const c = order('c', 'c', x, '100', dusd, '100');
  const match = findMatch([a, b, c], now);
  assert.deepEqual(
    match?.orders.map((item) => item.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    match?.legs.map((leg) => leg.amount),
    ['100000', '100'],
  );
});

test('matches a three-owner ring, never separate sequential settlement', () => {
  const a = order('a', 'a', x, '100', dusd, '100');
  const b = order('b', 'b', dusd, '100', btc, '100000');
  const c = order('c', 'c', btc, '100000', x, '100');
  const match = findMatch([a, b, c], now);
  assert.deepEqual(
    match?.orders.map((item) => item.id),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    match?.legs.map((leg) => [leg.fromOrderId, leg.toOrderId]),
    [
      ['a', 'c'],
      ['c', 'b'],
      ['b', 'a'],
    ],
  );
});

test('rejects insufficient ring amount, same owner, expired, mismatched contract and network', () => {
  const a = order('a', 'a', x, '100', dusd, '101');
  const b = order('b', 'b', dusd, '100', btc, '100000');
  const c = order('c', 'c', btc, '100000', x, '100');
  assert.equal(findMatch([a, b, c], now), null);
  assert.equal(
    findMatch([{ ...a, minReceiveAmount: '100' }, b, { ...c, ownerId: 'b' }], now),
    null,
  );
  assert.equal(
    findMatch(
      [
        { ...a, minReceiveAmount: '100' },
        b,
        { ...c, expiresAt: Date.parse('2020-01-01T00:00:00.000Z') },
      ],
      now,
    ),
    null,
  );
  assert.equal(
    findMatch(
      [{ ...a, minReceiveAmount: '100' }, b, { ...c, receiveAsset: { ...x, contractId: 'other' } }],
      now,
    ),
    null,
  );
  assert.equal(
    findMatch([{ ...a, minReceiveAmount: '100' }, b, { ...c, network: 'signet' }], now),
    null,
  );
});

test('atomic amounts reject fractions, signs, exponent, leading zeros and u64 overflow', () => {
  for (const invalid of ['1.1', '-1', '+1', '1e3', '01', '18446744073709551616'])
    assert.throws(() => atomicAmount(invalid), /INVALID_ATOMIC_AMOUNT/);
  assert.equal(atomicAmount('18446744073709551615'), 18446744073709551615n);
  assert.throws(() => atomicAmount('0', true), /INVALID_ATOMIC_AMOUNT/);
});

test('partial direct fills use the remaining give amount without weakening either price', () => {
  const parent = order('a', 'a', dusd, '1000', btc, '1000000', {
    partialFill: { minGiveAmount: '200' },
  });
  const seller = order('b', 'b', btc, '300000', dusd, '300');
  assert.deepEqual(
    findMatch([parent, seller], now)?.legs.map((leg) => leg.amount),
    ['300', '300000'],
  );
  assert.equal(findMatch([{ ...parent, partialFill: undefined }, seller], now), null);
  assert.equal(findMatch([parent, { ...seller, minReceiveAmount: '301' }], now), null);
  assert.equal(
    findMatch([parent, { ...seller, giveAmount: '199000', minReceiveAmount: '199' }], now),
    null,
  );
  const tail = {
    ...parent,
    fillProgress: {
      filledGiveAmount: '900',
      receivedAmount: '900000',
      feeBudgetUsedSats: '900',
      fillCount: 3,
    },
  };
  assert.deepEqual(
    findMatch([tail, { ...seller, giveAmount: '100000', minReceiveAmount: '100' }], now)?.legs.map(
      (leg) => leg.amount,
    ),
    ['100', '100000'],
  );
  assert.equal(findMatch([tail, seller], now), null);
});

test('both partial orders match exact integer lots and cannot enter a ring', () => {
  const a = order('a', 'a', x, '4', dusd, '6', { partialFill: { minGiveAmount: '1' } });
  const b = order('b', 'b', dusd, '3', x, '2', { partialFill: { minGiveAmount: '1' } });
  assert.deepEqual(
    findMatch([a, b], now)?.legs.map((leg) => leg.amount),
    ['2', '3'],
  );
  const ring = [a, order('b', 'b', dusd, '6', btc, '1000'), order('c', 'c', btc, '1000', x, '4')];
  assert.equal(findMatch(ring, now), null);
  assert.equal(
    findMatch([{ ...a, partialFill: undefined }, ...ring.slice(1)], now)?.orders.length,
    3,
  );
});

test('partial price arithmetic stays exact above Number safe integer precision', () => {
  const a = order('a', 'a', x, '18446744073709551615', btc, '18446744073709551615', {
    partialFill: { minGiveAmount: '1' },
  });
  const b = order('b', 'b', btc, '9007199254740993', x, '9007199254740993');
  assert.deepEqual(
    findMatch([a, b], now)?.legs.map((leg) => leg.amount),
    ['9007199254740993', '9007199254740993'],
  );
  assert.equal(findMatch([a, { ...b, minReceiveAmount: '9007199254740994' }], now), null);
});

function remainingOrder(
  id: string,
  total: bigint,
  minimum: bigint,
  remaining: bigint,
  minFill: bigint,
  giveAsset: AssetRef,
  receiveAsset: AssetRef,
): MatchOrder {
  const filled = total - remaining;
  return order(id, id, giveAsset, total.toString(), receiveAsset, minimum.toString(), {
    partialFill: { minGiveAmount: minFill.toString() },
    fillProgress: {
      filledGiveAmount: filled.toString(),
      receivedAmount: ((filled * minimum + total - 1n) / total).toString(),
      feeBudgetUsedSats: '0',
      fillCount: filled ? 1 : 0,
    },
  });
}

test('both partially filled orders find integer amounts between their limits and minimums', () => {
  const a = remainingOrder('a', 37n, 28n, 15n, 10n, x, dusd);
  const b = remainingOrder('b', 25n, 32n, 23n, 9n, dusd, x);
  assert.deepEqual(
    findMatch([a, b], now)?.legs.map((leg) => leg.amount),
    ['13', '10'],
  );
  const narrowA = remainingOrder('a', 23n, 28n, 18n, 1n, x, dusd);
  const narrowB = remainingOrder('b', 33n, 26n, 9n, 1n, dusd, x);
  assert.deepEqual(
    findMatch([narrowA, narrowB], now)?.legs.map((leg) => leg.amount),
    ['4', '5'],
  );
  const maximum = 18446744073709551615n;
  const largeA = remainingOrder('a', maximum - 3n, maximum - 1n, maximum - 4n, 1n, x, dusd);
  const largeB = remainingOrder('b', maximum - 1n, maximum - 3n, maximum - 2n, 1n, dusd, x);
  assert.deepEqual(
    findMatch([largeA, largeB], now)?.legs.map((leg) => leg.amount),
    [((maximum - 3n) / 2n).toString(), ((maximum - 1n) / 2n).toString()],
  );
});

test('bounded integer matching agrees with an exhaustive oracle for remaining amounts and minimum fills', () => {
  let checked = 0;
  for (let aGive = 1n; aGive <= 4n; aGive++)
    for (let aReceive = 1n; aReceive <= 4n; aReceive++)
      for (let bGive = 1n; bGive <= 4n; bGive++)
        for (let bReceive = 1n; bReceive <= 4n; bReceive++)
          for (let aRemaining = 1n; aRemaining <= aGive; aRemaining++)
            for (let bRemaining = 1n; bRemaining <= bGive; bRemaining++)
              for (let minA = 1n; minA <= aGive; minA++)
                for (let minB = 1n; minB <= bGive; minB++) {
                  const valid = (give: bigint, receive: bigint): boolean =>
                    give > 0n &&
                    give <= aRemaining &&
                    receive > 0n &&
                    receive <= bRemaining &&
                    (give >= minA || give === aRemaining) &&
                    (receive >= minB || receive === bRemaining) &&
                    receive * aGive >= give * aReceive &&
                    give * bGive >= receive * bReceive;
                  let exists = false;
                  for (let give = 1n; give <= aRemaining; give++)
                    for (let receive = 1n; receive <= bRemaining; receive++)
                      if (valid(give, receive)) exists = true;
                  const match = findMatch(
                    [
                      remainingOrder('a', aGive, aReceive, aRemaining, minA, x, dusd),
                      remainingOrder('b', bGive, bReceive, bRemaining, minB, dusd, x),
                    ],
                    now,
                  );
                  assert.equal(Boolean(match), exists);
                  if (match)
                    assert.equal(
                      valid(BigInt(match.legs[0].amount), BigInt(match.legs[1].amount)),
                      true,
                    );
                  checked++;
                }
  assert.equal(checked, 14400);
});
