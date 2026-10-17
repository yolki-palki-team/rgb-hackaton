import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { MarketStore } from '../../market/src/store.ts';
import { PublicOrderSchema } from '@rgb-exchange/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MockWalletAdapter } from '../src/wallet.ts';
import App from '../ui/src/App.tsx';
import {
  ChatInput,
  ChatInputSubmit,
  ChatInputTextArea,
} from '../ui/src/components/ui/chat-input.tsx';
import { LocalClient, formatAsset, mapBalance, type DesktopBridge } from '../ui/src/api.ts';

test('chat composer blocks empty, disconnected, and loading submissions', () => {
  for (const state of [
    { value: '', blocked: true },
    { value: '   ', blocked: true },
    { value: 'Swap X for DUSD', disabled: true, blocked: true },
    { value: 'Swap X for DUSD', loading: true, blocked: true },
    { value: 'Swap X for DUSD', blocked: false },
  ]) {
    const html = renderToStaticMarkup(
      createElement(ChatInput, {
        ...state,
        children: [
          createElement(ChatInputTextArea, {
            key: 'input',
            'aria-label': 'Swap terms',
            examples: ['Can I swap 10 X for 5 DUSD?'],
            readOnly: true,
          }),
          createElement(ChatInputSubmit, { key: 'submit' }),
        ],
      }),
    );
    assert.equal(/<button[^>]*disabled/.test(html), state.blocked);
    assert.match(html, /aria-label="Swap terms"/);
    assert.match(html, /placeholder="Can I swap 10 X for 5 DUSD\?"/);
    if (!state.value.trim()) assert.match(html, /<textarea[^>]*>\s*<\/textarea>/);
  }
});

test('unpaired wallet starts with no synthetic balances, orders, or network', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { palkaWallet: undefined },
  });
  try {
    const html = renderToStaticMarkup(createElement(App));
    assert.match(html, /Local wallet unavailable/);
    assert.match(html, /NETWORK UNAVAILABLE/);
    assert.match(html, /Preview sample data/);
    assert.match(html, /Order book/);
    assert.match(html, /Your assets/);
    assert.match(html, /Connect your wallet to see open orders/);
    assert.doesNotMatch(html, /<button[^>]*>Market<\/button>/);
    assert.match(html, /Top up/);
    assert.match(html, /<div hidden="">[\s\S]*Connect a real regtest wallet to top up/);
    assert.doesNotMatch(html, /Create WDK account/);
    assert.doesNotMatch(html, /0\.00250000|DEMO-A1|BITCOIN REGTEST/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('desktop funding approval uses the privileged bridge instead of a generic request', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let approvedId: string | null = null;
  const bridge: DesktopBridge = {
    connect: async () => {
      throw new Error('Unexpected connection');
    },
    request: async () => {
      throw new Error('Generic request must not approve funding');
    },
    approveTrade: async () => {
      throw new Error('Unexpected trade approval');
    },
    approveFunding: async (id) => {
      approvedId = id;
      return { id, status: 'SIGNED', network: 'regtest' };
    },
    getPendingOffer: async () => null,
    onOfferSelected: () => () => {},
    openPublicMarket: async () => {},
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { palkaWallet: bridge },
  });
  try {
    const operation = await new LocalClient().approveFunding('operation-1');
    assert.equal(approvedId, 'operation-1');
    assert.equal(operation.status, 'SIGNED');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('desktop transport connects without a renderer pairing token or loopback fetch', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const wallet = await new MockWalletAdapter('A').capabilities();
  const bridge: DesktopBridge = {
    connect: async () => ({
      ownerId: 'A',
      network: 'regtest',
      mode: 'mock',
      wallet,
      qvac: { available: false },
    }),
    request: async () => {
      throw new Error('Unexpected API request');
    },
    approveTrade: async () => {
      throw new Error('Unexpected approval');
    },
    getPendingOffer: async () => null,
    onOfferSelected: () => () => {},
    openPublicMarket: async () => {},
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { palkaWallet: bridge, location: { origin: 'palka-app://local' } },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => {
      throw new Error('Renderer fetch must not run');
    },
  });
  try {
    const status = await new LocalClient().connect();
    assert.equal(status.mode, 'mock');
    assert.equal(status.network, 'regtest');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
});

test('local wallet renders exact BTC and RGB amounts using asset precision', async () => {
  const state = await new MockWalletAdapter('A').state();
  const rgb = state.balances[1].asset;
  assert.equal(rgb.kind, 'rgb');
  if (rgb.kind !== 'rgb') throw new Error('Expected a mock RGB asset');
  assert.equal(mapBalance(state.balances[0].asset, '250000').amount, '0.00250000');
  assert.equal(mapBalance(rgb, '9007199254740993').amount, '9007199254740993');
  assert.equal(
    mapBalance({ ...rgb, precision: 6 }, '9007199254740993123').amount,
    '9007199254740.993123',
  );
  assert.equal(formatAsset({ ...rgb, precision: 6 }, '12345678'), '12.345678 X');
});

test('wallet balance failure keeps the matched trade available for explicit recovery', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const wallet = new MockWalletAdapter('A');
  const market = new MarketStore(':memory:');
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../packages/contracts/fixtures/direct.json', import.meta.url),
      'utf8',
    ),
  );
  for (const raw of fixture.orders) {
    const order = PublicOrderSchema.parse({
      ...raw,
      createdAt: Date.now(),
      expiresAt: Date.now() + 1800000,
    });
    market.createOrder(order.ownerId, order);
  }
  const snapshot = market.snapshot('A');
  assert.equal(snapshot.trades.length, 1);
  let unavailable = false;
  const bridge: DesktopBridge = {
    connect: async () => ({
      ownerId: 'A',
      network: 'regtest',
      mode: 'mock',
      wallet: await wallet.capabilities(),
      qvac: { available: false },
    }),
    request: async (_method, path) => {
      if (path === '/api/state') {
        if (unavailable) throw new Error('RGB indexing pending');
        return wallet.state();
      }
      if (path === '/api/snapshot') return snapshot;
      if (path.endsWith('/progress'))
        return {
          tradeId: snapshot.trades[0].plan.tradeId,
          signingAuthorized: false,
          recoveryRequired: false,
          receipt: null,
        };
      if (path === '/api/policy')
        return {
          allowedAssetKeys: ['btc', 'dusd'],
          protectedBalances: {},
          maxFeeSats: '1000',
          allowBtcSale: true,
        };
      if (path.endsWith('/sync'))
        return {
          tradeId: snapshot.trades[0].plan.tradeId,
          network: 'regtest',
          mode: 'mock',
          state: 'reconciling',
          chainConfirmed: false,
          rgbAccepted: false,
        };
      throw new Error('Unexpected request');
    },
    approveTrade: async () => {
      throw new Error('Must not sign');
    },
    getPendingOffer: async () => null,
    onOfferSelected: () => () => {},
    openPublicMarket: async () => {},
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { palkaWallet: bridge },
  });
  try {
    const client = new LocalClient();
    await client.connect();
    assert.ok((await client.snapshot()).balances.length);
    unavailable = true;
    const pending = await client.snapshot();
    assert.equal(pending.walletError, 'RGB indexing pending');
    assert.deepEqual(pending.balances, []);
    assert.equal(pending.trade?.id, snapshot.trades[0].plan.tradeId);
    assert.equal((await client.sync(pending.trade!.id)).state, 'reconciling');
    await assert.rejects(
      client.checkDraft(
        {
          giveAsset: 'BTC',
          receiveAsset: 'DUSD',
          giveAmount: '100',
          minReceiveAmount: '1',
          maxFeeSats: '1000',
          expiresMinutes: '30',
        },
        pending.policy,
      ),
      /Balances have not loaded/,
    );
  } finally {
    market.close();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
