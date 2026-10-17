import { sameAsset, type AssetRef, type PublicOrder } from '@rgb-exchange/contracts';

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

export function findMatch(input: MatchOrder[], now = Date.now()): Match | null {
  const orders = input
    .filter((order) => isOpen(order, now))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (let i = 0; i < orders.length; i++) {
    for (let j = i + 1; j < orders.length; j++) {
      const direct = validCycle([orders[i], orders[j]], now);
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
