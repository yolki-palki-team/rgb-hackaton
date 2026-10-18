import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { participantId } from '@rgb-exchange/contracts/participant';
import { desktopDataDirectory, loadDesktopConfig } from '../src/config.ts';

test('fresh desktop saves a unique automatic identity before any connection and reuses it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    PALKA_MARKET_URL: 'https://market.example.org',
    PALKA_WALLET_RPC_URL: 'http://127.0.0.1:4209',
  };
  const first = loadDesktopConfig(dir, env);
  assert.equal(first.marketRegistration, 'automatic');
  assert.equal(first.ownerId, participantId(first.marketToken));
  assert.equal(first.marketUrl, env.PALKA_MARKET_URL);
  assert.equal(first.walletRpcUrl, env.PALKA_WALLET_RPC_URL);
  assert.deepEqual(loadDesktopConfig(dir, {}), first);
  assert.equal(statSync(join(dir, 'desktop-config.json')).mode & 0o777, 0o600);
  const another = loadDesktopConfig(join(dir, 'another'), env);
  assert.notEqual(another.ownerId, first.ownerId);
  assert.notEqual(another.marketToken, first.marketToken);
});

test('Mutinynet uses a separate desktop profile and cannot reuse regtest configuration', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-network-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(desktopDataDirectory(dir, {}), dir);
  assert.equal(desktopDataDirectory(dir, { PALKA_NETWORK: 'mutinynet' }), `${dir}-mutinynet`);
  assert.equal(
    desktopDataDirectory(dir, { PALKA_NETWORK: 'signetcustom', PALKA_DESKTOP_DATA_DIR: dir }),
    dir,
  );
  loadDesktopConfig(dir, {});
  const path = join(dir, 'desktop-config.json');
  const original = readFileSync(path, 'utf8');
  assert.throws(() => loadDesktopConfig(dir, { PALKA_NETWORK: 'mutinynet' }), /another network/);
  assert.equal(readFileSync(path, 'utf8'), original);
  const profile = join(dir, 'mutinynet');
  const config = loadDesktopConfig(profile, { PALKA_NETWORK: 'mutinynet' });
  assert.equal(config.network, 'signetcustom');
  assert.deepEqual(loadDesktopConfig(profile, {}), config);
  assert.throws(() => loadDesktopConfig(profile, { PALKA_NETWORK: 'regtest' }), /another network/);
  assert.throws(
    () => loadDesktopConfig(profile, { PALKA_WALLET_MODE: 'mock' }),
    /only available on regtest/,
  );
  assert.throws(() => loadDesktopConfig(join(dir, 'mainnet'), { PALKA_NETWORK: 'mainnet' }));
});

test('legacy desktop configuration remains regtest and cannot be relabeled as Mutinynet', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-legacy-network-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'desktop-config.json'),
    JSON.stringify({ ownerId: 'alice', marketToken: 'legacy-token' }),
    { mode: 0o600 },
  );
  assert.equal(loadDesktopConfig(dir, {}).network, 'regtest');
  assert.throws(() => loadDesktopConfig(dir, { PALKA_NETWORK: 'mutinynet' }), /another network/);
});

test('existing config and wallet identity are never rewritten or auto-enrolled', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'desktop-config.json');
  const legacy = {
    ownerId: 'alice',
    marketToken: 'existing-market-token',
    walletRpcToken: 'existing-wallet-token',
    walletRpcUrl: 'http://127.0.0.1:44111',
    marketUrl: 'http://127.0.0.1:44100',
    port: 44101,
  };
  const raw = JSON.stringify(legacy);
  writeFileSync(path, raw, { mode: 0o600 });
  const config = loadDesktopConfig(dir, {});
  assert.equal(config.marketRegistration, 'manual');
  for (const [key, value] of Object.entries(legacy))
    assert.equal(config[key as keyof typeof config], value);
  assert.equal(readFileSync(path, 'utf8'), raw);
  const override = loadDesktopConfig(dir, {
    PALKA_OWNER_ID: 'bob',
    PALKA_MARKET_TOKEN: 'bob-existing-token',
  });
  assert.equal(override.ownerId, 'bob');
  assert.equal(override.marketRegistration, 'manual');
  assert.equal(readFileSync(path, 'utf8'), raw);
});

test('new profile with explicit legacy credentials keeps their owner and token', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-explicit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = loadDesktopConfig(dir, {
    PALKA_OWNER_ID: 'carol',
    PALKA_MARKET_TOKEN: 'existing-token',
  });
  assert.equal(first.marketRegistration, 'manual');
  assert.equal(first.ownerId, 'carol');
  assert.deepEqual(loadDesktopConfig(dir, {}), first);
});

test('bad config, changed market, or partial automatic identity override cannot regenerate credentials', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-protected-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  loadDesktopConfig(dir, {});
  const path = join(dir, 'desktop-config.json');
  const raw = readFileSync(path, 'utf8');
  assert.throws(
    () => loadDesktopConfig(dir, { PALKA_MARKET_URL: 'https://different.example.org' }),
    /another market/,
  );
  assert.throws(() => loadDesktopConfig(dir, { PALKA_OWNER_ID: 'alice' }), /both/);
  assert.equal(readFileSync(path, 'utf8'), raw);
  writeFileSync(path, '{broken');
  assert.throws(() => loadDesktopConfig(dir, {}), /not replaced/);
  assert.equal(readFileSync(path, 'utf8'), '{broken');
});

test('missing desktop config cannot silently assign a new identity to existing wallet state', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'palka-missing-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'local.sqlite'), 'synthetic existing state marker');
  assert.throws(() => loadDesktopConfig(dir, {}), /original owner/);
  assert.equal(existsSync(join(dir, 'desktop-config.json')), false);
  assert.equal(
    readFileSync(join(state, 'local.sqlite'), 'utf8'),
    'synthetic existing state marker',
  );
  const another = join(dir, 'fresh');
  assert.throws(
    () => loadDesktopConfig(another, { PALKA_WALLET_RPC_TOKEN: 'existing-sidecar-token' }),
    /original owner/,
  );
  assert.equal(existsSync(join(another, 'desktop-config.json')), false);
});
