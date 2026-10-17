import assert from 'node:assert/strict';
import { QvacInterpreter } from '../src/qvac.js';
import { assetKey } from '@rgb-exchange/contracts';
import { defaultPolicy, draftFromIntent } from '../src/intent.js';
import { MockWalletAdapter } from '../src/wallet.js';

const qvac = new QvacInterpreter();
const state = await new MockWalletAdapter('QVAC-SMOKE').state();
const assets = state.balances.map(({ asset }) => ({
  key: assetKey(asset),
  symbol: asset.symbol,
  precision: asset.precision,
}));
const xKey = assetKey(state.balances[1].asset);
const dusdKey = assetKey(state.balances[2].asset);

try {
  const health = await qvac.health();
  if (!health.available) throw new Error(`QVAC unavailable: ${health.reason}`);
  const result = await qvac.interpret(
    'Sell 100 X for at least 100 DUSD. Maximum fee 1000 sats. Do not sell BTC.',
    assets,
  );
  console.log(
    JSON.stringify({
      catalog: 'synthetic mock wallet',
      provider: result.diagnostics.provider,
      model: result.diagnostics.model,
      durationMs: result.diagnostics.durationMs,
      stopReason: result.diagnostics.stopReason,
      output: result.output,
    }),
  );
  if (result.output.giveAssetKey !== xKey || result.output.receiveAssetKey !== dusdKey)
    throw new Error('QVAC did not identify the requested assets');
  if (result.output.giveAmount !== '100' || result.output.minReceiveAmount !== '100')
    throw new Error('QVAC did not preserve the requested amounts');
  if (
    result.output.maxFeeSats !== '1000' ||
    result.output.allowBtcSale !== null ||
    result.output.protectedBalances.length !== 0 ||
    result.output.clarification !== null
  )
    throw new Error('QVAC did not produce the requested fixed-order terms');
  const converted = draftFromIntent(result.output, state, defaultPolicy(state));
  if (
    !converted.draft ||
    converted.draft.giveAmount !== '100' ||
    converted.draft.minReceiveAmount !== '100' ||
    converted.draft.maxFeeSats !== '1000'
  )
    throw new Error('Deterministic validation did not produce a reviewable draft');
  console.log(
    JSON.stringify({ stage: 'local draft validated for review', settlement: 'not attempted' }),
  );
  const btcKey = assetKey(state.balances[0].asset);
  const cases = [
    {
      goal: 'Sell exactly 10 X for at least 10000 sats of BTC. Maximum transaction fee: 1000 sats.',
      give: xKey,
      receive: btcKey,
      giveAmount: '10',
      receiveAmount: '10000',
    },
    {
      goal: 'Sell exactly 10 X for at least 0.0001 BTC. Maximum transaction fee: 1000 sats.',
      give: xKey,
      receive: btcKey,
      giveAmount: '10',
      receiveAmount: '10000',
    },
    {
      goal: 'Sell exactly 10000 sats of BTC for at least 10 X. Maximum transaction fee: 1000 sats.',
      give: btcKey,
      receive: xKey,
      giveAmount: '10000',
      receiveAmount: '10',
    },
    {
      goal: 'Sell exactly 0.0001 BTC for at least 10 X. Maximum transaction fee: 1000 sats.',
      give: btcKey,
      receive: xKey,
      giveAmount: '10000',
      receiveAmount: '10',
    },
    {
      goal: 'I would like ten X in return for my ten thousand satoshis. Fee limit: 1000 sats.',
      give: btcKey,
      receive: xKey,
      giveAmount: '10000',
      receiveAmount: '10',
    },
    {
      goal: '\u0425\u043e\u0447\u0443 \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043c\u0438\u043d\u0438\u043c\u0443\u043c 10 X, \u043e\u0442\u0434\u0430\u044e 10000 \u0441\u0430\u0442\u043e\u0448\u0438. \u041a\u043e\u043c\u0438\u0441\u0441\u0438\u044f \u043d\u0435 \u0432\u044b\u0448\u0435 1000 \u0441\u0430\u0442\u043e\u0448\u0438.',
      give: btcKey,
      receive: xKey,
      giveAmount: '10000',
      receiveAmount: '10',
    },
    {
      goal: 'get 5 dusd for 100 sat, max fee 1000 sats',
      give: btcKey,
      receive: dusdKey,
      giveAmount: '100',
      receiveAmount: '5',
    },
  ];
  for (const fixture of cases) {
    const result = await qvac.interpret(fixture.goal, assets);
    const converted = draftFromIntent(result.output, state, {
      ...defaultPolicy(state),
      allowBtcSale: true,
    });
    assert.ok(converted.draft, converted.clarification ?? 'Expected a fixed draft');
    assert.equal(assetKey(converted.draft.giveAsset), fixture.give);
    assert.equal(assetKey(converted.draft.receiveAsset), fixture.receive);
    assert.equal(converted.draft.giveAmount, fixture.giveAmount);
    assert.equal(converted.draft.minReceiveAmount, fixture.receiveAmount);
    assert.equal(converted.draft.maxFeeSats, '1000');
    console.log(
      JSON.stringify({
        stage: 'regression draft validated',
        goal: fixture.goal,
        giveAmount: converted.draft.giveAmount,
        minReceiveAmount: converted.draft.minReceiveAmount,
        durationMs: result.diagnostics.durationMs,
        settlement: 'not attempted',
      }),
    );
  }
  const reserved = await qvac.interpret(
    'Sell 10 X for at least 10000 sats. Maximum fee 500 sats.',
    assets,
  );
  const reserves = draftFromIntent(reserved.output, state);
  assert.ok(reserves.draft);
  assert.equal(reserves.policy.maxFeeSats, '500');
  assert.deepEqual(reserves.policy.protectedBalances, {});
  console.log(
    JSON.stringify({
      stage: 'explicit order fee validated',
      durationMs: reserved.diagnostics.durationMs,
      settlement: 'not attempted',
    }),
  );
  const incomplete = await qvac.interpret('Sell 10 X for BTC. Maximum fee 1000 sats.', assets);
  assert.equal(draftFromIntent(incomplete.output, state, defaultPolicy(state)).draft, null);
  console.log(
    JSON.stringify({ stage: 'missing amount requires clarification', settlement: 'not attempted' }),
  );
  const colloquial = await qvac.interpret('get some dusd for 100 sat', assets);
  assert.equal(colloquial.output.minReceiveAmount, null);
  const partial = draftFromIntent(colloquial.output, state, defaultPolicy(state));
  assert.equal(partial.draft, null);
  assert.match(partial.clarification ?? '', /DUSD/i);
  console.log(
    JSON.stringify({
      stage: 'colloquial goal needs minimum DUSD',
      clarification: partial.clarification,
      durationMs: colloquial.diagnostics.durationMs,
      settlement: 'not attempted',
    }),
  );
} finally {
  await qvac.dispose();
}
