import { useEffect, useState } from 'react';
import { initialDraft, sampleBalances, sampleOrders, sampleTrades } from './model';
import type { AssetCode, Balance, Draft, Order, Trade, View } from './model';
import { LocalClient, type ClientStatus } from './api';
import type { PrivatePolicy } from '@rgb-exchange/contracts';

const assetCodes: AssetCode[] = ['BTC', 'X', 'DUSD'];
const assetClass: Record<AssetCode, string> = { BTC: 'btc', X: 'x', DUSD: 'dusd' };
const navItems: { key: View; label: string; subtitle: string; icon: string }[] = [
  { key: 'home', label: 'Обзор', subtitle: 'Баланс и цель', icon: 'grid' },
  { key: 'market', label: 'Рынок', subtitle: 'Заявки', icon: 'arrows' },
  { key: 'trade', label: 'Сделка', subtitle: 'Проверка и подпись', icon: 'route' },
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
  return <span className={`asset-icon ${assetClass[code]} ${size === 'large' ? 'large' : ''}`} aria-hidden="true">{code === 'BTC' ? '₿' : code === 'DUSD' ? '$' : 'X'}</span>;
}

function SectionTitle({ kicker, title, action }: { kicker: string; title: string; action?: React.ReactNode }) {
  return <div className="section-title"><div><div className="eyebrow">{kicker}</div><h2>{title}</h2></div>{action}</div>;
}

function App() {
  const [view, setView] = useState<View>('home');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [clientUrl, setClientUrl] = useState('http://127.0.0.1:4101');
  const [pairToken, setPairToken] = useState('');
  const [client, setClient] = useState<LocalClient | null>(null);
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [balances, setBalances] = useState<Balance[]>(sampleBalances);
  const [orders, setOrders] = useState<Order[]>(sampleOrders);
  const [myOrder, setMyOrder] = useState<Order | null>(null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [policy, setPolicy] = useState<PrivatePolicy | null>(null);
  const [policyAssets, setPolicyAssets] = useState<{ key: string; label: string }[]>([]);
  const [sampleTradeKind, setSampleTradeKind] = useState<'direct' | 'ring'>('ring');
  const [goal, setGoal] = useState('Хочу получить 100 DUSD за X. Сохранить хотя бы половину X, BTC не продавать, комиссия до 1000 sats.');
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftChecked, setDraftChecked] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approvalAttemptedTradeId, setApprovalAttemptedTradeId] = useState<string | null>(null);
  const connected = Boolean(client && status);
  const isMock = !connected || status?.mode === 'mock';

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
        // Model download can continue after pairing; reflect QVAC readiness without reconnecting.
        void client.connect().then(health => { if (active) setStatus(health); }).catch(() => {});
      } catch (error) {
        if (active) setNotice({ tone: 'error', text: messageOf(error) });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client]);

  const connect = async () => {
    setBusy('connect'); setNotice(null);
    try {
      const next = new LocalClient(clientUrl, pairToken);
      const health = await next.connect();
      setClient(next); setStatus(health); setConnectionOpen(false);
      setBalances([]); setOrders([]); setMyOrder(null); setTrade(null); setPolicy(null); setPolicyAssets([]);
      setApprovalAttemptedTradeId(null);
      setPairToken('');
      setNotice({ tone: 'success', text: `Локальный клиент подключён · ${health.network} · ${health.mode.toUpperCase()}` });
    } catch (error) { setNotice({ tone: 'error', text: `Не удалось подключиться: ${messageOf(error)}` }); }
    finally { setBusy(null); }
  };

  const disconnect = () => {
    setClient(null); setStatus(null); setBalances(sampleBalances); setOrders(sampleOrders); setMyOrder(null); setTrade(null); setPolicy(null); setPolicyAssets([]); setApprovalAttemptedTradeId(null);
    setNotice({ tone: 'info', text: 'Локальный клиент отключён. Показаны учебные данные интерфейса.' });
  };

  const interpret = async () => {
    if (!client) { setDraftOpen(true); setNotice({ tone: 'info', text: 'QVAC недоступен без локального клиента. Заявку можно заполнить вручную.' }); return; }
    setBusy('interpret'); setNotice(null);
    try {
      const result = await client.interpret(goal);
      if (result.draft) setDraft(result.draft);
      setPolicy(result.policy); setDraftOpen(true); setDraftChecked(false);
      setNotice(result.draft ? { tone: 'success', text: 'QVAC обработал цель локально. Проверьте и подтвердите условия заявки.' } : { tone: 'info', text: result.clarification ?? 'Цель требует уточнения. Заполните условия вручную.' });
    } catch (error) { setDraftOpen(true); setNotice({ tone: 'error', text: `QVAC недоступен: ${messageOf(error)}. Используйте ручную форму.` }); }
    finally { setBusy(null); }
  };

  const checkDraft = async () => {
    setBusy('check'); setNotice(null);
    try {
      validateDraftShape(draft, policy);
      if (client) {
        if (!policy) throw new Error('Локальная политика ещё не загружена.');
        await client.checkDraft(draft, policy);
      }
      setDraftChecked(true);
      setNotice({ tone: 'success', text: client ? 'Локальная политика проверена. Публикация требует отдельного нажатия.' : 'Форма заполнена. Для проверки политики и публикации подключите локальный клиент.' });
    } catch (error) { setDraftChecked(false); setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const publish = async () => {
    if (!client || !draftChecked || !policy) return;
    setBusy('publish'); setNotice(null);
    try {
      const order = await client.publishDraft(draft, policy);
      setMyOrder(order); setDraftOpen(false); setView('market');
      setNotice({ tone: 'success', text: 'Заявка опубликована. Это не разрешение подписать транзакцию.' });
    } catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const cancelOrder = async () => {
    if (!client || !myOrder) return;
    setBusy('cancel');
    try { await client.cancelOrder(myOrder.id); setMyOrder(null); setNotice({ tone: 'info', text: 'Заявка отозвана.' }); }
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
    try { await client.approve(tradeId, digest); setNotice({ tone: 'info', text: 'Локальное разрешение передано кошельку. Следите за статусом; подтверждение RGB ещё требуется.' }); }
    catch (error) { setNotice({ tone: 'error', text: `${messageOf(error)}. Результат подписи может быть неизвестен; проверьте состояние кошелька перед новой попыткой.` }); }
    finally { setBusy(null); }
  };

  const prepare = async () => {
    if (!client || !trade) return;
    setBusy('prepare'); setNotice(null);
    try { const result = await client.prepare(trade.id); setNotice({ tone: 'info', text: `Подготовка: ${result}.` }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const preview = async () => {
    if (!client || !trade) return;
    setBusy('preview'); setNotice(null);
    try { const checked = await client.preview(trade.id); setTrade(current => current?.id === trade.id ? { ...current, validatedPreview: checked } : current); setNotice({ tone: 'success', text: 'Окончательный пакет проверен локальным кошельком. Сверьте суммы перед подписью.' }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const reject = async () => {
    if (!client || !trade) return;
    setBusy('reject'); setNotice(null);
    try { await client.reject(trade.id); setNotice({ tone: 'info', text: 'Сделка отклонена до подписи.' }); }
    catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const sync = async () => {
    if (!client || !trade) return;
    setBusy('sync'); setNotice(null);
    try {
      const receipt = await client.sync(trade.id);
      setNotice({ tone: receipt.state === 'confirmed' ? 'success' : 'info', text: `Сверка: ${receipt.state}; Bitcoin ${receipt.chainConfirmed ? 'подтверждён' : 'не подтверждён'}, RGB ${receipt.rgbAccepted ? 'принят' : 'не принят'}. ${receipt.reason ?? ''}` });
    } catch (error) { setNotice({ tone: 'error', text: messageOf(error) }); }
    finally { setBusy(null); }
  };

  const shownTrade = trade ?? sampleTrades[sampleTradeKind];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><span /><span /><span /></span><span>orbit<span className="brand-dot">.</span></span></div>
      <div className="sidebar-caption">RGB P2P EXCHANGE</div>
      <nav aria-label="Основная навигация" className="sidebar-nav">
        {navItems.map(item => <button key={item.key} type="button" className={`nav-item ${view === item.key ? 'active' : ''}`} onClick={() => setView(item.key)} aria-current={view === item.key ? 'page' : undefined}>
          <span className="nav-icon"><Icon name={item.icon} /></span><span><strong>{item.label}</strong><small>{item.subtitle}</small></span>{view === item.key && <span className="nav-marker" />}
        </button>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-help-icon"><Icon name="shield" size={19} /></div><strong>Ключи остаются у вас</strong><p>Площадка видит заявки. Кошелёк и AI работают локально.</p><span className="sidebar-version">MVP · REGTEST</span></div>
    </aside>

    <div className="main-area">
      <header className="topbar"><div className="breadcrumb">Пространство <Icon name="chevron" size={14} /> <strong>{navItems.find(item => item.key === view)?.label}</strong></div><div className="top-actions"><span className="network-pill"><span className="live-dot" /> BITCOIN REGTEST</span><button className={`wallet-button ${connected ? 'connected' : ''}`} type="button" onClick={() => setConnectionOpen(true)}><Icon name="wallet" size={17} />{connected ? `Кошелёк ${status?.walletLabel ?? 'подключён'}` : 'Подключить кошелёк'}</button></div></header>
      <main className="content">
        <div className={`mode-banner ${isMock ? 'mock' : 'real'}`} role="status"><Icon name="info" size={17} /><div><strong>{!connected ? 'Режим примера' : status?.mode === 'mock' ? 'Подключён mock-кошелёк' : 'Подключён реальный локальный клиент'}</strong><span>{!connected ? 'Все балансы, заявки и схемы ниже — учебные данные. Сделки и подпись недоступны.' : status?.mode === 'mock' ? 'Тестовый интерфейс без реальных RGB-переводов и подтверждений блокчейна.' : `Сеть ${status?.network}. Перед подписью кошелёк проверит окончательный пакет.`}</span></div></div>
        {notice && <div className={`notice ${notice.tone}`} role="alert"><span>{notice.text}</span><button type="button" onClick={() => setNotice(null)} aria-label="Закрыть сообщение"><Icon name="close" size={15} /></button></div>}

        {view === 'home' && <>
          <div className="page-heading"><div><div className="eyebrow">ВАШЕ ПРОСТРАНСТВО</div><h1>Обмен под вашим контролем<span className="accent-stop">.</span></h1><p>Опишите желаемый обмен. Локальный помощник подготовит заявку, а решение останется за вами.</p></div><div className="heading-art" aria-hidden="true"><div className="orbit-ring outer" /><div className="orbit-ring inner" /><div className="orbit-core"><Icon name="arrows" size={26} /></div><span className="orbit-node node-a">₿</span><span className="orbit-node node-b">X</span><span className="orbit-node node-c">$</span></div></div>
          <section aria-labelledby="balance-heading"><SectionTitle kicker="01 / АКТИВЫ" title="Ваши активы" action={<span className="section-note">{connected ? 'Данные локального кошелька' : 'Учебные остатки'}</span>} /><div className="balance-grid">{balances.map(balance => <article className="balance-card" key={balance.code}><div className="balance-card-top"><AssetIcon code={balance.code} size="large" /><span className="balance-code">{balance.code}</span></div><div className="balance-value">{balance.amount} <small>{balance.unit}</small></div><p>{balance.label}</p></article>)}</div><p className="asset-disclaimer">DUSD — тестовый RGB-актив для regtest. Он не обеспечен долларом и не является USDT.</p></section>
          <section className="goal-section" aria-labelledby="goal-heading"><SectionTitle kicker="02 / НОВАЯ ЗАЯВКА" title="Что вы хотите обменять?" /><div className="goal-card"><div className="goal-card-head"><div className="goal-mark"><Icon name="spark" size={23} /></div><div><strong>Помощник QVAC</strong><span>Обрабатывает цель на вашем устройстве</span></div><span className={`ai-status ${status?.qvacAvailable ? 'available' : ''}`}>{status?.qvacAvailable ? 'ДОСТУПЕН' : 'НЕ ПОДКЛЮЧЁН'}</span></div><label className="field-label" htmlFor="goal">Опишите цель и ограничения своими словами</label><textarea id="goal" value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder="Например: получить 100 DUSD за X, сохранить половину X…" /><div className="goal-actions"><span>AI предложит условия. Количества и лимиты проверит код.</span><div><button className="text-button" type="button" onClick={() => { setDraftOpen(true); setDraftChecked(false); }}>Заполнить вручную</button><button className="primary-button" type="button" onClick={() => void interpret()} disabled={busy !== null || !goal.trim()}><Icon name="spark" size={16} />{busy === 'interpret' ? 'Обработка…' : 'Подготовить заявку'}<Icon name="arrow" size={16} /></button></div></div></div></section>
          <section className="how-section" aria-labelledby="how-heading"><SectionTitle kicker="КАК ЭТО РАБОТАЕТ" title="Три шага до обмена" /><div className="step-grid"><div><span>01</span><strong>Сформулируйте цель</strong><p>QVAC локально готовит заявку. Вы редактируете и подтверждаете условия.</p></div><div><span>02</span><strong>Найдите совпадение</strong><p>Площадка ищет прямую пару или кольцо из трёх участников.</p></div><div><span>03</span><strong>Проверьте и подпишите</strong><p>Кошелёк отдельно проверяет итоговую транзакцию. Без вашего согласия подписи нет.</p></div></div></section>
        </>}

        {view === 'market' && <><div className="page-heading compact"><div><div className="eyebrow">P2P / ЗАЯВКИ</div><h1>Рынок обмена<span className="accent-stop">.</span></h1><p>Фиксированные суммы, полное исполнение. Прямые пары и кольца из трёх.</p></div><button className="primary-button" type="button" onClick={() => { setView('home'); setDraftOpen(true); }}>Новая заявка <Icon name="arrow" size={16} /></button></div>
          <div className="market-layout"><div className="panel orderbook"><div className="panel-heading"><div><span className="eyebrow">ОТКРЫТЫЕ ПРЕДЛОЖЕНИЯ</span><h2>Книга заявок</h2></div><span className="count-pill">{orders.length}</span></div><div className="table-wrap"><table><thead><tr><th>Участник</th><th>Отдаёт</th><th>Получает минимум</th><th>Статус</th></tr></thead><tbody>{orders.length ? orders.map(order => <tr key={order.id}><td><strong>{order.owner}</strong><small>{order.id}</small></td><td><span className="table-amount"><AssetIcon code={order.giveAsset} />{order.giveAmount} {order.giveAsset !== 'BTC' ? order.giveAsset : ''}</span></td><td><span className="table-amount"><AssetIcon code={order.receiveAsset} />{order.minReceiveAmount} {order.receiveAsset !== 'BTC' && !order.minReceiveAmount.includes(order.receiveAsset) ? order.receiveAsset : ''}</span></td><td><span className="status-pill open">{order.status}</span></td></tr>) : <tr><td colSpan={4} className="empty-cell">Пока нет открытых заявок.</td></tr>}</tbody></table></div><div className="panel-footer">{connected ? 'Заявки доступны серверу рынка. Приватные инструкции остаются локальными.' : 'Учебные строки. Подключите локальный клиент для настоящих заявок.'}</div></div>
          <aside className="market-side"><div className="panel my-order"><span className="eyebrow">МОЯ ЗАЯВКА</span>{myOrder ? <><h3>{myOrder.giveAmount} {myOrder.giveAsset} <span>→</span> {myOrder.minReceiveAmount} {myOrder.receiveAsset}</h3><p>Статус: {myOrder.status}. Публикация заявки не разрешает подпись.</p>{myOrder.status === 'Открыта' ? <button type="button" className="outline-button" onClick={() => void cancelOrder()} disabled={busy !== null}>Отозвать заявку</button> : <button type="button" className="outline-button" onClick={() => setView('trade')}>Смотреть сделку <Icon name="arrow" size={15} /></button>}</> : <><h3>Активной заявки нет</h3><p>Создайте заявку через QVAC или заполните форму вручную.</p><button type="button" className="outline-button" onClick={() => { setView('home'); setDraftOpen(true); }}>Создать заявку <Icon name="arrow" size={15} /></button></>}</div><div className="market-tip"><Icon name="shield" size={20} /><strong>Как происходит поиск?</strong><p>Сначала прямые пары, затем кольца. Комиссия и точные суммы показываются до подписи.</p></div></aside></div>
        </>}

        {view === 'trade' && <><div className="page-heading compact"><div><div className="eyebrow">P2P / ПРОВЕРКА</div><h1>Детали сделки<span className="accent-stop">.</span></h1><p>Один план, точные направления переводов и отдельное подтверждение кошелька.</p></div></div>
          {!trade && <div className="sample-switch" role="group" aria-label="Пример типа сделки"><span>Учебный пример:</span><button className={sampleTradeKind === 'direct' ? 'selected' : ''} type="button" onClick={() => setSampleTradeKind('direct')}>Прямой обмен</button><button className={sampleTradeKind === 'ring' ? 'selected' : ''} type="button" onClick={() => setSampleTradeKind('ring')}>Кольцо из трёх</button></div>}
          {trade && status && !(trade.kind === 'ring' ? status.wallet.ringSwap : status.wallet.directSwap) && <div className="capability-warning" role="status"><Icon name="info" size={17} /><span>{trade.kind === 'ring' ? 'Атомарный обмен втроём' : 'Прямой атомарный обмен'} не поддерживается текущим кошельком. {status.wallet.reason ?? 'Подпись недоступна.'}</span></div>}
          <div className="trade-layout"><div className="panel trade-panel">
            <div className="panel-heading trade-head"><div><span className="eyebrow">{shownTrade.kind === 'direct' ? 'ДВА УЧАСТНИКА' : 'ТРИ УЧАСТНИКА · КОЛЬЦО'}</span><h2>{shownTrade.kind === 'direct' ? 'Прямой обмен' : 'Кольцевой обмен'}</h2><small>План {shownTrade.id}</small></div><span className={`status-pill ${trade ? 'open' : 'sample'}`}>{trade ? statusLabel(shownTrade.status) : shownTrade.status}</span></div>
            <div className="flow-caption">УЧАСТНИКИ СДЕЛКИ</div>
            <div className={`trade-flow ${shownTrade.kind}`}>{shownTrade.participants.map((participant, index) => <div className={`participant-card ${participant.mine ? 'mine' : ''}`} key={`${participant.name}-${index}`}><div className="participant-avatar">{String.fromCharCode(65 + index)}</div><div><strong>{participant.name}</strong><span>Отдаёт {participant.give}</span></div></div>)}</div>
            <div className="leg-list">{shownTrade.legs.map((leg, index) => <div key={`${leg.from}-${leg.to}-${index}`}><strong>{leg.from}</strong><Icon name="arrow" size={15} /><strong>{leg.to}</strong><span>{leg.amount}</span></div>)}</div>
            <div className="trade-legend">{shownTrade.kind === 'ring' ? 'Все три передачи должны войти в один общий пакет. Последовательные переводы не являются атомарным обменом.' : 'Итоговый пакет должны проверить оба кошелька до подписи.'}</div>
            <div className="trade-summary"><div><span>Я отдаю</span><strong>{shownTrade.participants.find(p => p.mine)?.give ?? '—'}</strong></div><div><span>Я получаю</span><strong>{shownTrade.participants.find(p => p.mine)?.receive ?? '—'}</strong></div><div><span>Моя комиссия</span><strong>{shownTrade.feeSats} sats</strong></div></div>{shownTrade.reason && <div className="reason"><Icon name="info" size={16} />{shownTrade.reason}</div>}
          </div>
          <aside className="market-side"><div className="panel approval-panel"><span className="eyebrow">ОТДЕЛЬНОЕ ПОДТВЕРЖДЕНИЕ</span><h3>Перед подписью</h3>
            {trade?.validatedPreview ? <><p>Локальный кошелёк проверил окончательный пакет. Сверьте точные изменения:</p><dl><div><dt>Отдаю</dt><dd>{trade.validatedPreview.give}</dd></div><div><dt>Получаю</dt><dd>{trade.validatedPreview.receive}</dd></div><div><dt>Комиссия</dt><dd>{trade.validatedPreview.feeSats} sats</dd></div><div><dt>Изменение BTC</dt><dd>{trade.validatedPreview.btcDeltaSats} sats</dd></div></dl><button className="primary-button full" type="button" onClick={() => void approve()} disabled={busy !== null || isMock}>Разрешить подпись <Icon name="arrow" size={16} /></button></> : <><div className="approval-lock"><Icon name="shield" size={26} /></div><p>{trade ? 'Ожидаем окончательный пакет и проверку локального кошелька. Одного плана сделки недостаточно для подписи.' : 'Это учебный план. Окончательного пакета и проверки кошелька нет.'}</p>
              {trade && trade.status === 'RESERVED' && approvalAttemptedTradeId !== trade.id && <button className="outline-button full" type="button" onClick={() => void prepare()} disabled={busy !== null}>Проверить доступность сделки</button>}
              {trade && !isMock && trade.status === 'AWAITING_APPROVAL' && approvalAttemptedTradeId !== trade.id && <button className="outline-button full" type="button" onClick={() => void preview()} disabled={busy !== null}>Проверить окончательный пакет</button>}
              {(isMock || !trade || trade.status === 'UNSUPPORTED') && <button className="primary-button full" type="button" disabled>Подпись недоступна <Icon name="arrow" size={16} /></button>}
            </>}
            {trade && ['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING', 'CONFIRMED'].includes(trade.status) && <button className="outline-button full" type="button" onClick={() => void sync()} disabled={busy !== null}>Сверить Bitcoin и RGB</button>}
            {trade && approvalAttemptedTradeId === trade.id && !['SIGNING', 'READY_TO_BROADCAST', 'BROADCAST', 'RECONCILING', 'CONFIRMED'].includes(trade.status) && <button className="outline-button full" type="button" onClick={() => void sync()} disabled={busy !== null}>Уточнить результат подписи</button>}
            {trade && approvalAttemptedTradeId !== trade.id && ['RESERVED', 'PREPARING', 'AWAITING_APPROVAL'].includes(trade.status) && <button className="text-button danger reject-button" type="button" onClick={() => void reject()} disabled={busy !== null}>Отклонить сделку</button>}
            <div className="approval-foot">Подтверждение заявки выше не заменяет разрешение подписи.</div>
          </div></aside></div>
        </>}
      </main>
      <footer className="footer"><span>Orbit · RGB P2P Exchange</span><span>Regtest · BTC + тестовые RGB X и DUSD</span></footer>
    </div>

    {connectionOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setConnectionOpen(false); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title"><div className="modal-head"><div className="modal-icon"><Icon name="wallet" size={21} /></div><button type="button" onClick={() => setConnectionOpen(false)} aria-label="Закрыть"><Icon name="close" size={18} /></button></div><div className="eyebrow">ЛОКАЛЬНЫЙ КОШЕЛЁК</div><h2 id="connection-title">Подключение к клиенту</h2><p>Браузер обращается только к адресу на этом устройстве. Введите локальный pairing token; он хранится в памяти вкладки.</p><label className="field-label" htmlFor="client-url">Адрес локального API</label><input id="client-url" value={clientUrl} onChange={event => setClientUrl(event.target.value)} inputMode="url" spellCheck={false} /><label className="field-label" htmlFor="pair-token">Pairing token</label><input id="pair-token" type="password" value={pairToken} onChange={event => setPairToken(event.target.value)} autoComplete="off" placeholder="Введите локальный токен" /><div className="modal-actions">{connected && <button type="button" className="text-button danger" onClick={() => { disconnect(); setConnectionOpen(false); }}>Отключить</button>}<button type="button" className="primary-button" onClick={() => void connect()} disabled={busy !== null || !pairToken.trim()}>{busy === 'connect' ? 'Подключение…' : 'Подключить'} <Icon name="arrow" size={16} /></button></div></div></div>}

    {draftOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDraftOpen(false); }}><div className="modal draft-modal" role="dialog" aria-modal="true" aria-labelledby="draft-title">
      <div className="modal-head"><div className="modal-icon"><Icon name="arrows" size={21} /></div><button type="button" onClick={() => setDraftOpen(false)} aria-label="Закрыть"><Icon name="close" size={18} /></button></div>
      <div className="eyebrow">УСЛОВИЯ ЗАЯВКИ</div><h2 id="draft-title">Проверьте обмен</h2><p>Один актив на один актив, фиксированные суммы. Публикация разрешает поиск пары, но не расход средств.</p>
      <div className="draft-grid">
        <div><label className="field-label" htmlFor="give-asset">Отдаю</label><select id="give-asset" value={draft.giveAsset} onChange={event => updateDraft({ giveAsset: event.target.value as AssetCode })}>{assetCodes.map(code => <option key={code}>{code}</option>)}</select></div>
        <div><label className="field-label" htmlFor="give-amount">Количество {draft.giveAsset === 'BTC' ? 'в sats' : 'в единицах'}</label><input id="give-amount" value={draft.giveAmount} onChange={event => updateDraft({ giveAmount: event.target.value })} inputMode="numeric" /></div>
        <div><label className="field-label" htmlFor="receive-asset">Получаю</label><select id="receive-asset" value={draft.receiveAsset} onChange={event => updateDraft({ receiveAsset: event.target.value as AssetCode })}>{assetCodes.map(code => <option key={code}>{code}</option>)}</select></div>
        <div><label className="field-label" htmlFor="receive-amount">Не меньше {draft.receiveAsset === 'BTC' ? 'sats' : 'единиц'}</label><input id="receive-amount" value={draft.minReceiveAmount} onChange={event => updateDraft({ minReceiveAmount: event.target.value })} inputMode="numeric" /></div>
        <div><label className="field-label" htmlFor="max-fee">Макс. комиссия заявки, sats</label><input id="max-fee" value={draft.maxFeeSats} onChange={event => updateDraft({ maxFeeSats: event.target.value })} inputMode="numeric" /></div>
        <div><label className="field-label" htmlFor="expires">Действует, минут</label><input id="expires" value={draft.expiresMinutes} onChange={event => updateDraft({ expiresMinutes: event.target.value })} inputMode="numeric" /></div>
      </div>
      {policy && <div className="policy-block"><div className="policy-heading"><Icon name="shield" size={17} /><strong>Локальные ограничения</strong><span>не видны рынку</span></div><div className="draft-grid">
        <div><label className="field-label" htmlFor="policy-fee">Лимит комиссии политики, sats</label><input id="policy-fee" value={policy.maxFeeSats} onChange={event => updatePolicy({ maxFeeSats: event.target.value })} inputMode="numeric" /></div>
        <label className="policy-toggle"><input type="checkbox" checked={policy.allowBtcSale} onChange={event => updatePolicy({ allowBtcSale: event.target.checked })} /><span>Разрешить продажу BTC</span></label>
      </div><div className="policy-reserves"><span className="field-label">Защищённый остаток после обмена, минимальные единицы</span>{policyAssets.map(asset => <label key={asset.key}><span>{asset.label}</span><input value={policy.protectedBalances[asset.key] ?? '0'} onChange={event => updatePolicy({ protectedBalances: { ...policy.protectedBalances, [asset.key]: event.target.value } })} inputMode="numeric" /></label>)}</div></div>}
      <div className="draft-note"><Icon name="shield" size={17} />{connected ? 'Политика, остатки и сети проверяются локально. Изменения политики применяются при публикации.' : 'Учебная форма: локальная политика и остатки не проверены.'}</div>
      <div className="modal-actions"><button className="outline-button" type="button" onClick={() => void checkDraft()} disabled={busy !== null}>{busy === 'check' ? 'Проверка…' : 'Проверить условия'}</button><button className="primary-button" type="button" onClick={() => void publish()} disabled={!connected || !draftChecked || busy !== null}>{busy === 'publish' ? 'Публикация…' : 'Подтвердить и опубликовать'} <Icon name="arrow" size={16} /></button></div>
    </div></div>}
  </div>;

  function updateDraft(change: Partial<Draft>) { setDraft(current => ({ ...current, ...change })); setDraftChecked(false); }
  function updatePolicy(change: Partial<PrivatePolicy>) { setPolicy(current => current ? { ...current, ...change } : current); setDraftChecked(false); }
}

function validateDraftShape(draft: Draft, policy: PrivatePolicy | null) {
  if (draft.giveAsset === draft.receiveAsset) throw new Error('Активы должны различаться.');
  for (const [name, value] of Object.entries({ 'Количество отдачи': draft.giveAmount, 'Минимум получения': draft.minReceiveAmount, 'Комиссия': draft.maxFeeSats, 'Время действия': draft.expiresMinutes })) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name}: введите целое число в минимальных единицах.`);
    if (BigInt(value) > 18446744073709551615n) throw new Error(`${name}: число превышает допустимый размер.`);
  }
  if (BigInt(draft.giveAmount) === 0n || BigInt(draft.minReceiveAmount) === 0n || BigInt(draft.expiresMinutes) === 0n) throw new Error('Суммы и время действия должны быть больше нуля.');
  if (policy) {
    for (const [name, value] of Object.entries({ 'Лимит комиссии политики': policy.maxFeeSats, ...policy.protectedBalances })) {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error(`${name}: введите целое число в допустимом диапазоне.`);
    }
  }
}

function messageOf(error: unknown) { return error instanceof Error ? error.message : 'Неизвестная ошибка'; }

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    RESERVED: 'Ожидает проверки', PREPARING: 'Подготовка', AWAITING_APPROVAL: 'Ожидает подписи',
    SIGNING: 'Подпись', READY_TO_BROADCAST: 'Готова к отправке', BROADCAST: 'В сети Bitcoin',
    CONFIRMED: 'BTC и RGB подтверждены', RECONCILING: 'Сверка состояния', REJECTED: 'Отклонена',
    CANCELLED: 'Отменена', EXPIRED: 'Истекла', UNSUPPORTED: 'Не поддерживается',
  };
  return labels[status] ?? status;
}

export default App;
