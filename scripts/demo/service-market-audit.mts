// Read the actual A database and advance only its expiry clock; no service replacement.
import assert from 'node:assert/strict';
import type { TradeSnapshot } from '@rgb-exchange/contracts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const [source, database, tradeId] = process.argv.slice(2);
const { MarketStore } = await import(
  pathToFileURL(resolve(source, 'apps/market/src/store.ts')).href
);
const store = new MarketStore(database);
const before = store.snapshot('alice');
const trade = before.trades.find((t: TradeSnapshot) => t.plan.tradeId === tradeId);
assert(trade && ['SIGNING', 'RECONCILING', 'BROADCAST'].includes(trade.status));
store.expireOrders(Date.now() + 8 * 24 * 60 * 60 * 1000);
const after = store.snapshot('alice');
assert.equal(after.trades.length, before.trades.length);
assert.equal(
  after.trades.find((t: TradeSnapshot) => t.plan.tradeId === tradeId)?.status,
  trade.status,
);
for (const ref of trade.plan.orderRefs)
  assert.equal(store.getOrder(ref.orderId).status, 'RESERVED');
store.close();
const db = new DatabaseSync(database, { readOnly: true });
const prohibited =
  /"(?:privatePolicy|protectedBalances|allowedAssetKeys|allowBtcSale|mnemonic|seed|privateKey|goal|prompt)"\s*:/i;
for (const table of ['orders', 'trades', 'events']) {
  for (const row of db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[])
    assert(!prohibited.test(row.data), `Private data field in ${table}`);
}
db.close();
console.log(
  JSON.stringify({
    ttlClockAdvancedDays: 8,
    signedOrdersRemainReserved: true,
    sameTrade: true,
    marketPrivateFieldAudit: 'passed',
  }),
);
