import { canonicalDecimal } from './intent-grounding.ts';
import {
  AiIntentSchema,
  OrderDraftSchema,
  PrivatePolicySchema,
  assetKey,
  toAtomic,
  assertPolicy,
  type PrivatePolicy,
  type WalletState,
} from '@rgb-exchange/contracts';

export function defaultPolicy(state: WalletState): PrivatePolicy {
  return {
    allowedAssetKeys: state.balances.map((b) => assetKey(b.asset)),
    protectedBalances: {},
    maxFeeSats: '1000',
    allowBtcSale: false,
  };
}
export function draftFromIntent(
  output: unknown,
  state: WalletState,
  previous: PrivatePolicy,
  now = Date.now(),
) {
  const intent = AiIntentSchema.parse(output);
  const policy = PrivatePolicySchema.parse(structuredClone(previous));
  // AI may tighten a saved policy, but only the user can relax it in the review form.
  if (intent.maxFeeSats !== null && BigInt(intent.maxFeeSats) < BigInt(policy.maxFeeSats))
    policy.maxFeeSats = intent.maxFeeSats;
  if (intent.allowBtcSale === false) policy.allowBtcSale = false;
  const byKey = new Map(state.balances.map((b) => [assetKey(b.asset), b]));
  for (const reserve of intent.protectedBalances) {
    const balance = byKey.get(reserve.assetKey);
    if (!balance) throw new Error('AI specified an unknown asset in the protected balance');
    if ((reserve.minAmount === null) === (reserve.minPercent === null))
      throw new Error('Specify a protected balance as an amount or a percentage');
    const proposed =
      reserve.minAmount !== null
        ? toAtomic(canonicalDecimal(reserve.minAmount), balance.asset.precision)
        : ((BigInt(balance.amount) * BigInt(reserve.minPercent!) + 99n) / 100n).toString();
    if (BigInt(proposed) > BigInt(policy.protectedBalances[reserve.assetKey] ?? '0'))
      policy.protectedBalances[reserve.assetKey] = proposed;
  }
  const give = intent.giveAssetKey ? byKey.get(intent.giveAssetKey) : null;
  const receive = intent.receiveAssetKey ? byKey.get(intent.receiveAssetKey) : null;
  if ((intent.giveAssetKey && !give) || (intent.receiveAssetKey && !receive))
    throw new Error('AI specified an unknown asset key; choose a verified asset');
  if (
    intent.clarification ||
    !give ||
    !receive ||
    intent.giveAmount === null ||
    intent.minReceiveAmount === null
  )
    return {
      intent,
      policy,
      draft: null,
      clarification:
        intent.clarification ||
        'Specify both assets, the exact amount to sell, and the minimum to receive. The model does not calculate exchange rates.',
    };
  const draft = OrderDraftSchema.parse({
    giveAsset: give.asset,
    giveAmount: toAtomic(canonicalDecimal(intent.giveAmount), give.asset.precision),
    receiveAsset: receive.asset,
    minReceiveAmount: toAtomic(canonicalDecimal(intent.minReceiveAmount), receive.asset.precision),
    maxFeeSats: policy.maxFeeSats,
    expiresAt: now + 30 * 60_000,
  });
  assertPolicy(draft, policy, state, now);
  return { intent, policy, draft, clarification: null };
}
