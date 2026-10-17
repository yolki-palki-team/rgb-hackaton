import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { MarketStore } from '../../market/src/store.ts';
import { createMarketServer } from '../../market/src/server.ts';
import { MarketClient } from '../../local-client/src/market-client.ts';
import { loadDesktopConfig } from '../src/config.ts';

test('desktop enrolls before HTTP/WS access and reuses saved credentials after a lost response', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-enrollment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  const server = createMarketServer(store, new Map(), { selfRegistration: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    for (const lostResponse of [false, true]) {
      const profile = join(dir, lostResponse ? 'lost-response' : 'new-participant');
      const config = loadDesktopConfig(profile, { PALKA_MARKET_URL: url });
      assert.equal(store.participantOwner(config.marketToken), null);
      if (lostResponse) {
        // Simulate the server committing enrollment while the desktop never reads the reply.
        await fetch(`${url}/participants`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.marketToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
      }
      const reloaded = loadDesktopConfig(profile, {});
      assert.deepEqual(reloaded, config);
      const client = new MarketClient(url, reloaded.marketToken, undefined, reloaded.ownerId);
      try {
        const [one, two] = await Promise.all([client.snapshot(), client.snapshot()]);
        assert.deepEqual(one, two);
        assert.equal(store.participantOwner(config.marketToken), config.ownerId);
        client.connected = false;
        client.connect();
        const deadline = Date.now() + 3000;
        while (!client.connected && Date.now() < deadline) await delay(10);
        assert.equal(client.connected, true, 'WebSocket authenticated with persisted registration');
      } finally {
        client.close();
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
