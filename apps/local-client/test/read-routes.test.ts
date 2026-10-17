import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/server.ts';
import type { LocalService } from '../src/service.ts';
import { LocalStore } from '../src/store.ts';
import { MarketHttpError } from '../src/market-client.ts';

test('progress and authenticated history reads do not wait for wallet operations', async () => {
  const requests: string[] = [];
  const history = { myOrders: [], trades: [], nextCursor: null };
  let invalidHistory = false;
  let offline = false;
  let missingHistory = false;
  const directory = mkdtempSync(join(tmpdir(), 'palka-history-read-'));
  const database = join(directory, 'local.sqlite');
  const service = {
    ownerId: 'test-owner',
    store: new LocalStore(database),
    market: {
      url: 'http://127.0.0.1:4100',
      snapshot: async () => ({ myOrders: [], trades: [] }),
      request: async (path: string) => {
        requests.push(path);
        if (missingHistory) throw new MarketHttpError('NOT_FOUND', 404);
        if (offline) throw new Error('Market unavailable');
        return invalidHistory ? { ...history, secret: 'must-not-be-relayed' } : history;
      },
    },
    progress: async (id: string) => ({ tradeId: id, state: 'RECONCILING' }),
    exclusive: () => assert.fail('read-only route entered the mutation queue'),
    snapshot: () => assert.fail('read-only route invoked cancellation cleanup'),
    state: () => assert.fail('progress read requested wallet balances'),
  } as unknown as LocalService;
  const token = 'a'.repeat(40);
  const server = createLocalServer(service, { token });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${base}/api/history`)).status, 401);
    assert.equal(requests.length, 0);
    for (const path of ['/api/snapshot', '/api/trades/trade-1/progress']) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 200);
    }
    for (const query of ['', '?cursor=b3JkZXItMQ']) {
      const response = await fetch(`${base}/api/history${query}`, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), history);
    }
    assert.deepEqual(requests, ['/history/me', '/history/me?cursor=b3JkZXItMQ']);
    for (const query of [
      '?cursor=',
      '?cursor=one&cursor=two',
      '?cursor=one&token=secret',
      '?cursor=%2Fprivate',
      `?cursor=${'a'.repeat(301)}`,
    ]) {
      assert.equal((await fetch(`${base}/api/history${query}`, { headers })).status, 400);
    }
    assert.equal(requests.length, 2);
    invalidHistory = true;
    const invalid = await fetch(`${base}/api/history`, { headers });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(await invalid.text(), /must-not-be-relayed/);
    service.store.close();
    Object.assign(service, { store: new LocalStore(database) });
    offline = true;
    const cached = await fetch(`${base}/api/history`, { headers });
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), { ...history, stale: true });
    // Another participant or market must never receive this profile's cached history.
    Object.assign(service, { ownerId: 'another-owner' });
    assert.equal((await fetch(`${base}/api/history`, { headers })).status, 400);
    Object.assign(service, { ownerId: 'test-owner' });
    Object.assign(service.market, { url: 'http://127.0.0.1:4109' });
    assert.equal((await fetch(`${base}/api/history`, { headers })).status, 400);
    offline = false;
    missingHistory = true;
    const unsupported = await fetch(`${base}/api/history`, { headers });
    assert.equal(unsupported.status, 503);
    assert.deepEqual(await unsupported.json(), {
      error:
        'Order history requires an updated market server. Restart the market with the current project version.',
      code: 'HISTORY_UNAVAILABLE',
    });
    Object.assign(service.market, { url: 'http://127.0.0.1:4100' });
    const olderServer = await fetch(`${base}/api/history`, { headers });
    assert.equal(olderServer.status, 200);
    assert.deepEqual(await olderServer.json(), { ...history, stale: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
