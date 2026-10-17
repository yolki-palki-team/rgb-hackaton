import { useEffect, useState } from 'react';
import type { MarketHistory, PublicOrder, TradeStatus } from '@rgb-exchange/contracts';
import { formatAsset } from '../api';
import { Button, Panel, SectionTitle, StatusBadge } from './ui/wallet-kit';
import { MorphingSquare } from './ui/morphing-square';

export function mergeOrderHistory(
  current: MarketHistory,
  page: MarketHistory & { stale?: boolean },
  older: boolean,
): MarketHistory {
  const orders = new Map(current.myOrders.map((order) => [order.id, order]));
  const trades = new Map(current.trades.map((trade) => [trade.plan.tradeId, trade]));
  for (const order of page.myOrders) {
    const saved = orders.get(order.id);
    if (!saved || (!page.stale && saved.revision <= order.revision)) orders.set(order.id, order);
  }
  for (const trade of page.trades) {
    if (!page.stale || !trades.has(trade.plan.tradeId)) trades.set(trade.plan.tradeId, trade);
  }
  return {
    myOrders: [...orders.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    ),
    trades: [...trades.values()].sort((a, b) => b.plan.createdAt - a.plan.createdAt),
    nextCursor: older || current.myOrders.length === 0 ? page.nextCursor : current.nextCursor,
  };
}

const tradeLabels: Record<TradeStatus, string> = {
  RESERVED: 'Match found',
  PREPARING: 'Preparing',
  AWAITING_APPROVAL: 'Awaiting approval',
  SIGNING: 'Collecting signatures',
  READY_TO_BROADCAST: 'Ready to broadcast',
  BROADCAST: 'Awaiting confirmation',
  RECONCILING: 'Checking settlement',
  CONFIRMED: 'BTC and RGB confirmed',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  UNSUPPORTED: 'Unsupported',
};
const orderLabels: Record<PublicOrder['status'], string> = {
  OPEN: 'Waiting',
  RESERVED: 'Matched',
  FILLED: 'Filled',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

export function OrderHistoryRows({ history }: { history: MarketHistory }) {
  return (
    <ol className="wallet-history-list" aria-label="Your saved orders">
      {history.myOrders.map((order) => {
        const trades = history.trades.filter((trade) =>
          trade.plan.orderRefs.some((ref) => ref.orderId === order.id),
        );
        return (
          <li className="wallet-history-row" key={order.id}>
            <div className="wallet-history-terms">
              <strong>{formatAsset(order.giveAsset, order.giveAmount)}</strong>
              <span aria-label="for at least">→ ≥</span>
              <strong>{formatAsset(order.receiveAsset, order.minReceiveAmount)}</strong>
            </div>
            <StatusBadge className="status-pill">{orderLabels[order.status]}</StatusBadge>
            <div className="wallet-history-meta">
              <time dateTime={new Date(order.createdAt).toISOString()}>
                {new Date(order.createdAt).toLocaleString()}
              </time>
              <span>{order.network}</span>
              <span title={order.id}>
                Order{' '}
                {order.id.length > 20 ? `${order.id.slice(0, 10)}…${order.id.slice(-6)}` : order.id}
              </span>
            </div>
            {trades.map((trade) => (
              <div className="wallet-history-outcome" key={trade.plan.tradeId}>
                <span>
                  {trade.plan.participants.length === 3 ? '3-party ring' : 'Direct swap'} ·{' '}
                  {tradeLabels[trade.status]}
                </span>
                {trade.reason && <p>{trade.reason}</p>}
              </div>
            ))}
          </li>
        );
      })}
    </ol>
  );
}

export function OrderHistory({
  loadPage,
}: {
  loadPage: (cursor?: string) => Promise<MarketHistory & { stale?: boolean }>;
}) {
  const [history, setHistory] = useState<MarketHistory>({
    myOrders: [],
    trades: [],
    nextCursor: null,
  });
  const [request, setRequest] = useState<{ cursor?: string }>({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async (cursor?: string) => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const page = await loadPage(cursor);
        if (active) {
          setHistory((current) => mergeOrderHistory(current, page, cursor !== undefined));
          setLoaded(true);
          setError(Boolean(page.stale));
        }
      } catch {
        if (active) setError(true);
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    void load(request.cursor);
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadPage, request]);

  return (
    <section className="wallet-history" aria-labelledby="wallet-history-heading">
      <SectionTitle
        kicker="SAVED ACTIVITY"
        title="Your order history"
        id="wallet-history-heading"
        action={
          <Button
            className="refresh-button"
            disabled={loading}
            aria-busy={loading}
            onClick={() => setRequest({})}
          >
            {loaded && loading && (
              <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />
            )}
            Refresh history
          </Button>
        }
      />
      <Panel className="panel wallet-history-panel">
        {error && (
          <p className="wallet-history-error" role="status">
            History is temporarily unavailable.{' '}
            {loaded ? 'Showing the last saved history; it may be out of date.' : 'Try refreshing.'}
          </p>
        )}
        {!loaded && loading && (
          <MorphingSquare message="Loading history…" wrapperClassName="wallet-history-note py-8" />
        )}
        {loaded && history.myOrders.length === 0 && (
          <p className="wallet-history-note">No published orders yet.</p>
        )}
        <OrderHistoryRows history={history} />
        {history.nextCursor && (
          <Button
            className="outline-button wallet-history-more"
            disabled={loading}
            aria-busy={loading}
            onClick={() => setRequest({ cursor: history.nextCursor! })}
          >
            {loading && <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />}
            {loading ? 'Loading…' : 'Load older orders'}
          </Button>
        )}
      </Panel>
    </section>
  );
}
