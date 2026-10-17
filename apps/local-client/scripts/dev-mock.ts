import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// This runner creates no keys and performs no blockchain settlement.
const dir = resolve('.state', `mock-${Date.now()}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const profiles = ['A', 'B', 'C'].map((ownerId, index) => ({
  ownerId,
  port: 4101 + index,
  marketToken: randomBytes(32).toString('hex'),
  sessionToken: randomBytes(32).toString('hex'),
}));
writeFileSync(resolve(dir, 'pairing.json'), JSON.stringify({ mode: 'mock', profiles }, null, 2), {
  mode: 0o600,
});
const children: ChildProcess[] = [];
const run = (script: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && !stopping) stop(code);
  });
};
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
}
run('node_modules/tsx/dist/cli.mjs', ['apps/market/src/main.ts'], {
  MARKET_PORT: '4100',
  MARKET_DB_PATH: resolve(dir, 'market.sqlite'),
  MARKET_TOKENS_JSON: JSON.stringify(
    Object.fromEntries(profiles.map((p) => [p.marketToken, p.ownerId])),
  ),
});
for (const p of profiles)
  run('node_modules/tsx/dist/cli.mjs', ['apps/local-client/src/main.ts'], {
    LOCAL_HOST: '127.0.0.1',
    LOCAL_PORT: String(p.port),
    LOCAL_OWNER_ID: p.ownerId,
    LOCAL_SESSION_TOKEN: p.sessionToken,
    LOCAL_STATE_DIR: resolve(dir, p.ownerId),
    LOCAL_ALLOWED_ORIGINS: `http://127.0.0.1:${p.port},http://localhost:${p.port}`,
    MARKET_URL: 'http://127.0.0.1:4100',
    MARKET_TOKEN: p.marketToken,
    WALLET_MODE: 'mock',
  });
run('node_modules/vite/bin/vite.js', ['--config', 'apps/web/vite.config.ts']);
console.log(
  `Public market: http://127.0.0.1:5173. Local wallets A/B/C: http://127.0.0.1:4101/ through :4103/. Pairing details: ${resolve(dir, 'pairing.json')}. MOCK wallets; no real settlement.`,
);
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
