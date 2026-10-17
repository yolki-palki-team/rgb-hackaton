import { QvacInterpreter } from '../src/qvac.ts';

const qvac = new QvacInterpreter();
let code = 0;
try {
  console.log('Preparing shared QVAC CPU model cache (first start downloads about 1.06 GB).');
  const health = await qvac.health();
  if (!health.available) throw new Error(health.reason);
  console.log(`QVAC model cache ready: ${health.model}`);
} catch {
  console.error(
    'QVAC model preparation failed. Check network access, free disk and Docker memory, then restart runtime.',
  );
  code = 1;
} finally {
  await qvac.dispose();
}
// The SDK RPC worker may retain handles after unload; this preparation
// process owns no database and can exit once unload has completed.
process.exit(code);
