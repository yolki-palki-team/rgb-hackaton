import type {
  AssetRef,
  PublicMarketHistory,
  PublicMarketOrder,
  TradeStatus,
} from '@rgb-exchange/contracts';

export type MarketState =
  | { kind: 'loading'; orders: PublicMarketOrder[] }
  | { kind: 'ready'; orders: PublicMarketOrder[]; updatedAt: number }
  | { kind: 'error'; orders: PublicMarketOrder[]; updatedAt?: number; message: string };

export function marketLoadFailed(current: MarketState, message: string): MarketState {
  return { ...current, kind: 'error', message };
}

export function mergeHistory(
  current: PublicMarketHistory,
  page: PublicMarketHistory,
  older: boolean,
): PublicMarketHistory {
  const orders = new Map(current.orders.map((entry) => [entry.order.id, entry]));
  for (const entry of page.orders) {
    if ((orders.get(entry.order.id)?.order.revision ?? -1) <= entry.order.revision)
      orders.set(entry.order.id, entry);
  }
  return {
    orders: [...orders.values()].sort(
      (a, b) => b.order.createdAt - a.order.createdAt || b.order.id.localeCompare(a.order.id),
    ),
    nextCursor: older || current.orders.length === 0 ? page.nextCursor : current.nextCursor,
  };
}

export function orderStatusLabel(entry: PublicMarketOrder): string {
  if (entry.execution) return executionLabels[entry.execution.status];
  return {
    OPEN: 'Waiting',
    RESERVED: 'Matched',
    FILLED: 'Filled',
    CANCELLED: 'Cancelled',
    EXPIRED: 'Expired',
  }[entry.order.status];
}

export function formatAssetAmount(asset: AssetRef, atomic: string): string {
  const precision = asset.precision;
  const digits = atomic.padStart(precision + 1, '0');
  if (precision === 0) return BigInt(atomic).toLocaleString('en-US');
  const whole = BigInt(digits.slice(0, -precision)).toLocaleString('en-US');
  const fraction = digits.slice(-precision).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function formatAsset(asset: AssetRef, atomic: string): string {
  return `${formatAssetAmount(asset, atomic)} ${asset.kind === 'btc' ? 'BTC' : asset.symbol}`;
}

export function assetIdentity(asset: AssetRef): string {
  return asset.kind === 'btc'
    ? `${asset.network} · Bitcoin`
    : `${asset.network} · RGB ${asset.contractId}`;
}

export function shortId(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

export function desktopOfferUrl(id: string): string | null {
  return /^order-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? `palka://offer/${id}`
    : null;
}

export const executionLabels: Record<TradeStatus, string> = {
  RESERVED: 'Match found',
  PREPARING: 'Preparing swap',
  AWAITING_APPROVAL: 'Awaiting approval',
  SIGNING: 'Collecting signatures',
  READY_TO_BROADCAST: 'Ready to broadcast',
  BROADCAST: 'Awaiting confirmation',
  RECONCILING: 'Checking settlement',
  CONFIRMED: 'Completed',
  REJECTED: 'Declined',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  UNSUPPORTED: 'Unsupported',
};

export function executionStep(status: TradeStatus): number | null {
  if (status === 'RESERVED' || status === 'PREPARING') return 0;
  if (status === 'AWAITING_APPROVAL') return 1;
  if (status === 'SIGNING' || status === 'READY_TO_BROADCAST') return 2;
  if (status === 'BROADCAST') return 3;
  if (status === 'CONFIRMED') return 4;
  return null;
}
