import { useEffect, useRef, useState } from 'react';
import { initialDraft, sampleBalances, sampleOrders, sampleTrades } from './model';
import type { AssetCode, Balance, Draft, Order, Trade, View } from './model';
import { LocalClient, type ClientStatus } from './api';
import type { PrivatePolicy } from '@rgb-exchange/contracts';

const sampleAssetCodes: AssetCode[] = ['BTC', 'X', 'DUSD'];
const navItems: { key: View; label: string; subtitle: string; icon: string }[] = [
  { key: 'home', label: 'Overview', subtitle: 'Balances and goal', icon: 'grid' },
  { key: 'market', label: 'Market', subtitle: 'Orders', icon: 'arrows' },
  { key: 'trade', label: 'Trade', subtitle: 'Review and sign', icon: 'route' },
];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    arrows: <><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></>,
    route: <><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7 6h10M5 8v6l5 3m9-9v6l-5 3" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M16 11h5M5 5V4a2 2 0 0 1 2-2h11" /><circle cx="17" cy="14" r="1" /></>,
    spark: <><path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2Z" /><path d="m19 18 .5 1.5L21 20l-1.5.5L19 22l-.5-1.5L17 20l1.5-.5L19 18Z" /></>,
    shield: <><path d="m12 2 9 4v6c0 5.2-3.6 8.7-9 10-5.4-1.3-9-4.8-9-10V6l9-4Z" /><path d="m8 12 3 3 5-6" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9A7 7 0 0 1 18 6l2 1M4 17l2 1a7 7 0 0 0 12.5-3" /></>,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    info: <><circle cx="12" cy="12" r="10" /><path d="M12 11v6m0-10h.01" /></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function AssetIcon({ code, size = 'normal' }: { code: AssetCode; size?: 'normal' | 'large' }) {
  const assetClass = code === 'BTC' ? 'btc' : code === 'DUSD' ? 'dusd' : 'x';
  return <span className={`asset-icon ${assetClass} ${size === 'large' ? 'large' : ''}`} aria-hidden="true">{code === 'BTC' ? '₿' : code.slice(0, 1).toUpperCase()}</span>;
}

function SectionTitle({ kicker, title, action, id }: { kicker: string; title: string; action?: React.ReactNode; id?: string }) {
  return <div className="section-title"><div><div className="eyebrow">{kicker}</div><h2 id={id}>{title}</h2></div>{action}</div>;
}

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
  const [draftChecked, setDraftChecked] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approvalAttemptedTradeId, setApprovalAttemptedTradeId] = useState<string | null>(null);
  const connected = Boolean(client && status);
  const desktop = Boolean(window.palkaWallet);
  const isMock = status?.mode === 'mock';
  const ready = connected && !syncError && balances.length > 0;
  const visibleBalances = connected ? balances : samplePreview ? sampleBalances : [];
  const visibleOrders = connected ? orders : samplePreview ? sampleOrders : [];
  const assetCodes = connected ? balances.map(balance => balance.code) : samplePreview ? sampleAssetCodes : [];

  useEffect(() => {
    if (!client) return;
    let active = true;
    const refresh = async () => {
      try {
        const data = await client.snapshot();
        if (!active) return;
        setBalances(data.balances);
        setOrders(data.orders);
        setMyOrder(data.myOrder);
        setTrade(data.trade);
        setPolicy(current => current ?? data.policy);
        setPolicyAssets(data.policyAssets);
        setSyncError(null);
        const codes = data.balances.map(balance => balance.code);
        if (codes.length >= 2) setDraft(current => codes.includes(current.giveAsset) && codes.includes(current.receiveAsset) ? current : { ...current, giveAsset: codes[0], receiveAsset: codes[1] });
        // Model download can continue after pairing; reflect QVAC readiness without reconnecting.
        void client.connect().then(health => { if (active) setStatus(health); }).catch(() => {});
      } catch (error) {
        if (active) {
          setBalances([]); setOrders([]); setMyOrder(null); setTrade(null); setPolicy(null); setPolicyAssets([]);
          setSyncError(messageOf(error));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client]);

  useEffect(() => {
    if (!desktop || desktopConnectStarted.current) return;
    desktopConnectStarted.current = true;
    void connect();
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    const bridge = window.palkaWallet!;
    let active = true;
    const selectOffer = (orderId: string) => { if (active) { setSelectedOfferId(orderId); setView('market'); } };
    const unsubscribe = bridge.onOfferSelected(selectOffer);
    void bridge.getPendingOffer().then(orderId => { if (orderId) selectOffer(orderId); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [desktop]);

  const connect = async () => {
    setBusy('connect'); setNotice(null);
    try {
      const next = new LocalClient(desktop ? undefined : pairToken);
      const health = await next.connect();
      setClient(next); setStatus(health); setConnectionOpen(false); setSamplePreview(false); setSyncError(null);
      setBalances([]); setOrders([]); setMyOrder(null); setTrade(null); setPolicy(null); setPolicyAssets([]);
      setApprovalAttemptedTradeId(null);
      setPairToken('');
      setNotice({ tone: 'success', text: `Local wallet connected · ${health.network} · ${health.mode.toUpperCase()}` });
    } catch (error) { setNotice({ tone: 'error', text: `Could not connect: ${messageOf(error)}` }); }
    finally { setBusy(null); }
  };

  const disconnect = () => {
    setClient(null); setStatus(null); setBalances([]); setOrders([]); setMyOrder(null); setTrade(null); setPolicy(null); setPolicyAssets([]); setApprovalAttemptedTradeId(null); setSyncError(null);
    setNotice({ tone: 'info', text: 'Local wallet disconnected.' });
  };

  const interpret = async () => {
    if (!client) { setNotice({ tone: 'info', text: 'Pair a local wallet to interpret a goal. Sample preview does not run QVAC.' }); return; }
    if (!status?.qvacAvailable) { setDraftOpen(true); setDraftChecked(false); setNotice({ tone: 'info', text: `QVAC unavailable: ${status?.qvacReason ?? 'The local model is not ready.'} Use the manual form.` }); return; }
    setBusy('interpret'); setNotice(null);
    try {
      const result = await client.interpret(goal);
      if (result.draft) setDraft(result.draft);
      setPolicy(result.policy); setDraftOpen(true); setDraftChecked(false);
      setNotice(result.draft ? { tone: 'success', text: 'QVAC interpreted the goal locally. Review and confirm the order terms.' } : { tone: 'info', text: result.clarification ?? 'The goal needs clarification. Fill in the terms manually.' });
    } catch (error) { setDraftOpen(true); setNotice({ tone: 'error', text: `QVAC unavailable: ${messageOf(error)}. Use the manual form.` }); }
    finally { setBusy(null); }
  };

  const checkDraft = async () => {
    setBusy('check'); setNotice(null);
    try {
      validateDraftShape(draft, policy);
      if (!client || !ready) throw new Error('Connect the local wallet and load its balances before validation.');
      if (!policy) throw new Error('Local policy has not loaded yet.');
      await client.checkDraft(draft, policy);
      setDraftChecked(true);
      setNotice({ tone: 'success', text: 'Local policy validated. Publishing requires a separate action.' });
    } catch (error) { setDraftChecked(false); setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!client || !ready || !draftChecked || !policy) return;
    setBusy('publish'); setNotice(null);
    try {
      const order = await client.publishDraft(draft, policy);
      setMyOrder(order); setDraftOpen(false); setView('market');
      setNotice({ tone: 'success', text: 'Order published. This does not authorize transaction signing.' });
    } catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const cancelOrder = async () => {
    if (!client || !myOrder) return;
    setBusy('cancel');
    try { await client.cancelOrder(myOrder.id); setMyOrder(null); setNotice({ tone: 'info', text: 'Order canceled.' }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const approve = async () => {
    if (!client || !trade?.validatedPreview) return;
    setBusy('approve'); setNotice(null);
    const digest = trade.validatedPreview.digest;
    const tradeId = trade.id;
    setApprovalAttemptedTradeId(tradeId);
    setTrade(current => current?.id === tradeId ? { ...current, validatedPreview: undefined } : current);
    try { await client.approve(tradeId, digest); setNotice({ tone: 'info', text: 'Local approval sent to the wallet. Check the status; RGB acceptance is still required.' }); }
    catch (error) { setNotice({ tone: 'error', text: `${messageOf(error)}. The signing outcome may be uncertain; check wallet state before another attempt.` }); }
    finally { setBusy(null); }
  };

  const prepare = async () => {
    if (!client || !trade) return;
    setBusy('prepare'); setNotice(null);
    try { const result = await client.prepare(trade.id); setNotice({ tone: 'info', text: `Preparation: ${result}.` }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const preview = async () => {
    if (!client || !trade) return;
    setBusy('preview'); setNotice(null);
    try { const checked = await client.preview(trade.id); setTrade(current => current?.id === trade.id ? { ...current, validatedPreview: checked } : current); setNotice({ tone: 'success', text: 'The final package was validated by the local wallet. Review amounts before signing.' }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const reject = async () => {
    if (!client || !trade) return;
    setBusy('reject'); setNotice(null);
    try { await client.reject(trade.id); setNotice({ tone: 'info', text: 'Trade rejected before signing.' }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const sync = async () => {
    if (!client || !trade) return;
    setBusy('sync'); setNotice(null);
    try {
      const receipt = await client.sync(trade.id);
      setNotice({ tone: receipt.state === 'confirmed' ? 'success' : 'info', text: `Reconciliation: ${receipt.state}; Bitcoin ${receipt.chainConfirmed ? 'confirmed' : 'unconfirmed'}, RGB ${receipt.rgbAccepted ? 'accepted' : 'not accepted'}. ${receipt.reason ?? ''}` });
    } catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const shownTrade = trade ?? (!connected && samplePreview ? sampleTrades[sampleTradeKind] : null);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><span /><span /><span /></span><span>palka<span className="brand-dot">.</span></span></div>
      <div className="sidebar-caption">LOCAL WALLET · RGB P2P</div>
      <nav aria-label="Main navigation" className="sidebar-nav">
        {navItems.map(item => <button key={item.key} type="button" className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => setView(item.key)} aria-current={view === item.key ? 'page' : undefined}>
          <span className="nav-icon"><Icon name={item.icon} /></span><span><strong>{item.label}</strong><small>{item.subtitle}</small></span>{view === item.key && <span className="nav-marker" />}
        </button>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-help-icon"><Icon name="shield" size={19} /></div><strong>Your keys stay with you</strong><p>The public market sees orders. Your wallet and AI run locally.</p><span className="sidebar-version">MVP · LOCAL</span></div>
    </aside>

    <div className="main-area">
      <header className="topbar"><div className="breadcrumb">Local wallet <Icon name="chevron" size={14} /> <strong>{navItems.find(item => item.key === view)?.label}</strong></div><div className="top-actions">{desktop ? <button className="text-button" type="button" onClick={() => void window.palkaWallet?.openPublicMarket()}>Public market</button> : <a className="text-button" href="http://127.0.0.1:5173/market" target="_blank" rel="noopener noreferrer">Public market</a>}<span className="network-pill">{connected && <span className="live-dot" />}{connected ? `BITCOIN ${status?.network.toUpperCase()}` : 'NETWORK UNAVAILABLE'}</span><button className={`wallet-button ${connected ? 'connected' : ''}`} type="button" onClick={() => setConnectionOpen(true)}><Icon name="wallet" size={17} />{connected ? `Wallet ${status?.walletLabel ?? 'connected'}` : desktop ? 'Backend unavailable' : 'Pair local wallet'}</button></div></header>
      <main className="content">
        <div className={`mode-banner ${connected && !isMock ? 'real' : 'mock'}`} role="status"><Icon name="info" size={17} /><div><strong>{!connected ? samplePreview ? 'Sample preview · disconnected' : 'Local wallet unavailable' : syncError ? 'Wallet data unavailable' : isMock ? 'Mock wallet connected' : 'Real local wallet connected'}</strong><span>{!connected ? samplePreview ? 'Synthetic balances and plans are shown for UI preview only. Trading and signing are unavailable.' : 'Pair the local wallet to load balances, network, orders, and QVAC status.' : syncError ? syncError : isMock ? 'Demo wallet: matching works, BTC/RGB signing and broadcast are unsupported.' : `Network ${status?.network}. Final settlement requires separate wallet validation and approval.`}</span></div>{!connected && <button className="text-button sample-action" type="button" onClick={() => setSamplePreview(current => !current)}>{samplePreview ? 'Exit sample preview' : 'Preview sample data'}</button>}</div>
        {notice && <div className={`notice ${notice.tone}`} role="alert"><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message"><Icon name="close" size={15} /></button></div>}

        {view === 'home' && <>
          <div className="page-heading"><div><div className="eyebrow">YOUR LOCAL WALLET</div><h1>Swap on your terms<span className="accent-stop">.</span></h1><p>Describe your swap. The local assistant prepares an order for your review.</p></div><div className="heading-art" aria-hidden="true"><div className="swap-ring outer" /><div className="swap-ring inner" /><div className="swap-core"><Icon name="arrows" size={26} /></div></div></div>
          <section aria-labelledby="balance-heading"><SectionTitle id="balance-heading" kicker="01 / ASSETS" title="Your assets" action={<span className="section-note">{connected ? 'Local wallet balances' : samplePreview ? 'Synthetic preview' : 'Unavailable'}</span>} />{visibleBalances.length ? <div className="balance-grid">{visibleBalances.map(balance => <article className="balance-card" key={balance.code}><div className="balance-card-top"><AssetIcon code={balance.code} size="large" /><span className="balance-code">{balance.code}</span></div><div className="balance-value">{balance.amount} <small>{balance.unit}</small></div><p>{balance.label}</p></article>)}</div> : <p className="empty-state" role="status">{connected ? syncError ? 'Wallet balances are unavailable. Check the local backend.' : 'No assets reported by this wallet.' : 'No wallet connected. Pair the local backend to load balances.'}</p>}{visibleBalances.some(balance => balance.code === 'DUSD') && <p className="asset-disclaimer">DUSD is a test RGB asset on regtest. It is not dollar-backed or USDT.</p>}</section>
          <section className="goal-section" aria-labelledby="goal-heading"><SectionTitle id="goal-heading" kicker="02 / NEW ORDER" title="What would you like to swap?" /><div className="goal-card"><div className="goal-card-head"><div className="goal-mark"><Icon name="spark" size={23} /></div><div><strong>QVAC assistant</strong><span>Interprets your goal on this device</span></div><span className={`ai-status ${status?.qvacAvailable ? 'available' : ''}`}>{status?.qvacAvailable ? 'AVAILABLE' : connected ? 'UNAVAILABLE' : 'NOT CONNECTED'}</span></div>{connected && !status?.qvacAvailable && <p className="qvac-reason" role="status">{status?.qvacReason ?? 'Local model unavailable.'} You can enter the order manually.</p>}<label className="field-label" htmlFor="goal">Describe your goal and limits in your own words</label><textarea id="goal" value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder="Describe the asset you would give and the minimum you want in return." /><div className="goal-actions"><span>QVAC suggests terms. Code checks amounts and limits before publication.</span><div><button className="text-button" type="button" onClick={() => { if (connected || samplePreview) { setDraftOpen(true); setDraftChecked(false); } else setNotice({ tone: 'info', text: 'Pair a local wallet before creating an order.' }); }}>Fill in manually</button><button className="primary-button" type="button" onClick={() => void interpret()} disabled={busy !== null || !goal.trim() || !connected}><Icon name="spark" size={16} />{busy === 'interpret' ? 'Interpreting…' : 'Prepare order'}<Icon name="arrow" size={16} /></button></div></div></div></section>
          <section className="how-section" aria-labelledby="how-heading"><SectionTitle kicker="HOW IT WORKS" title="Three steps to a swap" /><div className="step-grid"><div><span>01</span><strong>Describe your goal</strong><p>QVAC prepares an order locally. You review and confirm its terms.</p></div><div><span>02</span><strong>Find a match</strong><p>The market looks for a direct pair or a three-party ring.</p></div><div><span>03</span><strong>Review and sign</strong><p>The wallet validates the final transaction. Signing requires your approval.</p></div></div></section>
        </>}

        {view === 'market' && <><div className="page-heading compact"><div><div className="eyebrow">P2P / ORDERS</div><h1>Swap market<span className="accent-stop">.</span></h1><p>Fixed amounts and full fills. Direct pairs and three-party rings.</p></div><button className="primary-button" type="button" onClick={() => { setView('home'); setDraftOpen(true); }} disabled={!ready}>New order <Icon name="arrow" size={16} /></button></div>
          {selectedOfferId && <div className="selected-offer" role="status"><strong>Selected public offer</strong><span>{selectedOfferId}</span><p>{visibleOrders.some(order => order.id === selectedOfferId) ? 'Review the terms below. No trade action has been taken.' : 'This offer is not in the current order book. No trade action has been taken.'}</p></div>}
          <div className="market-layout"><div className="panel orderbook"><div className="panel-heading"><div><span className="eyebrow">OPEN OFFERS</span><h2>Order book</h2></div><span className="count-pill">{visibleOrders.length}</span></div><div className="table-wrap"><table><thead><tr><th>Participant</th><th>Gives</th><th>Receives at least</th><th>Status</th></tr></thead><tbody>{visibleOrders.length ? visibleOrders.map(order => <tr className={selectedOfferId === order.id ? 'selected-order' : ''} key={order.id}><td><strong>{order.owner}</strong><small>{order.id}</small></td><td><span className="table-amount"><AssetIcon code={order.giveAsset} />{order.giveAmount} {order.giveAsset !== 'BTC' ? order.giveAsset : ''}</span></td><td><span className="table-amount"><AssetIcon code={order.receiveAsset} />{order.minReceiveAmount} {order.receiveAsset !== 'BTC' && !order.minReceiveAmount.includes(order.receiveAsset) ? order.receiveAsset : ''}</span></td><td><span className="status-pill open">{order.status}</span></td></tr>) : <tr><td colSpan={4} className="empty-cell">{connected ? syncError ? 'Order book unavailable.' : 'No open orders yet.' : samplePreview ? 'No sample orders.' : 'Pair a local wallet to load orders.'}</td></tr>}</tbody></table></div><div className="panel-footer">{connected ? 'Public orders are visible to the market. Private instructions stay local.' : samplePreview ? 'Synthetic preview only. Pair the wallet for live orders.' : 'Local backend unavailable. No orders loaded.'}</div></div>
          <aside className="market-side"><div className="panel my-order"><span className="eyebrow">MY ORDER</span>{myOrder ? <><h3>{myOrder.giveAmount} {myOrder.giveAsset} <span>→</span> {myOrder.minReceiveAmount} {myOrder.receiveAsset}</h3><p>Status: {myOrder.status}. Publishing an order does not authorize signing.</p>{myOrder.status === 'Open' ? <button type="button" className="outline-button" onClick={() => void cancelOrder()} disabled={busy !== null || !ready}>Cancel order</button> : <button type="button" className="outline-button" onClick={() => setView('trade')}>View trade <Icon name="arrow" size={15} /></button>}</> : <><h3>{connected ? 'No active order' : 'Wallet unavailable'}</h3><p>{connected ? 'Create an order with QVAC or enter terms manually.' : 'Pair the local backend to view or publish your orders.'}</p><button type="button" className="outline-button" onClick={() => { setView('home'); setDraftOpen(true); }} disabled={!ready}>Create order <Icon name="arrow" size={15} /></button></>}</div><div className="market-tip"><Icon name="shield" size={20} /><strong>How does matching work?</strong><p>Direct pairs come first, then rings. Exact amounts and fees appear before signing.</p></div></aside></div>
        </>}

        {view === 'trade' && <><div className="page-heading compact"><div><div className="eyebrow">P2P / REVIEW</div><h1>Trade details<span className="accent-stop">.</span></h1><p>One plan, exact transfer directions, and separate wallet approval.</p></div></div>
          {!connected && samplePreview && <div className="sample-switch" role="group" aria-label="Sample trade type"><span>Sample plan:</span><button className={sampleTradeKind === 'direct' ? 'selected' : ''} type="button" onClick={() => setSampleTradeKind('direct')}>Direct swap</button><button className={sampleTradeKind === 'ring' ? 'selected' : ''} type="button" onClick={() => setSampleTradeKind('ring')}>Three-party ring</button></div>}
          {trade && status && !(trade.kind === 'ring' ? status.wallet.ringSwap : status.wallet.directSwap) && <div className="capability-warning" role="status"><Icon name="info" size={17} /><span>{trade.kind === 'ring' ? 'Three-party atomic swap' : 'Direct atomic swap'} is not supported by this wallet. {status.wallet.reason ?? 'Signing unavailable.'}</span></div>}
          {!shownTrade && <div className="empty-state" role="status">{connected ? syncError ? 'Trade data unavailable. Check the local backend.' : 'No trade plan yet. A matched order will appear here.' : 'No wallet connected. Pair the local backend to view trades.'}</div>}
          {shownTrade && <div className="trade-layout"><div className="panel trade-panel">
            <div className="panel-heading trade-head"><div><span className="eyebrow">{shownTrade.kind === 'direct' ? 'TWO PARTICIPANTS' : 'THREE PARTICIPANTS · RING'}</span><h2>{shownTrade.kind === 'direct' ? 'Direct swap' : 'Ring swap'}</h2><small>Plan {shownTrade.id}</small></div><span className={`status-pill ${trade ? 'open' : 'sample'}`}>{trade ? statusLabel(shownTrade.status) : shownTrade.status}</span></div>
            <div className="flow-caption">TRADE PARTICIPANTS</div>
            <div className={`trade-flow ${shownTrade.kind}`}>{shownTrade.participants.map((participant, index) => <div className={`participant-card ${participant.mine ? 'mine' : ''}`} key={`${participant.name}-${index}`}><div className="participant-avatar">{String.fromCharCode(65 + index)}</div><div><strong>{participant.name}</strong><span>Gives {participant.give}</span></div></div>)}</div>
            <div className="leg-list">{shownTrade.legs.map((leg, index) => <div key={`${leg.from}-${leg.to}-${index}`}><strong>{leg.from}</strong><Icon name="arrow" size={15} /><strong>{leg.to}</strong><span>{leg.amount}</span></div>)}</div>
            <div className="trade-legend">{shownTrade.kind === 'ring' ? 'All three transfers must be in one atomic package. Sequential transfers are not an atomic swap.' : 'Both wallets must validate the final package before signing.'}</div>
            <div className="trade-summary"><div><span>I give</span><strong>{shownTrade.participants.find(p => p.mine)?.give ?? '—'}</strong></div><div><span>I receive</span><strong>{shownTrade.participants.find(p => p.mine)?.receive ?? '—'}</strong></div><div><span>My fee</span><strong>{shownTrade.feeSats} sats</strong></div></div>{shownTrade.reason && <div className="reason"><Icon name="info" size={16} />{shownTrade.reason}</div>}
          </div>
          <aside className="market-side"><div className="panel approval-panel"><span className="eyebrow">SEPARATE APPROVAL</span><h3>Before signing</h3>
             {trade?.validatedPreview ? <><p>The local wallet validated the final package. Review exact changes:</p><dl><div><dt>Give</dt><dd>{trade.validatedPreview.give}</dd></div><div><dt>Receive</dt><dd>{trade.validatedPreview.receive}</dd></div><div><dt>Fee</dt><dd>{trade.validatedPreview.feeSats} sats</dd></div><div><dt>BTC change</dt><dd>{trade.validatedPreview.btcDeltaSats} sats</dd></div></dl><button className="primary-button full" type="button" onClick={() => void approve()} disabled={busy !== null || !ready || isMock}>Authorize signing <Icon name="arrow" size={16} /></button></> : <><div className="approval-lock"><Icon name="shield" size={26} /></div><p>{trade ? 'Waiting for final package and local wallet validation. A trade plan alone cannot be signed.' : 'This is a sample plan. There is no final package or wallet validation.'}</p>
               {trade && trade.status === 'RESERVED' && approvalAttemptedTradeId !== trade.id && <button className="outline-button full" type="button" onClick={() => void prepare()} disabled={busy !== null || !ready}>Check trade readiness</button>}
               {trade && !isMock && trade.status === 'AWAITING_APPROVAL' && approvalAttemptedTradeId !== trade.id && <button className="outline-button full" type="button" onClick={() => void preview()} disabled={busy !== null || !ready}>Validate final package</button>}
              {(isMock || !trade || trade.status === 'UNSUPPORTED') && <button className="primary-button full" type="button" disabled>Signing unavailable <Icon name="arrow" size={16} /></button>}
            </>}
            {trade && ['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING', 'CONFIRMED'].includes(trade.status) && <button className="outline-button full" type="button" onClick={() => void sync()} disabled={busy !== null}>Reconcile Bitcoin and RGB</button>}
            {trade && approvalAttemptedTradeId === trade.id && !['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING', 'CONFIRMED'].includes(trade.status) && <button className="outline-button full" type="button" onClick={() => void sync()} disabled={busy !== null}>Check signing outcome</button>}
            {trade && approvalAttemptedTradeId !== trade.id && ['RESERVED', 'PREPARING', 'AWAITING_APPROVAL'].includes(trade.status) && <button className="text-button danger reject-button" type="button" onClick={() => void reject()} disabled={busy !== null}>Reject trade</button>}
            <div className="approval-foot">Order confirmation does not authorize transaction signing.</div>
          </div></aside></div>}
        </>}
      </main>
      <footer className="footer"><span>palka · P2P Exchange</span><span>{connected ? `Bitcoin ${status?.network} · ${status?.mode.toUpperCase()} wallet` : 'No wallet connected'}</span></footer>
    </div>

    {connectionOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConnectionOpen(false); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title"><div className="modal-head"><div className="modal-icon"><Icon name="wallet" size={21} /></div><button type="button" onClick={() => setConnectionOpen(false)} aria-label="Close"><Icon name="close" size={18} /></button></div><div className="eyebrow">LOCAL WALLET</div><h2 id="connection-title">{desktop ? 'Local backend' : 'Pair this wallet'}</h2>{desktop ? <p>The desktop app connects through its local bridge. Service credentials stay outside this window.</p> : <><p>This page uses only its own loopback API at {window.location.origin}. The pairing token stays in this tab's memory.</p><label className="field-label" htmlFor="pair-token">Pairing token</label><input id="pair-token" type="password" value={pairToken} onChange={event => setPairToken(event.target.value)} autoComplete="off" placeholder="Enter local pairing token" /></>}<div className="modal-actions">{connected && <button type="button" className="text-button danger" onClick={() => { disconnect(); setConnectionOpen(false); }}>Disconnect</button>}<button type="button" className="primary-button" onClick={() => void connect()} disabled={busy !== null || (!desktop && !pairToken.trim())}>{busy === 'connect' ? 'Connecting…' : desktop ? 'Reconnect' : 'Pair wallet'} <Icon name="arrow" size={16} /></button></div></div></div>}

    {draftOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDraftOpen(false); }}><div className="modal draft-modal" role="dialog" aria-modal="true" aria-labelledby="draft-title">
      <div className="modal-head"><div className="modal-icon"><Icon name="arrows" size={21} /></div><button type="button" onClick={() => setDraftOpen(false)} aria-label="Close"><Icon name="close" size={18} /></button></div>
      <div className="eyebrow">ORDER TERMS</div><h2 id="draft-title">Review swap</h2><p>One asset for another, at fixed amounts. Publishing permits matching, not spending.</p>
      <div className="draft-grid">
        <div><label className="field-label" htmlFor="give-asset">Give</label><select id="give-asset" value={draft.giveAsset} onChange={event => updateDraft({ giveAsset: event.target.value as AssetCode })}>{assetCodes.map(code => <option key={code}>{code}</option>)}</select></div>
        <div><label className="field-label" htmlFor="give-amount">Amount {draft.giveAsset === 'BTC' ? 'in sats' : 'in atomic units'}</label><input id="give-amount" value={draft.giveAmount} onChange={event => updateDraft({ giveAmount: event.target.value })} inputMode="numeric" /></div>
        <div><label className="field-label" htmlFor="receive-asset">Receive</label><select id="receive-asset" value={draft.receiveAsset} onChange={event => updateDraft({ receiveAsset: event.target.value as AssetCode })}>{assetCodes.map(code => <option key={code}>{code}</option>)}</select></div>
        <div><label className="field-label" htmlFor="receive-amount">At least {draft.receiveAsset === 'BTC' ? 'sats' : 'atomic units'}</label><input id="receive-amount" value={draft.minReceiveAmount} onChange={event => updateDraft({ minReceiveAmount: event.target.value })} inputMode="numeric" /></div>
        <div><label className="field-label" htmlFor="max-fee">Maximum order fee, sats</label><input id="max-fee" value={draft.maxFeeSats} onChange={event => updateDraft({ maxFeeSats: event.target.value })} inputMode="numeric" /></div>
        <div><label className="field-label" htmlFor="expires">Expires in, minutes</label><input id="expires" value={draft.expiresMinutes} onChange={event => updateDraft({ expiresMinutes: event.target.value })} inputMode="numeric" /></div>
      </div>
      {policy && <div className="policy-block"><div className="policy-heading"><Icon name="shield" size={17} /><strong>Private policy</strong><span>not visible to market</span></div><div className="draft-grid">
        <div><label className="field-label" htmlFor="policy-fee">Policy fee limit, sats</label><input id="policy-fee" value={policy.maxFeeSats} onChange={event => updatePolicy({ maxFeeSats: event.target.value })} inputMode="numeric" /></div>
        <label className="policy-toggle"><input type="checkbox" checked={policy.allowBtcSale} onChange={event => updatePolicy({ allowBtcSale: event.target.checked })} /><span>Allow BTC sale</span></label>
      </div><div className="policy-reserves"><span className="field-label">Protected balance after swap, base units</span>{policyAssets.map(asset => <label key={asset.key}><span>{asset.label}</span><input value={policy.protectedBalances[asset.key] ?? '0'} onChange={event => updatePolicy({ protectedBalances: { ...policy.protectedBalances, [asset.key]: event.target.value } })} inputMode="numeric" /></label>)}</div></div>}
      <div className="draft-note"><Icon name="shield" size={17} />{ready ? 'Policy, balances, and network are checked locally. Policy changes apply on publication.' : 'Wallet balances and policy are unavailable. This form cannot publish an order.'}</div>
      <div className="modal-actions"><button className="outline-button" type="button" onClick={() => void checkDraft()} disabled={busy !== null || !ready}>{busy === 'check' ? 'Validating…' : 'Validate terms'}</button><button className="primary-button" type="button" onClick={() => void publish()} disabled={!ready || !draftChecked || busy !== null}>{busy === 'publish' ? 'Publishing…' : 'Confirm and publish'} <Icon name="arrow" size={16} /></button></div>
    </div></div>}
  </div>;

  function updateDraft(change: Partial<Draft>) { setDraft(current => ({ ...current, ...change })); setDraftChecked(false); }
  function updatePolicy(change: Partial<PrivatePolicy>) { setPolicy(current => current ? { ...current, ...change } : current); setDraftChecked(false); }
}

function validateDraftShape(draft: Draft, policy: PrivatePolicy | null) {
  if (draft.giveAsset === draft.receiveAsset) throw new Error('Assets must differ.');
  for (const [name, value] of Object.entries({ 'Amount to give': draft.giveAmount, 'Minimum to receive': draft.minReceiveAmount, 'Fee': draft.maxFeeSats, 'Expiry': draft.expiresMinutes })) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name}: enter an integer in base units.`);
    if (BigInt(value) > 18446744073709551615n) throw new Error(`${name}: number exceeds the allowed size.`);
  }
  if (BigInt(draft.giveAmount) === 0n || BigInt(draft.minReceiveAmount) === 0n || BigInt(draft.expiresMinutes) === 0n) throw new Error('Amounts and expiry must be greater than zero.');
  if (policy) {
    for (const [name, value] of Object.entries({ 'Policy fee limit': policy.maxFeeSats, ...policy.protectedBalances })) {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error(`${name}: enter an integer in the allowed range.`);
    }
  }
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : 'Unknown error'; }

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    RESERVED: 'Awaiting validation', PREPARING: 'Preparing', AWAITING_APPROVAL: 'Awaiting approval',
    SIGNING: 'Signing', READY_TO_BROADCAST: 'Ready to broadcast', BROADCAST: 'Broadcast',
    CONFIRMED: 'BTC and RGB confirmed', RECONCILING: 'Reconciling', REJECTED: 'Rejected',
    CANCELLED: 'Canceled', EXPIRED: 'Expired', UNSUPPORTED: 'Unsupported',
  };
  return labels[status] ?? status;
}

export default App;
