import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import WebSocket from 'ws';
import { MarketStore } from '../src/store.ts';
import { createMarketServer } from '../src/server.ts';
import type { PublicOrder } from '@rgb-exchange/contracts';

const now = Date.now();
const btc = { network: 'regtest', kind: 'btc', precision: 8, symbol: 'BTC' } as const;
const dusd = {
  network: 'regtest',
  kind: 'rgb',
  precision: 0,
  contractId: 'dusd',
  symbol: 'DUSD',
} as const;
function order(
  id: string,
  ownerId: string,
  giveAsset: PublicOrder['giveAsset'],
  giveAmount: string,
  receiveAsset: PublicOrder['receiveAsset'],
  minReceiveAmount: string,
): PublicOrder {
  return {
    id,
    ownerId,
    revision: 0,
    network: 'regtest',
    giveAsset,
    giveAmount,
    receiveAsset,
    minReceiveAmount,
    maxFeeSats: '1000',
    createdAt: now,
    expiresAt: now + 60000,
    status: 'OPEN',
  };
}

test('HTTP auth and WebSocket resume keep private plans participant-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rgb-market-http-'));
  const store = new MarketStore(join(dir, 'market.sqlite'));
  const server = createMarketServer(
    store,
    new Map([
      ['token-a', 'a'],
      ['token-b', 'b'],
      ['token-c', 'c'],
    ]),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (token: string, value: unknown) =>
    fetch(`${base}/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await post('token-a', order('a1', 'b', btc, '100000', dusd, '100'))).status, 403);
    assert.equal((await post('token-a', order('a1', 'a', btc, '100000', dusd, '100'))).status, 201);
    const matched = await post('token-b', order('b1', 'b', dusd, '100', btc, '100000'));
    assert.equal(matched.status, 201);
    const body = (await matched.json()) as { trade: { plan: { tradeId: string } } };
    assert.ok(body.trade.plan.tradeId);
    const activityResponse = await fetch(`${base}/activity`);
    assert.equal(activityResponse.status, 200);
    const activity = (await activityResponse.json()) as { orders: { execution: unknown }[] };
    assert.equal(activity.orders.length, 2);
    assert.deepEqual(activity.orders[0].execution, { status: 'RESERVED', participants: 2 });
    assert.equal(JSON.stringify(activity).includes('plan'), false);
    assert.equal((await fetch(`${base}/trades/${body.trade.plan.tradeId}`)).status, 401);
    const denied = await fetch(`${base}/trades/${body.trade.plan.tradeId}`, {
      headers: { authorization: 'Bearer token-c' },
    });
    assert.equal(denied.status, 404);
    const outsider = await fetch(`${base}/snapshot?afterSequence=0`, {
      headers: { authorization: 'Bearer token-c' },
    });
    const snapshot = (await outsider.json()) as {
      trades: unknown[];
      events: { tradeId?: string }[];
      sequence: number;
    };
    assert.equal(snapshot.trades.length, 0);
    assert.equal(
      snapshot.events.some((event) => event.tradeId === body.trade.plan.tradeId),
      false,
    );

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/events`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'authenticate', token: 'token-a', afterSequence: 0 }));
    const [raw] = await once(ws, 'message');
    const resumed = JSON.parse(raw.toString()) as {
      type: string;
      trades: { plan: { tradeId: string } }[];
      events: { tradeId?: string }[];
    };
    assert.equal(resumed.type, 'snapshot');
    assert.equal(resumed.trades[0].plan.tradeId, body.trade.plan.tradeId);
    assert.equal(
      resumed.events.filter((event) => event.tradeId === body.trade.plan.tradeId).length,
      1,
    );
    ws.close();
    await once(ws, 'close');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
