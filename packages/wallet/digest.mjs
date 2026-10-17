// Same canonical ordering as A's protocol-v1 digest helper, including localeCompare.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const digestValue = (value) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
if (process.argv[2] === '--stdin')
  process.stdout.write(digestValue(JSON.parse(readFileSync(0, 'utf8'))));
