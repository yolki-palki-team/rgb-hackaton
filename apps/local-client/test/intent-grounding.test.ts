import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetKey, type AiIntent } from '@rgb-exchange/contracts';
import { groundIntentAmounts, IntentValidationError } from '../src/intent-grounding.ts';
import { defaultPolicy, draftFromIntent } from '../src/intent.ts';
import { MockWalletAdapter } from '../src/wallet.ts';

const state = await new MockWalletAdapter('grounding-test').state();
const assets = state.balances.map(({ asset }) => ({ ...asset, key: assetKey(asset) }));
const [btc, x, dusd] = assets;
const original: AiIntent = {
  giveAssetKey: x.key,
  giveAmount: '10.00000000',
  receiveAssetKey: btc.key,
  minReceiveAmount: '10000.00000000',
  maxFeeSats: '1000',
  allowBtcSale: null,
  protectedBalances: [],
  clarification: null,
};
const goal =
  'Sell exactly 10 X for at least 10000 sats of BTC. Maximum transaction fee: 1000 sats.';

test('the actual Qwen regression keeps precision-0 RGB and converts source sats exactly once', () => {
  for (const minReceiveAmount of ['10000.00000000', '0.00010000']) {
    const intent = groundIntentAmounts({ ...original, minReceiveAmount }, goal, assets);
    assert.equal(intent.giveAmount, '10');
    assert.equal(intent.minReceiveAmount, '0.0001');
    const { draft } = draftFromIntent(intent, state, defaultPolicy(state));
    assert.equal(draft?.giveAsset.symbol, 'X');
    assert.equal(draft?.receiveAsset.symbol, 'BTC');
    assert.equal(draft?.giveAmount, '10');
    assert.equal(draft?.minReceiveAmount, '10000');
    assert.equal(draft?.maxFeeSats, '1000');
  }
});

test('explicit BTC and satoshi sales preserve direction with exact integer conversion', () => {
  for (const terms of [
    'Sell 0.0001 BTC for 10 X.',
    'Swap 10000 sats for 10 X.',
    'Buy 10 X with 10000 sats.',
  ]) {
    const intent = groundIntentAmounts(
      {
        ...original,
        giveAssetKey: btc.key,
        giveAmount: '10000',
        receiveAssetKey: x.key,
        minReceiveAmount: '10',
        maxFeeSats: null,
      },
      terms,
      assets,
    );
    const { draft } = draftFromIntent(intent, state, {
      ...defaultPolicy(state),
      allowBtcSale: true,
    });
    assert.equal(draft?.giveAsset.symbol, 'BTC');
    assert.equal(draft?.giveAmount, '10000');
    assert.equal(draft?.minReceiveAmount, '10');
  }
});

test('fractions, guessed amounts, reversed assets, fee substitutions and ambiguous terms fail closed', () => {
  for (const [output, source] of [
    [original, goal.replace('10 X', '10.5 X')],
    [{ ...original, giveAmount: '10.5' }, goal.replace('10 X', '10.5 X')],
    [{ ...original, minReceiveAmount: '10000.5' }, goal.replace('10000 sats', '10000.5 sats')],
    [{ ...original, giveAmount: '20' }, goal],
    [
      {
        ...original,
        giveAssetKey: btc.key,
        receiveAssetKey: x.key,
        giveAmount: '10000',
        minReceiveAmount: '10',
      },
      goal,
    ],
    [{ ...original, minReceiveAmount: '1000' }, 'Sell 10 X for BTC. Maximum fee 1000 sats.'],
    [original, 'Sell 10 X or 20 X for 10000 sats.'],
    [{ ...original, maxFeeSats: '500' }, goal],
    [original, 'Sell 10 X for 10000 sats or 20000 sats.'],
    [original, goal.replace('10 X', '-10 X')],
    [original, `Do not ${goal.toLowerCase()}`],
    [original, `${goal} Sell 20 DUSD for 10 X.`],
    [original, 'Sell 10 X for 10000 sats or 10 DUSD.'],
  ] as [AiIntent, string][]) {
    assert.throws(() => groundIntentAmounts(output, source, assets), IntentValidationError);
  }
});

test('malformed or unsupported explicit fees cannot become a default fee', () => {
  for (const clause of [
    'Maximum fee 0.5 sats.',
    'Maximum fee 500.0 sats.',
    'Maximum fee 5e2 sats.',
    'Maximum fee -500 sats.',
    'Maximum fee +500 sats.',
    'Maximum fee 1,000 sats.',
    'Maximum fee 1_000 sats.',
    'Maximum fee 1 000 sats.',
    'Maximum fee 0x1f4 sats.',
    'Maximum fee 500.',
    'Maximum fees 500 sats.',
    'Maximum fee 1000 sats. Additional fee 0.5 sats.',
  ]) {
    for (const maxFeeSats of [null, '1000']) {
      assert.throws(
        () =>
          groundIntentAmounts(
            { ...original, maxFeeSats },
            `Sell 10 X for 10000 sats. ${clause}`,
            assets,
          ),
        IntentValidationError,
        clause,
      );
    }
  }
});

test('compact whole-satoshi fees are grounded and only absent fee terms use the saved default', () => {
  for (const fee of ['500 sats', '500sats']) {
    const source = `Sell 10 X for 10000 sats. Maximum fee ${fee}.`;
    const intent = groundIntentAmounts({ ...original, maxFeeSats: '500' }, source, assets);
    assert.equal(draftFromIntent(intent, state, defaultPolicy(state)).draft?.maxFeeSats, '500');
    for (const maxFeeSats of [null, '1000'])
      assert.throws(
        () => groundIntentAmounts({ ...original, maxFeeSats }, source, assets),
        IntentValidationError,
      );
  }
  const noFee = groundIntentAmounts(
    { ...original, maxFeeSats: null },
    'Sell 10 X for 10000 sats.',
    assets,
  );
  assert.equal(draftFromIntent(noFee, state, defaultPolicy(state)).draft?.maxFeeSats, '1000');
});

test('RGB to RGB and large values retain exact amounts; only redundant decimal zeros are removed', () => {
  const large = '9007199254740993';
  const intent = groundIntentAmounts(
    {
      ...original,
      giveAmount: `${large}.000`,
      receiveAssetKey: dusd.key,
      minReceiveAmount: '100.00',
    },
    `Sell ${large} X for 100 DUSD. Maximum fee 1000 sats.`,
    assets,
  );
  assert.equal(intent.giveAmount, large);
  assert.equal(intent.minReceiveAmount, '100');
  assert.throws(
    () => groundIntentAmounts(original, goal, [...assets, { ...x, key: 'other-X' }]),
    IntentValidationError,
  );
});

test('missing terms and clarification never become a complete draft', () => {
  for (const output of [
    { ...original, giveAmount: null },
    { ...original, clarification: 'How much X?' },
  ]) {
    const intent = groundIntentAmounts(output, goal, assets);
    assert.equal(draftFromIntent(intent, state, defaultPolicy(state)).draft, null);
  }
});
