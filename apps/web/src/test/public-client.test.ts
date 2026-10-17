import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicHealth, getPublicOrders } from '../api';
import { formatAssetAmount } from '../model';
import type { AssetRef, PublicOrder } from '@rgb-exchange/contracts';

const btc: AssetRef = { kind: 'btc', network: 'regtest', symbol: 'BTC', precision: 8 };
const rgb: AssetRef = { kind: 'rgb', network: 'regtest', symbol: 'X', contractId: 'contract-x', precision: 2 };

test('public client reads only the same-origin order book without credentials or stale orders', async () => {
  const now = Date.now();
  const base: PublicOrder = { id: 'open-1', ownerId: 'owner-1', revision: 0, network: 'regtest', giveAsset: btc, giveAmount: '100000000', receiveAsset: rgb, minReceiveAmount: '12345', maxFeeSats: '1000', createdAt: now - 1000, expiresAt: now + 60_000, status: 'OPEN' };
  const original = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ orders: [base, { ...base, id: 'reserved-1', status: 'RESERVED' }, { ...base, id: 'expired-1', expiresAt: now - 1 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    assert.deepEqual((await getPublicOrders()).map(order => order.id), ['open-1']);
    assert.equal(calls[0].input, '/market-api/orders');
    assert.equal(calls[0].init?.method, 'GET');
    assert.equal(calls[0].init?.credentials, 'omit');
    assert.equal(calls[0].init?.headers, undefined);
  } finally { globalThis.fetch = original; }
});

test('health is read-only and amounts preserve asset precision', async () => {
  const original = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (input, init) => {
    requested = String(input);
    assert.equal(init?.credentials, 'omit');
    return new Response(JSON.stringify({ ok: true, protocolVersion: 1, mode: 'coordination-only' }), { status: 200 });
  };
  try {
    assert.equal(await getPublicHealth(), true);
    assert.equal(requested, '/market-api/health');
    assert.equal(formatAssetAmount(btc, '100000000'), '1');
    assert.equal(formatAssetAmount(rgb, '12345'), '123.45');
  } finally { globalThis.fetch = original; }
});
