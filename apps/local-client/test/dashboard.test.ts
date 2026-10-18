import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completionKey,
  dismissCompletion,
  isCompletionDismissed,
  sortBalances,
} from '../ui/src/dashboard';

test('asset quantities sort exactly across decimals and large integers without mutating balances', () => {
  const balances = [
    '0.00000001',
    '9,007,199,254,740,992',
    '9,007,199,254,740,993',
    '0',
    '900',
    '0.1',
  ].map((amount, index) => ({ code: String(index), amount, unit: 'units', label: 'Test asset' }));
  assert.deepEqual(
    sortBalances(balances).map((balance) => balance.code),
    ['2', '1', '4', '5', '0', '3'],
  );
  assert.equal(balances[0].amount, '0.00000001');
});

test('completion dismissal survives reads and is isolated by wallet, network, mode and trade', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key),
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const profile = { mode: 'real', network: 'regtest', ownerId: 'alice' };
  const key = completionKey(profile, 'trade-1');
  assert.equal(isCompletionDismissed(key), false);
  assert.equal(dismissCompletion(key), true);
  assert.equal(isCompletionDismissed(completionKey(profile, 'trade-1')), true);
  for (const other of [
    completionKey(profile, 'trade-2'),
    completionKey({ ...profile, ownerId: 'bob' }, 'trade-1'),
    completionKey({ ...profile, network: 'signet' }, 'trade-1'),
    completionKey({ ...profile, mode: 'mock' }, 'trade-1'),
  ])
    assert.equal(isCompletionDismissed(other), false);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('Storage blocked');
    },
  });
  assert.equal(dismissCompletion(key), false);
  assert.equal(isCompletionDismissed(key), false);
});
