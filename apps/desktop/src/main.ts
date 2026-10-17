import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { parseOfferLink, validateTradeId, validateWalletRequest } from './security.ts';
import { loadDesktopConfig, type DesktopConfig } from './config.ts';
import type { FundingStatus } from '../../local-client/src/funding-types.ts';

const APP_URL = 'palka-app://local/';
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
protocol.registerSchemesAsPrivileged([
  { scheme: 'palka-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName('palka');
if (process.env.PALKA_DESKTOP_DATA_DIR) {
  const dataDir = resolve(process.env.PALKA_DESKTOP_DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  app.setPath('userData', dataDir);
}

const appRoot = app.getAppPath();
let window: BrowserWindow | null = null;
let backend: ChildProcess | null = null;
let pendingOffer: string | null = null;
let backendToken = '';
let config: DesktopConfig;
let startupStage = 'configuration';

function rejectSecrets(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  if (
    [backendToken, config.marketToken, config.walletRpcToken].some(
      (secret) => secret && serialized.includes(secret),
    )
  )
    throw new Error('Sensitive response blocked');
  return value;
}
function approvalSummary(result: unknown): { token: string; detail: string } {
  if (!result || typeof result !== 'object') throw new Error('Invalid wallet preview');
  const source = result as Record<string, unknown>;
  const preview = source.preview;
  if (
    typeof source.approvalToken !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(source.approvalToken) ||
    !preview ||
    typeof preview !== 'object'
  )
    throw new Error('Invalid wallet preview');
  const value = preview as Record<string, unknown>;
  const amount = (entry: unknown): string => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid wallet preview');
    const row = entry as Record<string, unknown>;
    if (
      typeof row.amount !== 'string' ||
      !/^\d{1,20}$/.test(row.amount) ||
      !row.asset ||
      typeof row.asset !== 'object'
    )
      throw new Error('Invalid wallet preview');
    const asset = row.asset as Record<string, unknown>;
    if (asset.kind === 'btc') return `${row.amount} sats BTC`;
    if (
      asset.kind === 'rgb' &&
      typeof asset.contractId === 'string' &&
      /^[a-zA-Z0-9:._~+/#=-]{1,200}$/.test(asset.contractId)
    )
      return `${row.amount} atomic RGB units (${asset.contractId})`;
    throw new Error('Invalid wallet preview');
  };
  if (
    value.validated !== true ||
    value.mode !== 'real' ||
    value.network !== 'regtest' ||
    typeof value.feeSats !== 'string' ||
    !/^\d{1,20}$/.test(value.feeSats)
  )
    throw new Error('Wallet has not validated this trade');
  return {
    token: source.approvalToken,
    detail: `Give: ${amount(value.give)}\nReceive: ${amount(value.receive)}\nBitcoin fee: ${value.feeSats} sats\nNetwork: regtest`,
  };
}
function validatedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (
    !window ||
    event.sender !== window.webContents ||
    !frame ||
    frame !== window.webContents.mainFrame ||
    frame.url !== APP_URL ||
    window.webContents.getURL() !== APP_URL
  )
    throw new Error('Untrusted desktop frame');
}
async function requestLocal(
  method: 'GET' | 'POST',
  path: string,
  input?: unknown,
): Promise<unknown> {
  if (!backend || backend.exitCode !== null) throw new Error('Local wallet service is unavailable');
  const payload = input === undefined ? undefined : JSON.stringify(input);
  if (payload && Buffer.byteLength(payload) > 128 * 1024) throw new Error('Request is too large');
  const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${backendToken}`,
      Origin: `http://127.0.0.1:${config.port}`,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload,
    redirect: 'error',
    signal: AbortSignal.timeout(
      path === '/api/interpret' ||
        path.startsWith('/api/funding') ||
        /\/(prepare|preview|sync|approve)$/.test(path)
        ? 90_000
        : 15_000,
    ),
  }).catch(() => {
    throw new Error('Local wallet service is unavailable');
  });
  const result = (await response.json().catch(() => {
    throw new Error('Invalid local wallet response');
  })) as unknown;
  rejectSecrets(result);
  if (!response.ok) {
    const message =
      result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? result.error
        : `Local wallet request failed (${response.status})`;
    throw new Error(message);
  }
  return result;
}
async function waitForBackend(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!backend || backend.exitCode !== null) break;
    try {
      await requestLocal('GET', '/api/health');
      return;
    } catch {
      await delay(150);
    }
  }
  throw new Error(
    'Local wallet service is unavailable. Check the desktop configuration and wallet adapter.',
  );
}
function startBackend(): void {
  backendToken = randomBytes(32).toString('hex');
  const nodeBin = join(appRoot, 'node_modules', 'node', 'bin', 'node');
  const backendEntry = join(appRoot, 'apps', 'local-client', 'src', 'main.ts');
  if (!existsSync(nodeBin) || !existsSync(backendEntry))
    throw new Error('Bundled local wallet runtime is missing');
  const stateDir = process.env.PALKA_LOCAL_STATE_DIR
    ? resolve(process.env.PALKA_LOCAL_STATE_DIR)
    : join(app.getPath('userData'), 'state', config.ownerId);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'WDK_ELECTRUM_PORT',
  ])
    if (process.env[key]) environment[key] = process.env[key];
  Object.assign(environment, {
    LOCAL_OWNER_ID: config.ownerId,
    LOCAL_PORT: String(config.port),
    LOCAL_HOST: '127.0.0.1',
    LOCAL_STATE_DIR: stateDir,
    LOCAL_SESSION_TOKEN: backendToken,
    LOCAL_ALLOWED_ORIGINS: `http://127.0.0.1:${config.port}`,
    MARKET_URL: config.marketUrl,
    MARKET_TOKEN: config.marketToken,
    MARKET_AUTO_REGISTER: String(config.marketRegistration === 'automatic'),
    WALLET_MODE: config.walletMode,
    WALLET_RPC_URL: config.walletRpcUrl,
    WALLET_RPC_TOKEN: config.walletRpcToken,
  });
  backend = spawn(nodeBin, ['--import', 'tsx', backendEntry], {
    cwd: appRoot,
    env: environment,
    stdio: 'ignore',
  });
  backend.on('error', () => {
    backend = null;
  });
}
async function bundledUi(requestUrl: string): Promise<Response> {
  const url = new URL(requestUrl);
  if (
    url.protocol !== 'palka-app:' ||
    url.hostname !== 'local' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return new Response('Not found', { status: 404 });
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (path !== '/index.html' && !/^\/assets\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(path))
    return new Response('Not found', { status: 404 });
  const uiRoot = join(appRoot, 'apps', 'local-client', 'ui', 'dist');
  const file = resolve(uiRoot, path.slice(1));
  try {
    if ((await lstat(uiRoot)).isSymbolicLink() || (await lstat(file)).isSymbolicLink())
      return new Response('Not found', { status: 404 });
    const root = await realpath(uiRoot);
    const target = await realpath(file);
    const inside = relative(root, target);
    if (!inside || inside === '..' || inside.startsWith(`..${sep}`))
      return new Response('Not found', { status: 404 });
    if (path.startsWith('/assets/')) {
      const assets = join(uiRoot, 'assets');
      if (
        (await lstat(assets)).isSymbolicLink() ||
        relative(await realpath(assets), target).startsWith('..')
      )
        return new Response('Not found', { status: 404 });
    }
    const mime =
      path === '/index.html' ? 'text/html; charset=utf-8' : MIME[extname(path).toLowerCase()];
    if (!mime) return new Response('Not found', { status: 404 });
    const bytes = await readFile(target);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control':
          path === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Local wallet UI is not bundled', { status: 503 });
  }
}
function showOffer(raw: string): void {
  const id = parseOfferLink(raw);
  if (!id) return;
  pendingOffer = id;
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
    if (!window.webContents.isLoading()) window.webContents.send('offer:selected', id);
  }
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  showOffer(url);
});
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', (_event, args) => {
    for (const arg of args) showOffer(arg);
    if (window) window.focus();
  });
  for (const arg of process.argv) showOffer(arg);
  if (process.defaultApp) app.setAsDefaultProtocolClient('palka', process.execPath, [appRoot]);
  else app.setAsDefaultProtocolClient('palka');
  app
    .whenReady()
    .then(async () => {
      config = loadDesktopConfig(app.getPath('userData'));
      startupStage = 'registering the local UI protocol';
      protocol.handle('palka-app', (request) => bundledUi(request.url));
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      startupStage = 'starting the local wallet service';
      startBackend();
      startupStage = 'creating the wallet window';
      const preload = join(appRoot, 'apps', 'desktop', 'dist', 'preload.cjs');
      window = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 900,
        minHeight: 650,
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => {
        if (url !== APP_URL) event.preventDefault();
      });
      window.webContents.on('did-finish-load', () => {
        if (pendingOffer) window?.webContents.send('offer:selected', pendingOffer);
      });
      startupStage = 'loading the bundled wallet UI';
      await window.loadURL(APP_URL);
      window.show();
    })
    .catch(() => {
      console.error(`palka. startup failed while ${startupStage}`);
      dialog.showErrorBox(
        'palka. startup failed',
        `Could not complete ${startupStage}. Check the installed app and private desktop configuration.`,
      );
      app.quit();
    });
  ipcMain.handle('wallet:connect', async (event) => {
    validatedSender(event);
    await waitForBackend();
    return requestLocal('GET', '/api/health');
  });
  ipcMain.handle(
    'wallet:request',
    async (event, method: unknown, path: unknown, input: unknown) => {
      validatedSender(event);
      if (!validateWalletRequest(method, path)) throw new Error('Unsupported wallet operation');
      return requestLocal(method as 'GET' | 'POST', path as string, input);
    },
  );
  ipcMain.handle('wallet:approve', async (event, tradeId: unknown, approvalToken: unknown) => {
    validatedSender(event);
    if (
      !validateTradeId(tradeId) ||
      typeof approvalToken !== 'string' ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(approvalToken)
    )
      throw new Error('Invalid approval request');
    // Refreshing the preview invalidates the renderer's token. Only this newly wallet-validated preview is shown and approved.
    const fresh = approvalSummary(await requestLocal('POST', `/api/trades/${tradeId}/preview`, {}));
    const decision = await dialog.showMessageBox(window!, {
      type: 'warning',
      buttons: ['Cancel', 'Approve and sign'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Approve wallet signature',
      message: 'Approve this exact trade and sign?',
      detail: `Trade: ${tradeId}\n${fresh.detail}\nThe wallet will validate the final package again before signing.`,
    });
    if (decision.response !== 1) throw new Error('Signing was not approved');
    return requestLocal('POST', `/api/trades/${tradeId}/approve`, {
      approvalToken: fresh.token,
      confirmed: true,
    });
  });
  ipcMain.handle('offer:pending', (event) => {
    validatedSender(event);
    const id = pendingOffer;
    pendingOffer = null;
    return id;
  });
  ipcMain.handle('funding:approve', async (event, operationId: unknown) => {
    validatedSender(event);
    if (!validateTradeId(operationId)) throw new Error('Invalid funding operation.');
    const status = (await requestLocal('GET', '/api/funding')) as FundingStatus;
    const operation = status.operation;
    if (
      !status.available ||
      !operation ||
      operation.id !== operationId ||
      operation.status !== 'PREVIEW' ||
      operation.expiresAt <= Date.now()
    )
      throw new Error('Funding preview changed or expired. Review it again.');
    const decision = await dialog.showMessageBox(window!, {
      type: 'warning',
      buttons: ['Cancel', 'Approve funding'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Approve WDK funding',
      message: 'Send BTC to your exchange wallet?',
      detail: `Network: regtest\nDestination: ${operation.address}\nAmount: ${operation.amountSats} sats\nEstimated fee: ${operation.feeSats} sats\nMaximum fee: ${operation.maxFeeSats} sats\nThis is a separate funding transaction, not an RGB exchange.`,
    });
    if (decision.response !== 1) throw new Error('Funding was not approved.');
    return requestLocal('POST', '/api/funding/approve', { operationId, confirmed: true });
  });
  ipcMain.handle('market:open', async (event) => {
    validatedSender(event);
    await shell.openExternal(config.publicMarketUrl);
  });
  app.on('before-quit', () => {
    backend?.kill('SIGTERM');
  });
  app.on('window-all-closed', () => app.quit());
}
