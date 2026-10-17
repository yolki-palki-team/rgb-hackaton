import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import config from '../../web/vite.config.ts';

test('public development proxy forwards only the validated history cursor without credentials', async () => {
  const requests: { url?: string; authorization?: string; cookie?: string }[] = [];
  const market = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    response.setHeader('Content-Type', 'application/json');
    response.end('{"orders":[],"nextCursor":null}');
  });
  market.listen(0, '127.0.0.1');
  await once(market, 'listening');
  const address = market.address();
  assert.ok(address && typeof address !== 'string');
  const previousMarketUrl = process.env.MARKET_URL;
  process.env.MARKET_URL = `http://127.0.0.1:${address.port}`;
  const vite = await createViteServer({
    ...config,
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await vite.listen();
    const viteAddress = vite.httpServer!.address();
    assert.ok(viteAddress && typeof viteAddress !== 'string');
    const base = `http://127.0.0.1:${viteAddress.port}/market-api`;
    const response = await fetch(`${base}/history?cursor=b3JkZXItMQ&token=private&ownerId=other`, {
      headers: { authorization: 'Bearer private', cookie: 'session=private' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(requests, [
      { url: '/history?cursor=b3JkZXItMQ', authorization: undefined, cookie: undefined },
    ]);
    assert.equal((await fetch(`${base}/history?cursor=bad%26token%3Dprivate`)).status, 400);
    assert.equal((await fetch(`${base}/history/me`)).status, 404);
    assert.equal((await fetch(`${base}/history`, { method: 'POST', body: 'private' })).status, 405);
    assert.equal(requests.length, 1);
    assert.equal((await fetch(`${base}/activity?cursor=b3JkZXItMQ&token=private`)).status, 200);
    assert.equal(requests[1].url, '/activity');
    process.env.MARKET_URL = 'invalid-url';
    assert.equal((await fetch(`${base}/history`)).status, 502);
  } finally {
    if (previousMarketUrl === undefined) delete process.env.MARKET_URL;
    else process.env.MARKET_URL = previousMarketUrl;
    await vite.close();
    await new Promise<void>((resolve) => market.close(() => resolve()));
  }
});
