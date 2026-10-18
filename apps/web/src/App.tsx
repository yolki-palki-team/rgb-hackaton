import { useEffect, useMemo, useState } from 'react';
import { assetKey, type PublicMarketOrder } from '@rgb-exchange/contracts';
import VideoHero from '@/components/ui/video-hero';
import SiteHeader from '@/components/ui/site-header';
import { DEMO_URL } from './links';
import HalftoneWordmarkFooter from '@/components/ui/halftone-wordmark-footer';
import { getPublicActivity } from './api';
import { MorphingSquare } from './components/ui/morphing-square';
import {
  assetIdentity,
  formatAsset,
  shortId,
  executionLabels,
  executionStep,
  marketLoadFailed,
  orderFillSummary,
  orderStatusLabel,
  type MarketState,
} from './model';

const marketPath = '/market';

function Landing() {
  return (
    <div className="public-site landing-page">
      <VideoHero />
      <SiteFooter />
    </div>
  );
}

function OrderCard({ entry }: { entry: PublicMarketOrder }) {
  const { order, execution } = entry;
  const step = execution ? executionStep(execution.status) : null;
  const finished =
    execution &&
    ['CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'UNSUPPORTED'].includes(execution.status);
  const tone = order.partialFill
    ? order.status === 'OPEN'
      ? 'waiting'
      : order.status === 'RESERVED'
        ? 'executing'
        : 'finished'
    : !execution
      ? 'waiting'
      : finished
        ? 'finished'
        : 'executing';
  return (
    <article className={`order-card order-card--${tone}`}>
      <div className="order-card-top">
        <span className="order-network">{order.network.toUpperCase()}</span>
        <span className="order-open">
          <span aria-hidden="true" />{' '}
          {order.partialFill
            ? orderStatusLabel(entry)
            : execution
              ? executionLabels[execution.status]
              : 'Open order'}
        </span>
      </div>
      <div className="order-pair">
        <span>{order.giveAsset.symbol}</span>
        <span className="pair-arrow" aria-hidden="true">
          →
        </span>
        <span>{order.receiveAsset.symbol}</span>
      </div>
      <div className="order-amounts">
        <div>
          <span>{order.partialFill ? 'Total offer' : 'Giving'}</span>
          <strong>{formatAsset(order.giveAsset, order.giveAmount)}</strong>
          <small>{assetIdentity(order.giveAsset)}</small>
        </div>
        <div>
          <span>{order.partialFill ? 'Total receive at least' : 'Receive at least'}</span>
          <strong>{formatAsset(order.receiveAsset, order.minReceiveAmount)}</strong>
          <small>{assetIdentity(order.receiveAsset)}</small>
        </div>
      </div>
      {order.partialFill && (
        <p className="order-fill-progress">
          {orderFillSummary(order)}
          <br />
          Minimum fill {formatAsset(order.giveAsset, order.partialFill.minGiveAmount)}
        </p>
      )}
      {execution && (
        <div className="order-execution">
          <div className="execution-heading">
            <strong>
              {order.partialFill ? 'Fill · ' : ''}
              {executionLabels[execution.status]}
            </strong>
            <span>{execution.participants === 3 ? '3-party ring' : 'Direct swap'}</span>
          </div>
          {step !== null && (
            <ol className="execution-steps" aria-label="Swap progress">
              {['Prepare', 'Approval', 'Signatures', 'Confirmation'].map((label, index) => (
                <li
                  key={label}
                  className={index < step ? 'complete' : index === step ? 'current' : ''}
                  aria-current={index === step ? 'step' : undefined}
                >
                  {label}
                </li>
              ))}
            </ol>
          )}
          {execution.status === 'CONFIRMED' && (
            <small>
              {order.partialFill
                ? 'This fill was confirmed by both wallets.'
                : 'Confirmed by all participant wallets.'}
            </small>
          )}
        </div>
      )}
      <div className="order-card-bottom">
        <span>Order {shortId(order.id)}</span>
      </div>
    </article>
  );
}

function Market() {
  const [state, setState] = useState<MarketState>({ kind: 'loading', orders: [] });
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [retry, setRetry] = useState(0);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      setRefreshing(true);
      try {
        const orders = await getPublicActivity();
        if (active) setState({ kind: 'ready', orders, updatedAt: Date.now() });
      } catch (error) {
        if (active)
          setState((current) =>
            marketLoadFailed(
              current,
              error instanceof Error && error.message.startsWith('Market')
                ? error.message
                : 'Could not load public orders.',
            ),
          );
      } finally {
        pending = false;
        if (active) setRefreshing(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 5_000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [retry]);

  const assets = useMemo(
    () =>
      [
        ...new Map(
          state.orders
            .flatMap(({ order }) => [order.giveAsset, order.receiveAsset])
            .map((asset) => [assetKey(asset), asset] as const),
        ).entries(),
      ].sort((a, b) => a[1].symbol.localeCompare(b[1].symbol)),
    [state.orders],
  );
  const visibleOrders =
    assetFilter === 'all'
      ? state.orders
      : state.orders.filter(
          ({ order }) =>
            assetKey(order.giveAsset) === assetFilter ||
            assetKey(order.receiveAsset) === assetFilter,
        );

  return (
    <div className="public-site market-page">
      <SiteHeader active="market" />
      <main>
        <section className="market-content page-container" aria-labelledby="orderbook-heading">
          <div className="book-heading">
            <div>
              <span className="section-index">PUBLIC MARKET</span>
              <h1 id="orderbook-heading">Order book</h1>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              aria-label="Refresh orders"
              disabled={refreshing}
              aria-busy={refreshing}
            >
              {refreshing ? (
                <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />
              ) : (
                <span aria-hidden="true">↻</span>
              )}{' '}
              Refresh
            </button>
          </div>
          <div>
            <div className="filter-row" role="group" aria-label="Filter by asset">
              <button
                type="button"
                className={assetFilter === 'all' ? 'active' : ''}
                onClick={() => setAssetFilter('all')}
              >
                All assets
              </button>
              {assets.map(([key, asset]) => (
                <button
                  type="button"
                  key={key}
                  className={assetFilter === key ? 'active' : ''}
                  onClick={() => setAssetFilter(key)}
                  title={assetIdentity(asset)}
                >
                  {asset.symbol}
                  {asset.kind === 'rgb' ? ` · ${shortId(asset.contractId)}` : ''}
                </button>
              ))}
            </div>
            {state.kind === 'loading' && (
              <div className="market-message" role="status">
                <MorphingSquare wrapperClassName="mb-6" aria-hidden="true" />
                <h3>Loading orders</h3>
                <p>Fetching the public order book.</p>
              </div>
            )}
            {state.kind === 'error' && state.orders.length === 0 && (
              <div className="market-message error" role="alert">
                <span className="message-symbol" aria-hidden="true">
                  !
                </span>
                <h3>Could not open market</h3>
                <p>{state.message}</p>
                <button
                  type="button"
                  className="dark-button"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Try again
                </button>
              </div>
            )}
            {state.kind === 'error' && state.orders.length > 0 && (
              <p className="market-stale" role="status">
                {state.message} Showing the last loaded orders; they may be out of date.
              </p>
            )}
            {state.kind === 'ready' && state.orders.length === 0 && (
              <div className="market-message" role="status">
                <span className="message-symbol" aria-hidden="true">
                  ◌
                </span>
                <h3>No orders yet</h3>
              </div>
            )}
            {state.kind === 'ready' && state.orders.length > 0 && visibleOrders.length === 0 && (
              <div className="market-message" role="status">
                <h3>No orders for this asset</h3>
                <p>Choose another asset or show all orders.</p>
                <button
                  className="outline-button"
                  type="button"
                  onClick={() => setAssetFilter('all')}
                >
                  All assets
                </button>
              </div>
            )}
            {state.kind === 'ready' && visibleOrders.length > 0 && (
              <p className="execution-note">
                Live wallet-reported progress · Updates every 5 seconds
              </p>
            )}
            {state.kind !== 'loading' && visibleOrders.length > 0 && (
              <div className="order-list">
                {visibleOrders.map((entry) => (
                  <OrderCard key={entry.order.id} entry={entry} />
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteFooter() {
  return (
    <HalftoneWordmarkFooter
      wordmark="pálka"
      label="pálka A2A Exchange"
      meta="Bitcoin + RGB · Agent-to-agent market"
      palette={{ background: '#080808', ink: '#eeeeee', warm: '#aaaaaa' }}
      columns={[
        {
          title: 'Explore',
          links: [
            { label: 'Market', href: marketPath },
            { label: 'Home', href: '/' },
            { label: 'Demo', href: DEMO_URL },
          ],
        },
        {
          title: 'Learn',
          links: [
            { label: 'RGB Protocol', href: 'https://docs.rgb.info/' },
            { label: 'QVAC', href: 'https://docs.qvac.tether.io/quickstart/' },
          ],
        },
      ]}
    />
  );
}

export default function App() {
  return window.location.pathname === marketPath ? <Market /> : <Landing />;
}
