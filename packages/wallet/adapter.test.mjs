import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    await assert.rejects(wallet[op]({ approved: true }), {
      code: 'UNVERIFIED_SETTLEMENT_CAPABILITY',
    });
  }
});

test('unknown local profile is refused', () => {
  assert.throws(() => createWalletAdapter({ profile: '../bob' }));
});

test('unavailable Mutinynet backend stays unavailable on the requested custom Signet', async () => {
  const wallet = createWalletAdapter({
    profile: 'alice',
    network: 'mutinynet',
    binary: '/no-such-rgb-backend',
  });
  const capabilities = await wallet.capabilities();
  assert.equal(capabilities.network, 'signetcustom');
  assert.equal(capabilities.mode, 'unavailable');
  assert.equal(capabilities.sign, false);
  assert.throws(() => createWalletAdapter({ profile: 'alice', network: 'mainnet' }));
  assert.throws(() => createWalletAdapter({ profile: 'alice', network: 'signet' }));
});

test('old native backend cannot relabel regtest state as Mutinynet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-native-fixture-'));
  try {
    const binary = join(dir, 'native');
    writeFileSync(
      binary,
      `#!${process.execPath}\nconsole.log(JSON.stringify({ network: 'regtest', mode: 'real' }));\n`,
      { mode: 0o700 },
    );
    const wallet = createWalletAdapter({ profile: 'alice', network: 'mutinynet', binary });
    assert.equal((await wallet.capabilities()).mode, 'unavailable');
    await assert.rejects(wallet.state(), /network mismatch/);
    await assert.rejects(wallet.identity(), /network mismatch/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
