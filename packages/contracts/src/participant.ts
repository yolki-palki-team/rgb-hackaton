import { createHash } from 'node:crypto';

export function participantId(token: string): string {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid registration token');
  return `participant-${createHash('sha256').update(`palka-participant-v1:${token}`).digest('hex')}`;
}

export function participantTokenHash(token: string): string {
  return createHash('sha256').update(`palka-market-token-v1:${token}`).digest('hex');
}
