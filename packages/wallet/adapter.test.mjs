import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletAdapter } from './adapter.mjs';

test('missing native backend cannot advertise real settlement', async () => {
  const wallet = createWalletAdapter({ profile: 'alice', binary: '/no-such-rgb-backend' });
  const capabilities = await wallet.capabilities();
  assert.equal(capabilities.mode, 'unavailable');
  assert.equal(capabilities.directAtomic, false);
  assert.equal(capabilities.ringAtomic, false);
});

test('production adapter cannot bypass experimental approval gate', async () => {
  const wallet = createWalletAdapter({ profile: 'alice' });
  for (const op of ['prepare', 'sign', 'broadcast']) {
    await assert.rejects(wallet[op]({ approved: true }), { code: 'UNVERIFIED_SETTLEMENT_CAPABILITY' });
  }
});

test('unknown local profile is refused', () => {
  assert.throws(() => createWalletAdapter({ profile: '../bob' }));
});
