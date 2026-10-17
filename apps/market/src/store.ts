import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  CoordinationMessageSchema,
  EventEnvelopeSchema,
  MarketSnapshotSchema,
  PROTOCOL_VERSION,
  PublicOrderSchema,
  ReceiptSchema,
  SettlementPackageSchema,
  TradePlanSchema,
  TradeSnapshotSchema,
  type CoordinationMessage,
  type EventEnvelope,
  type MarketSnapshot,
  type PublicOrder,
  type TradePlan,
  type TradeSnapshot,
} from '@rgb-exchange/contracts';
import { digestValue, planDigest } from '@rgb-exchange/contracts/digest';
import { findMatch } from './matcher.ts';

type OrderRow = { data: string; status: PublicOrder['status']; revision: number };
type TradeRow = { data: string };
type EventRow = { data: string; audience: string };
type Pending = { event: EventEnvelope; audience: string[] }[];

export class MarketError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export class MarketStore {
  private db: DatabaseSync;
  private listeners = new Set<(event: EventEnvelope, audience: string[]) => void>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_orders_owner_status ON orders(owner_id, status);
      CREATE TABLE IF NOT EXISTS trades (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trade_participants (trade_id TEXT NOT NULL REFERENCES trades(id), owner_id TEXT NOT NULL, PRIMARY KEY (trade_id, owner_id));
      CREATE INDEX IF NOT EXISTS idx_participant_owner ON trade_participants(owner_id);
      CREATE TABLE IF NOT EXISTS trade_orders (trade_id TEXT NOT NULL REFERENCES trades(id), order_id TEXT NOT NULL REFERENCES orders(id), PRIMARY KEY (trade_id, order_id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, audience TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_idempotency (trade_id TEXT NOT NULL, owner_id TEXT NOT NULL, message_id TEXT NOT NULL, digest TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES events(sequence), PRIMARY KEY (trade_id, owner_id, message_id));
    `);
  }

  close(): void {
    this.db.close();
  }
  subscribe(listener: (event: EventEnvelope, audience: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private transaction<T>(action: (pending: Pending) => T): T {
    const pending: Pending = [];
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = action(pending);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const item of pending)
      for (const listener of this.listeners) {
        try {
          listener(item.event, item.audience);
        } catch {
          /* Resync from persisted events. */
        }
      }
    return result;
  }

  private event(
    type: EventEnvelope['type'],
    revision: number,
    payload: unknown,
    audience: string[],
    pending: Pending,
    tradeId?: string,
  ): EventEnvelope {
    const event = EventEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      sequence: 0,
      type,
      revision,
      payload,
      ...(tradeId ? { tradeId } : {}),
    });
    const row = this.db
      .prepare('INSERT INTO events (audience, data) VALUES (?, ?)')
      .run(JSON.stringify(audience), JSON.stringify(event));
    event.sequence = Number(row.lastInsertRowid);
    this.db
      .prepare('UPDATE events SET data=? WHERE sequence=?')
      .run(JSON.stringify(event), event.sequence);
    pending.push({ event, audience });
    return event;
  }

  private order(row: OrderRow): PublicOrder {
    return PublicOrderSchema.parse({
      ...JSON.parse(row.data),
      revision: row.revision,
      status: row.status,
    });
  }

  private expireOpen(now: number, pending: Pending): void {
    const rows = this.db
      .prepare("SELECT data, status, revision FROM orders WHERE status='OPEN' AND expires_at<=?")
      .all(now) as OrderRow[];
    for (const row of rows) {
      const order = this.order(row);
      this.db
        .prepare(
          "UPDATE orders SET status='EXPIRED', revision=revision+1 WHERE id=? AND status='OPEN'",
        )
        .run(order.id);
      this.event('order.expired', order.revision + 1, { orderId: order.id }, [], pending);
    }
  }

  expireOrders(now = Date.now()): void {
    this.transaction((pending) => this.expireOpen(now, pending));
  }

  private activeOwner(ownerId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM orders WHERE owner_id=? AND status IN ('OPEN','RESERVED') LIMIT 1")
        .get(ownerId),
    );
  }

  private cancelTradeOrders(trade: TradeSnapshot): void {
    for (const ref of trade.plan.orderRefs) {
      const result = this.db
        .prepare(
          "UPDATE orders SET status='CANCELLED', revision=revision+1 WHERE id=? AND status='RESERVED' AND revision=?",
        )
        .run(ref.orderId, ref.revision);
      if (result.changes !== 1) throw new MarketError('STALE_ORDER', 409);
    }
  }

  private fillTradeOrders(trade: TradeSnapshot): void {
    for (const ref of trade.plan.orderRefs) {
      const result = this.db
        .prepare(
          "UPDATE orders SET status='FILLED', revision=revision+1 WHERE id=? AND status='RESERVED' AND revision=?",
        )
        .run(ref.orderId, ref.revision);
      if (result.changes !== 1) throw new MarketError('STALE_ORDER', 409);
    }
  }

  private applyMessage(
    trade: TradeSnapshot,
    ownerId: string,
    message: CoordinationMessage,
  ): TradeSnapshot {
    const status = trade.status;
    if (['REJECTED', 'CANCELLED', 'EXPIRED', 'UNSUPPORTED', 'CONFIRMED'].includes(status))
      throw new MarketError('TRADE_TERMINAL', 409);
    if (message.type === 'prepare') {
      if (status !== 'RESERVED' && status !== 'PREPARING')
        throw new MarketError('INVALID_TRADE_STAGE', 409);
      return { ...trade, status: 'PREPARING' };
    }
    if (message.type === 'package') {
      if (!['RESERVED', 'PREPARING', 'AWAITING_APPROVAL'].includes(status))
        throw new MarketError('PACKAGE_LOCKED', 409);
      const pkg = SettlementPackageSchema.parse(message.payload);
      if (
        pkg.tradeId !== trade.plan.tradeId ||
        pkg.planRevision !== trade.plan.revision ||
        pkg.planDigest !== trade.plan.digest ||
        pkg.network !== trade.plan.network
      )
        throw new MarketError('PACKAGE_PLAN_MISMATCH', 409);
      if (
        trade.settlementPackage &&
        JSON.stringify(trade.settlementPackage) !== JSON.stringify(pkg)
      )
        throw new MarketError('PACKAGE_LOCKED', 409);
      return { ...trade, status: 'AWAITING_APPROVAL', settlementPackage: pkg };
    }
    if (message.type === 'signature') {
      if (
        !trade.settlementPackage ||
        !['AWAITING_APPROVAL', 'SIGNING', 'RECONCILING', 'BROADCAST'].includes(status)
      )
        throw new MarketError('INVALID_TRADE_STAGE', 409);
      if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload))
        throw new MarketError('INVALID_SIGNATURE_NOTICE', 400);
      const payload = message.payload as Record<string, unknown>;
      if (
        payload.packageId !== trade.settlementPackage.packageId ||
        payload.unsignedTxDigest !== trade.settlementPackage.unsignedTxDigest ||
        payload.commitmentDigest !== trade.settlementPackage.commitmentDigest
      )
        throw new MarketError('SIGNATURE_PACKAGE_MISMATCH', 409);
      if (payload.signature === undefined && payload.signatureMayExist !== true)
        throw new MarketError('INVALID_SIGNATURE_NOTICE', 400);
      const previous = trade.messages
        .filter((item) => item.ownerId === ownerId && item.message.type === 'signature')
        .map((item) => item.message.payload as Record<string, unknown>)
        .find((item) => item.signature !== undefined);
      if (
        previous &&
        payload.signature !== undefined &&
        digestValue(previous.signature) !== digestValue(payload.signature)
      )
        throw new MarketError('SIGNATURE_CONFLICT', 409);
      return { ...trade, status: status === 'AWAITING_APPROVAL' ? 'SIGNING' : status };
    }
    if (message.type === 'broadcast') {
      if (!['SIGNING', 'READY_TO_BROADCAST', 'RECONCILING', 'BROADCAST'].includes(status))
        throw new MarketError('INVALID_TRADE_STAGE', 409);
      const receipt = ReceiptSchema.parse(message.payload);
      if (
        receipt.mode !== 'real' ||
        receipt.tradeId !== trade.plan.tradeId ||
        receipt.network !== trade.plan.network ||
        !receipt.txid
      )
        throw new MarketError('INVALID_BROADCAST_RECEIPT', 400);
      const prior = trade.messages
        .filter((item) => item.message.type === 'broadcast')
        .map((item) => ReceiptSchema.parse(item.message.payload));
      if (prior.some((item) => item.txid !== receipt.txid))
        throw new MarketError('BROADCAST_TXID_CONFLICT', 409);
      return { ...trade, status: receipt.state === 'reconciling' ? 'RECONCILING' : 'BROADCAST' };
    }
    if (message.type === 'receipt') {
      const receipt = ReceiptSchema.parse(message.payload);
      if (receipt.tradeId !== trade.plan.tradeId || receipt.network !== trade.plan.network)
        throw new MarketError('INVALID_RECEIPT', 400);
      if (
        receipt.state === 'confirmed' &&
        (receipt.mode !== 'real' ||
          !receipt.txid ||
          !receipt.chainConfirmed ||
          !receipt.rgbAccepted)
      )
        throw new MarketError('INVALID_CONFIRMED_RECEIPT', 400);
      if (
        receipt.state === 'confirmed' &&
        !['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING'].includes(status)
      )
        throw new MarketError('INVALID_TRADE_STAGE', 409);
      // The coordinator aggregates authenticated wallet reports. It cannot verify the chain or RGB state itself.
      const latest = new Map<string, typeof receipt>();
      for (const item of [...trade.messages, { ownerId, message }]) {
        if (item.message.type === 'receipt')
          latest.set(item.ownerId, ReceiptSchema.parse(item.message.payload));
      }
      const reports = trade.plan.participants.map((owner) => latest.get(owner));
      if (
        reports.every(
          (report) =>
            report?.mode === 'real' &&
            report.state === 'confirmed' &&
            report.txid &&
            report.chainConfirmed &&
            report.rgbAccepted,
        )
      ) {
        const txids = new Set(reports.map((report) => report!.txid));
        const broadcastTxids = trade.messages
          .filter((item) => item.message.type === 'broadcast')
          .map((item) => ReceiptSchema.parse(item.message.payload).txid);
        if (txids.size !== 1 || broadcastTxids.some((txid) => txid !== reports[0]!.txid))
          return {
            ...trade,
            status: 'RECONCILING',
            reason: 'Wallet reports disagree on transaction ID',
          };
        this.fillTradeOrders(trade);
        return { ...trade, status: 'CONFIRMED' };
      }
      if (
        receipt.state === 'reconciling' &&
        ['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING'].includes(status)
      )
        return { ...trade, status: 'RECONCILING' };
      return trade;
    }
    if (message.type === 'reject' || message.type === 'unsupported') {
      const reason =
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'reason' in message.payload &&
        typeof message.payload.reason === 'string'
          ? message.payload.reason.slice(0, 1000)
          : undefined;
      const signatureMayExist =
        typeof message.payload === 'object' &&
        message.payload !== null &&
        'signatureMayExist' in message.payload &&
        message.payload.signatureMayExist === true;
      if (
        signatureMayExist ||
        ['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING'].includes(status)
      )
        return { ...trade, status: 'RECONCILING', ...(reason ? { reason } : {}) };
      this.cancelTradeOrders(trade);
      return {
        ...trade,
        status: message.type === 'reject' ? 'REJECTED' : 'UNSUPPORTED',
        ...(reason ? { reason } : {}),
      };
    }
    throw new MarketError('INVALID_MESSAGE_TYPE', 400);
  }

  createOrder(
    ownerId: string,
    raw: unknown,
    now = Date.now(),
  ): { order: PublicOrder; trade: TradeSnapshot | null } {
    const input = PublicOrderSchema.parse(raw);
    if (ownerId !== input.ownerId) throw new MarketError('OWNER_MISMATCH', 403);
    if (input.network !== 'regtest') throw new MarketError('UNSUPPORTED_NETWORK', 400);
    if (input.revision !== 0 || input.status !== 'OPEN')
      throw new MarketError('INVALID_INITIAL_ORDER', 400);
    return this.transaction((pending) => {
      this.expireOpen(now, pending);
      const existing = this.db
        .prepare('SELECT data, status, revision FROM orders WHERE id=?')
        .get(input.id) as OrderRow | undefined;
      if (existing) {
        if (JSON.stringify(JSON.parse(existing.data)) !== JSON.stringify(input))
          throw new MarketError('ORDER_ID_CONFLICT', 409);
        const row = this.db
          .prepare(
            'SELECT t.data FROM trades t JOIN trade_orders o ON o.trade_id=t.id WHERE o.order_id=?',
          )
          .get(input.id) as TradeRow | undefined;
        return {
          order: this.order(existing),
          trade: row ? TradeSnapshotSchema.parse(JSON.parse(row.data)) : null,
        };
      }
      if (Math.abs(input.createdAt - now) > 5 * 60 * 1000)
        throw new MarketError('INVALID_CREATED_AT', 400);
      if (input.expiresAt <= now || input.expiresAt > now + 7 * 24 * 60 * 60 * 1000)
        throw new MarketError('INVALID_EXPIRY', 400);
      if (this.activeOwner(ownerId)) throw new MarketError('ACTIVE_ORDER_EXISTS', 409);
      this.db
        .prepare(
          'INSERT INTO orders (id, owner_id, revision, status, expires_at, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(input.id, ownerId, 0, 'OPEN', input.expiresAt, input.createdAt, JSON.stringify(input));
      this.event('order.created', 0, { order: input }, [], pending);
      const trade = this.reserveFirstMatch(now, pending);
      return {
        order: trade?.plan.orderRefs.some((ref) => ref.orderId === input.id)
          ? { ...input, status: 'RESERVED' as const, revision: 1 }
          : input,
        trade,
      };
    });
  }

  private reserveFirstMatch(now: number, pending: Pending): TradeSnapshot | null {
    const rows = this.db
      .prepare(
        "SELECT data, status, revision FROM orders WHERE status='OPEN' ORDER BY created_at, id",
      )
      .all() as OrderRow[];
    const match = findMatch(
      rows.map((row) => this.order(row)),
      now,
    );
    if (!match) return null;
    for (const order of match.orders) {
      const result = this.db
        .prepare(
          "UPDATE orders SET status='RESERVED', revision=revision+1 WHERE id=? AND status='OPEN' AND revision=?",
        )
        .run(order.id, order.revision);
      if (result.changes !== 1) throw new MarketError('STALE_ORDER', 409);
    }
    const ownerByOrder = new Map(match.orders.map((order) => [order.id, order.ownerId]));
    const planWithoutDigest = {
      protocolVersion: PROTOCOL_VERSION,
      tradeId: randomUUID(),
      revision: 0,
      network: match.orders[0].network,
      orderRefs: match.orders.map((order) => ({ orderId: order.id, revision: order.revision + 1 })),
      participants: match.orders.map((order) => order.ownerId),
      legs: match.legs.map((leg) => ({
        fromOwnerId: ownerByOrder.get(leg.fromOrderId)!,
        toOwnerId: ownerByOrder.get(leg.toOrderId)!,
        asset: leg.asset,
        amount: leg.amount,
      })),
      fees: match.orders.map((order) => ({ ownerId: order.ownerId, feeSats: order.maxFeeSats })),
      feeState: 'estimate' as const,
      createdAt: now,
    };
    const plan: TradePlan = TradePlanSchema.parse({
      ...planWithoutDigest,
      digest: planDigest(planWithoutDigest),
    });
    const trade = TradeSnapshotSchema.parse({ plan, status: 'RESERVED', messages: [] });
    this.db
      .prepare('INSERT INTO trades (id, status, data) VALUES (?, ?, ?)')
      .run(plan.tradeId, trade.status, JSON.stringify(trade));
    for (const owner of plan.participants)
      this.db
        .prepare('INSERT INTO trade_participants (trade_id, owner_id) VALUES (?, ?)')
        .run(plan.tradeId, owner);
    for (const order of match.orders)
      this.db
        .prepare('INSERT INTO trade_orders (trade_id, order_id) VALUES (?, ?)')
        .run(plan.tradeId, order.id);
    this.event('trade.updated', 0, { trade }, plan.participants, pending, plan.tradeId);
    this.event(
      'trade.updated',
      0,
      { unavailableOrderIds: match.orders.map((order) => order.id) },
      [],
      pending,
    );
    return trade;
  }

  cancelOrder(ownerId: string, orderId: string, revision: number, now = Date.now()): PublicOrder {
    return this.transaction((pending) => {
      this.expireOpen(now, pending);
      const row = this.db
        .prepare('SELECT data, status, revision FROM orders WHERE id=?')
        .get(orderId) as OrderRow | undefined;
      if (!row) throw new MarketError('ORDER_NOT_FOUND', 404);
      const order = this.order(row);
      if (order.ownerId !== ownerId) throw new MarketError('ORDER_NOT_FOUND', 404);
      if (order.status !== 'OPEN' || order.revision !== revision)
        throw new MarketError('STALE_OR_RESERVED_ORDER', 409);
      this.db
        .prepare(
          "UPDATE orders SET status='CANCELLED', revision=revision+1 WHERE id=? AND status='OPEN' AND revision=?",
        )
        .run(orderId, revision);
      this.event('order.cancelled', revision + 1, { orderId }, [], pending);
      return { ...order, status: 'CANCELLED', revision: revision + 1 };
    });
  }

  listOpen(now = Date.now()): PublicOrder[] {
    return (
      this.db
        .prepare(
          "SELECT data, status, revision FROM orders WHERE status='OPEN' AND expires_at>? ORDER BY created_at, id",
        )
        .all(now) as OrderRow[]
    ).map((row) => this.order(row));
  }

  getOrder(id: string): PublicOrder | null {
    const row = this.db.prepare('SELECT data, status, revision FROM orders WHERE id=?').get(id) as
      OrderRow | undefined;
    return row ? this.order(row) : null;
  }

  getTrade(id: string, ownerId: string): TradeSnapshot | null {
    if (
      !this.db
        .prepare('SELECT 1 FROM trade_participants WHERE trade_id=? AND owner_id=?')
        .get(id, ownerId)
    )
      return null;
    const row = this.db.prepare('SELECT data FROM trades WHERE id=?').get(id) as
      TradeRow | undefined;
    return row ? TradeSnapshotSchema.parse(JSON.parse(row.data)) : null;
  }

  relayTradeMessage(ownerId: string, tradeId: string, raw: unknown): EventEnvelope {
    const message: CoordinationMessage = CoordinationMessageSchema.parse(raw);
    return this.transaction((pending) => {
      const trade = this.getTrade(tradeId, ownerId);
      if (!trade) throw new MarketError('TRADE_NOT_FOUND', 404);
      if (trade.plan.revision !== message.revision) throw new MarketError('STALE_TRADE', 409);
      const digest = JSON.stringify(message);
      const existing = this.db
        .prepare(
          'SELECT digest, sequence FROM relay_idempotency WHERE trade_id=? AND owner_id=? AND message_id=?',
        )
        .get(tradeId, ownerId, message.messageId) as
        { digest: string; sequence: number } | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new MarketError('MESSAGE_ID_CONFLICT', 409);
        const row = this.db
          .prepare('SELECT data FROM events WHERE sequence=?')
          .get(existing.sequence) as { data: string };
        return EventEnvelopeSchema.parse(JSON.parse(row.data));
      }
      const updated = TradeSnapshotSchema.parse({
        ...this.applyMessage(trade, ownerId, message),
        messages: [...trade.messages, { ownerId, message }],
      });
      this.db
        .prepare('UPDATE trades SET status=?, data=? WHERE id=?')
        .run(updated.status, JSON.stringify(updated), tradeId);
      const event = this.event(
        'trade.message',
        trade.plan.revision,
        { ownerId, message },
        trade.plan.participants,
        pending,
        tradeId,
      );
      this.event(
        'trade.updated',
        trade.plan.revision,
        { trade: updated },
        trade.plan.participants,
        pending,
        tradeId,
      );
      this.db
        .prepare(
          'INSERT INTO relay_idempotency (trade_id, owner_id, message_id, digest, sequence) VALUES (?, ?, ?, ?, ?)',
        )
        .run(tradeId, ownerId, message.messageId, digest, event.sequence);
      return event;
    });
  }

  sequence(): number {
    return Number(
      (
        this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get() as {
          sequence: number;
        }
      ).sequence,
    );
  }

  snapshot(ownerId: string, afterSequence = 0, now = Date.now()): MarketSnapshot {
    const sequence = this.sequence();
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > sequence)
      throw new MarketError('INVALID_SEQUENCE', 400);
    const myOrders = (
      this.db
        .prepare(
          'SELECT data, status, revision FROM orders WHERE owner_id=? ORDER BY created_at DESC LIMIT 50',
        )
        .all(ownerId) as OrderRow[]
    ).map((row) => this.order(row));
    const trades = (
      this.db
        .prepare(
          'SELECT t.data FROM trades t JOIN trade_participants p ON p.trade_id=t.id WHERE p.owner_id=? ORDER BY t.rowid DESC LIMIT 50',
        )
        .all(ownerId) as TradeRow[]
    ).map((row) => TradeSnapshotSchema.parse(JSON.parse(row.data)));
    const events = (
      this.db
        .prepare('SELECT data, audience FROM events WHERE sequence>? ORDER BY sequence')
        .all(afterSequence) as EventRow[]
    )
      .filter((row) => {
        const audience = JSON.parse(row.audience) as string[];
        return audience.length === 0 || audience.includes(ownerId);
      })
      .map((row) => EventEnvelopeSchema.parse(JSON.parse(row.data)));
    return MarketSnapshotSchema.parse({
      sequence,
      orders: this.listOpen(now),
      myOrders,
      trades,
      events,
    });
  }
}
