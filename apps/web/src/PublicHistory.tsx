import { useEffect, useState } from 'react';
import {
  networkLabel,
  type PublicMarketHistory,
  type PublicMarketOrder,
} from '@rgb-exchange/contracts';
import { getPublicHistory } from './api';
import { MorphingSquare } from './components/ui/morphing-square';
import {
  assetIdentity,
  formatAsset,
  mergeHistory,
  orderFillSummary,
  orderStatusLabel,
  executionLabels,
  shortId,
} from './model';

export function PublicHistory({ activity }: { activity: PublicMarketOrder[] }) {
  const [history, setHistory] = useState<PublicMarketHistory>({ orders: [], nextCursor: null });
  const [request, setRequest] = useState<{ cursor?: string }>({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHistory((current) => {
      const saved = new Map(current.orders.map((entry) => [entry.order.id, entry]));
      const orders = activity.filter((entry) => {
        const previous = saved.get(entry.order.id);
        return (
          previous &&
          ['OPEN', 'RESERVED'].includes(previous.order.status) &&
          entry.order.revision >= previous.order.revision
        );
      });
      return orders.length
        ? mergeHistory(current, { orders, nextCursor: current.nextCursor }, false)
        : current;
    });
  }, [activity]);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async (cursor?: string) => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const page = await getPublicHistory(cursor);
        if (active) {
          setHistory((current) => mergeHistory(current, page, cursor !== undefined));
          setLoaded(true);
          setError(null);
        }
      } catch {
        if (active) setError('History is temporarily unavailable.');
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
  }, [request]);

  return (
    <section className="public-history" aria-labelledby="history-heading">
      <div className="history-heading">
        <div>
          <h2 id="history-heading">Order history</h2>
          <p>All published orders, including cancelled, expired and unsuccessful swaps.</p>
        </div>
        <button
          className="refresh-button"
          disabled={loading}
          aria-busy={loading}
          onClick={() => setRequest({})}
          type="button"
        >
          {loaded && loading && (
            <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />
          )}
          Refresh history
        </button>
      </div>
      {error && (
        <p className="market-stale" role="status">
          {error}{' '}
          {loaded ? 'Showing the last saved history; it may be out of date.' : 'Try refreshing.'}
        </p>
      )}
      {!loaded && loading && <MorphingSquare message="Loading history…" wrapperClassName="py-8" />}
      {loaded && history.orders.length === 0 && (
        <p className="execution-note">No published orders yet.</p>
      )}
      <ol className="history-list" aria-label="Published order history">
        {history.orders.map((entry) => (
          <li className="history-row" key={entry.order.id}>
            <div className="history-terms">
              <strong title={assetIdentity(entry.order.giveAsset)}>
                {formatAsset(entry.order.giveAsset, entry.order.giveAmount)}
              </strong>
              <span aria-label="for at least">→ ≥</span>
              <strong title={assetIdentity(entry.order.receiveAsset)}>
                {formatAsset(entry.order.receiveAsset, entry.order.minReceiveAmount)}
              </strong>
            </div>
            <span className="history-status">{orderStatusLabel(entry)}</span>
            {entry.order.partialFill && (
              <p className="history-fill-progress">
                {orderFillSummary(entry.order)} · {entry.order.fillProgress?.fillCount ?? 0}{' '}
                completed {entry.order.fillProgress?.fillCount === 1 ? 'fill' : 'fills'}
              </p>
            )}
            <div className="history-meta">
              <time dateTime={new Date(entry.order.createdAt).toISOString()}>
                {new Date(entry.order.createdAt).toLocaleString()}
              </time>
              <span>{networkLabel(entry.order.network)}</span>
              <span title={entry.order.id}>Order {shortId(entry.order.id)}</span>
              {entry.execution && (
                <span>
                  {entry.execution.participants === 3 ? '3-party ring' : 'Direct swap'}
                  {entry.order.partialFill
                    ? ` · Latest fill: ${executionLabels[entry.execution.status]}`
                    : ''}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      {history.nextCursor && (
        <button
          className="outline-button history-more"
          disabled={loading}
          aria-busy={loading}
          onClick={() => setRequest({ cursor: history.nextCursor! })}
          type="button"
        >
          {loading && <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />}
          {loading ? 'Loading…' : 'Load older orders'}
        </button>
      )}
    </section>
  );
}
