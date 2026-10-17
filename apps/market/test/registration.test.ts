import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { participantId } from '@rgb-exchange/contracts/participant';
import { MarketStore } from '../src/store.ts';
import { createMarketServer } from '../src/server.ts';

async function listen(
  store: MarketStore,
  owners = new Map<string, string>(),
  options = { selfRegistration: true },
) {
  const server = createMarketServer(store, owners, options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const enroll = (url: string, token: string, body = {}) =>
  fetch(`${url}/participants`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('registration is idempotent, hashes credentials, survives restart, and cannot claim legacy owners', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'market-registration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'market.sqlite');
  const token = randomBytes(32).toString('hex');
  const owner = participantId(token);
  const legacy = new Map([['legacy-token', 'alice']]);
  for (const restart of [false, true]) {
    const store = new MarketStore(path);
    const { server, url } = await listen(store, legacy, { selfRegistration: !restart });
    try {
      assert.equal((await enroll(url, token, { ownerId: 'alice' })).status, 400);
      const result = await enroll(url, token);
      assert.equal(result.status, restart ? 200 : 201);
      assert.deepEqual(await result.json(), { ownerId: owner });
      assert.deepEqual(await (await enroll(url, token)).json(), { ownerId: owner });
      assert.deepEqual(await (await enroll(url, 'legacy-token')).json(), { ownerId: 'alice' });
      assert.equal(
        (await fetch(`${url}/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).status,
        200,
      );
      assert.equal(
        (await fetch(`${url}/snapshot`, { headers: { Authorization: 'Bearer not-a-token' } }))
          .status,
        401,
      );
      if (restart) assert.equal((await enroll(url, randomBytes(32).toString('hex'))).status, 403);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db.prepare('SELECT * FROM registered_participants').all();
        assert.equal(rows.length, 1);
        assert.equal(JSON.stringify(rows).includes(token), false);
      } finally {
        db.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  }
});

test('new registrations are bounded, with existing credentials still usable at the limits', async () => {
  const store = new MarketStore(':memory:');
  const server = createMarketServer(store, new Map(), {
    selfRegistration: true,
    registrationsPerMinute: 1,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const token = randomBytes(32).toString('hex');
  try {
    assert.equal((await enroll(url, 'weak')).status, 400);
    assert.equal((await enroll(url, token)).status, 201);
    assert.equal((await enroll(url, token)).status, 200);
    assert.equal((await enroll(url, randomBytes(32).toString('hex'))).status, 429);
    const next = randomBytes(32).toString('hex');
    assert.throws(
      () => store.registerParticipant(next, new Set(), 1),
      /REGISTRATION_CAPACITY_REACHED/,
    );
    assert.throws(
      () => store.registerParticipant(next, new Set([participantId(next)])),
      /PARTICIPANT_ID_RESERVED/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
