import {
  MarketSnapshotSchema, OrderDraftSchema, PrivatePolicySchema, PublicOrderSchema, ReceiptSchema, WalletPreviewSchema, WalletStateSchema, assetKey,
} from '@rgb-exchange/contracts';
import type { AssetRef, MarketSnapshot, OrderDraft, PrivatePolicy, PublicOrder, Receipt, TradeSnapshot, WalletCapabilities, WalletState } from '@rgb-exchange/contracts';
import type { AssetCode, Balance, Draft, Order, Trade } from './model';

export type ClientStatus = {
  ownerId: string;
  network: string;
  mode: 'mock' | 'real';
  walletLabel: string;
  wallet: WalletCapabilities;
  qvacAvailable: boolean;
  qvacReason?: string;
};

type LocalHealth = { ownerId: string; network: string; mode: 'mock' | 'real'; wallet: WalletCapabilities | null; qvac: { available: boolean; reason?: string }; blockedReason?: string };
type Snapshot = { balances: Balance[]; orders: Order[]; myOrder: Order | null; trade: Trade | null; policy: PrivatePolicy; policyAssets: { key: string; label: string }[] };

export class LocalClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private status: ClientStatus | null = null;
  private walletState: WalletState | null = null;
  private marketSnapshot: MarketSnapshot | null = null;
  private policy: PrivatePolicy | null = null;
  private readonly receipts = new Map<string, Receipt>();
  private approval: { tradeId: string; planDigest: string; approvalToken: string; preview: Trade['validatedPreview'] } | null = null;

  constructor(url: string, token: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Локальный API должен быть на http://127.0.0.1 или localhost.');
    }
    if (!token.trim()) throw new Error('Введите pairing token.');
    this.baseUrl = parsed.href.replace(/\/$/, '');
    this.token = token.trim();
  }

  async connect(): Promise<ClientStatus> {
    const health = await this.request<LocalHealth>('GET', '/api/health');
    if (!health?.wallet) throw new Error(health?.blockedReason ?? 'Локальный кошелёк недоступен.');
    if (!['mock', 'real'].includes(health.mode) || health.wallet.mode !== health.mode) throw new Error('Некорректный ответ локального клиента.');
    if (this.status && (this.status.ownerId !== health.ownerId || this.status.network !== health.network || this.status.mode !== health.mode)) this.receipts.clear();
    this.status = {
      ownerId: health.ownerId, network: health.network, mode: health.mode,
      walletLabel: health.ownerId.slice(0, 10), wallet: health.wallet,
      qvacAvailable: Boolean(health.qvac?.available), qvacReason: health.qvac?.reason,
    };
    return this.status;
  }

  async snapshot(): Promise<Snapshot> {
    if (!this.status) throw new Error('Сначала подключите кошелёк.');
    const [rawState, rawSnapshot, rawPolicy] = await Promise.all([
      this.request<unknown>('GET', '/api/state'), this.request<unknown>('GET', '/api/snapshot'), this.request<unknown>('GET', '/api/policy'),
    ]);
    const state = WalletStateSchema.parse(rawState);
    const market = MarketSnapshotSchema.parse(rawSnapshot);
    const policy = PrivatePolicySchema.parse(rawPolicy);
    if (state.ownerId !== this.status.ownerId || state.network !== this.status.network) throw new Error('Ответ кошелька не совпадает с подключённым профилем.');
    this.walletState = state; this.marketSnapshot = market; this.policy = policy;
    const trade = market.trades[0] ? mapTrade(market.trades[0], this.status.ownerId, this.approval, this.receipts.get(market.trades[0].plan.tradeId)) : null;
    const activeOrder = market.myOrders.find(order => order.status === 'OPEN' || order.status === 'RESERVED');
    return {
      balances: state.balances.map(balance => mapBalance(balance.asset, balance.amount)),
      orders: market.orders.map(order => mapOrder(order)), myOrder: activeOrder ? mapOrder(activeOrder, true) : null,
      trade, policy, policyAssets: state.balances.map(balance => ({ key: assetKey(balance.asset), label: balance.asset.symbol })),
    };
  }

  async interpret(goal: string): Promise<{ draft: Draft | null; clarification: string | null; policy: PrivatePolicy }> {
    const response = await this.request<{ draft: unknown; policy: unknown; clarification: string | null }>('POST', '/api/interpret', { goal });
    const policy = PrivatePolicySchema.parse(response.policy);
    this.policy = policy;
    if (response.draft === null) return { draft: null, clarification: response.clarification, policy };
    const draft = OrderDraftSchema.parse(response.draft);
    return { draft: mapDraft(draft), clarification: response.clarification, policy };
  }

  async checkDraft(draft: Draft, policy: PrivatePolicy): Promise<void> {
    await this.request('POST', '/api/draft/validate', { draft: this.toOrderDraft(draft), policy: PrivatePolicySchema.parse(policy) });
  }

  async publishDraft(draft: Draft, policy: PrivatePolicy): Promise<Order> {
    const raw = await this.request<unknown>('POST', '/api/orders', {
      draft: this.toOrderDraft(draft), policy: PrivatePolicySchema.parse(policy), confirmed: true, requestId: crypto.randomUUID(),
    });
    return mapOrder(PublicOrderSchema.parse(raw), true);
  }

  async cancelOrder(id: string): Promise<void> {
    const order = this.marketSnapshot?.myOrders.find(item => item.id === id);
    if (!order) throw new Error('Версия заявки неизвестна. Обновите данные.');
    await this.request('POST', `/api/orders/${encodeURIComponent(id)}/cancel`, { revision: order.revision });
  }

  async prepare(tradeId: string): Promise<string> {
    const result = await this.request<{ status: string; reason?: string }>('POST', `/api/trades/${encodeURIComponent(tradeId)}/prepare`, {});
    return result.reason ?? result.status;
  }

  async reject(tradeId: string): Promise<void> {
    await this.request('POST', `/api/trades/${encodeURIComponent(tradeId)}/reject`, { reason: 'Пользователь отклонил сделку' });
    this.approval = null;
  }

  async sync(tradeId: string): Promise<{ state: string; chainConfirmed: boolean; rgbAccepted: boolean; reason?: string }> {
    if (!this.status) throw new Error('Сначала подключите кошелёк.');
    const raw = await this.request<unknown>('POST', `/api/trades/${encodeURIComponent(tradeId)}/sync`, {});
    const receipt = ReceiptSchema.parse(raw);
    if (receipt.tradeId !== tradeId || receipt.network !== this.status.network || receipt.mode !== this.status.mode) throw new Error('Квитанция не совпадает с локальным кошельком или сделкой.');
    if (receipt.state === 'confirmed' && (receipt.mode !== 'real' || !receipt.txid || !receipt.chainConfirmed || !receipt.rgbAccepted)) throw new Error('Кошелёк не подтвердил Bitcoin и принятие RGB.');
    this.receipts.set(tradeId, receipt);
    return { state: receipt.state, chainConfirmed: receipt.chainConfirmed, rgbAccepted: receipt.rgbAccepted, reason: receipt.reason };
  }

  async preview(tradeId: string): Promise<Trade['validatedPreview']> {
    const trade = this.marketSnapshot?.trades.find(item => item.plan.tradeId === tradeId);
    if (!trade || !this.status) throw new Error('План сделки не найден.');
    if (this.status.mode !== 'real' || !this.status.wallet.signing || !(trade.plan.participants.length === 3 ? this.status.wallet.ringSwap : this.status.wallet.directSwap)) {
      throw new Error(this.status.wallet.reason ?? 'Подписание этого типа сделки не поддерживается кошельком.');
    }
    const result = await this.request<{ preview: unknown; approvalToken: string }>('POST', `/api/trades/${encodeURIComponent(tradeId)}/preview`, {});
    const preview = WalletPreviewSchema.parse(result.preview);
    if (!preview.validated || preview.mode !== 'real' || preview.planDigest !== trade.plan.digest || preview.ownerId !== this.status.ownerId) {
      throw new Error(preview.reasons.join('; ') || 'Пакет не прошёл проверку локального кошелька.');
    }
    const mapped = {
      give: formatAsset(preview.give.asset, preview.give.amount), receive: formatAsset(preview.receive.asset, preview.receive.amount),
      feeSats: preview.feeSats, btcDeltaSats: preview.btcDelta, digest: preview.unsignedTxDigest,
    };
    this.approval = { tradeId, planDigest: trade.plan.digest, approvalToken: result.approvalToken, preview: mapped };
    return mapped;
  }

  async approve(tradeId: string, digest: string): Promise<void> {
    if (!this.approval || this.approval.tradeId !== tradeId || this.approval.preview?.digest !== digest) throw new Error('Проверка пакета устарела. Запросите новый preview.');
    const approvalToken = this.approval.approvalToken;
    // Once a signing request leaves this tab, its result may be uncertain. Never offer a retry with the same token.
    this.approval = null;
    await this.request('POST', `/api/trades/${encodeURIComponent(tradeId)}/approve`, { approvalToken, confirmed: true });
  }

  private toOrderDraft(draft: Draft): OrderDraft {
    if (!this.walletState) throw new Error('Остатки ещё не загружены. Обновите страницу после подключения.');
    const findAsset = (code: AssetCode) => {
      const matches = this.walletState!.balances.map(balance => balance.asset).filter(asset => asset.symbol === code);
      if (matches.length !== 1) throw new Error(`Актив ${code} не найден или неоднозначен в кошельке.`);
      return matches[0];
    };
    const giveAsset = findAsset(draft.giveAsset);
    const receiveAsset = findAsset(draft.receiveAsset);
    const raw = {
      giveAsset, giveAmount: draft.giveAmount, receiveAsset, minReceiveAmount: draft.minReceiveAmount,
      maxFeeSats: draft.maxFeeSats, expiresAt: Date.now() + Number(draft.expiresMinutes) * 60_000,
    };
    return OrderDraftSchema.parse(raw);
  }

  private async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = path === '/api/interpret' ? 55_000 : 15_000;
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store',
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `HTTP ${response.status}`;
        throw new Error(error);
      }
      return payload as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new Error(`Локальный клиент не ответил за ${timeoutMs / 1000} секунд.`);
      throw error;
    } finally { window.clearTimeout(timeout); }
  }
}

function mapBalance(asset: AssetRef, amount: string): Balance {
  return {
    code: asset.symbol as AssetCode, amount: asset.kind === 'btc' ? formatBtc(amount) : amount,
    label: asset.kind === 'btc' ? 'Bitcoin' : asset.symbol === 'DUSD' ? 'Тестовый DUSD' : `RGB ${asset.symbol}`,
    unit: asset.kind === 'btc' ? 'BTC' : asset.symbol,
  };
}

function mapOrder(order: PublicOrder, mine = false): Order {
  return {
    id: order.id, owner: mine ? 'Мой кошелёк' : order.ownerId,
    giveAsset: order.giveAsset.symbol as AssetCode, giveAmount: formatAsset(order.giveAsset, order.giveAmount, false),
    receiveAsset: order.receiveAsset.symbol as AssetCode, minReceiveAmount: formatAsset(order.receiveAsset, order.minReceiveAmount, false),
    status: order.status === 'OPEN' ? 'Открыта' : order.status === 'RESERVED' ? 'Зарезервирована' : order.status, mine,
  };
}

function mapDraft(draft: OrderDraft): Draft {
  return {
    giveAsset: draft.giveAsset.symbol as AssetCode, giveAmount: draft.giveAmount,
    receiveAsset: draft.receiveAsset.symbol as AssetCode, minReceiveAmount: draft.minReceiveAmount,
    maxFeeSats: draft.maxFeeSats, expiresMinutes: String(Math.max(1, Math.ceil((draft.expiresAt - Date.now()) / 60_000))),
  };
}

function mapTrade(snapshot: TradeSnapshot, ownerId: string, approval: { tradeId: string; planDigest: string; preview: Trade['validatedPreview'] } | null, receipt?: Receipt): Trade {
  const plan = snapshot.plan;
  const needsLocalConfirmation = snapshot.status === 'CONFIRMED' && receipt?.state !== 'confirmed';
  const participants = plan.participants.map((id, index) => {
    const outgoing = plan.legs.find(leg => leg.fromOwnerId === id)!;
    const incoming = plan.legs.find(leg => leg.toOwnerId === id)!;
    return { name: id === ownerId ? 'Вы · мой кошелёк' : `Участник ${index + 1}`, give: formatAsset(outgoing.asset, outgoing.amount), receive: formatAsset(incoming.asset, incoming.amount), mine: id === ownerId };
  });
  const fee = plan.fees.find(item => item.ownerId === ownerId)?.feeSats ?? '0';
  return {
    id: plan.tradeId, kind: participants.length === 3 ? 'ring' : 'direct', status: needsLocalConfirmation ? 'RECONCILING' : snapshot.status,
    participants,
    legs: plan.legs.map(leg => ({
      from: String.fromCharCode(65 + plan.participants.indexOf(leg.fromOwnerId)),
      to: String.fromCharCode(65 + plan.participants.indexOf(leg.toOwnerId)), amount: formatAsset(leg.asset, leg.amount),
    })),
    feeSats: plan.feeState === 'estimate' ? `≤ ${fee}` : fee,
    reason: needsLocalConfirmation ? 'Площадка сообщает о завершении. Подтвердите результат локальной проверкой кошелька.' : snapshot.reason,
    validatedPreview: approval?.tradeId === plan.tradeId && approval.planDigest === plan.digest ? approval.preview : undefined,
  };
}

function formatBtc(sats: string): string {
  const normalized = BigInt(sats).toString().padStart(9, '0');
  return `${normalized.slice(0, -8)}.${normalized.slice(-8)}`;
}

function formatAsset(asset: AssetRef, amount: string, includeCode = true): string {
  const value = BigInt(amount).toLocaleString('ru-RU');
  return asset.kind === 'btc' ? `${value} sats` : includeCode ? `${value} ${asset.symbol}` : value;
}
