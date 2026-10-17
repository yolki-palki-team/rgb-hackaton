import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { participantId } from '@rgb-exchange/contracts/participant';
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

test('automatic market identity recovers after authorization loss without replaying writes', async () => {
  const token = 'a'.repeat(64);
  const owner = participantId(token);
  let enrolled = false;
  let enrollments = 0;
  let writes = 0;
  let afterSequence = '';
  let rejectReads = false;
  let reads = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/participants' && request.method === 'POST') {
      enrolled = true;
      enrollments++;
      response.end(JSON.stringify({ ownerId: owner }));
      return;
    }
    if (request.method === 'GET') reads++;
    if (rejectReads) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return;
    }
    if (!enrolled) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
      return;
    }
    if (request.url?.startsWith('/snapshot?')) {
      afterSequence =
        new URL(request.url, 'http://127.0.0.1').searchParams.get('afterSequence') ?? '';
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/orders' && request.method === 'POST') writes++;
    response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new MarketClient(`http://127.0.0.1:${address.port}`, token, undefined, owner);
  try {
    await client.request('/snapshot?afterSequence=9');
    assert.equal(enrollments, 1);
    enrolled = false;
    await client.request('/snapshot?afterSequence=9');
    assert.equal(afterSequence, '0');
    assert.equal(enrollments, 2);
    enrolled = false;
    await assert.rejects(client.request('/orders', 'POST', { id: 'one' }), /Review and retry/);
    assert.equal(enrollments, 3);
    assert.equal(writes, 0);
    await client.request('/orders', 'POST', { id: 'one' });
    assert.equal(writes, 1);
    enrolled = false;
    const manual = new MarketClient(`http://127.0.0.1:${address.port}`, 'manual-token');
    await assert.rejects(manual.request('/snapshot?afterSequence=0'), /UNAUTHORIZED/);
    assert.equal(enrollments, 3);
    rejectReads = true;
    const before = reads;
    await assert.rejects(client.request('/snapshot?afterSequence=0'), /UNAUTHORIZED/);
    assert.equal(reads - before, 2, 'a persistent 401 gets one read retry');
    assert.equal(enrollments, 4);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
