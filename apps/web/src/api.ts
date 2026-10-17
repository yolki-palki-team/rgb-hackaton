import {
  PROTOCOL_VERSION,
  PublicOrderSchema,
  PublicMarketActivitySchema,
  PublicMarketHistorySchema,
} from '@rgb-exchange/contracts';
import type { PublicOrder, PublicMarketOrder, PublicMarketHistory } from '@rgb-exchange/contracts';
import { z } from 'zod';

const PublicOrdersResponse = z.object({ orders: z.array(PublicOrderSchema) }).strict();
const PublicHealthResponse = z
  .object({
    ok: z.literal(true),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    mode: z.literal('coordination-only'),
  })
  .strict();

async function getPublic(
  path:
    | '/market-api/orders'
    | '/market-api/health'
    | '/market-api/activity'
    | `/market-api/history${string}`,
): Promise<unknown> {
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Market is temporarily unavailable (HTTP ${response.status}).`);
  return response.json();
}

export async function getPublicOrders(): Promise<PublicOrder[]> {
  const { orders } = PublicOrdersResponse.parse(await getPublic('/market-api/orders'));
  const now = Date.now();
  return orders
    .filter((order) => order.status === 'OPEN' && order.expiresAt > now)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPublicHealth(): Promise<boolean> {
  PublicHealthResponse.parse(await getPublic('/market-api/health'));
  return true;
}

export async function getPublicActivity(): Promise<PublicMarketOrder[]> {
  const { orders } = PublicMarketActivitySchema.parse(await getPublic('/market-api/activity'));
  const now = Date.now();
  return orders
    .filter(
      ({ order, execution }) =>
        execution !== null || (order.status === 'OPEN' && order.expiresAt > now),
    )
    .sort((a, b) => b.order.createdAt - a.order.createdAt);
}

export async function getPublicHistory(cursor?: string): Promise<PublicMarketHistory> {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return PublicMarketHistorySchema.parse(await getPublic(`/market-api/history${query}`));
}
