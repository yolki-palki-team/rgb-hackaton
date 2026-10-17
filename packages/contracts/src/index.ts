import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_ATOMIC = 18446744073709551615n;
export const AtomicAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).max(20).refine(v => /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 20 && BigInt(v) <= MAX_ATOMIC, 'Amount exceeds u64');
export const PositiveAmountSchema = AtomicAmountSchema.refine(v => BigInt(v) > 0n, 'Amount must be positive');
export const IdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:._-]+$/);
export const ContractIdSchema = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:._~+/#=-]+$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NetworkSchema = z.enum(['regtest', 'signet', 'signetcustom', 'testnet', 'mainnet']);
export type Network = z.infer<typeof NetworkSchema>;
const assetCommon = { network: NetworkSchema, symbol: z.string().min(1).max(16).regex(/^[a-zA-Z0-9_-]+$/) };
export const AssetRefSchema = z.discriminatedUnion('kind', [
  z.object({ ...assetCommon, kind: z.literal('btc'), precision: z.literal(8) }).strict(),
  z.object({ ...assetCommon, kind: z.literal('rgb'), contractId: ContractIdSchema, precision: z.number().int().min(0).max(18) }).strict(),
]);
export type AssetRef = z.infer<typeof AssetRefSchema>;
export const assetKey = (asset: AssetRef): string => `${asset.network}:${asset.kind}:${asset.kind === 'rgb' ? asset.contractId : 'btc'}`;
export const sameAsset = (a: AssetRef, b: AssetRef): boolean => assetKey(a) === assetKey(b) && a.precision === b.precision;
export const OrderStatusSchema = z.enum(['OPEN', 'RESERVED', 'FILLED', 'CANCELLED', 'EXPIRED']);
export const PublicOrderSchema = z.object({
  id: IdSchema, ownerId: IdSchema, revision: z.number().int().nonnegative(), network: NetworkSchema,
  giveAsset: AssetRefSchema, giveAmount: PositiveAmountSchema, receiveAsset: AssetRefSchema,
  minReceiveAmount: PositiveAmountSchema, maxFeeSats: AtomicAmountSchema,
  createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), status: OrderStatusSchema,
}).strict().superRefine((v, ctx) => {
  if (v.giveAsset.network !== v.network || v.receiveAsset.network !== v.network) ctx.addIssue({code: 'custom', message: 'Asset network mismatch'});
  if (sameAsset(v.giveAsset, v.receiveAsset)) ctx.addIssue({code: 'custom', message: 'Cannot exchange the same asset'});
  if (v.expiresAt <= v.createdAt) ctx.addIssue({code: 'custom', message: 'Invalid expiry'});
});
export type PublicOrder = z.infer<typeof PublicOrderSchema>;
export const PrivatePolicySchema = z.object({
  allowedAssetKeys: z.array(z.string().min(1).max(250)).min(2).max(100),
  protectedBalances: z.record(AtomicAmountSchema), maxFeeSats: AtomicAmountSchema, allowBtcSale: z.boolean(),
}).strict();
export type PrivatePolicy = z.infer<typeof PrivatePolicySchema>;
export const OrderDraftSchema = z.object({
  giveAsset: AssetRefSchema, giveAmount: PositiveAmountSchema, receiveAsset: AssetRefSchema,
  minReceiveAmount: PositiveAmountSchema, maxFeeSats: AtomicAmountSchema, expiresAt: z.number().int().positive(),
}).strict();
export type OrderDraft = z.infer<typeof OrderDraftSchema>;
export const BalanceSchema = z.object({asset: AssetRefSchema, amount: AtomicAmountSchema}).strict();
export type Balance = z.infer<typeof BalanceSchema>;
export const WalletStateSchema = z.object({walletId: IdSchema, ownerId: IdSchema, network: NetworkSchema, mode: z.enum(['mock','real']), balances: z.array(BalanceSchema), observedAt: z.number().int().nonnegative()}).strict().refine(s => s.balances.every(b => b.asset.network === s.network) && new Set(s.balances.map(b => assetKey(b.asset))).size === s.balances.length, 'Invalid or duplicate wallet assets');
export type WalletState = z.infer<typeof WalletStateSchema>;
export const WalletCapabilitiesSchema = z.object({
  protocolVersion: z.literal(1), mode: z.enum(['mock', 'real']), network: NetworkSchema,
  directSwap: z.boolean(), ringSwap: z.boolean(), signing: z.boolean(), broadcast: z.boolean(),
  reason: z.string().max(2000).optional(), adapterVersion: z.string().max(100),
}).strict();
export type WalletCapabilities = z.infer<typeof WalletCapabilitiesSchema>;
export const TradeLegSchema = z.object({fromOwnerId: IdSchema, toOwnerId: IdSchema, asset: AssetRefSchema, amount: PositiveAmountSchema}).strict();
export const TradePlanSchema = z.object({
  protocolVersion: z.literal(1), tradeId: IdSchema, revision: z.number().int().nonnegative(), network: NetworkSchema,
  orderRefs: z.array(z.object({orderId: IdSchema, revision: z.number().int().nonnegative()}).strict()).min(2).max(3),
  participants: z.array(IdSchema).min(2).max(3), legs: z.array(TradeLegSchema).min(2).max(3),
  fees: z.array(z.object({ownerId: IdSchema, feeSats: AtomicAmountSchema}).strict()).min(2).max(3),
  feeState: z.enum(['estimate', 'final']), createdAt: z.number().int().nonnegative(), digest: DigestSchema,
}).strict().superRefine((p, ctx) => {
  const n = p.participants.length;
  if (new Set(p.participants).size !== n || new Set(p.orderRefs.map(r => r.orderId)).size !== n || p.orderRefs.length !== n || p.legs.length !== n || p.fees.length !== n) ctx.addIssue({code:'custom',message:'Invalid participant/order cardinality'});
  if (new Set(p.fees.map(f => f.ownerId)).size !== n || p.fees.some(f => !p.participants.includes(f.ownerId))) ctx.addIssue({code:'custom',message:'Invalid fee allocation'});
  for (const owner of p.participants) {
    if (p.legs.filter(l => l.fromOwnerId === owner).length !== 1 || p.legs.filter(l => l.toOwnerId === owner).length !== 1) ctx.addIssue({code:'custom',message:'Each participant must send and receive exactly once'});
  }
  if (p.legs.some(l => l.fromOwnerId === l.toOwnerId || !p.participants.includes(l.fromOwnerId) || !p.participants.includes(l.toOwnerId) || l.asset.network !== p.network)) ctx.addIssue({code:'custom',message:'Invalid trade leg'});
});
export type TradePlan = z.infer<typeof TradePlanSchema>;
export const SettlementPackageSchema = z.object({
  protocolVersion: z.literal(1), packageId: IdSchema, tradeId: IdSchema, planRevision: z.number().int().nonnegative(),
  planDigest: DigestSchema, network: NetworkSchema,
  unsignedTxDigest: DigestSchema, commitmentDigest: DigestSchema,
  format: z.string().min(1).max(100), payload: z.unknown(),
}).strict();
export type SettlementPackage = z.infer<typeof SettlementPackageSchema>;
export const WalletPreviewSchema = z.object({
  walletId: IdSchema, ownerId: IdSchema, mode: z.enum(['mock','real']), network: NetworkSchema,
  packageId: IdSchema, planDigest: DigestSchema, unsignedTxDigest: DigestSchema, commitmentDigest: DigestSchema,
  validated: z.boolean(), reasons: z.array(z.string().max(1000)).max(30),
  give: BalanceSchema, receive: BalanceSchema, feeSats: AtomicAmountSchema,
  btcDelta: z.string().regex(/^-?(0|[1-9][0-9]*)$/).max(21), balancesAfter: z.array(BalanceSchema),
}).strict();
export type WalletPreview = z.infer<typeof WalletPreviewSchema>;
export const ApprovalSchema = z.object({
  protocolVersion: z.literal(1), approvalId: IdSchema, walletId: IdSchema, ownerId: IdSchema,
  network: NetworkSchema, tradeId: IdSchema, planRevision: z.number().int().nonnegative(),
  packageId: IdSchema, planDigest: DigestSchema, unsignedTxDigest: DigestSchema, commitmentDigest: DigestSchema,
  approvedAt: z.number().int().nonnegative(),
}).strict();
export type Approval = z.infer<typeof ApprovalSchema>;
export const TradeStatusSchema = z.enum(['RESERVED','PREPARING','AWAITING_APPROVAL','SIGNING','READY_TO_BROADCAST','BROADCAST','CONFIRMED','RECONCILING','REJECTED','CANCELLED','EXPIRED','UNSUPPORTED']);
export type TradeStatus = z.infer<typeof TradeStatusSchema>;
export const CoordinationMessageSchema = z.object({
  messageId: IdSchema, revision: z.number().int().nonnegative(),
  type: z.enum(['prepare','package','signature','broadcast','receipt','reject','unsupported']), payload: z.unknown(),
}).strict();
export type CoordinationMessage = z.infer<typeof CoordinationMessageSchema>;
export const TradeSnapshotSchema = z.object({plan: TradePlanSchema, status: TradeStatusSchema, reason: z.string().optional(), settlementPackage: SettlementPackageSchema.optional(), messages: z.array(z.object({ownerId: IdSchema, message: CoordinationMessageSchema}).strict()).default([])}).strict();
export type TradeSnapshot = z.infer<typeof TradeSnapshotSchema>;
export const EventEnvelopeSchema = z.object({
  protocolVersion: z.literal(1), eventId: IdSchema, sequence: z.number().int().nonnegative(),
  type: z.enum(['order.created','order.cancelled','order.expired','trade.updated','trade.message']),
  tradeId: IdSchema.optional(), revision: z.number().int().nonnegative(), payload: z.unknown(),
}).strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export const MarketSnapshotSchema = z.object({sequence: z.number().int().nonnegative(), orders: z.array(PublicOrderSchema), myOrders: z.array(PublicOrderSchema), trades: z.array(TradeSnapshotSchema), events: z.array(EventEnvelopeSchema)}).strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;
export const PrepareResultSchema = z.object({status: z.enum(['pending','ready','unsupported']), reason: z.string().optional(), material: z.unknown().optional(), settlementPackage: SettlementPackageSchema.optional()}).strict();
export type PrepareResult = z.infer<typeof PrepareResultSchema>;
export const SignatureResultSchema = z.object({status: z.enum(['signed','unsupported']), signature: z.unknown().optional(), reason: z.string().optional()}).strict();
export type SignatureResult = z.infer<typeof SignatureResultSchema>;
export const ReceiptSchema = z.object({
  mode: z.enum(['mock','real']), tradeId: IdSchema, network: NetworkSchema,
  txid: z.string().regex(/^[a-f0-9]{64}$/).optional(), chainConfirmed: z.boolean(), rgbAccepted: z.boolean(),
  state: z.enum(['pending','confirmed','reconciling','unsupported']), reason: z.string().optional(),
}).strict().refine(v => v.mode !== 'mock' || (!v.txid && !v.chainConfirmed && !v.rgbAccepted && v.state !== 'confirmed'), 'Mock cannot claim settlement');
export type Receipt = z.infer<typeof ReceiptSchema>;
/** RPC method params are identical to these method arguments; B owns payload codecs and cryptography. */
export interface WalletAdapter {
  capabilities(): Promise<WalletCapabilities>;
  state(): Promise<WalletState>;
  reserve(plan: TradePlan): Promise<{reservationId: string}>;
  release(tradeId: string): Promise<void>;
  prepare(plan: TradePlan, materials: Array<{ownerId:string; material:unknown}>): Promise<PrepareResult>;
  validate(pkg: SettlementPackage, plan: TradePlan): Promise<WalletPreview>;
  sign(pkg: SettlementPackage, approval: Approval): Promise<SignatureResult>;
  finalize(pkg: SettlementPackage, signatures: Array<{ownerId:string; signature:unknown}>): Promise<Receipt>;
  sync(tradeId: string): Promise<Receipt>;
}
/** Human units only. A model is never trusted to compute atomic amounts or choose contract IDs. */
export const AiIntentSchema = z.object({
  giveAssetKey: z.string().max(250).nullable(), giveAmount: z.string().max(80).nullable(),
  receiveAssetKey: z.string().max(250).nullable(), minReceiveAmount: z.string().max(80).nullable(),
  maxFeeSats: AtomicAmountSchema.nullable(), allowBtcSale: z.boolean().nullable(),
  protectedBalances: z.array(z.object({assetKey: z.string().max(250), minAmount: z.string().max(80).nullable(), minPercent: z.number().int().min(0).max(100).nullable()}).strict()).max(100),
  clarification: z.string().max(2000).nullable(),
}).strict();
export type AiIntent = z.infer<typeof AiIntentSchema>;
export function toAtomic(value: string, precision: number): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || value.length > 80) throw new Error('Enter a non-negative decimal number without an exponent');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > precision) throw new Error('Too many decimal places');
  return AtomicAmountSchema.parse((BigInt(whole) * 10n ** BigInt(precision) + BigInt(fraction.padEnd(precision, '0') || '0')).toString());
}
export function formatAmount(value: string, precision: number): string {
  const n = AtomicAmountSchema.parse(value).padStart(precision + 1, '0');
  return precision === 0 ? n : `${n.slice(0, -precision)}.${n.slice(-precision)}`.replace(/\.?0+$/, '');
}
export function assertPolicy(draft: OrderDraft, policy: PrivatePolicy, state: WalletState, now = Date.now()): void {
  OrderDraftSchema.parse(draft); PrivatePolicySchema.parse(policy); WalletStateSchema.parse(state);
  if (draft.expiresAt <= now) throw new Error('Order expired');
  if (Object.keys(policy.protectedBalances).some(key => !state.balances.some(b => assetKey(b.asset) === key))) throw new Error('Unknown asset in protected balances');
  if (sameAsset(draft.giveAsset, draft.receiveAsset)) throw new Error('Choose two different assets');
  for (const asset of [draft.giveAsset, draft.receiveAsset]) {
    if (asset.network !== state.network || !state.balances.some(b => sameAsset(b.asset, asset))) throw new Error('Unverified asset, contractId or network');
    if (!policy.allowedAssetKeys.includes(assetKey(asset))) throw new Error('Asset is blocked by local policy');
  }
  if (draft.giveAsset.kind === 'btc' && !policy.allowBtcSale) throw new Error('BTC sale is blocked by local policy');
  const fee = BigInt(draft.maxFeeSats);
  if (fee > BigInt(policy.maxFeeSats)) throw new Error('Fee limit exceeded');
  for (const b of state.balances) {
    const outgoing = sameAsset(b.asset, draft.giveAsset) ? BigInt(draft.giveAmount) : 0n;
    // Incoming assets cannot finance a fee or satisfy a protected pre-trade reserve.
    const after = BigInt(b.amount) - outgoing - (b.asset.kind === 'btc' ? fee : 0n);
    if (after < BigInt(policy.protectedBalances[assetKey(b.asset)] ?? '0')) throw new Error('Insufficient funds or protected balance violation');
  }
  if (fee > 0n && !state.balances.some(b => b.asset.kind === 'btc')) throw new Error('No BTC available for fees');
}
