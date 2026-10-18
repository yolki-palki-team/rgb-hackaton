import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { participantId } from '@rgb-exchange/contracts/participant';
import { developmentNetwork, type DevelopmentNetwork } from '@rgb-exchange/contracts';

export type DesktopConfig = {
  network: DevelopmentNetwork;
  ownerId: string;
  marketUrl: string;
  marketToken: string;
  marketRegistration: 'automatic' | 'manual';
  marketIdentityOrigin?: string;
  walletRpcUrl: string;
  walletRpcToken: string;
  walletMode: 'real' | 'mock';
  port: number;
  publicMarketUrl: string;
};

function serviceUrl(raw: string, local: boolean, path = '/'): string {
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    (local
      ? url.protocol !== 'http:' || !loopback
      : url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== path
  )
    throw new Error('Invalid desktop service URL');
  return path === '/' ? url.origin : url.toString();
}

function resolveConfig(saved: Record<string, unknown>, env: NodeJS.ProcessEnv): DesktopConfig {
  const value = (key: string, variable: string, fallback = '') =>
    String(env[variable] ?? saved[key] ?? fallback);
  const network = developmentNetwork(value('network', 'PALKA_NETWORK', 'regtest'));
  if (Object.hasOwn(saved, 'network') && developmentNetwork(String(saved.network)) !== network)
    throw new Error(
      'Desktop configuration belongs to another network; use a separate desktop profile',
    );
  const ownerId = value('ownerId', 'PALKA_OWNER_ID');
  const marketToken = value('marketToken', 'PALKA_MARKET_TOKEN');
  if (!/^[a-zA-Z0-9:._-]{1,200}$/.test(ownerId)) throw new Error('Invalid local owner ID');
  if (!marketToken || marketToken.length > 2048)
    throw new Error('Missing or invalid market token; existing identity was not replaced');
  const port = Number(value('port', 'PALKA_LOCAL_PORT', '4211'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5173)
    throw new Error('Invalid local port');
  const walletMode = value('walletMode', 'PALKA_WALLET_MODE', 'real');
  if (walletMode !== 'real' && walletMode !== 'mock') throw new Error('Invalid wallet mode');
  if (network !== 'regtest' && walletMode === 'mock')
    throw new Error('Mock wallets are only available on regtest');
  const savedRegistration = saved.marketRegistration ?? 'manual';
  if (savedRegistration !== 'automatic' && savedRegistration !== 'manual')
    throw new Error('Invalid registration mode');
  let marketRegistration: 'automatic' | 'manual' = savedRegistration;
  if (
    marketRegistration === 'automatic' &&
    (env.PALKA_OWNER_ID !== undefined || env.PALKA_MARKET_TOKEN !== undefined)
  ) {
    if (!env.PALKA_OWNER_ID || !env.PALKA_MARKET_TOKEN)
      throw new Error('Override both owner ID and market token together');
    marketRegistration = 'manual';
  }
  const marketUrl = serviceUrl(
    value('marketUrl', 'PALKA_MARKET_URL', 'http://127.0.0.1:4100'),
    false,
  );
  if (marketRegistration === 'automatic') {
    if (participantId(marketToken) !== ownerId)
      throw new Error('Automatic participant identity does not match its token');
    if (saved.marketIdentityOrigin !== marketUrl)
      throw new Error(
        'Automatic identity belongs to another market; use a separate desktop profile',
      );
  }
  return {
    network,
    ownerId,
    marketToken,
    marketUrl,
    marketRegistration,
    ...(marketRegistration === 'automatic' ? { marketIdentityOrigin: marketUrl } : {}),
    port,
    walletMode,
    walletRpcUrl: serviceUrl(
      value('walletRpcUrl', 'PALKA_WALLET_RPC_URL', 'http://127.0.0.1:4201'),
      true,
    ),
    walletRpcToken: value('walletRpcToken', 'PALKA_WALLET_RPC_TOKEN'),
    publicMarketUrl: serviceUrl(
      value('publicMarketUrl', 'PALKA_PUBLIC_MARKET_URL', 'http://127.0.0.1:5173/market'),
      false,
      '/market',
    ),
  };
}

export function loadDesktopConfig(
  userData: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopConfig {
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const path = join(userData, 'desktop-config.json');
  if (!existsSync(path)) {
    const manual = env.PALKA_OWNER_ID !== undefined || env.PALKA_MARKET_TOKEN !== undefined;
    if (manual && (!env.PALKA_OWNER_ID || !env.PALKA_MARKET_TOKEN))
      throw new Error('Provide both owner ID and market token for an existing wallet');
    const stateDirectories = [join(userData, 'state'), env.PALKA_LOCAL_STATE_DIR].filter(
      (directory): directory is string => Boolean(directory),
    );
    if (
      !manual &&
      (env.PALKA_WALLET_RPC_TOKEN ||
        stateDirectories.some(
          (directory) => existsSync(directory) && readdirSync(directory).length > 0,
        ))
    )
      throw new Error(
        'Existing wallet state requires its original owner ID and market token; restore the desktop configuration',
      );
    // Persist before the first network request. A lost registration response reuses this token.
    const token = manual ? env.PALKA_MARKET_TOKEN! : randomBytes(32).toString('hex');
    const initial = resolveConfig(
      {
        ownerId: manual ? env.PALKA_OWNER_ID : participantId(token),
        marketToken: token,
        marketRegistration: manual ? 'manual' : 'automatic',
        marketIdentityOrigin: serviceUrl(env.PALKA_MARKET_URL ?? 'http://127.0.0.1:4100', false),
      },
      env,
    );
    try {
      writeFileSync(path, JSON.stringify(initial, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error('Desktop configuration must be an owner-only regular file');
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Invalid private desktop configuration; identity was not replaced');
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved))
    throw new Error('Invalid private desktop configuration');
  const record = saved as Record<string, unknown>;
  return resolveConfig({ ...record, network: record.network ?? 'regtest' }, env);
}

export function desktopDataDirectory(
  defaultDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PALKA_DESKTOP_DATA_DIR) return env.PALKA_DESKTOP_DATA_DIR;
  return developmentNetwork(env.PALKA_NETWORK) === 'signetcustom'
    ? `${defaultDirectory}-mutinynet`
    : defaultDirectory;
}
