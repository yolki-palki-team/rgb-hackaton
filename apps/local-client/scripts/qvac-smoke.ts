import {QvacInterpreter} from '../src/qvac.js';
import {assetKey} from '@rgb-exchange/contracts';
import {defaultPolicy, draftFromIntent} from '../src/intent.js';
import {MockWalletAdapter} from '../src/wallet.js';

const qvac = new QvacInterpreter();
const state = await new MockWalletAdapter('QVAC-SMOKE').state();
const assets = state.balances.map(({asset}) => ({key: assetKey(asset), symbol: asset.symbol, precision: asset.precision}));
const xKey = assetKey(state.balances[1].asset);
const dusdKey = assetKey(state.balances[2].asset);

try {
  const health = await qvac.health();
  if (!health.available) throw new Error(`QVAC unavailable: ${health.reason}`);
  const result = await qvac.interpret('Sell 100 X for at least 100 DUSD. Maximum fee 1000 sats. Do not sell BTC.', assets);
  console.log(JSON.stringify({catalog: 'synthetic mock wallet', provider: result.diagnostics.provider, model: result.diagnostics.model, durationMs: result.diagnostics.durationMs, stopReason: result.diagnostics.stopReason, output: result.output}));
  if (result.output.giveAssetKey !== xKey || result.output.receiveAssetKey !== dusdKey) throw new Error('QVAC did not identify the requested assets');
  if (result.output.giveAmount !== '100' || result.output.minReceiveAmount !== '100') throw new Error('QVAC did not preserve the requested amounts');
  if (result.output.maxFeeSats !== '1000' || result.output.allowBtcSale !== false || result.output.protectedBalances.length !== 0 || result.output.clarification !== null) throw new Error('QVAC did not produce the requested fixed-order terms');
  const converted = draftFromIntent(result.output, state, defaultPolicy(state));
  if (!converted.draft || converted.draft.giveAmount !== '100' || converted.draft.minReceiveAmount !== '100' || converted.draft.maxFeeSats !== '1000') throw new Error('Deterministic validation did not produce a reviewable draft');
  console.log(JSON.stringify({stage: 'local draft validated for review', settlement: 'not attempted'}));
} finally {
  await qvac.dispose();
}
