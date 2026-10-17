import { createHash } from 'node:crypto';
import type { TradePlan } from './index.ts';
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const digestValue = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export function planDigest(plan: Omit<TradePlan, 'digest'> | TradePlan): string {
  const { digest: _digest, ...content } = plan as TradePlan;
  return digestValue(content);
}
