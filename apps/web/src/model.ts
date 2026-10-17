import type { AssetRef, PublicOrder } from '@rgb-exchange/contracts';

export type MarketState =
  | { kind: 'loading'; orders: PublicOrder[] }
  | { kind: 'ready'; orders: PublicOrder[]; updatedAt: number }
  | { kind: 'error'; orders: PublicOrder[]; message: string };

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
