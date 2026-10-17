import {QvacInterpreter} from '../src/qvac.js';

const qvac = new QvacInterpreter();
const assets = [
  {key: 'btc:regtest', symbol: 'BTC', precision: 8},
  {key: 'rgb:regtest:X', symbol: 'X', precision: 0},
  {key: 'rgb:regtest:DUSD', symbol: 'DUSD', precision: 0},
];

try {
  const health = await qvac.health();
  if (!health.available) throw new Error(`QVAC unavailable: ${health.reason}`);
  const result = await qvac.interpret('Продать 100 X за минимум 100 DUSD. Комиссия не более 1000 сатоши. BTC не продавать.', assets);
  console.log(JSON.stringify({provider: result.diagnostics.provider, model: result.diagnostics.model, durationMs: result.diagnostics.durationMs, stopReason: result.diagnostics.stopReason, output: result.output}));
  if (result.output.giveAssetKey !== 'rgb:regtest:X' || result.output.receiveAssetKey !== 'rgb:regtest:DUSD') throw new Error('QVAC did not identify the requested assets');
  if (result.output.giveAmount !== '100' || result.output.minReceiveAmount !== '100') throw new Error('QVAC did not preserve the requested amounts');
  if (result.output.maxFeeSats !== '1000' || result.output.allowBtcSale !== false || result.output.clarification !== null) throw new Error('QVAC did not produce a usable fixed-order draft');
} finally {
  await qvac.dispose();
}
