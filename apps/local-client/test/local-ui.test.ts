import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MockWalletAdapter } from '../src/wallet.ts';
import App from '../ui/src/App.tsx';
import { LocalClient, formatAsset, mapBalance, type DesktopBridge } from '../ui/src/api.ts';

test('unpaired wallet starts with no synthetic balances, orders, or network', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { palkaWallet: undefined } });
  try {
    const html = renderToStaticMarkup(createElement(App));
    assert.match(html, /Local wallet unavailable/);
    assert.match(html, /NETWORK UNAVAILABLE/);
    assert.match(html, /Preview sample data/);
    assert.doesNotMatch(html, /0\.00250000|DEMO-A1|BITCOIN REGTEST/);
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
    connect: async () => ({ ownerId: 'A', network: 'regtest', mode: 'mock', wallet, qvac: { available: false } }),
    request: async () => { throw new Error('Unexpected API request'); },
    approveTrade: async () => { throw new Error('Unexpected approval'); },
    getPendingOffer: async () => null,
    onOfferSelected: () => () => {},
    openPublicMarket: async () => {},
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { palkaWallet: bridge, location: { origin: 'palka-app://local' } } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: () => { throw new Error('Renderer fetch must not run'); } });
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
  assert.equal(mapBalance({ ...rgb, precision: 6 }, '9007199254740993123').amount, '9007199254740.993123');
  assert.equal(formatAsset({ ...rgb, precision: 6 }, '12345678'), '12.345678 X');
});
