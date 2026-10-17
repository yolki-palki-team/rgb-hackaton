import { ChatInput, ChatInputTextArea, ChatInputSubmit } from './components/ui/chat-input';
import {
  AssetCard,
  Button,
  Icon,
  Input,
  Panel,
  Select,
  SectionTitle,
  StatusBadge,
} from './components/ui/wallet-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FundingPanel } from './FundingPanel';
import { initialDraft, sampleBalances, sampleOrders, sampleTrades } from './model';
import type { AssetCode, Balance, Draft, Order, Trade, View } from './model';
import { LocalClient, type ClientStatus } from './api';
import { TradeWorkflow, tradeProgress } from './workflow';
import type { PrivatePolicy } from '@rgb-exchange/contracts';

const sampleAssetCodes: AssetCode[] = ['BTC', 'X', 'DUSD'];
const navItems: { key: View; label: string; subtitle: string; icon: string }[] = [
  { key: 'home', label: 'Overview', subtitle: 'Balances and goal', icon: 'grid' },
  { key: 'market', label: 'Market', subtitle: 'Orders', icon: 'arrows' },
  { key: 'trade', label: 'Trade', subtitle: 'Review and sign', icon: 'route' },
];

function App() {
  const [view, setView] = useState<View>('home');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [pairToken, setPairToken] = useState('');
  const [client, setClient] = useState<LocalClient | null>(null);
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [myOrder, setMyOrder] = useState<Order | null>(null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [policy, setPolicy] = useState<PrivatePolicy | null>(null);
  const [policyAssets, setPolicyAssets] = useState<{ key: string; label: string }[]>([]);
  const [sampleTradeKind, setSampleTradeKind] = useState<'direct' | 'ring'>('ring');
  const [samplePreview, setSamplePreview] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const desktopConnectStarted = useRef(false);
  const [goal, setGoal] = useState('');
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [draftOpen, setDraftOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const workflow = useRef(new TradeWorkflow());
  const foregroundBusy = useRef(busy);
  foregroundBusy.current = busy;
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowPaused, setWorkflowPaused] = useState(false);
  const connected = Boolean(client && status);
  const desktop = Boolean(window.palkaWallet);
  const isMock = status?.mode === 'mock';
  const ready = connected && !syncError && balances.length > 0;
  const visibleBalances = connected ? balances : samplePreview ? sampleBalances : [];
  const visibleOrders = connected ? orders : samplePreview ? sampleOrders : [];
  const assetCodes = connected
    ? balances.map((balance) => balance.code)
    : samplePreview
      ? sampleAssetCodes
      : [];

  useEffect(() => {
    if (!notice || notice.tone === 'error') return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const connect = useCallback(async () => {
    setBusy('connect');
    setNotice(null);
    try {
      const next = new LocalClient(desktop ? undefined : pairToken);
      const health = await next.connect();
      setClient(next);
      setStatus(health);
      setConnectionOpen(false);
      setSamplePreview(false);
      setSyncError(null);
      setBalances([]);
      setOrders([]);
      setMyOrder(null);
      setTrade(null);
      setPolicy(null);
      setPolicyAssets([]);
      workflow.current = new TradeWorkflow();
      setPairToken('');
      setNotice({
        tone: 'success',
        text: `Welcome back. Your ${health.network} wallet is connected.`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: `Could not connect: ${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  }, [desktop, pairToken]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let healthChecked = 0;
    const refresh = async () => {
      try {
        if (foregroundBusy.current) return;
        const data = await client.snapshot();
        if (!active || foregroundBusy.current) return;
        setBalances(data.balances);
        setOrders(data.orders);
        setMyOrder(data.myOrder);
        setTrade(data.trade);
        setPolicy((current) => current ?? data.policy);
        setPolicyAssets(data.policyAssets);
        setSyncError(data.walletError ?? null);
        const codes = data.balances.map((balance) => balance.code);
        if (codes.length >= 2)
          setDraft((current) =>
            codes.includes(current.giveAsset) && codes.includes(current.receiveAsset)
              ? current
              : { ...current, giveAsset: codes[0], receiveAsset: codes[1] },
          );
        if (Date.now() - healthChecked > 30_000) {
          const health = await client.connect();
          if (!active) return;
          setStatus(health);
          healthChecked = Date.now();
        }
        if (data.trade && !foregroundBusy.current && client.supportsTrade(data.trade)) {
          // Recovery must continue even while the RGB balance index is catching up.
          setWorkflowRunning(true);
          const checked = await workflow.current.advance(client, data.trade);
          if (!active) return;
          if (checked)
            setTrade((current) =>
              current && current.id === data.trade?.id
                ? { ...current, validatedPreview: checked }
                : current,
            );
          setWorkflowError(workflow.current.error);
          setWorkflowPaused(workflow.current.paused);
        }
      } catch (error) {
        // Retain the last view but disable actions until fresh wallet data arrives.
        if (active) setSyncError(messageOf(error));
      } finally {
        if (active) {
          setWorkflowRunning(false);
          // Schedule from completion: native wallet calls must never overlap.
          timer = setTimeout(() => void refresh(), 3000);
        }
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client]);

  useEffect(() => {
    if (!desktop || desktopConnectStarted.current) return;
    desktopConnectStarted.current = true;
    void connect();
  }, [desktop, connect]);

  useEffect(() => {
    if (!desktop) return;
    const bridge = window.palkaWallet!;
    let active = true;
    const selectOffer = (orderId: string) => {
      if (active) {
        setSelectedOfferId(orderId);
        setView('market');
      }
    };
    const unsubscribe = bridge.onOfferSelected(selectOffer);
    void bridge
      .getPendingOffer()
      .then((orderId) => {
        if (orderId) selectOffer(orderId);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  const disconnect = () => {
    setClient(null);
    setStatus(null);
    setBalances([]);
    setOrders([]);
    setMyOrder(null);
    setTrade(null);
    setPolicy(null);
    setPolicyAssets([]);
    workflow.current = new TradeWorkflow();
    setSyncError(null);
    setNotice({ tone: 'info', text: 'Local wallet disconnected.' });
  };

  const interpret = async () => {
    if (!client) {
      setNotice({
        tone: 'info',
        text: 'Pair a local wallet to interpret a goal. Sample preview does not run QVAC.',
      });
      return;
    }
    if (!status?.qvacAvailable) {
      setDraftOpen(true);

      setNotice({
        tone: 'info',
        text: `QVAC unavailable: ${status?.qvacReason ?? 'The local model is not ready.'} Use the manual form.`,
      });
      return;
    }
    setBusy('interpret');
    setNotice(null);
    try {
      const result = await client.interpret(goal);
      if (result.draft) setDraft(result.draft);
      setPolicy(result.policy);
      setDraftOpen(true);

      setNotice(
        result.draft
          ? {
              tone: 'success',
              text: 'QVAC interpreted the goal locally. Review and confirm the order terms.',
            }
          : {
              tone: 'info',
              text:
                result.clarification ?? 'The goal needs clarification. Fill in the terms manually.',
            },
      );
    } catch (error) {
      setDraftOpen(true);
      setNotice({
        tone: 'error',
        text: `QVAC unavailable: ${messageOf(error)}. Use the manual form.`,
      });
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!client || !ready || !policy) return;
    setBusy('publish');
    setNotice(null);
    try {
      validateDraftShape(draft, policy);
      await client.checkDraft(draft, policy);
      const order = await client.publishDraft(draft, policy);
      setMyOrder(order);
      setDraftOpen(false);
      setView('market');
      setNotice({
        tone: 'success',
        text: 'Order published. We’ll let you know when a match is ready.',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  const cancelOrder = async () => {
    if (!client || !myOrder) return;
    setBusy('cancel');
    try {
      await client.cancelOrder(myOrder.id);
      setMyOrder(null);
      setNotice({ tone: 'info', text: 'Order canceled.' });
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!client || !trade?.validatedPreview) return;
    setBusy('approve');
    setNotice(null);
    const digest = trade.validatedPreview.digest;
    const tradeId = trade.id;
    foregroundBusy.current = 'approve';
    setTrade((current) =>
      current?.id === tradeId ? { ...current, validatedPreview: undefined } : current,
    );
    try {
      await client.approve(tradeId, digest);
      setNotice({
        tone: 'info',
        text: 'Approval saved. We’ll follow the swap through to completion for you.',
      });
    } catch (error) {
      setNotice({
        tone: 'info',
        text: messageOf(error).includes('Signing was not approved')
          ? 'Signing cancelled. You can review the swap again when you’re ready.'
          : 'Checking your signing result automatically. Your wallet will only continue with a saved approval.',
      });
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!client || !trade) return;
    setBusy('reject');
    foregroundBusy.current = 'reject';
    setNotice(null);
    try {
      await client.reject(trade.id);
      setNotice({ tone: 'info', text: 'Trade rejected before signing.' });
    } catch (error) {
      setNotice({ tone: 'error', text: messageOf(error) });
    } finally {
      setBusy(null);
    }
  };

  const shownTrade = trade ?? (!connected && samplePreview ? sampleTrades[sampleTradeKind] : null);

  return (
    <div className="app-shell">
      <div className="main-area">
        <header className="topbar">
          <button className="site-brand" onClick={() => setView('home')} aria-label="palka. home">
            palka.
          </button>
          <nav className="site-nav" aria-label="Wallet navigation">
            {navItems.map((item) => (
              <button
                key={item.key}
                aria-current={view === item.key ? 'page' : undefined}
                onClick={() => setView(item.key)}
              >
                {item.label}
                {item.key === 'trade' && trade?.validatedPreview && <span className="nav-dot" />}
              </button>
            ))}
          </nav>
          <div className="top-actions">
            {desktop ? (
              <Button
                className="text-button"
                type="button"
                onClick={() => void window.palkaWallet?.openPublicMarket()}
              >
                Public market
              </Button>
            ) : (
              <a
                className="text-button"
                href="http://127.0.0.1:5173/market"
                target="_blank"
                rel="noopener noreferrer"
              >
                Public market
              </a>
            )}
            <StatusBadge className="network-pill">
              {connected && <span className="live-dot" />}
              {connected ? `BITCOIN ${status?.network.toUpperCase()}` : 'NETWORK UNAVAILABLE'}
            </StatusBadge>
            <Button
              className={`wallet-button ${connected ? 'connected' : ''}`}
              type="button"
              onClick={() => setConnectionOpen(true)}
            >
              <Icon name="wallet" size={17} />
              {connected
                ? `Wallet ${status?.walletLabel ?? 'connected'}`
                : desktop
                  ? 'Backend unavailable'
                  : 'Pair local wallet'}
            </Button>
          </div>
        </header>
        <main className="content">
          <div className={`mode-banner ${connected && !isMock ? 'real' : 'mock'}`} role="status">
            <Icon name="info" size={17} />
            <div>
              <strong>
                {!connected
                  ? samplePreview
                    ? 'Sample preview · disconnected'
                    : 'Local wallet unavailable'
                  : syncError
                    ? 'Reconnecting to your wallet'
                    : isMock
                      ? 'Mock wallet connected'
                      : 'Real local wallet connected'}
              </strong>
              <span>
                {!connected
                  ? samplePreview
                    ? 'Synthetic balances and plans are shown for UI preview only. Trading and signing are unavailable.'
                    : 'Pair the local wallet to load balances, network, orders, and QVAC status.'
                  : syncError
                    ? 'We’re refreshing your wallet data. New orders and signatures will be available once the connection is restored.'
                    : isMock
                      ? 'Demo wallet: matching works, BTC/RGB signing and broadcast are unsupported.'
                      : 'Your keys stay on this device. You decide when to sign.'}
              </span>
              {syncError && (
                <details className="technical-details">
                  <summary>Connection details</summary>
                  <p>{syncError}</p>
                </details>
              )}
            </div>
            {!connected && (
              <Button
                className="text-button sample-action"
                type="button"
                onClick={() => setSamplePreview((current) => !current)}
              >
                {samplePreview ? 'Exit sample preview' : 'Preview sample data'}
              </Button>
            )}
          </div>
          {notice && (
            <div className={`notice ${notice.tone}`} role="alert">
              <span>{notice.text}</span>
              <Button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
                <Icon name="close" size={15} />
              </Button>
            </div>
          )}

          {trade &&
            view !== 'trade' &&
            !['CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED'].includes(trade.status) && (
              <button className="trade-notification" onClick={() => setView('trade')}>
                <span>
                  <strong>{tradeProgress(trade).title}</strong>
                  <small>
                    {trade.kind === 'ring' ? 'Three-party ring' : 'Direct swap'} · View your swap
                  </small>
                </span>
                <Icon name="arrow" size={20} />
              </button>
            )}
          {view === 'home' && (
            <>
              <section className="goal-section" aria-labelledby="goal-heading">
                <div className="composer-heading">
                  <h1 id="goal-heading">What would you like to swap?</h1>
                  <StatusBadge className="ai-status">
                    QVAC · {status?.qvacAvailable ? 'LOCAL' : connected ? 'UNAVAILABLE' : 'OFFLINE'}
                  </StatusBadge>
                </div>
                {connected && !status?.qvacAvailable && (
                  <p className="qvac-reason" role="status">
                    {status?.qvacReason ?? 'Local model unavailable.'} Use the manual form.
                  </p>
                )}
                <ChatInput
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  onSubmit={() => void interpret()}
                  loading={busy === 'interpret'}
                  disabled={busy !== null || !connected}
                  rows={2}
                >
                  <ChatInputTextArea
                    id="goal"
                    aria-label="Describe your swap and limits"
                    aria-describedby="goal-help"
                    placeholder="What would you give, and what would you like in return?"
                  />
                  <div className="composer-actions">
                    <Button
                      className="text-button"
                      disabled={busy !== null}
                      onClick={() => {
                        if (connected || samplePreview) setDraftOpen(true);
                        else
                          setNotice({
                            tone: 'info',
                            text: 'Pair a local wallet before creating an order.',
                          });
                      }}
                    >
                      Fill in manually
                    </Button>
                    <ChatInputSubmit />
                  </div>
                </ChatInput>
                <p className="composer-help" id="goal-help">
                  Private on this device. Review terms before publishing; signing needs your
                  approval.
                </p>
              </section>
              <FundingPanel client={client} wallet={status} />
              <section aria-labelledby="balance-heading">
                <SectionTitle
                  id="balance-heading"
                  kicker="YOUR WALLET"
                  title="Your assets"
                  action={
                    <span className="section-note">
                      {connected
                        ? 'Local wallet balances'
                        : samplePreview
                          ? 'Synthetic preview'
                          : 'Unavailable'}
                    </span>
                  }
                />
                {visibleBalances.length ? (
                  <div className="balance-grid">
                    {visibleBalances.map((balance) => (
                      <AssetCard key={balance.code} balance={balance} />
                    ))}
                  </div>
                ) : (
                  <p className="empty-state" role="status">
                    {connected
                      ? syncError
                        ? 'Wallet balances are unavailable. Check the local backend.'
                        : 'Loading your assets…'
                      : 'No wallet connected. Pair the local backend to load balances.'}
                  </p>
                )}
                {visibleBalances.some((balance) => balance.code === 'DUSD') && (
                  <p className="asset-disclaimer">
                    DUSD: regtest asset, not dollar-backed or USDT.
                  </p>
                )}
              </section>
            </>
          )}

          {view === 'market' && (
            <>
              <div className="page-heading compact">
                <div>
                  <div className="eyebrow">A2A / ORDERS</div>
                  <h1>
                    Swap market<span className="accent-stop">.</span>
                  </h1>
                  <p>Fixed amounts and full fills. Direct pairs and three-party rings.</p>
                </div>
                <Button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    setView('home');
                    setDraftOpen(true);
                  }}
                  disabled={!ready}
                >
                  New order <Icon name="arrow" size={16} />
                </Button>
              </div>
              {selectedOfferId && (
                <div className="selected-offer" role="status">
                  <strong>Selected public offer</strong>
                  <span>{selectedOfferId}</span>
                  <p>
                    {visibleOrders.some((order) => order.id === selectedOfferId)
                      ? 'Review the terms below. No trade action has been taken.'
                      : 'This offer is not in the current order book. No trade action has been taken.'}
                  </p>
                </div>
              )}
              <div className="market-layout">
                <Panel className="panel orderbook">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">OPEN OFFERS</span>
                      <h2>Order book</h2>
                    </div>
                    <StatusBadge className="count-pill">{visibleOrders.length}</StatusBadge>
                  </div>
                  <div className="order-list">
                    {visibleOrders.length ? (
                      visibleOrders.map((order) => (
                        <article
                          key={order.id}
                          className={`offer-card ${selectedOfferId === order.id ? 'selected-order' : ''}`}
                        >
                          <div className="offer-meta">
                            <span>{order.owner}</span>
                            <StatusBadge className="status-pill">{order.status}</StatusBadge>
                          </div>
                          <div className="offer-amounts">
                            <div>
                              <small>Gives</small>
                              <strong>
                                {order.giveAmount}{' '}
                                {order.giveAsset !== 'BTC' ? order.giveAsset : ''}
                              </strong>
                            </div>
                            <Icon name="arrow" size={20} />
                            <div>
                              <small>Receives at least</small>
                              <strong>
                                {order.minReceiveAmount}{' '}
                                {order.receiveAsset !== 'BTC' &&
                                !order.minReceiveAmount.includes(order.receiveAsset)
                                  ? order.receiveAsset
                                  : ''}
                              </strong>
                            </div>
                          </div>
                        </article>
                      ))
                    ) : (
                      <p className="empty-state">
                        {connected
                          ? 'No open orders yet. Your next swap starts with an order.'
                          : 'Connect your wallet to see open orders.'}
                      </p>
                    )}
                  </div>
                  <div className="panel-footer">
                    {connected
                      ? 'Public orders are visible to the market. Private instructions stay local.'
                      : samplePreview
                        ? 'Synthetic preview only. Pair the wallet for live orders.'
                        : 'Local backend unavailable. No orders loaded.'}
                  </div>
                </Panel>
                <aside className="market-side">
                  <Panel className="panel my-order">
                    <span className="eyebrow">MY ORDER</span>
                    {myOrder ? (
                      <>
                        <h3>
                          {myOrder.giveAmount} {myOrder.giveAsset} <span>→</span>{' '}
                          {myOrder.minReceiveAmount} {myOrder.receiveAsset}
                        </h3>
                        <p>
                          Status: {myOrder.status}. Publishing an order does not authorize signing.
                        </p>
                        {myOrder.status === 'Open' ? (
                          <Button
                            type="button"
                            className="outline-button"
                            onClick={() => void cancelOrder()}
                            disabled={busy !== null || !ready}
                          >
                            Cancel order
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            className="outline-button"
                            onClick={() => setView('trade')}
                          >
                            View trade <Icon name="arrow" size={15} />
                          </Button>
                        )}
                      </>
                    ) : (
                      <>
                        <h3>{connected ? 'No active order' : 'Wallet unavailable'}</h3>
                        <p>
                          {connected
                            ? 'Create an order with QVAC or enter terms manually.'
                            : 'Pair the local backend to view or publish your orders.'}
                        </p>
                        <Button
                          type="button"
                          className="outline-button"
                          onClick={() => {
                            setView('home');
                            setDraftOpen(true);
                          }}
                          disabled={!ready}
                        >
                          Create order <Icon name="arrow" size={15} />
                        </Button>
                      </>
                    )}
                  </Panel>
                  <div className="market-tip">
                    <Icon name="shield" size={20} />
                    <strong>How does matching work?</strong>
                    <p>
                      Direct pairs come first, then rings. Exact amounts and fees appear before
                      signing.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}

          {view === 'trade' && (
            <>
              <div className="page-heading compact">
                <div>
                  <div className="eyebrow">YOUR SWAP</div>
                  <h1>
                    Your swap<span className="accent-stop">.</span>
                  </h1>
                  <p>We handle the preparation. You review the amounts and decide when to sign.</p>
                </div>
              </div>
              {!connected && samplePreview && (
                <div className="sample-switch" role="group" aria-label="Sample trade type">
                  <span>Sample plan:</span>
                  <Button
                    className={sampleTradeKind === 'direct' ? 'selected' : ''}
                    type="button"
                    onClick={() => setSampleTradeKind('direct')}
                  >
                    Direct swap
                  </Button>
                  <Button
                    className={sampleTradeKind === 'ring' ? 'selected' : ''}
                    type="button"
                    onClick={() => setSampleTradeKind('ring')}
                  >
                    Three-party ring
                  </Button>
                </div>
              )}
              {trade &&
                status &&
                !(trade.kind === 'ring' ? status.wallet.ringSwap : status.wallet.directSwap) && (
                  <div className="capability-warning" role="status">
                    <Icon name="info" size={17} />
                    <span>
                      {trade.kind === 'ring' ? 'Three-party atomic swap' : 'Direct atomic swap'} is
                      not supported by this wallet. {status.wallet.reason ?? 'Signing unavailable.'}
                    </span>
                  </div>
                )}
              {!shownTrade && (
                <div className="empty-state" role="status">
                  {connected
                    ? syncError
                      ? 'Trade data unavailable. Check the local backend.'
                      : 'No trade plan yet. A matched order will appear here.'
                    : 'No wallet connected. Pair the local backend to view trades.'}
                </div>
              )}
              {trade && client?.supportsTrade(trade) && (
                <section className="swap-progress" aria-label="Swap progress" aria-live="polite">
                  <div className="progress-heading">
                    {tradeProgress(trade).waiting && !workflowPaused ? (
                      <span className="spinner" aria-hidden="true" />
                    ) : (
                      <Icon name="shield" size={24} />
                    )}
                    <div>
                      <h2>
                        {workflowPaused ? 'Your swap needs attention' : tradeProgress(trade).title}
                      </h2>
                      <p>
                        {workflowPaused
                          ? 'We couldn’t finish this step. Your approval and transaction history are saved. Check the details, then try again.'
                          : tradeProgress(trade).detail}
                      </p>
                    </div>
                  </div>
                  <ol className="progress-steps">
                    {['Prepare', 'Your approval', 'All wallets', 'Confirmation'].map(
                      (label, index) => (
                        <li
                          key={label}
                          className={
                            tradeProgress(trade).step > index
                              ? 'done'
                              : tradeProgress(trade).step === index
                                ? 'current'
                                : ''
                          }
                          aria-current={tradeProgress(trade).step === index ? 'step' : undefined}
                        >
                          <span>{tradeProgress(trade).step > index ? '✓' : index + 1}</span>
                          {label}
                        </li>
                      ),
                    )}
                  </ol>
                  {workflowError && (
                    <details className="technical-details">
                      <summary>
                        {workflowPaused ? 'What happened?' : 'Reconnecting automatically…'}
                      </summary>
                      <p>{workflowError}</p>
                    </details>
                  )}
                  {workflowPaused && (
                    <Button
                      className="outline-button"
                      disabled={workflowRunning || busy !== null}
                      onClick={() => {
                        workflow.current.retry();
                        setWorkflowPaused(false);
                        setWorkflowError(null);
                      }}
                    >
                      Try again
                    </Button>
                  )}
                </section>
              )}
              {shownTrade && (
                <div className="trade-layout">
                  <Panel className="panel trade-panel">
                    <div className="panel-heading trade-head">
                      <div>
                        <span className="eyebrow">
                          {shownTrade.kind === 'direct'
                            ? 'TWO PARTICIPANTS'
                            : 'THREE PARTICIPANTS · RING'}
                        </span>
                        <h2>{shownTrade.kind === 'direct' ? 'Direct swap' : 'Ring swap'}</h2>
                        <details className="technical-details">
                          <summary>Transaction details</summary>
                          <p>Plan {shownTrade.id}</p>
                          {shownTrade.txid && (
                            <p className="reason">
                              Bitcoin transaction: {shownTrade.txid}
                              <br />
                              Bitcoin {shownTrade.chainConfirmed ? 'confirmed' : 'unconfirmed'} ·
                              RGB {shownTrade.rgbAccepted ? 'accepted' : 'not accepted'}
                            </p>
                          )}
                        </details>
                      </div>
                      <StatusBadge className={`status-pill ${trade ? 'open' : 'sample'}`}>
                        {trade ? statusLabel(shownTrade.status) : shownTrade.status}
                      </StatusBadge>
                    </div>
                    <div className="flow-caption">TRADE PARTICIPANTS</div>
                    <div className={`trade-flow ${shownTrade.kind}`}>
                      {shownTrade.participants.map((participant, index) => (
                        <div
                          className={`participant-card ${participant.mine ? 'mine' : ''}`}
                          key={`${participant.name}-${index}`}
                        >
                          <div className="participant-avatar">
                            {String.fromCharCode(65 + index)}
                          </div>
                          <div>
                            <strong>{participant.name}</strong>
                            <span>Gives {participant.give}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="leg-list">
                      {shownTrade.legs.map((leg, index) => (
                        <div key={`${leg.from}-${leg.to}-${index}`}>
                          <strong>{leg.from}</strong>
                          <Icon name="arrow" size={15} />
                          <strong>{leg.to}</strong>
                          <span>{leg.amount}</span>
                        </div>
                      ))}
                    </div>
                    <div className="trade-legend">
                      {shownTrade.kind === 'ring'
                        ? 'All three transfers must be in one atomic package. Sequential transfers are not an atomic swap.'
                        : 'Both wallets must validate the final package before signing.'}
                    </div>
                    <div className="trade-summary">
                      <div>
                        <span>I give</span>
                        <strong>{shownTrade.participants.find((p) => p.mine)?.give ?? '—'}</strong>
                      </div>
                      <div>
                        <span>I receive</span>
                        <strong>
                          {shownTrade.participants.find((p) => p.mine)?.receive ?? '—'}
                        </strong>
                      </div>
                      <div>
                        <span>My fee</span>
                        <strong>{shownTrade.feeSats} sats</strong>
                      </div>
                    </div>
                    {shownTrade.reason && (
                      <div className="reason">
                        <Icon name="info" size={16} />
                        {shownTrade.reason}
                      </div>
                    )}
                  </Panel>
                  <aside className="market-side">
                    <Panel className="panel approval-panel">
                      <span className="eyebrow">YOUR DECISION</span>
                      <h3>
                        {trade?.status === 'CONFIRMED'
                          ? 'All done'
                          : trade?.signingAuthorized
                            ? 'You’ve approved'
                            : 'Review your swap'}
                      </h3>
                      {trade?.validatedPreview ? (
                        <>
                          <p>The local wallet validated the final package. Review exact changes:</p>
                          <dl>
                            <div>
                              <dt>Give</dt>
                              <dd>{trade.validatedPreview.give}</dd>
                            </div>
                            <div>
                              <dt>Receive</dt>
                              <dd>{trade.validatedPreview.receive}</dd>
                            </div>
                            <div>
                              <dt>Fee</dt>
                              <dd>{trade.validatedPreview.feeSats} sats</dd>
                            </div>
                            <div>
                              <dt>BTC change</dt>
                              <dd>{trade.validatedPreview.btcDeltaSats} sats</dd>
                            </div>
                          </dl>
                          <Button
                            className="primary-button full"
                            type="button"
                            onClick={() => void approve()}
                            disabled={busy !== null || workflowRunning || !ready || isMock}
                          >
                            {busy === 'approve' ? 'Waiting for approval…' : 'Review & sign'}{' '}
                            <Icon name="arrow" size={16} />
                          </Button>
                        </>
                      ) : (
                        <>
                          <div className="approval-lock">
                            <Icon name="shield" size={26} />
                          </div>
                          <p>
                            {trade
                              ? tradeProgress(trade).detail
                              : 'This is a sample plan. Connect your wallet to start a real swap.'}
                          </p>
                          {(isMock || !trade || trade.status === 'UNSUPPORTED') && (
                            <Button className="primary-button full" disabled>
                              Signing unavailable
                            </Button>
                          )}
                        </>
                      )}
                      {trade &&
                        !trade.recoveryRequired &&
                        ['RESERVED', 'PREPARING', 'AWAITING_APPROVAL'].includes(trade.status) && (
                          <Button
                            className="text-button danger reject-button"
                            type="button"
                            onClick={() => void reject()}
                            disabled={busy !== null || workflowRunning}
                          >
                            Cancel swap
                          </Button>
                        )}
                      <div className="approval-foot">
                        Your wallet checks the exact amounts again before signing.
                      </div>
                    </Panel>
                  </aside>
                </div>
              )}
            </>
          )}
        </main>
        <footer className="footer">
          <span>palka.</span>
          <span>
            {connected
              ? `Bitcoin ${status?.network} · ${status?.mode.toUpperCase()} wallet`
              : 'No wallet connected'}
          </span>
        </footer>
      </div>

      {connectionOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConnectionOpen(false);
          }}
        >
          <Panel
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-title"
          >
            <div className="modal-head">
              <div className="modal-icon">
                <Icon name="wallet" size={21} />
              </div>
              <Button type="button" onClick={() => setConnectionOpen(false)} aria-label="Close">
                <Icon name="close" size={18} />
              </Button>
            </div>
            <div className="eyebrow">LOCAL WALLET</div>
            <h2 id="connection-title">{desktop ? 'Local backend' : 'Pair this wallet'}</h2>
            {desktop ? (
              <p>
                The desktop app connects through its local bridge. Service credentials stay outside
                this window.
              </p>
            ) : (
              <>
                <p>
                  This page uses only its own loopback API at {window.location.origin}. The pairing
                  token stays in this tab's memory.
                </p>
                <label className="field-label" htmlFor="pair-token">
                  Pairing token
                </label>
                <Input
                  id="pair-token"
                  type="password"
                  value={pairToken}
                  onChange={(event) => setPairToken(event.target.value)}
                  autoComplete="off"
                  placeholder="Enter local pairing token"
                />
              </>
            )}
            <div className="modal-actions">
              {connected && (
                <Button
                  type="button"
                  className="text-button danger"
                  onClick={() => {
                    disconnect();
                    setConnectionOpen(false);
                  }}
                >
                  Disconnect
                </Button>
              )}
              <Button
                type="button"
                className="primary-button"
                onClick={() => void connect()}
                disabled={busy !== null || (!desktop && !pairToken.trim())}
              >
                {busy === 'connect' ? 'Connecting…' : desktop ? 'Reconnect' : 'Pair wallet'}{' '}
                <Icon name="arrow" size={16} />
              </Button>
            </div>
          </Panel>
        </div>
      )}

      {draftOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDraftOpen(false);
          }}
        >
          <Panel
            className="modal draft-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="draft-title"
          >
            <div className="modal-head">
              <div className="modal-icon">
                <Icon name="arrows" size={21} />
              </div>
              <Button type="button" onClick={() => setDraftOpen(false)} aria-label="Close">
                <Icon name="close" size={18} />
              </Button>
            </div>
            <div className="eyebrow">ORDER TERMS</div>
            <h2 id="draft-title">Review swap</h2>
            <p>
              One asset for another, at fixed amounts. Publishing permits matching, not spending.
            </p>
            <div className="draft-grid">
              <div>
                <label className="field-label" htmlFor="give-asset">
                  Give
                </label>
                <Select
                  id="give-asset"
                  value={draft.giveAsset}
                  onChange={(event) => updateDraft({ giveAsset: event.target.value as AssetCode })}
                >
                  {assetCodes.map((code) => (
                    <option key={code}>{code}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="field-label" htmlFor="give-amount">
                  Amount {draft.giveAsset === 'BTC' ? 'in sats' : 'in atomic units'}
                </label>
                <Input
                  id="give-amount"
                  value={draft.giveAmount}
                  onChange={(event) => updateDraft({ giveAmount: event.target.value })}
                  inputMode="numeric"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="receive-asset">
                  Receive
                </label>
                <Select
                  id="receive-asset"
                  value={draft.receiveAsset}
                  onChange={(event) =>
                    updateDraft({ receiveAsset: event.target.value as AssetCode })
                  }
                >
                  {assetCodes.map((code) => (
                    <option key={code}>{code}</option>
                  ))}
                </Select>
              </div>
              <div>
                <label className="field-label" htmlFor="receive-amount">
                  At least {draft.receiveAsset === 'BTC' ? 'sats' : 'atomic units'}
                </label>
                <Input
                  id="receive-amount"
                  value={draft.minReceiveAmount}
                  onChange={(event) => updateDraft({ minReceiveAmount: event.target.value })}
                  inputMode="numeric"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="max-fee">
                  Maximum order fee, sats
                </label>
                <Input
                  id="max-fee"
                  value={draft.maxFeeSats}
                  onChange={(event) => updateDraft({ maxFeeSats: event.target.value })}
                  inputMode="numeric"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="expires">
                  Expires in, minutes
                </label>
                <Input
                  id="expires"
                  value={draft.expiresMinutes}
                  onChange={(event) => updateDraft({ expiresMinutes: event.target.value })}
                  inputMode="numeric"
                />
              </div>
            </div>
            {policy && (
              <div className="policy-block">
                <div className="policy-heading">
                  <Icon name="shield" size={17} />
                  <strong>Private policy</strong>
                  <span>not visible to market</span>
                </div>
                <div className="draft-grid">
                  <div>
                    <label className="field-label" htmlFor="policy-fee">
                      Policy fee limit, sats
                    </label>
                    <Input
                      id="policy-fee"
                      value={policy.maxFeeSats}
                      onChange={(event) => updatePolicy({ maxFeeSats: event.target.value })}
                      inputMode="numeric"
                    />
                  </div>
                  <label className="policy-toggle">
                    <Input
                      type="checkbox"
                      checked={policy.allowBtcSale}
                      onChange={(event) => updatePolicy({ allowBtcSale: event.target.checked })}
                    />
                    <span>Allow BTC sale</span>
                  </label>
                </div>
                <div className="policy-reserves">
                  <span className="field-label">Protected balance after swap, base units</span>
                  {policyAssets.map((asset) => (
                    <label key={asset.key}>
                      <span>{asset.label}</span>
                      <Input
                        value={policy.protectedBalances[asset.key] ?? '0'}
                        onChange={(event) =>
                          updatePolicy({
                            protectedBalances: {
                              ...policy.protectedBalances,
                              [asset.key]: event.target.value,
                            },
                          })
                        }
                        inputMode="numeric"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="draft-note">
              <Icon name="shield" size={17} />
              {ready
                ? 'Policy, balances, and network are checked locally. Policy changes apply on publication.'
                : 'Wallet balances and policy are unavailable. This form cannot publish an order.'}
            </div>
            <div className="modal-actions">
              <Button
                className="primary-button"
                type="button"
                onClick={() => void publish()}
                disabled={!ready || busy !== null}
              >
                {busy === 'publish' ? 'Checking & publishing…' : 'Publish order'}{' '}
                <Icon name="arrow" size={16} />
              </Button>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );

  function updateDraft(change: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...change }));
  }
  function updatePolicy(change: Partial<PrivatePolicy>) {
    setPolicy((current) => (current ? { ...current, ...change } : current));
  }
}

function validateDraftShape(draft: Draft, policy: PrivatePolicy | null) {
  if (draft.giveAsset === draft.receiveAsset) throw new Error('Assets must differ.');
  for (const [name, value] of Object.entries({
    'Amount to give': draft.giveAmount,
    'Minimum to receive': draft.minReceiveAmount,
    Fee: draft.maxFeeSats,
    Expiry: draft.expiresMinutes,
  })) {
    if (!/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error(`${name}: enter an integer in base units.`);
    if (BigInt(value) > 18446744073709551615n)
      throw new Error(`${name}: number exceeds the allowed size.`);
  }
  if (
    BigInt(draft.giveAmount) === 0n ||
    BigInt(draft.minReceiveAmount) === 0n ||
    BigInt(draft.expiresMinutes) === 0n
  )
    throw new Error('Amounts and expiry must be greater than zero.');
  if (policy) {
    for (const [name, value] of Object.entries({
      'Policy fee limit': policy.maxFeeSats,
      ...policy.protectedBalances,
    })) {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n)
        throw new Error(`${name}: enter an integer in the allowed range.`);
    }
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Unknown error';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    RESERVED: 'Awaiting validation',
    PREPARING: 'Preparing',
    AWAITING_APPROVAL: 'Awaiting approval',
    SIGNING: 'Signing',
    READY_TO_BROADCAST: 'Ready to broadcast',
    BROADCAST: 'Broadcast',
    CONFIRMED: 'BTC and RGB confirmed',
    RECONCILING: 'Reconciling',
    REJECTED: 'Rejected',
    CANCELLED: 'Canceled',
    EXPIRED: 'Expired',
    UNSUPPORTED: 'Unsupported',
  };
  return labels[status] ?? status;
}

export default App;
