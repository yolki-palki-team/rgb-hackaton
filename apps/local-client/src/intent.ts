import { canonicalDecimal } from './intent-amounts.ts';
import {
  AiIntentSchema,
  OrderDraftSchema,
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
    allowBtcSale: true,
  };
}
export function draftFromIntent(
  output: unknown,
  state: WalletState,
  _previous?: PrivatePolicy,
  now = Date.now(),
) {
  const intent = AiIntentSchema.parse(output);
  const policy = defaultPolicy(state);
  if (intent.maxFeeSats !== null) policy.maxFeeSats = intent.maxFeeSats;
  const byKey = new Map(state.balances.map((b) => [assetKey(b.asset), b]));
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
