import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { LocalService } from '../src/service.ts';
import { LocalStore } from '../src/store.ts';
import { MarketClient } from '../src/market-client.ts';
import { MockWalletAdapter } from '../src/wallet.ts';
import { createLocalServer } from '../src/server.ts';
import { QvacUnavailableError } from '../src/qvac.ts';
import { IntentValidationError } from '../src/intent-amounts.ts';

test('authenticated QVAC health bypasses wallet work and API errors distinguish inference from semantics', async () => {
  const store = new LocalStore(':memory:');
  const market = new MarketClient('http://127.0.0.1:4100', 'unused-test-token');
  const wallet = new MockWalletAdapter('test');
  wallet.capabilities = async () => {
    throw new Error('Health must not probe the wallet');
  };
  let available = false;
  const service = new LocalService('test', wallet, market, store, {
    health: async () => ({ available, model: 'test', state: available ? 'ready' : 'loading' }),
    interpret: async () => {
      if (!available) throw new QvacUnavailableError('Local model unavailable');
      throw new IntentValidationError('X supports 0 decimal places');
    },
  });
  const token = 'test-only-pairing-token-for-qvac-health';
  const server = createLocalServer(service, { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${url}/api/qvac/health`)).status, 401);
    assert.equal(
      (await (await fetch(`${url}/api/qvac/health`, { headers })).json()).state,
      'loading',
    );
    const unavailable = await fetch(`${url}/api/interpret`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ goal: 'Sell 10 X for 10000 sats.' }),
    });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'QVAC_UNAVAILABLE');
    available = true;
    assert.equal(
      (await (await fetch(`${url}/api/qvac/health`, { headers })).json()).state,
      'ready',
    );
    const invalid = await fetch(`${url}/api/interpret`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ goal: 'Sell 10.5 X for 10000 sats.' }),
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), {
      error: 'X supports 0 decimal places',
      code: 'INTENT_INVALID',
    });
  } finally {
    server.close();
    await once(server, 'close');
    market.close();
    store.close();
  }
});
