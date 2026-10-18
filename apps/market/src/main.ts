import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { developmentNetwork } from '@rgb-exchange/contracts';
import { MarketStore } from './store.ts';
import { createMarketServer } from './server.ts';

const selfRegistration = process.env.MARKET_SELF_REGISTRATION === 'true';

function tokenMap(raw: string | undefined): Map<string, string> {
  // Persisted participants remain usable even when new registration is disabled.
  if (!raw) return new Map();
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('MARKET_TOKENS_JSON must be a JSON object');
  const entries = Object.entries(parsed);
  if (
    entries.some(
      ([token, owner]) =>
        !token || typeof owner !== 'string' || !/^[a-zA-Z0-9:._-]{1,200}$/.test(owner),
    )
  )
    throw new Error('Invalid MARKET_TOKENS_JSON entry');
  return new Map(entries as [string, string][]);
}

const owners = tokenMap(process.env.MARKET_TOKENS_JSON);
const network = developmentNetwork(process.env.MARKET_NETWORK ?? process.env.PALKA_NETWORK);
const path = resolve(
  process.env.MARKET_DB_PATH ??
    `./.state/market${network === 'regtest' ? '' : '-mutinynet'}.sqlite`,
);
const host = process.env.MARKET_HOST ?? '127.0.0.1';
const port = Number(process.env.MARKET_PORT ?? '4100');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MARKET_PORT');
mkdirSync(dirname(path), { recursive: true });
const store = new MarketStore(path, network);
const server = createMarketServer(store, owners, { selfRegistration });
const expiryTimer = setInterval(() => store.expireOrders(), 30000);
server.listen(port, host, () =>
  process.stdout.write(`Market listening at http://${host}:${port}\n`),
);

function shutdown(): void {
  clearInterval(expiryTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
