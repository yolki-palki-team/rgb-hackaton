import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopOfferUrl } from '../model.js';

test('public desktop links contain only a validated offer ID', () => {
  const id = 'order-11111111-1111-4111-8111-111111111111';
  assert.equal(desktopOfferUrl(id), `palka://offer/${id}`);
  for (const value of [
    'fixture-offer',
    `${id}?token=secret`,
    `${id}#approve`,
    '../settings',
    'https://example.com',
  ])
    assert.equal(desktopOfferUrl(value), null);
});
