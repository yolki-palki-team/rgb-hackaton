import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scriptedProvider } from '@kaleidorg/mind/testing';
import type { LLMProvider } from '@kaleidorg/mind';
import { assetKey } from '@rgb-exchange/contracts';
import { intentFromProposal, interpretWithMind } from '../src/mind-intent.ts';
import { defaultPolicy, draftFromIntent } from '../src/intent.ts';
import { MockWalletAdapter } from '../src/wallet.ts';

const state = await new MockWalletAdapter('mind-test').state();
const assets = state.balances.map(({ asset }) => ({
  key: assetKey(asset),
  symbol: asset.symbol,
  precision: asset.precision,
}));
const proposal = {
  giveAssetKey: 'asset1',
  giveAmount: '10.00000000',
  giveUnit: 'asset',
  receiveAssetKey: 'asset0',
  minReceiveAmount: '10000',
  receiveUnit: 'sats',
  maxFeeSats: '1000',
  forbidBtcSale: false,
};

test('model-mapped units become exact atomic amounts without parsing the goal wording', () => {
  for (const receive of [
    { asset: 'asset0', amount: '10000', unit: 'sats' },
    { asset: 'asset0', amount: '0.0001', unit: 'asset' },
  ]) {
    const intent = intentFromProposal(
      {
        ...proposal,
        receiveAssetKey: receive.asset,
        minReceiveAmount: receive.amount,
        receiveUnit: receive.unit,
      },
      assets,
    );
    const { draft } = draftFromIntent(intent, state, defaultPolicy(state));
    assert.equal(draft?.giveAsset.symbol, 'X');
    assert.equal(draft?.giveAmount, '10');
    assert.equal(draft?.receiveAsset.symbol, 'BTC');
    assert.equal(draft?.minReceiveAmount, '10000');
  }
  const reverse = intentFromProposal(
    {
      giveAssetKey: 'asset0',
      giveAmount: '10000',
      giveUnit: 'sats',
      receiveAssetKey: 'asset1',
      minReceiveAmount: '10',
      receiveUnit: 'asset',
      forbidBtcSale: false,
    },
    assets,
  );
  assert.equal(reverse.giveAssetKey, assets[0].key);
  assert.equal(reverse.giveAmount, '0.0001');
  assert.equal(reverse.minReceiveAmount, '10');
});

test('model arguments cannot bypass precision, verified identities or positive amounts', () => {
  for (const give of [
    { asset: 'asset1', amount: '10.5', unit: 'asset' },
    { asset: 'asset1', amount: '10', unit: 'sats' },
    { asset: 'unverified', amount: '10', unit: 'asset' },
    { asset: 'asset1', amount: '-10', unit: 'asset' },
    { asset: 'asset1', amount: '0', unit: 'asset' },
    { asset: 'asset1', amount: '1e3', unit: 'asset' },
  ])
    assert.throws(() =>
      intentFromProposal(
        { ...proposal, giveAssetKey: give.asset, giveAmount: give.amount, giveUnit: give.unit },
        assets,
      ),
    );
  assert.throws(() => intentFromProposal({ ...proposal, execute: true }, assets));
  assert.throws(() =>
    intentFromProposal({ ...proposal, protectedBalancesJson: 'not json' }, assets),
  );
  assert.throws(() =>
    intentFromProposal(
      {
        ...proposal,
        protectedBalancesJson: JSON.stringify([
          { assetKey: 'unverified', minAmount: '10', minPercent: null },
        ]),
      },
      assets,
    ),
  );
  assert.throws(() => intentFromProposal({ ...proposal, receiveAssetKey: 'asset1' }, assets));
});

test('KaleidoMind receives arbitrary phrasing and only exposes review/clarification tools', async () => {
  for (const goal of [
    'I have ten X; a minimum of 10000 satoshi would suit me.',
    '\u0425\u043e\u0447\u0443 \u043e\u0431\u043c\u0435\u043d\u044f\u0442\u044c \u0434\u0435\u0441\u044f\u0442\u044c X \u043d\u0430 10000 \u0441\u0430\u0442\u043e\u0448\u0438',
  ]) {
    const scripted = scriptedProvider([{ tool: 'review_swap', args: proposal }]);
    const provider: LLMProvider = {
      name: 'test-only',
      runTurn: async (input) => {
        assert.equal(input.messages.at(-1)?.content, goal);
        assert.deepEqual(
          input.tools.map((tool) => tool.name),
          ['review_swap', 'ask_clarification'],
        );
        return scripted.runTurn(input);
      },
    };
    const result = await interpretWithMind(provider, goal, assets);
    assert.equal(result.output.giveAmount, '10');
    assert.equal(result.output.minReceiveAmount, '0.0001');
    assert.ok(result.turns <= 2);
  }
});

test('missing DUSD quantity remains a question, never a default draft', async () => {
  const question = 'What is the minimum amount of DUSD you want for your 100 sats?';
  const result = await interpretWithMind(
    scriptedProvider([{ tool: 'ask_clarification', args: { question } }]),
    'get some dusd for 100 sat',
    assets,
  );
  assert.equal(result.output.clarification, question);
  assert.equal(result.output.minReceiveAmount, null);
  assert.equal(draftFromIntent(result.output, state, defaultPolicy(state)).draft, null);
});

test('KaleidoMind repairs invalid tool arguments before preparing a review', async () => {
  const result = await interpretWithMind(
    scriptedProvider([
      { tool: 'review_swap', args: { ...proposal, giveAmount: '10.5' } },
      { tool: 'review_swap', args: proposal },
    ]),
    'Sell 10 X for 10000 sats',
    assets,
  );
  assert.ok(result.turns <= 3);
  assert.equal(result.output.giveAmount, '10');
});

test('LLM-mapped private constraints only tighten the saved policy', () => {
  const output = intentFromProposal(
    {
      ...proposal,
      maxFeeSats: '500',
      forbidBtcSale: true,
      protectedBalancesJson: JSON.stringify([
        { assetKey: 'asset1', minAmount: null, minPercent: 50 },
        { assetKey: 'asset0', minAmount: '0.0001', minPercent: null },
      ]),
    },
    assets,
  );
  const { policy } = draftFromIntent(output, state, {
    ...defaultPolicy(state),
    allowBtcSale: true,
  });
  assert.equal(policy.allowBtcSale, false);
  assert.equal(policy.maxFeeSats, '500');
  assert.equal(
    policy.protectedBalances[assets[1].key],
    (BigInt(state.balances[1].amount) / 2n).toString(),
  );
  assert.equal(policy.protectedBalances[assets[0].key], '10000');
  const exact = intentFromProposal({ ...proposal, giveAmount: '9007199254740993.000' }, assets);
  assert.equal(exact.giveAmount, '9007199254740993');
});

test('prose or unknown tool calls cannot masquerade as a prepared order', async () => {
  for (const provider of [
    scriptedProvider([{ text: 'The swap has been completed.' }]),
    scriptedProvider([{ tool: 'send_payment', args: { amount: '100' } }, { text: 'Done.' }]),
  ]) {
    await assert.rejects(
      interpretWithMind(provider, 'Exchange X for BTC', assets),
      /could not prepare/,
    );
  }
});
