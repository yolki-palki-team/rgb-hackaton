import { useEffect, useState, type ReactNode } from 'react';
import type { MarketHistory, PublicOrder, TradeStatus } from '@rgb-exchange/contracts';
import { formatAsset, orderFillSummary } from '../api';
import { Button, Panel, StatusBadge } from './ui/wallet-kit';
import { MorphingSquare } from './ui/morphing-square';
import type { Trade } from '../model';
import { isFinishedTrade } from '../dashboard';

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

type TradeSelection = { tradeId?: string; orderId?: string; finished?: boolean; version: number };

type HistoryContent = {
  liveTrade?: Trade | null;
  liveContent?: ReactNode;
  request?: TradeSelection;
};

export function OrderHistoryRows({
  history,
  liveTrade,
  liveContent,
  request,
}: { history: MarketHistory } & HistoryContent) {
  // Active orders stay above the archive even after loading older pages.
  const active = (order: PublicOrder) =>
    order.status === 'OPEN' ||
    order.status === 'RESERVED' ||
    history.trades.some(
      (trade) =>
        !isFinishedTrade(trade) && trade.plan.orderRefs.some((ref) => ref.orderId === order.id),
    );
  const orders = [...history.myOrders].sort(
    (a, b) => Number(active(b)) - Number(active(a)) || b.createdAt - a.createdAt,
  );
  return (
    <ol className="wallet-history-list" aria-label="Your saved orders">
      {orders.map((order) => {
        const trades = history.trades.filter((trade) =>
          trade.plan.orderRefs.some((ref) => ref.orderId === order.id),
        );
        const current = trades.some((trade) => trade.plan.tradeId === liveTrade?.id);
        const running = (current && liveTrade && !isFinishedTrade(liveTrade)) || active(order);
        const selected =
          (running || request?.finished !== false) &&
          (request?.orderId === order.id ||
            trades.some((trade) => trade.plan.tradeId === request?.tradeId));
        return (
          <li key={order.id}>
            <details
              className="wallet-history-row"
              key={`${order.id}:${Boolean(running)}:${selected ? request?.version : 0}`}
              open={Boolean(running || selected)}
            >
              <summary className="wallet-history-summary">
                <span className="history-disclosure" aria-hidden="true">
                  ›
                </span>
                <span className="wallet-history-terms">
                  <strong>{formatAsset(order.giveAsset, order.giveAmount)}</strong>
                  <span aria-label="for at least">→ ≥</span>
                  <strong>{formatAsset(order.receiveAsset, order.minReceiveAmount)}</strong>
                </span>
                <StatusBadge className="status-pill">
                  {current && liveTrade && !isFinishedTrade(liveTrade)
                    ? (tradeLabels[liveTrade.status as TradeStatus] ?? liveTrade.status)
                    : order.status === 'OPEN' &&
                        BigInt(order.fillProgress?.filledGiveAmount ?? '0') > 0n
                      ? 'Partially filled'
                      : orderLabels[order.status]}
                </StatusBadge>
                <time dateTime={new Date(order.createdAt).toISOString()}>
                  {new Date(order.createdAt).toLocaleDateString()}
                </time>
              </summary>
              <div className="wallet-history-detail">
                {order.partialFill && (
                  <p className="wallet-history-progress">{orderFillSummary(order)}</p>
                )}
                <div className="wallet-history-meta">
                  <time dateTime={new Date(order.createdAt).toISOString()}>
                    {new Date(order.createdAt).toLocaleString()}
                  </time>
                  <span>{order.network}</span>
                  <span>Order {order.id}</span>
                </div>
                {current && liveContent}
                {trades
                  .filter((trade) => !liveContent || trade.plan.tradeId !== liveTrade?.id)
                  .map((trade) => {
                    const give = trade.plan.legs.find((leg) => leg.fromOwnerId === order.ownerId);
                    const receive = trade.plan.legs.find((leg) => leg.toOwnerId === order.ownerId);
                    const fee = trade.plan.fees.find((entry) => entry.ownerId === order.ownerId);
                    return (
                      <div className="wallet-history-outcome" key={trade.plan.tradeId}>
                        <span>
                          {trade.plan.participants.length > 2
                            ? `${trade.plan.participants.length}-party ring`
                            : 'Direct swap'}{' '}
                          · {tradeLabels[trade.status]}
                        </span>
                        {give && receive && (
                          <p>
                            {order.partialFill ? 'Fill' : 'Swap'} {trade.plan.tradeId} ·{' '}
                            {formatAsset(give.asset, give.amount)} →{' '}
                            {formatAsset(receive.asset, receive.amount)}
                          </p>
                        )}
                        <p>
                          My fee {fee?.feeSats ?? '0'} sats ·{' '}
                          {trade.plan.feeState === 'final' ? 'Final package' : 'Estimated'}
                        </p>
                        <div className="history-transfers">
                          {trade.plan.legs.map((leg, index) => (
                            <p key={index}>
                              {leg.fromOwnerId === order.ownerId
                                ? 'You'
                                : `Participant ${trade.plan.participants.indexOf(leg.fromOwnerId) + 1}`}{' '}
                              →{' '}
                              {leg.toOwnerId === order.ownerId
                                ? 'You'
                                : `Participant ${trade.plan.participants.indexOf(leg.toOwnerId) + 1}`}{' '}
                              <strong>{formatAsset(leg.asset, leg.amount)}</strong>
                            </p>
                          ))}
                        </div>
                        {trade.reason && <p>{trade.reason}</p>}
                      </div>
                    );
                  })}
                {trades.length === 0 && (
                  <p className="wallet-history-note">
                    {order.status === 'OPEN'
                      ? 'Waiting for a compatible order. A match will appear here automatically.'
                      : 'This order ended without a swap.'}
                  </p>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderHistory({
  loadPage,
  liveTrade,
  liveContent,
  request: selection,
}: HistoryContent & {
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
      <div className="history-toolbar">
        <h2 id="wallet-history-heading">Your orders</h2>
        <Button
          className="refresh-button"
          disabled={loading}
          aria-busy={loading}
          onClick={() => setRequest({})}
        >
          {loaded && loading && (
            <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />
          )}
          Refresh
        </Button>
      </div>
      {liveTrade &&
        !history.myOrders.some((order) =>
          history.trades.some(
            (trade) =>
              trade.plan.tradeId === liveTrade.id &&
              trade.plan.orderRefs.some((ref) => ref.orderId === order.id),
          ),
        ) && (
          <details
            className="wallet-history-row live-trade-fallback"
            key={`${liveTrade.id}:${isFinishedTrade(liveTrade)}:${selection?.tradeId === liveTrade.id ? selection.version : 0}`}
            open={
              !isFinishedTrade(liveTrade) ||
              (selection?.tradeId === liveTrade.id && selection.finished !== false)
            }
          >
            <summary className="wallet-history-summary">
              <span className="history-disclosure" aria-hidden="true">
                ›
              </span>
              <strong>{liveTrade.status === 'CONFIRMED' ? 'Swap complete' : 'Current swap'}</strong>
              <StatusBadge>
                {tradeLabels[liveTrade.status as TradeStatus] ?? liveTrade.status}
              </StatusBadge>
            </summary>
            <div className="wallet-history-detail">{liveContent}</div>
          </details>
        )}
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
        <OrderHistoryRows
          history={history}
          liveTrade={liveTrade}
          liveContent={liveContent}
          request={selection}
        />
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
