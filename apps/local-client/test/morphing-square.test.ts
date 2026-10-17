import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MorphingSquare } from '../ui/src/components/ui/morphing-square.tsx';
import { MorphingSquare as PublicLoader } from '../../web/src/components/ui/morphing-square.tsx';
import { FundingPanel } from '../ui/src/FundingPanel.tsx';
import { LocalClient, type ClientStatus } from '../ui/src/api.ts';

test('both apps share accessible loader messages, placement, and compact sizing', () => {
  assert.equal(MorphingSquare, PublicLoader);
  const plain = renderToStaticMarkup(createElement(MorphingSquare));
  assert.match(plain, /role="status" aria-label="Loading"/);
  assert.match(plain, /border-radius:6%;transform:none/);
  for (const [messagePlacement, direction] of Object.entries({
    bottom: 'flex-col',
    top: 'flex-col-reverse',
    right: 'flex-row',
    left: 'flex-row-reverse',
  })) {
    const html = renderToStaticMarkup(
      createElement(MorphingSquare, {
        message: 'Checking your wallet…',
        messagePlacement: messagePlacement as 'bottom' | 'top' | 'right' | 'left',
        className: 'h-4 w-4 bg-current',
        wrapperClassName: 'inline-flex',
      }),
    );
    assert.match(html, new RegExp(`class="[^"]*${direction}`));
    assert.match(html, /inline-flex/);
    assert.match(html, /<span>Checking your wallet…<\/span>/);
    assert.match(html, /h-4 w-4 bg-current/);
    assert.doesNotMatch(html, /h-10|w-10|bg-foreground/);
  }
  const decorative = renderToStaticMarkup(createElement(MorphingSquare, { 'aria-hidden': true }));
  assert.doesNotMatch(decorative, /role="status"|aria-label/);
  assert.match(
    renderToStaticMarkup(createElement(MorphingSquare, { 'aria-hidden': 'false' })),
    /role="status"/,
  );
});

test('funding shows a loader only while an eligible visible account is loading', () => {
  const wallet: ClientStatus = {
    ownerId: 'A',
    network: 'regtest',
    mode: 'real',
    walletLabel: 'Test',
    wallet: null,
    qvacAvailable: false,
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://127.0.0.1:4101' } },
  });
  let client: LocalClient;
  try {
    client = new LocalClient('test-only');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  const loading = renderToStaticMarkup(createElement(FundingPanel, { client, wallet }));
  assert.match(loading, /data-slot="morphing-square"/);
  assert.match(loading, /Loading your WDK account…/);
  for (const props of [
    { client: null, wallet: null },
    { client, wallet, visible: false },
    { client, wallet: { ...wallet, network: 'mainnet' } },
  ]) {
    assert.doesNotMatch(
      renderToStaticMarkup(createElement(FundingPanel, props)),
      /data-slot="morphing-square"/,
    );
  }
});
