import type { Balance, Trade } from './model';

export function isFinishedTrade(trade: Pick<Trade, 'status'>): boolean {
  return ['CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED'].includes(
    trade.status,
  );
}

// Compare displayed quantities exactly, including assets beyond Number's integer range.
// This sorts by quantity, not by fiat value; it never changes signing amounts.
export function sortBalances(balances: Balance[]): Balance[] {
  const parts = (amount: string) => amount.replace(/[,\s]/g, '').split('.');
  return [...balances].sort((a, b) => {
    const [aw, af = ''] = parts(a.amount);
    const [bw, bf = ''] = parts(b.amount);
    const precision = Math.max(af.length, bf.length);
    const av = BigInt(aw + af.padEnd(precision, '0'));
    const bv = BigInt(bw + bf.padEnd(precision, '0'));
    return av === bv ? a.code.localeCompare(b.code) : av > bv ? -1 : 1;
  });
}

export function completionKey(
  profile: { mode: string; network: string; ownerId: string },
  id: string,
) {
  return `palka:dismissed-swap:v1:${profile.mode}:${profile.network}:${profile.ownerId}:${id}`;
}

export function isCompletionDismissed(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissCompletion(key: string): boolean {
  try {
    localStorage.setItem(key, 'dismissed');
    return true;
  } catch {
    return false;
  }
}
