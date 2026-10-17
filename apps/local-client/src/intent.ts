import { AiIntentSchema, OrderDraftSchema, PrivatePolicySchema, assetKey, toAtomic, assertPolicy, type PrivatePolicy, type WalletState } from '@rgb-exchange/contracts';

export function defaultPolicy(state: WalletState): PrivatePolicy {
  return {allowedAssetKeys:state.balances.map(b => assetKey(b.asset)),protectedBalances:{},maxFeeSats:'1000',allowBtcSale:false};
}
export function draftFromIntent(output: unknown, state: WalletState, previous: PrivatePolicy, now = Date.now()) {
  const intent = AiIntentSchema.parse(output);
  const policy = PrivatePolicySchema.parse(structuredClone(previous));
  if (intent.maxFeeSats !== null) policy.maxFeeSats = intent.maxFeeSats;
  if (intent.allowBtcSale !== null) policy.allowBtcSale = intent.allowBtcSale;
  const byKey = new Map(state.balances.map(b => [assetKey(b.asset), b]));
  for (const reserve of intent.protectedBalances) {
    const balance = byKey.get(reserve.assetKey);
    if (!balance) throw new Error('AI указал неизвестный актив в защищённом остатке');
    if ((reserve.minAmount === null) === (reserve.minPercent === null)) throw new Error('Уточните остаток: сумма или процент');
    policy.protectedBalances[reserve.assetKey] = reserve.minAmount !== null ? toAtomic(reserve.minAmount, balance.asset.precision) : ((BigInt(balance.amount) * BigInt(reserve.minPercent!) + 99n) / 100n).toString();
  }
  const give = intent.giveAssetKey ? byKey.get(intent.giveAssetKey) : null;
  const receive = intent.receiveAssetKey ? byKey.get(intent.receiveAssetKey) : null;
  if ((intent.giveAssetKey && !give) || (intent.receiveAssetKey && !receive)) throw new Error('AI указал неизвестный asset key; выберите проверенный актив');
  if (intent.clarification || !give || !receive || intent.giveAmount === null || intent.minReceiveAmount === null) return {intent,policy,draft:null,clarification:intent.clarification || 'Укажите оба актива, точную отдаваемую сумму и минимум получения. Курс не вычисляется моделью.'};
  const draft = OrderDraftSchema.parse({giveAsset:give.asset,giveAmount:toAtomic(intent.giveAmount,give.asset.precision),receiveAsset:receive.asset,minReceiveAmount:toAtomic(intent.minReceiveAmount,receive.asset.precision),maxFeeSats:policy.maxFeeSats,expiresAt:now+30*60_000});
  assertPolicy(draft,policy,state,now);
  return {intent,policy,draft,clarification:null};
}
