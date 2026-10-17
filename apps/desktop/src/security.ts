import { WalletCapabilitiesSchema } from '@rgb-exchange/contracts';
import { z } from 'zod';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const orderId = new RegExp(`^order-${UUID}$`, 'i');
const tradeId = new RegExp(`^${UUID}$`, 'i');

export function parseOfferLink(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const match = /^palka:\/\/offer\/([a-zA-Z0-9-]+)$/.exec(raw);
  return match && orderId.test(match[1]) ? match[1] : null;
}

export function validateWalletRequest(method: unknown, path: unknown): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  if (
    typeof path !== 'string' ||
    path.length > 250 ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('%')
  )
    return false;
  if (method === 'GET') {
    if (
      [
        '/api/health',
        '/api/qvac/health',
        '/api/state',
        '/api/policy',
        '/api/snapshot',
        '/api/funding',
      ].includes(path)
    )
      return true;
    const trade = /^\/api\/trades\/([^/]+)(?:\/progress)?$/.exec(path);
    return Boolean(trade && tradeId.test(trade[1]));
  }
  if (['/api/interpret', '/api/draft/validate', '/api/orders'].includes(path)) return true;
  if (['/api/funding/create', '/api/funding/preview', '/api/funding/sync'].includes(path))
    return true;
  const cancel = /^\/api\/orders\/([^/]+)\/cancel$/.exec(path);
  if (cancel) return orderId.test(cancel[1]);
  const trade = /^\/api\/trades\/([^/]+)\/(prepare|preview|sync|reject)$/.exec(path);
  return Boolean(trade && tradeId.test(trade[1]));
}

export function validateTradeId(value: unknown): value is string {
  return typeof value === 'string' && tradeId.test(value);
}

export function walletReadyForDesktop(value: unknown): boolean {
  const parsed = z
    .object({ protocolVersion: z.literal(1), result: WalletCapabilitiesSchema })
    .strict()
    .safeParse(value);
  return (
    parsed.success && parsed.data.result.mode === 'real' && parsed.data.result.network === 'regtest'
  );
}
