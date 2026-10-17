import {
  isOrderFillValid,
  orderRemainingGive,
  sameAsset,
  type AssetRef,
  type PublicOrder,
} from '@rgb-exchange/contracts';

export type MatchOrder = PublicOrder;

export type Match = {
  orders: MatchOrder[];
  legs: { fromOrderId: string; toOrderId: string; asset: AssetRef; amount: string }[];
};

export const MAX_ATOMIC_AMOUNT = (1n << 64n) - 1n;

export function atomicAmount(value: string, positive = false): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('INVALID_ATOMIC_AMOUNT');
  const amount = BigInt(value);
  if (amount > MAX_ATOMIC_AMOUNT || (positive && amount === 0n))
    throw new Error('INVALID_ATOMIC_AMOUNT');
  return amount;
}

export function isOpen(order: MatchOrder, now: number): boolean {
  return order.status === 'OPEN' && order.expiresAt > now;
}

function validCycle(orders: MatchOrder[], now: number): Match | null {
  if (orders.some((order) => order.partialFill)) return null;
  if (!orders.every((order) => isOpen(order, now))) return null;
  if (new Set(orders.map((order) => order.ownerId)).size !== orders.length) return null;
  if (new Set(orders.map((order) => order.id)).size !== orders.length) return null;
  if (!orders.every((order) => order.network === orders[0].network)) return null;
  const legs: Match['legs'] = [];
  for (let i = 0; i < orders.length; i++) {
    const giver = orders[i];
    const recipient = orders[(i + 1) % orders.length];
    if (!sameAsset(giver.giveAsset, recipient.receiveAsset)) return null;
    if (atomicAmount(giver.giveAmount, true) < atomicAmount(recipient.minReceiveAmount, true))
      return null;
    legs.push({
      fromOrderId: giver.id,
      toOrderId: recipient.id,
      asset: giver.giveAsset,
      amount: giver.giveAmount,
    });
  }
  return { orders, legs };
}

const smaller = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const larger = (a: bigint, b: bigint): bigint => (a > b ? a : b);

// Euclidean floor sums count integer fills without scanning atomic units.
function floorSum(count: bigint, divisor: bigint, multiplier: bigint, offset: bigint): bigint {
  let total = 0n;
  while (true) {
    total += ((count - 1n) * count * (multiplier / divisor)) / 2n + count * (offset / divisor);
    multiplier %= divisor;
    offset %= divisor;
    const top = multiplier * count + offset;
    if (top < divisor) return total;
    count = top / divisor;
    offset = top % divisor;
    [divisor, multiplier] = [multiplier, divisor];
  }
}

function integerFill(a: MatchOrder, b: MatchOrder): [bigint, bigint] | null {
  const aGive = BigInt(a.giveAmount);
  const aReceive = BigInt(a.minReceiveAmount);
  const bGive = BigInt(b.giveAmount);
  const bReceive = BigInt(b.minReceiveAmount);
  if (aReceive * bReceive > aGive * bGive) return null;
  const remainingA = orderRemainingGive(a);
  const remainingB = orderRemainingGive(b);
  const maxA = smaller(
    remainingA,
    MAX_ATOMIC_AMOUNT - BigInt(b.fillProgress?.receivedAmount ?? '0'),
  );
  const maxB = smaller(
    remainingB,
    MAX_ATOMIC_AMOUNT - BigInt(a.fillProgress?.receivedAmount ?? '0'),
  );
  const minA = smaller(remainingA, BigInt(a.partialFill!.minGiveAmount));
  const minB = smaller(remainingB, BigInt(b.partialFill!.minGiveAmount));
  let low = larger(minA, (minB * bReceive + bGive - 1n) / bGive);
  let high = smaller(maxA, (maxB * aGive) / aReceive);
  const countFills = (from: bigint, to: bigint): bigint => {
    if (from > to) return 0n;
    const count = to - from + 1n;
    const upperCount = larger(0n, smaller(to, (maxB * bReceive) / bGive) - from + 1n);
    const upper = floorSum(upperCount, bReceive, bGive, from * bGive) + (count - upperCount) * maxB;
    const lowerCount = larger(0n, smaller(to, (minB * aGive) / aReceive) - from + 1n);
    const lower =
      lowerCount * minB +
      floorSum(count - lowerCount, aGive, aReceive, (from + lowerCount) * aReceive + aGive - 1n);
    return upper - lower + count;
  };
  if (countFills(low, high) === 0n) return null;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (countFills(middle, high) > 0n) low = middle;
    else high = middle - 1n;
  }
  return [low, smaller(maxB, (low * bGive) / bReceive)];
}

function partialDirect(a: MatchOrder, b: MatchOrder): Match | null {
  if (
    (!a.partialFill && !b.partialFill) ||
    a.id === b.id ||
    a.ownerId === b.ownerId ||
    a.network !== b.network ||
    !sameAsset(a.giveAsset, b.receiveAsset) ||
    !sameAsset(b.giveAsset, a.receiveAsset)
  )
    return null;
  const remainingA = orderRemainingGive(a);
  const remainingB = orderRemainingGive(b);
  const candidate = (giveA: bigint, giveB: bigint): Match | null => {
    if (
      !isOrderFillValid(a, giveA.toString(), giveB.toString()) ||
      !isOrderFillValid(b, giveB.toString(), giveA.toString())
    )
      return null;
    return {
      orders: [a, b],
      legs: [
        { fromOrderId: a.id, toOrderId: b.id, asset: a.giveAsset, amount: giveA.toString() },
        { fromOrderId: b.id, toOrderId: a.id, asset: b.giveAsset, amount: giveB.toString() },
      ],
    };
  };
  const full = candidate(remainingA, remainingB);
  if (full) return full;
  const boundedA = a.partialFill
    ? smaller(remainingA, (remainingB * BigInt(a.giveAmount)) / BigInt(a.minReceiveAmount))
    : remainingA;
  const boundedB = b.partialFill
    ? smaller(remainingB, (boundedA * BigInt(b.giveAmount)) / BigInt(b.minReceiveAmount))
    : remainingB;
  const boundary = candidate(boundedA, boundedB);
  if (boundary) return boundary;
  if (!a.partialFill || !b.partialFill) return null;
  const amounts = integerFill(a, b);
  return amounts ? candidate(...amounts) : null;
}

export function findMatch(input: MatchOrder[], now = Date.now()): Match | null {
  const orders = input
    .filter((order) => isOpen(order, now))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const direct = validCycle([orders[i], orders[j]], now) ?? partialDirect(orders[i], orders[j]);
      if (direct) return direct;
    }
  }
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      for (let k = j + 1; k < orders.length; k++) {
        const clockwise = validCycle([orders[i], orders[j], orders[k]], now);
        if (clockwise) return clockwise;
        const counterclockwise = validCycle([orders[i], orders[k], orders[j]], now);
        if (counterclockwise) return counterclockwise;
      }
    }
  }
  return null;
}
