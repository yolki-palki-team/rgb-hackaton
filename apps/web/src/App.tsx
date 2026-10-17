import { useEffect, useMemo, useState } from 'react';
import { assetKey, type PublicOrder } from '@rgb-exchange/contracts';
import VideoHero from '@/components/ui/video-hero';
import SiteHeader from '@/components/ui/site-header';
import HalftoneWordmarkFooter from '@/components/ui/halftone-wordmark-footer';
import { MatrixRain } from '@/components/ui/matrix-rain';
import { getPublicHealth, getPublicOrders } from './api';
import { assetIdentity, desktopOfferUrl, formatAsset, shortId, type MarketState } from './model';

import { walletUrl } from './wallet-url';

const marketPath = '/market';

function WalletLink({
  className = '',
  children = 'Open local wallet',
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a className={className} href={walletUrl} target="_blank" rel="noopener noreferrer">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

function StatusPill({ live }: { live: boolean | null }) {
  return (
    <span
      className={`status-pill ${live === true ? 'is-live' : live === false ? 'is-offline' : ''}`}
      role="status"
    >
      <span className="status-dot" />
      {live === null ? 'Checking connection' : live ? 'Market online' : 'Market offline'}
    </span>
  );
}

function SiteRain() {
  return (
    <MatrixRain
      className="site-rain"
      background="#080808"
      color="#b5b5b5"
      highlight="#eeeeee"
      density={0.55}
      fontSize={18}
      glow={1}
      speed={0.65}
    />
  );
}

function Landing() {
  return (
    <div className="public-site landing-page">
      <VideoHero />
      <SiteFooter />
    </div>
  );
}

function OrderCard({
  order,
  selected,
  onSelect,
}: {
  order: PublicOrder;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`order-card ${selected ? 'selected' : ''}`}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="order-card-top">
        <span className="order-network">{order.network.toUpperCase()}</span>
        <span className="order-open">
          <span /> Open
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
          <span>Giving</span>
          <strong>{formatAsset(order.giveAsset, order.giveAmount)}</strong>
          <small>{assetIdentity(order.giveAsset)}</small>
        </div>
        <div>
          <span>Receive at least</span>
          <strong>{formatAsset(order.receiveAsset, order.minReceiveAmount)}</strong>
          <small>{assetIdentity(order.receiveAsset)}</small>
        </div>
      </div>
      <div className="order-card-bottom">
        <span>Order {shortId(order.id)}</span>
        <span aria-hidden="true">↗</span>
      </div>
    </button>
  );
}

function OrderDetails({ order }: { order: PublicOrder }) {
  const desktopUrl = desktopOfferUrl(order.id);
  const expires = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(order.expiresAt);
  return (
    <aside className="order-detail" aria-label="Order details">
      <div className="detail-heading">
        <div>
          <span className="section-index">ORDER DETAILS</span>
          <h2>
            {order.giveAsset.symbol} <span>→</span> {order.receiveAsset.symbol}
          </h2>
        </div>
        <span className="detail-open">Open</span>
      </div>
      <p className="detail-intro">
        This is a participant's public intent. Balance checks, plan approval and signing require a
        local wallet.
      </p>
      <dl className="detail-terms">
        <div>
          <dt>Gives</dt>
          <dd>{formatAsset(order.giveAsset, order.giveAmount)}</dd>
        </div>
        <div>
          <dt>Receives at least</dt>
          <dd>{formatAsset(order.receiveAsset, order.minReceiveAmount)}</dd>
        </div>
        <div>
          <dt>Maximum fee</dt>
          <dd>{BigInt(order.maxFeeSats).toLocaleString('en-US')} sats</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{expires}</dd>
        </div>
      </dl>
      <div className="identity-block">
        <span>ASSET IDENTITY</span>
        <div>
          <small>Gives</small>
          <code>{assetIdentity(order.giveAsset)}</code>
          <small>Precision: {order.giveAsset.precision} decimal places</small>
        </div>
        <div>
          <small>Receives</small>
          <code>{assetIdentity(order.receiveAsset)}</code>
          <small>Precision: {order.receiveAsset.precision} decimal places</small>
        </div>
      </div>
      <div className="detail-meta">
        <span>Order ID</span>
        <code>{order.id}</code>
        <span>Participant</span>
        <code>{order.ownerId}</code>
      </div>
      <div className="order-wallet-actions">
        {desktopUrl && (
          <a className="dark-button" href={desktopUrl}>
            Open offer in palka. desktop <span aria-hidden="true">↗</span>
          </a>
        )}
        <WalletLink className="outline-button">Open browser wallet</WalletLink>
      </div>
      <p className="detail-footnote">
        This public site never accesses keys, private preferences or wallet state.
      </p>
    </aside>
  );
}

function Market() {
  const [state, setState] = useState<MarketState>({ kind: 'loading', orders: [] });
  const [live, setLive] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = false;
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const orders = await getPublicOrders();
        if (active) setState({ kind: 'ready', orders, updatedAt: Date.now() });
      } catch (error) {
        if (active)
          setState({
            kind: 'error',
            orders: [],
            message:
              error instanceof Error && error.message.startsWith('Market')
                ? error.message
                : 'Could not load public orders.',
          });
      } finally {
        pending = false;
      }
      try {
        await getPublicHealth();
        if (active) setLive(true);
      } catch {
        if (active) setLive(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
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
            .flatMap((order) => [order.giveAsset, order.receiveAsset])
            .map((asset) => [assetKey(asset), asset] as const),
        ).entries(),
      ].sort((a, b) => a[1].symbol.localeCompare(b[1].symbol)),
    [state.orders],
  );
  const visibleOrders =
    assetFilter === 'all'
      ? state.orders
      : state.orders.filter(
          (order) =>
            assetKey(order.giveAsset) === assetFilter ||
            assetKey(order.receiveAsset) === assetFilter,
        );
  const selected = state.orders.find((order) => order.id === selectedId) ?? null;

  return (
    <div className="public-site market-page">
      <SiteRain />
      <SiteHeader active="market" />
      <main>
        <section className="market-hero">
          <div className="page-container">
            <div className="market-topline">
              <span className="section-index">EXCHANGE palka. / 01</span>
              <StatusPill live={live} />
            </div>
            <div className="market-headline">
              <div>
                <h1>
                  Open <em>orders.</em>
                </h1>
                <p>
                  Explore public BTC and RGB exchange intents. Matching and settlement are checked
                  separately in a local wallet.
                </p>
              </div>
              <WalletLink className="market-wallet-cta">My local wallet</WalletLink>
            </div>
            <div className="market-note">
              <span className="note-symbol" aria-hidden="true">
                ↗
              </span>
              <p>
                Only open orders appear here. Balances, private limits, matched trades and
                signatures stay outside the public site.
              </p>
            </div>
          </div>
        </section>
        <section className="market-content page-container" aria-labelledby="orderbook-heading">
          <div className="book-heading">
            <div>
              <span className="section-index">PUBLIC MARKET</span>
              <h2 id="orderbook-heading">
                Order book{' '}
                <span>
                  {state.kind === 'ready' ? String(state.orders.length).padStart(2, '0') : '—'}
                </span>
              </h2>
            </div>
            <button
              className="refresh-button"
              type="button"
              onClick={() => setRetry((value) => value + 1)}
              aria-label="Refresh orders"
            >
              <span aria-hidden="true">↻</span> Refresh
            </button>
          </div>
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
              <span className="message-symbol" aria-hidden="true">
                ◌
              </span>
              <h3>Loading orders</h3>
              <p>Fetching the public order book.</p>
            </div>
          )}
          {state.kind === 'error' && (
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
          {state.kind === 'ready' && state.orders.length === 0 && (
            <div className="market-message" role="status">
              <span className="message-symbol" aria-hidden="true">
                ◌
              </span>
              <h3>No open orders yet</h3>
              <p>New offers appear here after publication from a local wallet.</p>
              <WalletLink className="outline-button">Open local wallet</WalletLink>
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
            <div className="book-layout">
              <div className="order-list">
                {visibleOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    selected={selectedId === order.id}
                    onSelect={() => setSelectedId(order.id)}
                  />
                ))}
              </div>
              {selected ? (
                <OrderDetails order={selected} />
              ) : (
                <aside className="detail-placeholder">
                  <div className="placeholder-art" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="section-index">DETAILS</span>
                  <h2>Select an order.</h2>
                  <p>See exact amounts, RGB contract IDs and expiry.</p>
                </aside>
              )}
            </div>
          )}
        </section>
        <section className="market-bottom page-container">
          <div>
            <span className="section-index">HOW TRADES WORK</span>
            <h2>From order to plan.</h2>
          </div>
          <p>
            The engine finds direct pairs or compatible three-party rings. Matching is available;
            BTC/RGB settlement requires a compatible local wallet adapter.
          </p>
          <WalletLink className="text-link">Open local wallet</WalletLink>
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
          ],
        },
        { title: 'Wallet', links: [{ label: 'Local wallet', href: walletUrl }] },
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
