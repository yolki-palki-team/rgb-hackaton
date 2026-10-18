import { ChatInput, ChatInputTextArea, ChatInputSubmit } from './components/ui/chat-input';
import {
  AssetRow,
  Button,
  Icon,
  Input,
  Panel,
  StatusBadge,
  WalletSkeleton,
} from './components/ui/wallet-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FundingPanel } from './FundingPanel';
import { AssetSelect } from './components/ui/asset-select';
import { MatrixRain } from './components/ui/matrix-rain';
import { MorphingSquare } from './components/ui/morphing-square';
import { OrderHistory } from './components/OrderHistory';
import {
  completionKey,
  dismissCompletion,
  isCompletionDismissed,
  isFinishedTrade,
  sortBalances,
} from './dashboard';
import { initialDraft, sampleBalances, sampleOrders, sampleTrades } from './model';
import type { Balance, Draft, Order, Trade, View } from './model';
import { LocalClient, type ClientStatus } from './api';
import { TradeWorkflow, nextTradeAction, tradeProgress } from './workflow';
import { prepareGoalReply, requestGoalReview } from './goal-review';
import type { PrivatePolicy } from '@rgb-exchange/contracts';

const goalExamples = [
  'Can I swap 10 X for at least 5 DUSD?',
  'What can I get for 0.0001 BTC?',
  'Can I swap 5 X with a 500-sat fee limit?',
];
const navItems: { key: View; label: string; subtitle: string; icon: string }[] = [
  { key: 'home', label: 'Overview', subtitle: 'Balances and goal', icon: 'grid' },
  { key: 'trade', label: 'Trade', subtitle: 'Review and sign', icon: 'route' },
  { key: 'topup', label: 'Top up', subtitle: 'Add BTC', icon: 'wallet' },
];

function App() {
  const [view, setView] = useState<View>('home');
  const [assetsExpanded, setAssetsExpanded] = useState(false);
  const [offerIndex, setOfferIndex] = useState(0);
  const [dismissedCompletion, setDismissedCompletion] = useState<string | null>(null);
  const [tradeRequest, setTradeRequest] = useState<{
    tradeId?: string;
    orderId?: string;
    finished?: boolean;
    version: number;
  }>({ version: 0 });
  const openTrade = (selection: { tradeId?: string; orderId?: string } = {}) => {
    setTradeRequest((current) => ({
      ...selection,
      finished: Boolean(
        selection.tradeId && trade?.id === selection.tradeId && isFinishedTrade(trade),
      ),
      version: current.version + 1,
    }));
    setView('trade');
  };
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [pairToken, setPairToken] = useState('');
  const [client, setClient] = useState<LocalClient | null>(null);
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [myOrder, setMyOrder] = useState<Order | null>(null);
  const [trade, setTrade] = useState<Trade | null>(null);
  const [policyAssets, setPolicyAssets] = useState<{ key: string; label: string }[]>([]);
  const [sampleTradeKind, setSampleTradeKind] = useState<'direct' | 'ring'>('ring');
  const [samplePreview, setSamplePreview] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletUpdatedAt, setWalletUpdatedAt] = useState<number | null>(null);
  const [walletRefreshing, setWalletRefreshing] = useState(false);
  const [walletCached, setWalletCached] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const desktopConnectStarted = useRef(false);
  const [goal, setGoal] = useState('');
  const focusGoalReply = useRef(false);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [draftOpen, setDraftOpen] = useState(false);
  const [notice, setNotice] = useState<{
    tone: 'error' | 'success' | 'info';
    text: string;
    replyToGoal?: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(window.palkaWallet ? 'connect' : null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const workflow = useRef(new TradeWorkflow());
  const foregroundBusy = useRef(busy);
  foregroundBusy.current = busy;
  const currentView = useRef(view);
  currentView.current = view;
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowPaused, setWorkflowPaused] = useState(false);
  const connected = Boolean(client && status);
  const desktop = Boolean(window.palkaWallet);
  const initialLoading = busy === 'connect' || snapshotLoading;
  const isMock = status?.mode === 'mock';
  const ready =
    connected &&
    Boolean(status?.wallet) &&
    !syncError &&
    !walletError &&
    !walletRefreshing &&
    !walletCached &&
    balances.length > 0;
  const connectionError = syncError ?? status?.walletError ?? walletError;
  const visibleBalances = sortBalances(connected ? balances : samplePreview ? sampleBalances : []);
  const visibleOrders = connected ? orders : samplePreview ? sampleOrders : [];
  const selectedOfferIndex = selectedOfferId
    ? visibleOrders.findIndex((order) => order.id === selectedOfferId)
    : -1;
  const currentOfferIndex = Math.min(
    selectedOfferIndex >= 0 ? selectedOfferIndex : offerIndex,
    Math.max(0, visibleOrders.length - 1),
  );
  const runningTrade = trade && !isFinishedTrade(trade) ? trade : null;
  const completedKey =
    status && trade?.status === 'CONFIRMED' ? completionKey(status, trade.id) : null;
  const showCompletion =
    completedKey && dismissedCompletion !== completedKey && !isCompletionDismissed(completedKey);
  const loadHistory = useCallback(
    (cursor?: string) => {
      if (!client) throw new Error('Pair the wallet first.');
      return client.history(cursor);
    },
    [client],
  );

  useEffect(() => {
    if (!draftOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[aria-labelledby="draft-title"]');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') setDraftOpen(false);
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ),
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [draftOpen]);

  useEffect(() => {
    if (!notice || notice.tone === 'error' || notice.replyToGoal !== undefined) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!focusGoalReply.current) return;
    const input = document.querySelector<HTMLTextAreaElement>('#goal');
    if (!input) return;
    focusGoalReply.current = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = input.scrollHeight;
  }, [goal, view]);

  const connect = useCallback(async () => {
    setBusy('connect');
    setSnapshotLoading(true);
    setNotice(null);
    try {
      const next = new LocalClient(desktop ? undefined : pairToken);
      const health = await next.connect();
      const savedWallet = next.cachedWallet() ?? (await next.refreshWallet());
      setClient(next);
      setStatus(health);
      setConnectionOpen(false);
      setSamplePreview(false);
      setSyncError(null);
      setWalletError(savedWallet.walletError ?? null);
      setWalletUpdatedAt(savedWallet.updatedAt);
      setWalletCached(savedWallet.cached);
      setWalletRefreshing(false);
      setBalances(savedWallet.balances);
      setOrders([]);
      setMyOrder(null);
      setTrade(null);
      setPolicyAssets(savedWallet.policyAssets);
      workflow.current = new TradeWorkflow();
      setWorkflowRunning(false);
      setWorkflowError(null);
      setWorkflowPaused(false);
      setPairToken('');
      setNotice({
        tone: 'success',
        text: health.wallet
          ? `Welcome back. Your ${health.network} wallet is connected.`
          : 'Local profile connected. Order history is available while the wallet reconnects.',
      });
    } catch (error) {
      setSnapshotLoading(false);
      setNotice({ tone: 'error', text: `Could not connect: ${messageOf(error)}` });
    } finally {
      setBusy(null);
    }
  }, [desktop, pairToken]);

  useEffect(() => {
    if (!client) return;
    setMarketLoading(true);
    let active = true;
    let progressTimer: ReturnType<typeof setTimeout>;
    let walletTimer: ReturnType<typeof setTimeout>;
    let healthChecked = Date.now();
    let marketLoaded = false;
    let latestTrade: Trade | null = null;
    const currentWorkflow = workflow.current;
    const refreshProgress = async () => {
      try {
        const data = await client.progressSnapshot();
        if (!active) return;
        marketLoaded = true;
        latestTrade = data.trade;
        setOrders(data.orders);
        setMyOrder(data.myOrder);
        setTrade(
          data.trade && foregroundBusy.current === 'approve'
            ? { ...data.trade, validatedPreview: undefined }
            : data.trade,
        );
        setSyncError(null);
        if (
          data.trade &&
          !foregroundBusy.current &&
          !currentWorkflow.running &&
          client.supportsTrade(data.trade)
        ) {
          setWorkflowRunning(true);
          // Status reads continue while the wallet prepares or reconciles a trade.
          void currentWorkflow.advance(client, data.trade).then((checked) => {
            if (!active) return;
            if (checked && !foregroundBusy.current)
              setTrade((current) =>
                current && current.id === data.trade?.id && nextTradeAction(current) === 'preview'
                  ? { ...current, validatedPreview: checked }
                  : current,
              );
            setWorkflowError(currentWorkflow.error);
            setWorkflowPaused(currentWorkflow.paused);
            setWorkflowRunning(false);
          });
        }
      } catch (error) {
        if (active) setSyncError(messageOf(error));
      } finally {
        if (active) {
          setMarketLoading(false);
          setSnapshotLoading(false);
          progressTimer = setTimeout(() => void refreshProgress(), 3000);
        }
      }
    };
    const refreshBalances = async () => {
      let delay = 3000;
      try {
        if (
          !marketLoaded ||
          foregroundBusy.current ||
          currentWorkflow.running ||
          currentView.current === 'topup'
        )
          return;
        if (Date.now() - healthChecked >= 30_000) {
          const health = await client.connect();
          if (!active) return;
          setStatus(health);
          healthChecked = Date.now();
        }
        if (
          latestTrade &&
          !['CONFIRMED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED'].includes(
            latestTrade.status,
          )
        )
          return;
        if (foregroundBusy.current || currentWorkflow.running) return;
        delay = 30_000;
        setWalletRefreshing(true);
        const data = await client.refreshWallet();
        if (!active) return;
        setBalances(data.balances);
        setPolicyAssets(data.policyAssets);
        setWalletError(data.walletError ?? null);
        setWalletUpdatedAt(data.updatedAt);
        setWalletCached(data.cached);
        const codes = data.balances.map((balance) => balance.code);
        if (codes.length >= 2)
          setDraft((current) =>
            codes.includes(current.giveAsset) && codes.includes(current.receiveAsset)
              ? current
              : { ...current, giveAsset: codes[0], receiveAsset: codes[1] },
          );
      } catch (error) {
        if (active) setWalletError(messageOf(error));
      } finally {
        if (active) {
          setWalletRefreshing(false);
          walletTimer = setTimeout(() => void refreshBalances(), delay);
        }
      }
    };
    void refreshProgress();
    void refreshBalances();
    return () => {
      active = false;
      clearTimeout(progressTimer);
      clearTimeout(walletTimer);
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refreshModel = async () => {
      try {
        const health = await client.qvacHealth();
        if (active)
          setStatus((current) =>
            current
              ? {
                  ...current,
                  qvacAvailable: health.available,
                  qvacState: health.state,
                  qvacReason: health.reason,
                }
              : current,
          );
      } catch {
        // A transport failure is not evidence that the model is unavailable.
      } finally {
        if (active) timer = setTimeout(() => void refreshModel(), 10_000);
      }
    };
    void refreshModel();
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
        setView('home');
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
    setPolicyAssets([]);
    workflow.current = new TradeWorkflow();
    setSyncError(null);
    setWalletError(null);
    setWalletUpdatedAt(null);
    setWalletRefreshing(false);
    setWorkflowRunning(false);
    setWorkflowError(null);
    setWorkflowPaused(false);
    setSnapshotLoading(false);
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
    setBusy('interpret');
    try {
      await requestGoalReview(
        (text) => client.interpret(text),
        goal,
        (review) => {
          setDraftOpen(review.state === 'review');
          if (review.state === 'loading') {
            setDraft({ ...initialDraft });
            setNotice(null);
            return;
          }
          if (review.state === 'error') {
            setNotice({ tone: 'error', text: `Could not interpret the goal: ${review.message}` });
            return;
          }
          setStatus((current) =>
            current
              ? { ...current, qvacAvailable: true, qvacState: 'ready', qvacReason: undefined }
              : current,
          );
          if (review.state === 'review') {
            setDraft(review.draft);
            setNotice({
              tone: 'success',
              text: 'QVAC interpreted the goal locally. Review and confirm the order terms.',
            });
          } else {
            setNotice({ tone: 'info', text: review.message, replyToGoal: goal });
          }
        },
      );
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!client || !ready) return;
    setBusy('publish');
    setNotice(null);
    try {
      const policy: PrivatePolicy = {
        allowedAssetKeys: policyAssets.map((asset) => asset.key),
        protectedBalances: {},
        maxFeeSats: draft.maxFeeSats,
        allowBtcSale: true,
      };
      validateDraftShape(draft, policy);
      await client.checkDraft(draft, policy);
      const order = await client.publishDraft(draft, policy);
      setMyOrder(order);
      setDraftOpen(false);
      setView('home');
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

  const liveTradeContent = (
    <>
      {trade &&
        status &&
        !(trade.kind === 'ring' ? status.wallet?.ringSwap : status.wallet?.directSwap) && (
          <div className="capability-warning" role="status">
            <span>
              {trade.kind === 'ring' ? 'Three-party atomic swap' : 'Direct atomic swap'} is not
              supported by this wallet.{' '}
              {status.wallet?.reason ?? status.walletError ?? 'Signing unavailable.'}
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
      {trade && connected && (
        <section className="swap-progress" aria-label="Swap progress" aria-live="polite">
          <div className="progress-heading">
            {tradeProgress(trade, busy === 'approve').waiting &&
              !workflowPaused &&
              !syncError &&
              client?.supportsTrade(trade) && (
                <MorphingSquare
                  className="h-6 w-6"
                  wrapperClassName="mt-1 shrink-0"
                  aria-hidden="true"
                />
              )}
            <div>
              <h2>
                {workflowPaused
                  ? 'Your swap needs attention'
                  : tradeProgress(trade, busy === 'approve').title}
              </h2>
              <p>
                {workflowPaused
                  ? 'We couldn’t finish this step. Your approval and transaction history are saved. Check the details, then try again.'
                  : tradeProgress(trade, busy === 'approve').detail}
              </p>
            </div>
          </div>
          <ol className="progress-steps">
            {['Prepare', 'Your approval', 'All wallets', 'Confirmation'].map((label, index) => (
              <li
                key={label}
                className={
                  tradeProgress(trade, busy === 'approve').step > index
                    ? 'done'
                    : tradeProgress(trade, busy === 'approve').step === index
                      ? 'current'
                      : ''
                }
                aria-current={
                  tradeProgress(trade, busy === 'approve').step === index ? 'step' : undefined
                }
              >
                <span>
                  {tradeProgress(trade, busy === 'approve').step > index ? '✓' : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
          {workflowError && (
            <details className="technical-details">
              <summary>{workflowPaused ? 'What happened?' : 'Reconnecting automatically…'}</summary>
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
        <div
          className={`trade-layout ${isFinishedTrade(shownTrade) ? 'trade-layout-finished' : ''}`}
        >
          <Panel className="panel trade-panel">
            <div className="panel-heading trade-head">
              <div>
                <span className="eyebrow">
                  {shownTrade.kind === 'direct' ? 'TWO PARTICIPANTS' : 'THREE PARTICIPANTS · RING'}
                </span>
                <h2>{shownTrade.kind === 'direct' ? 'Direct swap' : 'Ring swap'}</h2>
                <details className="technical-details">
                  <summary>Transaction details</summary>
                  <p>Plan {shownTrade.id}</p>
                  {shownTrade.txid && (
                    <p className="reason">
                      Bitcoin transaction: {shownTrade.txid}
                      <br />
                      Bitcoin {shownTrade.chainConfirmed ? 'confirmed' : 'unconfirmed'} · RGB{' '}
                      {shownTrade.rgbAccepted ? 'accepted' : 'not accepted'}
                    </p>
                  )}
                </details>
              </div>
              <StatusBadge className={`status-pill ${trade ? 'open' : 'sample'}`}>
                {trade ? statusLabel(shownTrade.status) : shownTrade.status}
              </StatusBadge>
            </div>
            <div className="flow-caption">TRADE PARTICIPANTS</div>
            <div className="trade-flow" data-trade-kind={shownTrade.kind}>
              {shownTrade.participants.map((participant, index) => (
                <div
                  className={`participant-card ${participant.mine ? 'mine' : ''}`}
                  key={`${participant.name}-${index}`}
                >
                  <div className="participant-avatar">{String.fromCharCode(65 + index)}</div>
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
                <strong>{shownTrade.participants.find((p) => p.mine)?.receive ?? '—'}</strong>
              </div>
              <div>
                <span>My fee</span>
                <strong>{shownTrade.feeSats} sats</strong>
              </div>
            </div>
            {shownTrade.reason && <div className="reason">{shownTrade.reason}</div>}
          </Panel>
          {(!shownTrade || !isFinishedTrade(shownTrade)) && (
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
                  </>
                ) : (
                  <>
                    <p>
                      {trade
                        ? tradeProgress(trade, busy === 'approve').detail
                        : 'This is a sample plan. Connect your wallet to start a real swap.'}
                    </p>
                    {(isMock || !trade || trade.status === 'UNSUPPORTED') && (
                      <Button className="primary-button full" disabled>
                        Signing unavailable
                      </Button>
                    )}
                  </>
                )}
                {(trade?.validatedPreview || busy === 'approve') && (
                  <Button
                    className="primary-button full"
                    onClick={() => void approve()}
                    disabled={
                      busy !== null ||
                      workflowRunning ||
                      Boolean(syncError) ||
                      !trade?.validatedPreview ||
                      !client?.supportsTrade(trade)
                    }
                    loading={busy === 'approve'}
                    loadingText="Signing transaction…"
                  >
                    Review & sign <Icon name="arrow" size={16} />
                  </Button>
                )}
                {trade &&
                  !trade.recoveryRequired &&
                  ['RESERVED', 'PREPARING', 'AWAITING_APPROVAL'].includes(trade.status) && (
                    <Button
                      className="text-button danger reject-button"
                      type="button"
                      onClick={() => void reject()}
                      loading={busy === 'reject'}
                      loadingText="Cancelling swap…"
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
          )}
        </div>
      )}
    </>
  );

  return (
    <div className="app-shell">
      {!desktop && (
        <MatrixRain
          className="wallet-rain"
          background="#080808"
          color="#b5b5b5"
          highlight="#eeeeee"
          density={0.55}
          fontSize={18}
          glow={1}
          speed={0.65}
        />
      )}
      <div className="main-area">
        <header className="topbar">
          <button className="site-brand" onClick={() => setView('home')} aria-label="pálka home">
            p<span className="brand-stress">a</span>lka
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
        </header>
        <main className="content">
          {(!connected || isMock || connectionError || busy === 'connect') && (
            <div className={`mode-banner ${connected && !isMock ? 'real' : 'mock'}`} role="status">
              {busy === 'connect' && (
                <MorphingSquare className="h-4 w-4 bg-current" aria-hidden="true" />
              )}
              <div>
                <strong>
                  {busy === 'connect'
                    ? 'Connecting…'
                    : !connected
                      ? samplePreview
                        ? 'Sample preview · disconnected'
                        : 'Local wallet unavailable'
                      : connectionError
                        ? syncError
                          ? 'Refreshing market progress'
                          : 'Wallet balances unavailable'
                        : 'Mock wallet connected'}
                </strong>
                {busy !== 'connect' && (
                  <span>
                    {!connected
                      ? samplePreview
                        ? 'Synthetic balances and plans are shown for UI preview only. Trading and signing are unavailable.'
                        : 'Pair the local wallet to load balances, network, orders, and QVAC status.'
                      : connectionError
                        ? syncError
                          ? 'The last known orders and swap status are shown while the market reconnects.'
                          : 'Order history and swap progress remain available. Cached balances cannot validate a new order; your wallet rechecks every signature.'
                        : 'Demo wallet: matching works, BTC/RGB signing and broadcast are unsupported.'}
                  </span>
                )}
                {connectionError && (
                  <details className="technical-details">
                    <summary>Connection details</summary>
                    <p>{connectionError}</p>
                  </details>
                )}
              </div>
              {!connected && busy !== 'connect' && (
                <Button
                  className="text-button"
                  type="button"
                  onClick={() => setConnectionOpen(true)}
                >
                  {desktop ? 'Reconnect' : 'Connect wallet'}
                </Button>
              )}
              {!connected && busy !== 'connect' && (
                <Button
                  className="text-button sample-action"
                  type="button"
                  onClick={() => setSamplePreview((current) => !current)}
                >
                  {samplePreview ? 'Exit sample preview' : 'Preview sample data'}
                </Button>
              )}
            </div>
          )}
          {notice && view !== 'topup' && (
            <div className={`notice ${notice.tone}`} role="alert">
              <div className="notice-content">
                <span>{notice.text}</span>
                {notice.replyToGoal !== undefined && (
                  <Button
                    type="button"
                    className="notice-reply"
                    disabled={busy !== null || !connected}
                    onClick={() => {
                      focusGoalReply.current = true;
                      setGoal(prepareGoalReply(notice.replyToGoal!, notice.text, goal));
                      setView('home');
                      setNotice(null);
                    }}
                  >
                    Reply
                  </Button>
                )}
              </div>
              <Button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message">
                <Icon name="close" size={15} />
              </Button>
            </div>
          )}

          {view === 'home' && trade && showCompletion && (
            <div className="completion-notice" role="status">
              <span className="completion-check" aria-hidden="true">
                ✓
              </span>
              <strong>Swap complete</strong>
              <Button className="completion-open" onClick={() => openTrade({ tradeId: trade.id })}>
                View swap <Icon name="arrow" size={17} />
              </Button>
              <Button
                className="completion-dismiss"
                aria-label="Dismiss completed swap"
                onClick={() => {
                  if (!completedKey) return;
                  const saved = dismissCompletion(completedKey);
                  setDismissedCompletion(completedKey);
                  if (!saved)
                    setNotice({
                      tone: 'info',
                      text: 'Hidden for this session. Local storage is unavailable, so this notice may return after reopening.',
                    });
                }}
              >
                <Icon name="close" size={16} />
              </Button>
            </div>
          )}
          {initialLoading && (
            <>
              {busy !== 'connect' && (
                <MorphingSquare message="Loading wallet data…" wrapperClassName="py-8" />
              )}
              <WalletSkeleton />
            </>
          )}
          {view === 'home' && !initialLoading && (
            <>
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
              <div className="dashboard-grid">
                <section className="ui-panel panel goal-section" aria-labelledby="goal-heading">
                  <div className="composer-heading">
                    <h1 id="goal-heading">What would you like to swap?</h1>
                    <StatusBadge className="ai-status">
                      {status?.qvacState === 'loading' && (
                        <MorphingSquare className="h-3 w-3 bg-current" aria-hidden="true" />
                      )}
                      QVAC ·{' '}
                      {status?.qvacAvailable
                        ? 'LOCAL'
                        : status?.qvacState === 'loading'
                          ? 'LOADING'
                          : connected
                            ? 'UNAVAILABLE'
                            : 'OFFLINE'}
                    </StatusBadge>
                  </div>
                  {connected && !status?.qvacAvailable && (
                    <p className="qvac-reason" role="status">
                      {status?.qvacReason ??
                        'Local model unavailable. Retry the goal or fill in the terms manually.'}
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
                      examples={goalExamples}
                    />
                    <div className="composer-actions">
                      <Button
                        className="text-button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (connected || samplePreview) {
                            setDraft({
                              ...initialDraft,
                              giveAsset: visibleBalances[0]?.code ?? 'X',
                              receiveAsset: visibleBalances[1]?.code ?? 'DUSD',
                            });
                            setDraftOpen(true);
                          } else
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
                    Private on this device
                  </p>
                </section>
                <section className="overview-assets" aria-labelledby="balance-heading">
                  <Panel className="panel">
                    <div className="panel-heading">
                      <div>
                        <span className="eyebrow">YOUR WALLET</span>
                        <h2 id="balance-heading">Your assets</h2>
                      </div>
                      <div className="section-note">
                        {connected ? (
                          walletRefreshing ? (
                            <MorphingSquare
                              message="Refreshing…"
                              messagePlacement="right"
                              className="h-3 w-3 bg-current"
                            />
                          ) : walletError || walletCached ? (
                            'Cached'
                          ) : (
                            'Last checked'
                          )
                        ) : samplePreview ? (
                          'Synthetic preview'
                        ) : (
                          'Unavailable'
                        )}
                      </div>
                    </div>
                    {visibleBalances.length ? (
                      <ul className="asset-list" aria-label="Wallet balances">
                        {(assetsExpanded ? visibleBalances : visibleBalances.slice(0, 3)).map(
                          (balance) => (
                            <AssetRow key={balance.code} balance={balance} />
                          ),
                        )}
                      </ul>
                    ) : connected && walletRefreshing ? (
                      <MorphingSquare
                        message="Loading your assets…"
                        wrapperClassName="empty-state py-8"
                      />
                    ) : (
                      <p className="empty-state" role="status">
                        {connected
                          ? walletError || status?.walletError
                            ? 'Wallet balances are unavailable. Check the local backend.'
                            : trade &&
                                ![
                                  'CONFIRMED',
                                  'REJECTED',
                                  'CANCELLED',
                                  'EXPIRED',
                                  'FAILED',
                                  'UNSUPPORTED',
                                ].includes(trade.status)
                              ? 'Balances refresh after the active swap. Progress and signing checks remain available.'
                              : walletUpdatedAt
                                ? 'No assets found in this wallet.'
                                : 'Waiting for the next balance check.'
                          : 'No wallet connected. Pair the local backend to load balances.'}
                      </p>
                    )}
                    {visibleBalances.length > 3 && (
                      <Button
                        className="assets-toggle"
                        aria-expanded={assetsExpanded}
                        onClick={() => setAssetsExpanded((current) => !current)}
                      >
                        {assetsExpanded
                          ? 'Show fewer assets'
                          : `Show all ${visibleBalances.length} assets`}
                        <span className={assetsExpanded ? 'chevron-up' : 'chevron-down'}>
                          <Icon name="chevron" size={15} />
                        </span>
                      </Button>
                    )}
                    {walletUpdatedAt && (
                      <p className="asset-disclaimer" role="status">
                        Updated{' '}
                        <time dateTime={new Date(walletUpdatedAt).toISOString()}>
                          {new Date(walletUpdatedAt).toLocaleTimeString()}
                        </time>
                        {walletError && ' · Refresh failed; showing saved balances.'}
                      </p>
                    )}
                  </Panel>
                </section>
                <Panel className="panel orderbook">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">OPEN OFFERS</span>
                      <h2>Open orders</h2>
                    </div>
                    <StatusBadge className="count-pill">{visibleOrders.length}</StatusBadge>
                  </div>
                  <div className="order-list">
                    {visibleOrders.length ? (
                      visibleOrders.slice(currentOfferIndex, currentOfferIndex + 1).map((order) => (
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
                              <small>{order.fillSummary ? 'Total offer' : 'Gives'}</small>
                              <strong>
                                {order.giveAmount}{' '}
                                {order.giveAsset !== 'BTC' ? order.giveAsset : ''}
                              </strong>
                            </div>
                            <Icon name="arrow" size={20} />
                            <div>
                              <small>
                                {order.fillSummary ? 'Total receive at least' : 'Receives at least'}
                              </small>
                              <strong>
                                {order.minReceiveAmount}{' '}
                                {order.receiveAsset !== 'BTC' &&
                                !order.minReceiveAmount.includes(order.receiveAsset)
                                  ? order.receiveAsset
                                  : ''}
                              </strong>
                            </div>
                          </div>
                          {order.fillSummary && (
                            <p className="order-fill-progress">
                              {order.fillSummary}
                              <br />
                              Minimum fill {order.minimumFill}
                            </p>
                          )}
                        </article>
                      ))
                    ) : connected && marketLoading ? (
                      <MorphingSquare
                        message="Loading orders…"
                        wrapperClassName="empty-state py-8"
                      />
                    ) : (
                      <p className="empty-state">
                        {connected
                          ? 'No open orders yet. Your next swap starts with an order.'
                          : 'Connect your wallet to see open orders.'}
                      </p>
                    )}
                  </div>
                  <div className="order-pagination" aria-label="Order book pages">
                    <span>
                      {visibleOrders.length
                        ? `${currentOfferIndex + 1} of ${visibleOrders.length}`
                        : 'No open offers'}
                    </span>
                    <div>
                      <Button
                        aria-label="Previous order"
                        disabled={currentOfferIndex === 0}
                        onClick={() => {
                          setSelectedOfferId(null);
                          setOfferIndex(currentOfferIndex - 1);
                        }}
                      >
                        <span className="previous-arrow">
                          <Icon name="chevron" size={17} />
                        </span>
                      </Button>
                      <Button
                        aria-label="Next order"
                        disabled={currentOfferIndex >= visibleOrders.length - 1}
                        onClick={() => {
                          setSelectedOfferId(null);
                          setOfferIndex(currentOfferIndex + 1);
                        }}
                      >
                        <Icon name="chevron" size={17} />
                      </Button>
                    </div>
                  </div>
                </Panel>
                <Panel className="panel running-orders">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">IN PROGRESS</span>
                      <h2>My running orders</h2>
                    </div>
                    <StatusBadge className="count-pill">
                      {myOrder || runningTrade ? 1 : 0}
                    </StatusBadge>
                  </div>
                  <div className="order-list">
                    {myOrder || runningTrade ? (
                      <article className="offer-card running-order">
                        <div className="offer-meta">
                          <span>My wallet</span>
                          <StatusBadge className="status-pill">
                            {runningTrade ? statusLabel(runningTrade.status) : myOrder?.status}
                          </StatusBadge>
                        </div>
                        <div className="offer-amounts">
                          <div>
                            <small>Giving</small>
                            <strong>
                              {runningTrade?.participants.find((p) => p.mine)?.give ??
                                `${myOrder?.giveAmount} ${myOrder?.giveAsset === 'BTC' ? '' : myOrder?.giveAsset}`}
                            </strong>
                          </div>
                          <Icon name="arrow" size={20} />
                          <div>
                            <small>Receiving</small>
                            <strong>
                              {runningTrade?.participants.find((p) => p.mine)?.receive ??
                                `${myOrder?.minReceiveAmount} ${myOrder?.receiveAsset === 'BTC' ? '' : myOrder?.receiveAsset}`}
                            </strong>
                          </div>
                        </div>
                        {myOrder?.fillSummary && (
                          <p className="order-fill-progress">{myOrder.fillSummary}</p>
                        )}
                      </article>
                    ) : (
                      <div className="empty-state">
                        <Icon name="route" size={26} />
                        <strong>No running orders</strong>
                        <span>Your next match will appear here.</span>
                      </div>
                    )}
                  </div>
                  <div className="order-pagination running-actions">
                    {myOrder && ['Open', 'Partially filled'].includes(myOrder.status) && (
                      <Button
                        className="text-button"
                        onClick={() => void cancelOrder()}
                        disabled={busy !== null || !connected || Boolean(syncError)}
                        loading={busy === 'cancel'}
                        loadingText="Cancelling…"
                      >
                        Cancel order
                      </Button>
                    )}
                    <Button
                      className="text-button"
                      onClick={() =>
                        openTrade(
                          runningTrade
                            ? { tradeId: runningTrade.id }
                            : myOrder
                              ? { orderId: myOrder.id }
                              : {},
                        )
                      }
                    >
                      {myOrder || runningTrade ? 'Open trade' : 'View past orders'}{' '}
                      <Icon name="arrow" size={16} />
                    </Button>
                  </div>
                </Panel>
              </div>
            </>
          )}

          {/* Keep funding state mounted so switching tabs cannot reset an approval attempt. */}
          <div hidden={view !== 'topup' || initialLoading}>
            <FundingPanel
              client={client}
              wallet={status}
              visible={view === 'topup' && !initialLoading}
            />
          </div>

          <div hidden={view !== 'trade' || initialLoading}>
            <div className="trade-page-heading">
              <span className="eyebrow">YOUR ACTIVITY</span>
              <h1>Trades</h1>
              <p>Follow your current order or open a past swap.</p>
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
            {connected && status ? (
              <OrderHistory
                key={status.ownerId}
                loadPage={loadHistory}
                liveTrade={trade}
                request={tradeRequest}
                liveContent={liveTradeContent}
              />
            ) : (
              liveTradeContent
            )}
          </div>
        </main>
        <footer className="footer">
          <span aria-label="pálka">
            p<span className="brand-stress">a</span>lka
          </span>
          <span>
            {initialLoading
              ? 'Loading local wallet…'
              : connected
                ? `Bitcoin ${status?.network}${isMock ? ' · MOCK wallet' : ''}`
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
                loading={busy === 'connect'}
                loadingText="Connecting…"
                disabled={busy !== null || (!desktop && !pairToken.trim())}
              >
                {desktop ? 'Reconnect' : 'Pair wallet'} <Icon name="arrow" size={16} />
              </Button>
            </div>
          </Panel>
        </div>
      )}

      {draftOpen && (
        <div
          className="modal-backdrop draft-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDraftOpen(false);
          }}
        >
          <Panel
            className="modal draft-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="draft-title"
            aria-describedby="draft-description"
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="modal-head">
              <div>
                <div className="eyebrow">ORDER TERMS</div>
                <h2 id="draft-title">Review swap</h2>
              </div>
              <Button type="button" onClick={() => setDraftOpen(false)} aria-label="Close">
                <Icon name="close" size={18} />
              </Button>
            </div>
            <p id="draft-description">
              Review your amounts and limits. Publishing allows matching, not spending.
            </p>
            <div className="draft-grid">
              <AssetSelect
                id="give-asset"
                label="You give"
                value={draft.giveAsset}
                balances={visibleBalances}
                onChange={(giveAsset) => updateDraft({ giveAsset })}
              />
              <div>
                <label className="field-label" htmlFor="give-amount">
                  Amount ({draft.giveAsset === 'BTC' ? 'sats' : 'base units'})
                </label>
                <Input
                  id="give-amount"
                  value={draft.giveAmount}
                  onChange={(event) => updateDraft({ giveAmount: event.target.value })}
                  inputMode="numeric"
                />
              </div>
              <AssetSelect
                id="receive-asset"
                label="You receive"
                value={draft.receiveAsset}
                balances={visibleBalances}
                onChange={(receiveAsset) => updateDraft({ receiveAsset })}
              />
              <div>
                <label className="field-label" htmlFor="receive-amount">
                  Minimum amount ({draft.receiveAsset === 'BTC' ? 'sats' : 'base units'})
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
                  {draft.allowPartial ? 'Total order fee budget (sats)' : 'Order fee limit (sats)'}
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
                  Expires in (minutes)
                </label>
                <Input
                  id="expires"
                  value={draft.expiresMinutes}
                  onChange={(event) => updateDraft({ expiresMinutes: event.target.value })}
                  inputMode="numeric"
                />
              </div>
              <label className="partial-fill-toggle">
                <input
                  type="checkbox"
                  checked={draft.allowPartial}
                  onChange={(event) => updateDraft({ allowPartial: event.target.checked })}
                />
                Allow partial fills (direct swaps)
              </label>
              {draft.allowPartial && (
                <>
                  <div>
                    <label className="field-label" htmlFor="minimum-fill">
                      Minimum fill (
                      {draft.giveAsset === 'BTC' ? 'sats' : `${draft.giveAsset} base units`})
                    </label>
                    <Input
                      id="minimum-fill"
                      value={draft.minGiveAmount}
                      onChange={(event) => updateDraft({ minGiveAmount: event.target.value })}
                      inputMode="numeric"
                      required
                    />
                  </div>
                  <p className="partial-fill-help">
                    Each fill is a separate atomic swap with its own approval. The total fee budget
                    is split by fill size. The final fill may be below your minimum.
                  </p>
                </>
              )}
            </div>
            <div className="draft-note">
              {ready
                ? 'Amounts and fees are checked locally. Signing requires your approval.'
                : 'Connect your wallet to check limits and publish.'}
            </div>
            <div className="modal-actions">
              <Button
                className="primary-button"
                type="button"
                onClick={() => void publish()}
                loading={busy === 'publish'}
                loadingText="Checking & publishing…"
                disabled={!ready || busy !== null}
              >
                Publish order <Icon name="arrow" size={16} />
              </Button>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );

  function updateDraft(change: Partial<Draft>) {
    setDraft((current) => ({
      ...current,
      ...(change.giveAsset && change.giveAsset !== current.giveAsset ? { minGiveAmount: '' } : {}),
      ...change,
    }));
  }
}

export function validateDraftShape(draft: Draft, policy: PrivatePolicy | null) {
  if (draft.giveAsset === draft.receiveAsset) throw new Error('Assets must differ.');
  for (const [name, value] of Object.entries({
    'Amount to give': draft.giveAmount,
    'Minimum to receive': draft.minReceiveAmount,
    Fee: draft.maxFeeSats,
    Expiry: draft.expiresMinutes,
    ...(draft.allowPartial ? { 'Minimum fill': draft.minGiveAmount } : {}),
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
  if (
    draft.allowPartial &&
    (BigInt(draft.minGiveAmount) === 0n || BigInt(draft.minGiveAmount) > BigInt(draft.giveAmount))
  )
    throw new Error('Minimum fill must be greater than zero and no larger than the total offer.');
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
