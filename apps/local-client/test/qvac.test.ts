import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discardEchoedClarification,
  parseQvacOutput,
  QvacInvalidOutputError,
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
