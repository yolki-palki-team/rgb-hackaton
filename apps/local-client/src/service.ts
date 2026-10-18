import type { QvacHealth } from './qvac.ts';
import { QvacUnavailableError, QvacInvalidOutputError } from './qvac.ts';
import { IntentValidationError } from './intent-amounts.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PublicOrderSchema,
  PrivatePolicySchema,
  OrderDraftSchema,
  TradeSnapshotSchema,
  WalletStateSchema,
  WalletCapabilitiesSchema,
  FundingTargetSchema,
  WalletPreviewSchema,
  ApprovalSchema,
  SettlementPackageSchema,
  ReceiptSchema,
  assertPolicy,
  isOrderFillValid,
  orderFillFeeSats,
  assetKey,
  sameAsset,
  type WalletAdapter,
  type WalletCapabilities,
  type PrivatePolicy,
  type PublicOrder,
  type TradeSnapshot,
  type SettlementPackage,
  type WalletPreview,
  type Approval,
  type DevelopmentNetwork,
  DevelopmentNetworkSchema,
} from '@rgb-exchange/contracts';
import { digestValue, planDigest } from '@rgb-exchange/contracts/digest';
import { MarketClient } from './market-client.ts';
import { LocalStore } from './store.ts';
import { defaultPolicy, draftFromIntent } from './intent.ts';

export interface Interpreter {
  health(): Promise<QvacHealth>;
  interpret(
    goal: string,
    assets: Array<{ key: string; symbol: string; precision: number }>,
  ): Promise<{ output: unknown; diagnostics: unknown }>;
}
export class LocalError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'LOCAL_VALIDATION',
  ) {
    super(message);
  }
}
type SavedPublication = { requestDigest: string; order: PublicOrder; policy: PrivatePolicy };
type SavedApproval = {
  tokenHash: string;
  package: SettlementPackage;
  preview: WalletPreview;
  approval: Approval;
};
type SigningIntent = { package: SettlementPackage; approval: Approval };
type LocalFill = {
  tradeId: string;
  planDigest: string;
  giveAmount: string;
  receiveAmount: string;
  feeSats: string;
};
const unsafeStates = ['SIGNING', 'SIGNED', 'RECONCILING', 'BROADCAST', 'CONFIRMED'];
const cancelledStates = ['REJECTED', 'CANCELLED', 'EXPIRED', 'UNSUPPORTED'];
type Operation = {
  state:
    'PREPARING' | 'SIGNING' | 'SIGNED' | 'RECONCILING' | 'BROADCAST' | 'CONFIRMED' | 'CANCELLED';
  reason?: string;
};

export class LocalService {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly ownerId: string,
    readonly wallet: WalletAdapter,
    readonly market: MarketClient,
    readonly store: LocalStore,
    readonly qvac: Interpreter,
    readonly network: DevelopmentNetwork = 'regtest',
  ) {
    DevelopmentNetworkSchema.parse(network);
    const savedNetwork = store.get<DevelopmentNetwork>('profile:network');
    if (
      (savedNetwork && savedNetwork !== network) ||
      (!savedNetwork && network !== 'regtest' && store.entries('').length)
    )
      throw new LocalError('Local state belongs to another network; use a separate profile', 409);
    store.set('profile:network', network);
  }
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.catch(() => undefined);
    return result;
  }
  async state() {
    const state = WalletStateSchema.parse(await this.wallet.state());
    if (
      state.ownerId !== this.ownerId ||
      state.network !== this.network ||
      (this.network !== 'regtest' && state.mode !== 'real')
    )
      throw new LocalError('Wallet identity/network mismatch', 409);
    return state;
  }
  async policy(): Promise<PrivatePolicy> {
    return defaultPolicy(await this.state());
  }
  async fundingTarget() {
    if (!this.wallet.fundingTarget)
      throw new LocalError('Native wallet receive address is unavailable.', 409);
    const target = FundingTargetSchema.parse(await this.wallet.fundingTarget());
    if (target.ownerId !== this.ownerId || target.network !== this.network)
      throw new LocalError('Receive address belongs to another wallet profile or network.', 409);
    return target;
  }
  async health() {
    let wallet: WalletCapabilities;
    try {
      wallet = WalletCapabilitiesSchema.parse(await this.wallet.capabilities());
      if (wallet.network !== this.network || (this.network !== 'regtest' && wallet.mode !== 'real'))
        throw new LocalError('Wallet network does not match this profile', 409);
    } catch (error) {
      const configured =
        error instanceof Error &&
        error.message === 'Real wallet unavailable: configure WALLET_RPC_URL and WALLET_RPC_TOKEN.';
      return {
        ownerId: this.ownerId,
        network: this.network,
        mode: 'real',
        wallet: null,
        qvac: {
          available: false,
          model: 'QVAC',
          reason: 'Configure the real wallet before using local AI.',
        },
        market: { connected: this.market.connected, sequence: this.market.sequence },
        blockedReason:
          configured || error instanceof LocalError
            ? error.message
            : 'Wallet adapter unavailable. Check sidecar B.',
      };
    }
    const qvac = await this.qvacHealth();
    return {
      ownerId: this.ownerId,
      network: wallet.network,
      mode: wallet.mode,
      wallet,
      qvac,
      market: { connected: this.market.connected, sequence: this.market.sequence },
    };
  }
  async qvacHealth(): Promise<QvacHealth> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Checking AI readiness must not call the wallet or delay trade recovery.
    const loading = new Promise<QvacHealth>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            available: false,
            state: 'loading',
            model: 'QVAC',
            reason:
              'The model is loading locally. You can retry the goal or fill in the terms manually.',
          }),
        1500,
      );
    });
    try {
      return await Promise.race([this.qvac.health(), loading]);
    } catch {
      return {
        available: false,
        state: 'unavailable',
        model: 'QVAC',
        reason: 'The local model is unavailable. Retry the goal.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async interpret(body: unknown) {
    const { goal } = z
      .object({ goal: z.string().trim().min(1).max(1200) })
      .strict()
      .parse(body);
    const state = await this.state();
    try {
      const result = await this.qvac.interpret(
        goal,
        state.balances.map((b) => ({
          key: assetKey(b.asset),
          symbol: b.asset.symbol,
          precision: b.asset.precision,
        })),
      );
      return {
        ...draftFromIntent(result.output, state),
        diagnostics: result.diagnostics,
      };
    } catch (error) {
      if (error instanceof QvacUnavailableError)
        throw new LocalError(error.message, 503, 'QVAC_UNAVAILABLE');
      if (error instanceof QvacInvalidOutputError || error instanceof IntentValidationError)
        throw new LocalError(error.message, 422, 'INTENT_INVALID');
      throw new LocalError(
        `The goal could not become a valid order: ${error instanceof Error ? error.message : 'check the terms'}`,
        422,
        'INTENT_INVALID',
      );
    }
  }

  async validateDraft(body: unknown) {
    const input = z
      .object({ draft: OrderDraftSchema, policy: PrivatePolicySchema })
      .strict()
      .parse(body);
    assertPolicy(input.draft, input.policy, await this.state());
    return { valid: true };
  }
  async publish(body: unknown) {
    const input = z
      .object({
        draft: OrderDraftSchema,
        policy: PrivatePolicySchema,
        confirmed: z.literal(true),
        requestId: z.string().uuid(),
      })
      .strict()
      .parse(body);
    const key = `publication:${input.requestId}`;
    const hash = digestValue(input);
    let saved = this.store.get<SavedPublication>(key);
    if (saved && saved.requestDigest !== hash)
      throw new LocalError(
        'Request ID is already associated with another order',
        409,
        'IDEMPOTENCY_CONFLICT',
      );
    if (!saved) {
      const state = await this.state();
      assertPolicy(input.draft, input.policy, state);
      const snapshot = await this.market.snapshot();
      if (snapshot.myOrders.some((o) => ['OPEN', 'RESERVED'].includes(o.status)))
        throw new LocalError('This profile already has an active order', 409);
      const order = PublicOrderSchema.parse({
        ...input.draft,
        id: `order-${input.requestId}`,
        ownerId: this.ownerId,
        network: state.network,
        revision: 0,
        status: 'OPEN',
        createdAt: Date.now(),
      });
      saved = { requestDigest: hash, order, policy: input.policy };
      this.store.set(key, saved);
      this.store.set(`order:${order.id}`, saved);
    }
    // Persist before sending: retry uses the same public id and exact order even after an uncertain HTTP result.
    const response = (await this.market.request('/orders', 'POST', saved.order)) as {
      order?: unknown;
    };
    return PublicOrderSchema.parse(response.order ?? response);
  }
  async trade(id: string): Promise<TradeSnapshot> {
    const result = (await this.market.request(`/trades/${encodeURIComponent(id)}`)) as {
      trade?: unknown;
    };
    const trade = TradeSnapshotSchema.parse(result.trade ?? result);
    if (
      trade.plan.tradeId !== id ||
      !trade.plan.participants.includes(this.ownerId) ||
      trade.plan.network !== this.network ||
      trade.plan.digest !== planDigest(trade.plan)
    )
      throw new LocalError('Invalid participant, network, or plan digest', 409);
    return trade;
  }
  async progress(id: string) {
    await this.trade(id);
    // Read durable local intent, including an approval whose response was lost.
    // Never infer permission to sign from a peer's market status.
    return {
      tradeId: id,
      signingAuthorized: Boolean(
        this.store.get(`signing:${id}`) || this.store.get(`signature:${id}`),
      ),
      recoveryRequired: this.signatureMayExist(id),
      receipt: this.store.get(`receipt:${id}`) ?? null,
    };
  }
  private ownPublication(trade: TradeSnapshot): SavedPublication {
    for (const ref of trade.plan.orderRefs) {
      const saved = this.store.get<SavedPublication>(`order:${ref.orderId}`);
      if (saved?.order.ownerId === this.ownerId) {
        const outgoing = trade.plan.legs.find((l) => l.fromOwnerId === this.ownerId)!;
        const incoming = trade.plan.legs.find((l) => l.toOwnerId === this.ownerId)!;
        if (
          !sameAsset(outgoing.asset, saved.order.giveAsset) ||
          !sameAsset(incoming.asset, saved.order.receiveAsset)
        )
          throw new LocalError('Plan changes the confirmed order', 409);
        if (saved.order.partialFill) {
          if (trade.plan.participants.length !== 2)
            throw new LocalError('Partial-fill orders require independent direct swaps', 409);
          const prefix = `fill:${saved.order.id}:`;
          const key = `${prefix}${trade.plan.tradeId}`;
          const bound = this.store.get<LocalFill>(key);
          if (bound) {
            if (bound.planDigest !== trade.plan.digest)
              throw new LocalError('The immutable fill plan changed', 409);
            return saved;
          }
          let filled = 0n;
          let received = 0n;
          let fees = 0n;
          const prior = this.store.entries<LocalFill>(prefix);
          for (const { value: fill } of prior) {
            const receipt = this.store.get<ReturnType<typeof ReceiptSchema.parse>>(
              `receipt:${fill.tradeId}`,
            );
            if (!receipt || receipt.state !== 'confirmed')
              throw new LocalError('Reconcile the previous fill before starting another', 409);
            this.checkReceipt(fill.tradeId, ReceiptSchema.parse(receipt));
            filled += BigInt(fill.giveAmount);
            received += BigInt(fill.receiveAmount);
            fees += BigInt(fill.feeSats);
          }
          if (ref.revision !== saved.order.revision + prior.length * 2 + 1)
            throw new LocalError('Stale order revision', 409);
          const order: PublicOrder = {
            ...saved.order,
            fillProgress: {
              filledGiveAmount: String(filled),
              receivedAmount: String(received),
              feeBudgetUsedSats: String(fees),
              fillCount: prior.length,
            },
          };
          if (!isOrderFillValid(order, outgoing.amount, incoming.amount))
            throw new LocalError('Fill exceeds the remaining quantity or confirmed limits', 409);
          const feeSats = trade.plan.fees.find((fee) => fee.ownerId === this.ownerId)!.feeSats;
          if (BigInt(feeSats) > BigInt(orderFillFeeSats(order, outgoing.amount)))
            throw new LocalError('Fill exceeds the remaining cumulative fee budget', 409);
          // Only this wallet's confirmed receipt unlocks the next independent fill.
          this.store.set(key, {
            tradeId: trade.plan.tradeId,
            planDigest: trade.plan.digest,
            giveAmount: outgoing.amount,
            receiveAmount: incoming.amount,
            feeSats,
          } satisfies LocalFill);
        } else {
          if (ref.revision !== saved.order.revision + 1)
            throw new LocalError('Stale order revision', 409);
          if (
            outgoing.amount !== saved.order.giveAmount ||
            BigInt(incoming.amount) < BigInt(saved.order.minReceiveAmount)
          )
            throw new LocalError('Plan changes the confirmed order', 409);
        }
        return saved;
      }
    }
    throw new LocalError('No locally confirmed order for this trade', 409);
  }
  private async message(
    trade: TradeSnapshot,
    type: 'prepare' | 'package' | 'signature' | 'broadcast' | 'receipt' | 'reject' | 'unsupported',
    payload: unknown,
  ) {
    // Content-derived ID makes relaying a preparation result/signature idempotent across reconnects.
    const messageId = digestValue({
      tradeId: trade.plan.tradeId,
      revision: trade.plan.revision,
      ownerId: this.ownerId,
      type,
      payload,
    });
    return this.market.request(`/trades/${trade.plan.tradeId}/messages`, 'POST', {
      messageId,
      revision: trade.plan.revision,
      type,
      payload,
    });
  }
  private signatureMayExist(id: string): boolean {
    return Boolean(
      this.store.get(`signing:${id}`) ||
      this.store.get(`signature:${id}`) ||
      unsafeStates.includes(this.store.get<Operation>(`operation:${id}`)?.state ?? ''),
    );
  }
  private async releaseCancelled(trade: TradeSnapshot): Promise<boolean> {
    const id = trade.plan.tradeId;
    if (!cancelledStates.includes(trade.status)) return false;
    this.ownPublication(trade);
    if (this.signatureMayExist(id) || trade.messages.some((m) => m.message.type === 'signature'))
      throw new LocalError('A signature may exist: automatic release is prohibited', 409);
    if (this.store.get<Operation>(`operation:${id}`)?.state === 'PREPARING')
      await this.wallet.release(id);
    this.store.set(`operation:${id}`, { state: 'CANCELLED' });
    this.store.set(`approval:${id}`, null);
    return true;
  }
  async snapshot() {
    const snapshot = await this.market.snapshot();
    for (const entry of snapshot.trades) {
      if (
        cancelledStates.includes(entry.status) &&
        this.store.get<Operation>(`operation:${entry.plan.tradeId}`)?.state === 'PREPARING'
      ) {
        // Re-fetch and validate identity/digest before touching local reservations.
        await this.releaseCancelled(await this.trade(entry.plan.tradeId));
      }
    }
    return snapshot;
  }
  async prepare(id: string) {
    const trade = await this.trade(id);
    this.ownPublication(trade);
    const cap = WalletCapabilitiesSchema.parse(await this.wallet.capabilities());
    if (cap.network !== this.network)
      throw new LocalError('Wallet network does not match this profile', 409);
    if (
      cap.mode !== 'real' ||
      !cap.signing ||
      (trade.plan.participants.length === 3 ? !cap.ringSwap : !cap.directSwap)
    ) {
      const reason = cap.reason || 'Wallet adapter does not support this atomic swap';
      await this.message(trade, 'unsupported', { reason });
      return { status: 'unsupported', reason };
    }
    if (this.signatureMayExist(id))
      throw new LocalError('Reconciliation is required after signing', 409);
    if (!['RESERVED', 'PREPARING'].includes(trade.status))
      throw new LocalError('Trade is not in the preparation stage', 409);
    this.store.set(`operation:${id}`, { state: 'PREPARING' });
    await this.wallet.reserve(trade.plan);
    const materials = trade.messages
      .filter((m) => m.message.type === 'prepare')
      .map((m) => ({
        ownerId: m.ownerId,
        material: (m.message.payload as { material?: unknown })?.material,
      }));
    const result = await this.wallet.prepare(trade.plan, materials);
    if (result.status === 'unsupported') {
      await this.message(trade, 'unsupported', {
        reason: result.reason ?? 'Unsupported wallet primitive',
      });
      await this.wallet.release(id);
      this.store.set(`operation:${id}`, { state: 'CANCELLED' });
    }
    if (result.material !== undefined)
      await this.message(trade, 'prepare', { material: result.material });
    if (result.settlementPackage) {
      const pkg = SettlementPackageSchema.parse(result.settlementPackage);
      await this.validatePackage(trade, pkg);
      await this.message(trade, 'package', pkg);
    }
    return { status: result.status, reason: result.reason };
  }
  private async validatePackage(
    trade: TradeSnapshot,
    pkg: SettlementPackage,
  ): Promise<WalletPreview> {
    const saved = this.ownPublication(trade);
    if (
      pkg.tradeId !== trade.plan.tradeId ||
      pkg.planRevision !== trade.plan.revision ||
      pkg.planDigest !== trade.plan.digest ||
      pkg.network !== trade.plan.network
    )
      throw new LocalError('Settlement package does not match the plan', 409);
    const state = await this.state();
    const preview = WalletPreviewSchema.parse(await this.wallet.validate(pkg, trade.plan));
    if (!preview.validated || preview.mode !== 'real' || state.mode !== 'real')
      throw new LocalError(
        preview.reasons.join('; ') || 'Wallet did not validate the package',
        409,
      );
    for (const key of [
      'packageId',
      'planDigest',
      'unsignedTxDigest',
      'commitmentDigest',
      'network',
    ] as const)
      if (preview[key] !== pkg[key])
        throw new LocalError('Wallet preview is not bound to the package', 409);
    if (preview.ownerId !== this.ownerId || preview.walletId !== state.walletId)
      throw new LocalError('Wallet preview belongs to another wallet', 409);
    const outgoing = trade.plan.legs.find((l) => l.fromOwnerId === this.ownerId)!;
    const incoming = trade.plan.legs.find((l) => l.toOwnerId === this.ownerId)!;
    if (
      !sameAsset(preview.give.asset, outgoing.asset) ||
      preview.give.amount !== outgoing.amount ||
      !sameAsset(preview.receive.asset, incoming.asset) ||
      preview.receive.amount !== incoming.amount
    )
      throw new LocalError('Wallet preview changes plan amounts or assets', 409);
    const feeLimit = trade.plan.fees.find((fee) => fee.ownerId === this.ownerId)!.feeSats;
    if (
      BigInt(preview.feeSats) > BigInt(saved.order.maxFeeSats) ||
      BigInt(preview.feeSats) > BigInt(feeLimit)
    )
      throw new LocalError('Final fee exceeds the order limit', 409);
    assertPolicy(
      {
        giveAsset: outgoing.asset,
        giveAmount: outgoing.amount,
        receiveAsset: incoming.asset,
        minReceiveAmount: incoming.amount,
        expiresAt: saved.order.expiresAt,
        maxFeeSats: preview.feeSats,
      },
      saved.policy,
      state,
    );
    const expectedDelta =
      (preview.receive.asset.kind === 'btc' ? BigInt(preview.receive.amount) : 0n) -
      (preview.give.asset.kind === 'btc' ? BigInt(preview.give.amount) : 0n) -
      BigInt(preview.feeSats);
    if (BigInt(preview.btcDelta) !== expectedDelta)
      throw new LocalError('Invalid final BTC balance change', 409);
    const after = new Map(preview.balancesAfter.map((b) => [assetKey(b.asset), b]));
    if (after.size !== preview.balancesAfter.length || after.size !== state.balances.length)
      throw new LocalError('Incomplete or duplicate final balance list', 409);
    for (const balance of state.balances) {
      const result = after.get(assetKey(balance.asset));
      let expected = BigInt(balance.amount);
      if (sameAsset(balance.asset, preview.give.asset)) expected -= BigInt(preview.give.amount);
      if (sameAsset(balance.asset, preview.receive.asset))
        expected += BigInt(preview.receive.amount);
      if (balance.asset.kind === 'btc') expected -= BigInt(preview.feeSats);
      if (!result || !sameAsset(result.asset, balance.asset) || BigInt(result.amount) !== expected)
        throw new LocalError('Balance changed unexpectedly or an unrelated asset is missing', 409);
    }
    return preview;
  }
  async preview(id: string) {
    const trade = await this.trade(id);
    if (
      !trade.settlementPackage ||
      !['AWAITING_APPROVAL', 'SIGNING', 'RECONCILING'].includes(trade.status)
    )
      throw new LocalError(
        'Final package is not ready; signing is unavailable',
        409,
        'PACKAGE_UNAVAILABLE',
      );
    if (this.signatureMayExist(id))
      throw new LocalError(
        'This profile has sent or may have sent a signature; reconcile first',
        409,
      );
    const preview = await this.validatePackage(trade, trade.settlementPackage);
    const approvalToken = randomUUID();
    const approval = ApprovalSchema.parse({
      protocolVersion: 1,
      approvalId: randomUUID(),
      ownerId: this.ownerId,
      walletId: preview.walletId,
      network: preview.network,
      tradeId: id,
      planRevision: trade.plan.revision,
      packageId: preview.packageId,
      planDigest: preview.planDigest,
      unsignedTxDigest: preview.unsignedTxDigest,
      commitmentDigest: preview.commitmentDigest,
      approvedAt: Date.now(),
    });
    this.store.set(`approval:${id}`, {
      tokenHash: digestValue(approvalToken),
      package: trade.settlementPackage,
      preview,
      approval,
    });
    return { preview, approvalToken };
  }
  async approve(id: string, body: unknown) {
    const input = z
      .object({ approvalToken: z.string().uuid(), confirmed: z.literal(true) })
      .strict()
      .parse(body);
    const saved = this.store.get<SavedApproval>(`approval:${id}`);
    if (!saved || saved.tokenHash !== digestValue(input.approvalToken))
      throw new LocalError('Approval is missing or stale', 409);
    if (this.signatureMayExist(id))
      throw new LocalError('Authorization already used; reconcile first', 409);
    if (
      this.store.get<Operation>(`operation:${id}`)?.state &&
      this.store.get<Operation>(`operation:${id}`)!.state !== 'PREPARING'
    )
      throw new LocalError('Repeated signing is prohibited; reconcile first', 409);
    const trade = await this.trade(id);
    if (
      !trade.settlementPackage ||
      !['AWAITING_APPROVAL', 'SIGNING', 'RECONCILING'].includes(trade.status)
    )
      throw new LocalError('Package is no longer available for signing', 409);
    const preview = await this.validatePackage(trade, trade.settlementPackage);
    if (digestValue(preview) !== digestValue(saved.preview))
      throw new LocalError(
        'Terms changed: review the new preview and approve again',
        409,
        'STALE_APPROVAL',
      );
    if (digestValue(trade.settlementPackage) !== digestValue(saved.package))
      throw new LocalError('Package changed after preview', 409);
    // Durable authorization precedes both the market notice and the wallet RPC.
    // Recovery must reuse this exact approval, including its original timestamp.
    this.store.set(`signing:${id}`, { package: saved.package, approval: saved.approval });
    this.store.set(`operation:${id}`, { state: 'SIGNING' });
    this.store.set(`approval:${id}`, null);
    try {
      await this.relaySignature(trade);
      await this.finalizeReady(await this.trade(id));
      return {
        status: 'signed',
        reason: 'Signature sent; chain confirmation and RGB acceptance are checked separately.',
      };
    } catch (error) {
      this.store.set(`operation:${id}`, {
        state: 'RECONCILING',
        reason: 'Signing or broadcast outcome requires wallet adapter reconciliation',
      });
      throw error;
    }
  }
  private async relaySignature(trade: TradeSnapshot) {
    const id = trade.plan.tradeId;
    const saved = this.store.get<SigningIntent>(`signing:${id}`);
    let cached = this.store.get<unknown>(`signature:${id}`);
    this.ownPublication(trade);
    const pkg = trade.settlementPackage;
    if (
      !pkg ||
      pkg.tradeId !== id ||
      pkg.planRevision !== trade.plan.revision ||
      pkg.planDigest !== trade.plan.digest ||
      pkg.network !== trade.plan.network
    )
      throw new LocalError('Recovery plan changed', 409);
    const bound = saved?.package ?? this.store.get<SettlementPackage>(`recovered-package:${id}`);
    if (bound && digestValue(pkg) !== digestValue(bound))
      throw new LocalError('Recovery package differs from the approved package', 409);
    if (!saved && (!bound || cached === null || cached === undefined)) {
      if (!this.wallet.recoverSignature) return; // Legacy adapter can still finalize already relayed signatures.
      // This RPC only reads a previously authorized durable signature. It cannot sign.
      const result = await this.wallet.recoverSignature(pkg);
      if (result.status !== 'signed' || result.signature === undefined)
        throw new LocalError('No saved signature is available for recovery', 409);
      this.store.set(`recovered-package:${id}`, pkg);
      this.store.set(`signature:${id}`, result.signature);
      cached = result.signature;
    }
    const binding = {
      packageId: pkg.packageId,
      unsignedTxDigest: pkg.unsignedTxDigest,
      commitmentDigest: pkg.commitmentDigest,
    };
    await this.message(trade, 'signature', { ...binding, signatureMayExist: true });
    const locked = await this.trade(id);
    if (
      !['SIGNING', 'RECONCILING'].includes(locked.status) ||
      digestValue(locked.settlementPackage) !== digestValue(pkg)
    )
      throw new LocalError('Trade stopped before signing; reconciliation is required', 409);
    let signature = cached;
    if (signature === undefined || signature === null) {
      const result = await this.wallet.sign(pkg, saved!.approval);
      if (result.status !== 'signed' || result.signature === undefined)
        throw new LocalError(result.reason || 'Wallet did not return a signature', 409);
      signature = result.signature;
      this.store.set(`signature:${id}`, signature);
    }
    this.store.set(`operation:${id}`, { state: 'SIGNED' });
    await this.message(trade, 'signature', { ...binding, signature });
  }
  private async finalizeReady(trade: TradeSnapshot) {
    const pkg = trade.settlementPackage;
    if (
      !pkg ||
      !['SIGNING', 'READY_TO_BROADCAST', 'RECONCILING', 'BROADCAST'].includes(trade.status)
    )
      return;
    this.ownPublication(trade);
    if (
      pkg.tradeId !== trade.plan.tradeId ||
      pkg.planRevision !== trade.plan.revision ||
      pkg.planDigest !== trade.plan.digest ||
      pkg.network !== trade.plan.network
    )
      throw new LocalError('Recovery plan changed', 409);
    const saved = this.store.get<SigningIntent>(`signing:${trade.plan.tradeId}`);
    const bound =
      saved?.package ??
      this.store.get<SettlementPackage>(`recovered-package:${trade.plan.tradeId}`);
    if (bound && digestValue(pkg) !== digestValue(bound))
      throw new LocalError('Recovery package differs from the approved package', 409);
    const signatures = new Map<string, { ownerId: string; signature: unknown }>();
    for (const item of trade.messages) {
      if (item.message.type !== 'signature') continue;
      const payload = item.message.payload as Record<string, unknown>;
      if (payload?.signature === undefined) continue;
      if (
        !trade.plan.participants.includes(item.ownerId) ||
        payload.packageId !== pkg.packageId ||
        payload.unsignedTxDigest !== pkg.unsignedTxDigest ||
        payload.commitmentDigest !== pkg.commitmentDigest
      )
        throw new LocalError('Signature does not match the package', 409);
      const prior = signatures.get(item.ownerId);
      if (prior && digestValue(prior.signature) !== digestValue(payload.signature))
        throw new LocalError('Conflicting participant signatures', 409);
      signatures.set(item.ownerId, { ownerId: item.ownerId, signature: payload.signature });
    }
    if (
      signatures.size !== trade.plan.participants.length ||
      !(await this.wallet.capabilities()).broadcast
    )
      return;
    // Journal before the external call: even a dropped HTTP response is recoverable.
    this.store.set(`operation:${trade.plan.tradeId}`, { state: 'RECONCILING' });
    const receipt = ReceiptSchema.parse(await this.wallet.finalize(pkg, [...signatures.values()]));
    this.checkReceipt(trade.plan.tradeId, receipt);
    this.store.set(`receipt:${trade.plan.tradeId}`, receipt);
    if (receipt.txid) await this.message(trade, 'broadcast', receipt);
    this.store.set(`operation:${trade.plan.tradeId}`, {
      state: receipt.state === 'reconciling' ? 'RECONCILING' : 'BROADCAST',
    });
    return receipt;
  }
  private checkReceipt(id: string, receipt: ReturnType<typeof ReceiptSchema.parse>) {
    if (receipt.tradeId !== id || receipt.network !== this.network)
      throw new LocalError('Receipt belongs to another trade or network', 409);
    if (
      receipt.state === 'confirmed' &&
      (!receipt.txid || !receipt.chainConfirmed || !receipt.rgbAccepted || receipt.mode !== 'real')
    )
      throw new LocalError('No chain confirmation or RGB acceptance', 409);
  }
  async recoverCommitted(): Promise<boolean> {
    const errors: unknown[] = [];
    let hasPending = false;
    for (const { key, value } of this.store.entries<Operation>('operation:')) {
      if (!unsafeStates.includes(value.state) || value.state === 'CONFIRMED') continue;
      const id = key.slice('operation:'.length);
      try {
        const trade = await this.trade(id);
        this.ownPublication(trade);
        const pkg = trade.settlementPackage;
        const bound =
          this.store.get<SigningIntent>(`signing:${id}`)?.package ??
          this.store.get<SettlementPackage>(`recovered-package:${id}`);
        if (
          !pkg ||
          !bound ||
          pkg.tradeId !== id ||
          pkg.planRevision !== trade.plan.revision ||
          pkg.planDigest !== trade.plan.digest ||
          pkg.network !== trade.plan.network ||
          digestValue(pkg) !== digestValue(SettlementPackageSchema.parse(bound))
        )
          throw new LocalError('Recovery package differs from the approved package', 409);
        const prior = this.store.get<unknown>(`receipt:${id}`);
        const knownReceipts = trade.messages
          .filter((item) => ['broadcast', 'receipt'].includes(item.message.type))
          .map((item) => ReceiptSchema.parse(item.message.payload));
        if (prior) knownReceipts.push(ReceiptSchema.parse(prior));
        for (const known of knownReceipts) this.checkReceipt(id, known);
        // Capability and balance checks can fail on our spent inputs until sync repairs the wallet.
        // This path only observes an existing transaction; it never resumes signing or finalization.
        const receipt = ReceiptSchema.parse(await this.wallet.sync(id));
        this.checkReceipt(id, receipt);
        if (
          receipt.mode !== 'real' ||
          knownReceipts.some((known) => known.txid && known.txid !== receipt.txid)
        )
          throw new LocalError('Recovery receipt does not match the existing transaction', 409);
        this.store.set(`receipt:${id}`, receipt);
        if (trade.status !== 'CONFIRMED') await this.message(trade, 'receipt', receipt);
        if (receipt.state === 'confirmed')
          this.store.set(`operation:${id}`, { state: 'CONFIRMED' });
        else hasPending = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Committed trade recovery is pending');
    return hasPending;
  }
  async sync(id: string): Promise<ReturnType<typeof ReceiptSchema.parse>> {
    let trade = await this.trade(id);
    if (await this.releaseCancelled(trade))
      return {
        mode: 'real',
        tradeId: id,
        network: this.network,
        state: 'pending',
        chainConfirmed: false,
        rgbAccepted: false,
        reason: 'Trade cancelled before signing; local reservations released.',
      };
    let receipt = ReceiptSchema.parse(await this.wallet.sync(id));
    this.checkReceipt(id, receipt);
    if (
      receipt.mode === 'real' &&
      (receipt.state === 'reconciling' || (receipt.state === 'pending' && !receipt.txid)) &&
      !receipt.chainConfirmed &&
      trade.status !== 'CONFIRMED' &&
      this.signatureMayExist(id)
    ) {
      try {
        if (['AWAITING_APPROVAL', 'SIGNING', 'RECONCILING'].includes(trade.status))
          await this.relaySignature(trade);
        trade = await this.trade(id);
        receipt = (await this.finalizeReady(trade)) ?? receipt;
      } catch (error) {
        this.store.set(`operation:${id}`, { state: 'RECONCILING' });
        throw error;
      }
    }
    this.store.set(`receipt:${id}`, receipt);
    if (receipt.mode === 'real') {
      if (trade.status !== 'CONFIRMED') await this.message(trade, 'receipt', receipt);
      if (receipt.state === 'confirmed') this.store.set(`operation:${id}`, { state: 'CONFIRMED' });
    }
    return receipt;
  }
  async reject(id: string, reason: string) {
    let trade = await this.trade(id);
    if (await this.releaseCancelled(trade)) return { status: 'cancelled' };
    if (trade.status === 'CONFIRMED') return { status: 'confirmed' };
    await this.message(trade, 'reject', { reason, signatureMayExist: this.signatureMayExist(id) });
    // Use the committed result: another participant may have locked signing first.
    trade = await this.trade(id);
    if (await this.releaseCancelled(trade)) return { status: 'cancelled' };
    this.store.set(`operation:${id}`, { state: 'RECONCILING' });
    return {
      status: 'reconciling',
      reason: 'A signature may have been sent. Reserves remain locked.',
    };
  }
}
