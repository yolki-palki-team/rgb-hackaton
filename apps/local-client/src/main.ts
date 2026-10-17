import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdSchema } from '@rgb-exchange/contracts';
import { LocalStore } from './store.ts';
import { MockWalletAdapter, HttpWalletAdapter, UnavailableWalletAdapter } from './wallet.ts';
import { MarketClient } from './market-client.ts';
import { QvacInterpreter } from './qvac.ts';
import { LocalService } from './service.ts';
import { createLocalServer } from './server.ts';
import { WdkFunding } from './wdk-funding.ts';

const owner = IdSchema.parse(process.env.LOCAL_OWNER_ID ?? 'A');
const mode = process.env.WALLET_MODE ?? 'real';
if (!['mock', 'real'].includes(mode)) throw new Error('WALLET_MODE must be mock or real');
const stateDir = resolve(process.env.LOCAL_STATE_DIR ?? `.state/local-${mode}-${owner}`);
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const tokenPath = resolve(stateDir, 'session-token');
if (!process.env.LOCAL_SESSION_TOKEN && !existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const token = process.env.LOCAL_SESSION_TOKEN ?? readFileSync(tokenPath, 'utf8').trim();
if (!process.env.MARKET_TOKEN) throw new Error('Set MARKET_TOKEN for this profile');
const market = new MarketClient(
  process.env.MARKET_URL ?? 'http://127.0.0.1:4100',
  process.env.MARKET_TOKEN,
  undefined,
  process.env.MARKET_AUTO_REGISTER === 'true' ? owner : undefined,
);
const store = new LocalStore(resolve(stateDir, 'local.sqlite'));
const wallet =
  mode === 'mock'
    ? new MockWalletAdapter(owner)
    : process.env.WALLET_RPC_TOKEN?.length && process.env.WALLET_RPC_TOKEN.length >= 16
      ? new HttpWalletAdapter(
          process.env.WALLET_RPC_URL ?? 'http://127.0.0.1:4201',
          process.env.WALLET_RPC_TOKEN,
        )
      : new UnavailableWalletAdapter();
const qvac = new QvacInterpreter();
const service = new LocalService(owner, wallet, market, store, qvac);
const port = Number(process.env.LOCAL_PORT ?? 4101);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid LOCAL_PORT');
const origins = (
  process.env.LOCAL_ALLOWED_ORIGINS ?? `http://127.0.0.1:${port},http://localhost:${port}`
)
  .split(',')
  .map((value) => value.trim());
const host = process.env.LOCAL_HOST ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(host))
  throw new Error('LOCAL_HOST must be 127.0.0.1 or 0.0.0.0');
const uiDirectory = fileURLToPath(new URL('../ui/dist/', import.meta.url));
const funding =
  mode === 'real'
    ? new WdkFunding({
        directory: resolve(stateDir, 'funding'),
        ownerId: owner,
        wallet,
        electrumPort: Number(process.env.WDK_ELECTRUM_PORT ?? 50001),
      })
    : undefined;
const server = createLocalServer(service, { token, allowedOrigins: origins, uiDirectory, funding });
server.listen(port, host, () => {
  market.connect();
  console.log(
    `Local profile ${owner}: http://127.0.0.1:${port}; wallet=${mode}; pairing token: ${process.env.LOCAL_SESSION_TOKEN ? 'provided through LOCAL_SESSION_TOKEN' : tokenPath}`,
  );
});
// Only unsigned cancellation cleanup runs in the background. Signing recovery
// remains an explicit sync operation using an already persisted authorization.
let checkingCancellation = false;
const cancellationTimer = setInterval(() => {
  if (checkingCancellation) return;
  checkingCancellation = true;
  void service
    .exclusive(() => service.snapshot())
    .catch(() => undefined)
    .finally(() => {
      checkingCancellation = false;
    });
}, 5000);
cancellationTimer.unref();
const close = () => {
  clearInterval(cancellationTimer);
  market.close();
  server.close(() => {
    void qvac.dispose().finally(() => {
      funding?.close();
      store.close();
      process.exit(0);
    });
  });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
