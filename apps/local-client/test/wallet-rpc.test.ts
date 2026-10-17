import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  HttpWalletAdapter,
  MockWalletAdapter,
  REAL_WALLET_UNAVAILABLE,
  UnavailableWalletAdapter,
  requireLoopback,
} from '../src/wallet.ts';
import { LocalService } from '../src/service.ts';
import { LocalStore } from '../src/store.ts';
import { MarketClient } from '../src/market-client.ts';

test('unconfigured real wallet is explicitly unavailable and cannot sign', async () => {
  const wallet = new UnavailableWalletAdapter();
  await assert.rejects(wallet.capabilities(), { message: REAL_WALLET_UNAVAILABLE });
  await assert.rejects(wallet.state(), { message: REAL_WALLET_UNAVAILABLE });
  await assert.rejects(wallet.sign(), { message: REAL_WALLET_UNAVAILABLE });
});

test('degraded real-wallet health is visible without starting QVAC', async () => {
  const store = new LocalStore(':memory:');
  const market = new MarketClient('http://127.0.0.1:4100', 'test-token');
  let modelStarted = false;
  const qvac = {
    health: async () => {
      modelStarted = true;
      return { available: true, model: 'unexpected' };
    },
    interpret: async () => {
      throw new Error('not used');
    },
  };
  const service = new LocalService('A', new UnavailableWalletAdapter(), market, store, qvac);
  try {
    const health = await service.health();
    assert.equal(health.mode, 'real');
    assert.equal(health.wallet, null);
    assert.equal(health.blockedReason, REAL_WALLET_UNAVAILABLE);
    assert.equal(health.qvac.available, false);
    assert.equal(modelStarted, false);
  } finally {
    store.close();
    market.close();
  }
});

test('wallet HTTP boundary validates protocol, authenticates, and never retries an uncertain request', async () => {
  const mock = new MockWalletAdapter('A');
  let calls = 0;
  let wrongVersion = false;
  let fail = false;
  const server = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/rpc');
    assert.equal(req.headers.authorization, 'Bearer sidecar-test-token-only');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(input.protocolVersion, 1);
    assert.equal(typeof input.requestId, 'string');
    if (fail) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ protocolVersion: wrongVersion ? 2 : 1, result: await mock.capabilities() }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const adapter = new HttpWalletAdapter(
    `http://127.0.0.1:${address.port}`,
    'sidecar-test-token-only',
  );
  try {
    assert.equal((await adapter.capabilities()).mode, 'mock');
    wrongVersion = true;
    await assert.rejects(adapter.capabilities());
    wrongVersion = false;
    fail = true;
    const before = calls;
    await assert.rejects(adapter.capabilities(), /HTTP 503/);
    assert.equal(calls, before + 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('wallet sidecar cannot point at a cloud URL and mock never provides transaction evidence', async () => {
  for (const value of [
    'https://api.openai.com',
    'http://example.org',
    'http://user:pass@localhost:4201',
    'http://127.0.0.1:4201?token=secret',
  ])
    assert.throws(() => requireLoopback(value));
  const wallet = new MockWalletAdapter('A');
  const receipt = await wallet.sync('trade-test');
  assert.equal(receipt.txid, undefined);
  assert.equal(receipt.state, 'unsupported');
  assert.equal(receipt.chainConfirmed, false);
  assert.equal(receipt.rgbAccepted, false);
});
