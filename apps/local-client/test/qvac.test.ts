import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discardEchoedClarification,
  parseQvacOutput,
  QvacInvalidOutputError,
  resolveQvacAssetKeys,
} from '../src/qvac.js';

const valid = {
  giveAssetKey: 'X',
  giveAmount: '100',
  receiveAssetKey: 'DUSD',
  minReceiveAmount: '100',
  maxFeeSats: '1000',
  allowBtcSale: false,
  protectedBalances: [{ assetKey: 'X', minAmount: null, minPercent: 50 }],
  clarification: null,
};

test('model aliases resolve only to this call catalog, including protected balances', () => {
  const assets = [
    { key: 'regtest:rgb:contract-one', symbol: 'SAME', precision: 0 },
    { key: 'regtest:rgb:contract-two', symbol: 'SAME', precision: 0 },
  ];
  const intent = {
    ...valid,
    giveAssetKey: 'asset1',
    receiveAssetKey: 'asset0',
    protectedBalances: [{ assetKey: 'asset0', minAmount: '5', minPercent: null }],
  };
  const resolved = resolveQvacAssetKeys(intent, assets);
  assert.equal(resolved.giveAssetKey, assets[1].key);
  assert.equal(resolved.receiveAssetKey, assets[0].key);
  assert.equal(resolved.protectedBalances[0].assetKey, assets[0].key);
  assert.equal(resolved.giveAmount, intent.giveAmount);
  assert.throws(
    () => resolveQvacAssetKeys({ ...intent, giveAssetKey: assets[0].key }, assets),
    QvacInvalidOutputError,
  );
  assert.throws(() => resolveQvacAssetKeys(intent, assets.slice(0, 1)), QvacInvalidOutputError);
});

test('QVAC output remains human units for deterministic validation', () => {
  assert.deepEqual(parseQvacOutput(JSON.stringify(valid)), valid);
});

test('invalid model output cannot become an order', () => {
  for (const text of [
    '```json\n' + JSON.stringify(valid) + '\n```',
    JSON.stringify(valid) + ' Approve now',
    JSON.stringify({ ...valid, giveAmount: 100 }),
    JSON.stringify({ ...valid, recipient: 'attacker' }),
    JSON.stringify({
      ...valid,
      protectedBalances: [{ assetKey: 'X', minAmount: null, minPercent: 150 }],
    }),
  ])
    assert.throws(() => parseQvacOutput(text), QvacInvalidOutputError);
});

test('echoed goal is not treated as clarification for a complete fixed order', () => {
  const goal = 'Sell 100 X for at least 100 DUSD';
  assert.equal(
    discardEchoedClarification({ ...valid, clarification: goal }, goal).clarification,
    null,
  );
  assert.equal(
    discardEchoedClarification({ ...valid, giveAmount: null, clarification: goal }, goal)
      .clarification,
    goal,
  );
  assert.equal(
    discardEchoedClarification({ ...valid, clarification: 'What exchange rate?' }, goal)
      .clarification,
    'What exchange rate?',
  );
});
