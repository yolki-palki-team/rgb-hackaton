import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import { MarketError, MarketStore } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024;

function tokenOwner(token: string, owners: Map<string, string>, store: MarketStore): string | null {
  if (!token || token.length > 2048) return null;
  const candidate = Buffer.from(token);
  for (const [key, owner] of owners) {
    const expected = Buffer.from(key);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return owner;
  }
  return store.participantOwner(token);
}

function authenticate(
  request: IncomingMessage,
  owners: Map<string, string>,
  store: MarketStore,
): string {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const owner = tokenOwner(token, owners, store);
  if (!owner) throw new MarketError('UNAUTHORIZED', 401);
  return owner;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new MarketError('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MarketError('INVALID_JSON', 400);
  }
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

export function createMarketServer(
  store: MarketStore,
  owners: Map<string, string>,
  options: {
    selfRegistration?: boolean;
    registrationLimit?: number;
    registrationsPerMinute?: number;
  } = {},
) {
  let registrationWindow = Date.now();
  let registrations = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (request.method === 'POST' && path === '/participants') {
        if (request.headers.origin) throw new MarketError('BROWSER_REGISTRATION_FORBIDDEN', 403);
        z.object({})
          .strict()
          .parse(await readJson(request));
        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
        // Existing credentials keep working even if new enrollment is later disabled.
        const existing = tokenOwner(token, owners, store);
        if (existing) return json(response, 200, { ownerId: existing });
        if (!options.selfRegistration) throw new MarketError('REGISTRATION_DISABLED', 403);
        if (!/^[0-9a-f]{64}$/.test(token)) throw new MarketError('INVALID_REGISTRATION_TOKEN', 400);
        if (Date.now() - registrationWindow >= 60000) {
          registrationWindow = Date.now();
          registrations = 0;
        }
        if (registrations >= (options.registrationsPerMinute ?? 60))
          throw new MarketError('REGISTRATION_RATE_LIMITED', 429);
        const ownerId = store.registerParticipant(
          token,
          new Set(owners.values()),
          options.registrationLimit,
        );
        registrations++;
        return json(response, 201, { ownerId });
      }
      if (request.method === 'GET' && path === '/health')
        return json(response, 200, { ok: true, protocolVersion: 1, mode: 'coordination-only' });
      if (request.method === 'GET' && path === '/orders')
        return json(response, 200, { orders: store.listOpen() });
      if (request.method === 'GET' && path === '/activity')
        return json(response, 200, store.publicActivity());
      if (request.method === 'GET' && path === '/history')
        return json(
          response,
          200,
          store.publicHistory(url.searchParams.get('cursor') ?? undefined),
        );
      if (request.method === 'GET' && path === '/history/me') {
        const owner = authenticate(request, owners, store);
        return json(
          response,
          200,
          store.history(owner, url.searchParams.get('cursor') ?? undefined),
        );
      }
      if (request.method === 'POST' && path === '/orders') {
        const owner = authenticate(request, owners, store);
        return json(response, 201, store.createOrder(owner, await readJson(request)));
      }
      const cancel = /^\/orders\/([^/]+)\/cancel$/.exec(path);
      if (request.method === 'POST' && cancel) {
        const owner = authenticate(request, owners, store);
        const payload = z
          .object({ revision: z.number().int().nonnegative() })
          .strict()
          .parse(await readJson(request));
        return json(response, 200, {
          order: store.cancelOrder(owner, cancel[1], payload.revision),
        });
      }
      const order = /^\/orders\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && order) {
        const found = store.getOrder(order[1]);
        if (
          !found ||
          (found.status !== 'OPEN' && found.ownerId !== authenticate(request, owners, store))
        )
          throw new MarketError('ORDER_NOT_FOUND', 404);
        return json(response, 200, { order: found });
      }
      if (request.method === 'GET' && path === '/snapshot') {
        const owner = authenticate(request, owners, store);
        const after = url.searchParams.get('afterSequence') ?? '0';
        if (!/^(0|[1-9][0-9]*)$/.test(after)) throw new MarketError('INVALID_SEQUENCE', 400);
        return json(response, 200, store.snapshot(owner, Number(after)));
      }
      const trade = /^\/trades\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && trade) {
        const owner = authenticate(request, owners, store);
        const found = store.getTrade(trade[1], owner);
        if (!found) throw new MarketError('TRADE_NOT_FOUND', 404);
        return json(response, 200, { trade: found });
      }
      const message = /^\/trades\/([^/]+)\/messages$/.exec(path);
      if (request.method === 'POST' && message) {
        const owner = authenticate(request, owners, store);
        return json(response, 200, {
          event: store.relayTradeMessage(owner, message[1], await readJson(request)),
        });
      }
      throw new MarketError('NOT_FOUND', 404);
    } catch (error) {
      if (error instanceof MarketError) json(response, error.status, { error: error.code });
      else if (error instanceof z.ZodError)
        json(response, 400, {
          error: 'INVALID_REQUEST',
          issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        });
      else json(response, 500, { error: 'INTERNAL_ERROR' });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  const sessions = new Map<WebSocket, string>();
  const unsubscribe = store.subscribe((event, audience) => {
    const serialized = JSON.stringify(event);
    for (const [socket, owner] of sessions)
      if (socket.readyState === 1 && (audience.length === 0 || audience.includes(owner)))
        socket.send(serialized);
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/events') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (socket) => {
    const timeout = setTimeout(() => socket.close(1008, 'AUTH_REQUIRED'), 10000);
    socket.on('message', (raw) => {
      if (sessions.has(socket)) {
        socket.close(1008, 'READ_ONLY');
        return;
      }
      try {
        const payload = z
          .object({
            type: z.literal('authenticate'),
            token: z.string().min(1).max(2048),
            afterSequence: z.number().int().nonnegative(),
          })
          .strict()
          .parse(JSON.parse(raw.toString()));
        const owner = tokenOwner(payload.token, owners, store);
        if (!owner) throw new Error('INVALID_AUTH');
        const snapshot = store.snapshot(owner, payload.afterSequence);
        sessions.set(socket, owner);
        clearTimeout(timeout);
        socket.send(JSON.stringify({ type: 'snapshot', ...snapshot }));
      } catch {
        socket.close(1008, 'INVALID_AUTH');
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      sessions.delete(socket);
    });
  });
  server.on('close', () => {
    unsubscribe();
    wss.close();
  });
  return server;
}
