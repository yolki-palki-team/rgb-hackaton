import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PublicOrderSchema, PrivatePolicySchema, OrderDraftSchema, TradeSnapshotSchema, WalletStateSchema,
  WalletCapabilitiesSchema, WalletPreviewSchema, ApprovalSchema, SettlementPackageSchema, ReceiptSchema,
  assertPolicy, assetKey, sameAsset, type WalletAdapter, type PrivatePolicy, type PublicOrder,
  type TradeSnapshot, type SettlementPackage, type WalletPreview, type Approval,
} from '@rgb-exchange/contracts';
import { digestValue, planDigest } from '@rgb-exchange/contracts/digest';
import { MarketClient } from './market-client.ts';
import { LocalStore } from './store.ts';
import { defaultPolicy, draftFromIntent } from './intent.ts';

export interface Interpreter {
  health(): Promise<{available:boolean;model:string;reason?:string}>;
  interpret(goal:string,assets:Array<{key:string;symbol:string;precision:number}>): Promise<{output:unknown;diagnostics:unknown}>;
}
export class LocalError extends Error {
  constructor(message:string, readonly status=400, readonly code='LOCAL_VALIDATION') { super(message); }
}
type SavedPublication = {requestDigest:string;order:PublicOrder;policy:PrivatePolicy};
type SavedApproval = {tokenHash:string;package:SettlementPackage;preview:WalletPreview;approval:Approval};
type Operation = {state:'PREPARING'|'SIGNING'|'SIGNED'|'RECONCILING'|'BROADCAST'|'CONFIRMED'|'CANCELLED'; reason?:string};

export class LocalService {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly ownerId:string,readonly wallet:WalletAdapter,readonly market:MarketClient,readonly store:LocalStore,readonly qvac:Interpreter) {}
  exclusive<T>(operation:()=>Promise<T>):Promise<T> {
    const result = this.chain.then(operation,operation);
    this.chain=result.catch(()=>undefined);
    return result;
  }
  async state() {
    const state=WalletStateSchema.parse(await this.wallet.state());
    if (state.ownerId !== this.ownerId || state.network !== 'regtest') throw new LocalError('Wallet identity/network mismatch',409);
    return state;
  }
  async policy():Promise<PrivatePolicy> { return PrivatePolicySchema.parse(this.store.get('policy') ?? defaultPolicy(await this.state())); }
  async health() {
    let timer:ReturnType<typeof setTimeout>|undefined;
    // Model download must not prevent pairing or the manual order form.
    const loading=new Promise<{available:boolean;model:string;reason:string}>(resolve=>{timer=setTimeout(()=>resolve({available:false,model:'QVAC',reason:'Модель загружается локально. Можно заполнить заявку вручную и обновить подключение позже.'}),1500);});
    const [walletResult,qvac] = await Promise.allSettled([this.wallet.capabilities(),Promise.race([this.qvac.health(),loading])]);
    clearTimeout(timer);
    const wallet=walletResult.status === 'fulfilled' ? WalletCapabilitiesSchema.parse(walletResult.value) : null;
    return {ownerId:this.ownerId,network:wallet?.network ?? 'regtest',mode:wallet?.mode ?? 'real',wallet,qvac:qvac.status === 'fulfilled' ? qvac.value : {available:false,model:'QVAC',reason:'Локальная модель недоступна'},market:{connected:this.market.connected,sequence:this.market.sequence},...(wallet ? {} : {blockedReason:'Wallet adapter недоступен. Проверьте sidecar B.'})};
  }
  async interpret(body:unknown) {
    const {goal}=z.object({goal:z.string().trim().min(1).max(1200)}).strict().parse(body);
    const state=await this.state();
    const result=await this.qvac.interpret(goal,state.balances.map(b=>({key:assetKey(b.asset),symbol:b.asset.symbol,precision:b.asset.precision})));
    return {...draftFromIntent(result.output,state,await this.policy()),diagnostics:result.diagnostics};
  }
  async validateDraft(body:unknown) {
    const input=z.object({draft:OrderDraftSchema,policy:PrivatePolicySchema}).strict().parse(body);
    assertPolicy(input.draft,input.policy,await this.state());
    return {valid:true};
  }
  async publish(body:unknown) {
    const input=z.object({draft:OrderDraftSchema,policy:PrivatePolicySchema,confirmed:z.literal(true),requestId:z.string().uuid()}).strict().parse(body);
    const key=`publication:${input.requestId}`;
    const hash=digestValue(input);
    let saved=this.store.get<SavedPublication>(key);
    if (saved && saved.requestDigest !== hash) throw new LocalError('Request ID уже связан с другой заявкой',409,'IDEMPOTENCY_CONFLICT');
    if (!saved) {
      const state=await this.state();
      assertPolicy(input.draft,input.policy,state);
      const snapshot=await this.market.snapshot();
      if (snapshot.myOrders.some(o=>['OPEN','RESERVED'].includes(o.status))) throw new LocalError('У профиля уже есть активная заявка',409);
      const order=PublicOrderSchema.parse({...input.draft,id:`order-${input.requestId}`,ownerId:this.ownerId,network:state.network,revision:0,status:'OPEN',createdAt:Date.now()});
      saved={requestDigest:hash,order,policy:input.policy};
      this.store.set(key,saved); this.store.set(`order:${order.id}`,saved); this.store.set('policy',input.policy);
    }
    // Persist before sending: retry uses the same public id and exact order even after an uncertain HTTP result.
    const response=await this.market.request('/orders','POST',saved.order) as {order?:unknown};
    return PublicOrderSchema.parse(response.order ?? response);
  }
  async trade(id:string):Promise<TradeSnapshot> {
    const result=await this.market.request(`/trades/${encodeURIComponent(id)}`) as {trade?:unknown};
    const trade=TradeSnapshotSchema.parse(result.trade ?? result);
    if (!trade.plan.participants.includes(this.ownerId) || trade.plan.network !== 'regtest' || trade.plan.digest !== planDigest(trade.plan)) throw new LocalError('Неверный участник, сеть или digest плана',409);
    return trade;
  }
  private ownPublication(trade:TradeSnapshot):SavedPublication {
    for (const ref of trade.plan.orderRefs) {
      const saved=this.store.get<SavedPublication>(`order:${ref.orderId}`);
      if (saved?.order.ownerId === this.ownerId) {
        if (ref.revision !== saved.order.revision+1) throw new LocalError('Устаревшая revision заявки',409);
        const outgoing=trade.plan.legs.find(l=>l.fromOwnerId===this.ownerId)!;
        const incoming=trade.plan.legs.find(l=>l.toOwnerId===this.ownerId)!;
        if (!sameAsset(outgoing.asset,saved.order.giveAsset) || outgoing.amount !== saved.order.giveAmount || !sameAsset(incoming.asset,saved.order.receiveAsset) || BigInt(incoming.amount)<BigInt(saved.order.minReceiveAmount)) throw new LocalError('План изменяет подтверждённую заявку',409);
        return saved;
      }
    }
    throw new LocalError('Нет локально подтверждённой заявки для этой сделки',409);
  }
  private async message(trade:TradeSnapshot,type:'prepare'|'package'|'signature'|'broadcast'|'receipt'|'reject'|'unsupported',payload:unknown) {
    // Content-derived ID makes relaying a preparation result/signature idempotent across reconnects.
    const messageId=digestValue({tradeId:trade.plan.tradeId,revision:trade.plan.revision,ownerId:this.ownerId,type,payload});
    return this.market.request(`/trades/${trade.plan.tradeId}/messages`,'POST',{messageId,revision:trade.plan.revision,type,payload});
  }
  async prepare(id:string) {
    const trade=await this.trade(id);
    this.ownPublication(trade);
    const cap=WalletCapabilitiesSchema.parse(await this.wallet.capabilities());
    if (cap.mode !== 'real' || !cap.signing || (trade.plan.participants.length===3 ? !cap.ringSwap : !cap.directSwap)) {
      const reason=cap.reason || 'Wallet adapter не поддерживает этот атомарный обмен';
      await this.message(trade,'unsupported',{reason});
      return {status:'unsupported',reason};
    }
    const operation=this.store.get<Operation>(`operation:${id}`);
    if (operation && ['SIGNING','SIGNED','RECONCILING','BROADCAST','CONFIRMED'].includes(operation.state)) throw new LocalError('После подписи требуется сверка состояния, а не новая подготовка',409);
    if (!['RESERVED','PREPARING'].includes(trade.status)) throw new LocalError('Сделка не находится в стадии подготовки',409);
    this.store.set(`operation:${id}`,{state:'PREPARING'});
    await this.wallet.reserve(trade.plan);
    const materials=trade.messages.filter(m=>m.message.type==='prepare').map(m=>({ownerId:m.ownerId,material:(m.message.payload as {material?:unknown})?.material}));
    const result=await this.wallet.prepare(trade.plan,materials);
    if (result.status==='unsupported') { await this.message(trade,'unsupported',{reason:result.reason ?? 'Unsupported wallet primitive'}); await this.wallet.release(id); this.store.set(`operation:${id}`,{state:'CANCELLED'}); }
    if (result.material !== undefined) await this.message(trade,'prepare',{material:result.material});
    if (result.settlementPackage) {
      const pkg=SettlementPackageSchema.parse(result.settlementPackage);
      await this.validatePackage(trade,pkg);
      await this.message(trade,'package',pkg);
    }
    return {status:result.status,reason:result.reason};
  }
  private async validatePackage(trade:TradeSnapshot,pkg:SettlementPackage):Promise<WalletPreview> {
    const saved=this.ownPublication(trade);
    if (pkg.tradeId !== trade.plan.tradeId || pkg.planRevision !== trade.plan.revision || pkg.planDigest !== trade.plan.digest || pkg.network !== trade.plan.network) throw new LocalError('Settlement package не соответствует плану',409);
    const state=await this.state();
    const preview=WalletPreviewSchema.parse(await this.wallet.validate(pkg,trade.plan));
    if (!preview.validated || preview.mode !== 'real' || state.mode !== 'real') throw new LocalError(preview.reasons.join('; ') || 'Wallet не подтвердил пакет',409);
    for (const key of ['packageId','planDigest','unsignedTxDigest','commitmentDigest','network'] as const) if (preview[key] !== pkg[key]) throw new LocalError('Wallet preview не привязан к пакету',409);
    if (preview.ownerId !== this.ownerId || preview.walletId !== state.walletId) throw new LocalError('Wallet preview принадлежит другому кошельку',409);
    const outgoing=trade.plan.legs.find(l=>l.fromOwnerId===this.ownerId)!;
    const incoming=trade.plan.legs.find(l=>l.toOwnerId===this.ownerId)!;
    if (!sameAsset(preview.give.asset,outgoing.asset) || preview.give.amount!==outgoing.amount || !sameAsset(preview.receive.asset,incoming.asset) || preview.receive.amount!==incoming.amount) throw new LocalError('Wallet preview изменяет суммы/активы плана',409);
    if (BigInt(preview.feeSats)>BigInt(saved.order.maxFeeSats)) throw new LocalError('Окончательная комиссия превышает заявку',409);
    const {giveAsset,giveAmount,receiveAsset,minReceiveAmount,expiresAt}=saved.order;
    assertPolicy({giveAsset,giveAmount,receiveAsset,minReceiveAmount,expiresAt,maxFeeSats:preview.feeSats},saved.policy,state);
    const expectedDelta=(preview.receive.asset.kind==='btc'?BigInt(preview.receive.amount):0n)-(preview.give.asset.kind==='btc'?BigInt(preview.give.amount):0n)-BigInt(preview.feeSats);
    if (BigInt(preview.btcDelta)!==expectedDelta) throw new LocalError('Неверное итоговое изменение BTC',409);
    const after=new Map(preview.balancesAfter.map(b=>[assetKey(b.asset),b]));
    if (after.size!==preview.balancesAfter.length || after.size!==state.balances.length) throw new LocalError('Неполный/дублирующийся список итоговых балансов',409);
    for (const balance of state.balances) {
      const result=after.get(assetKey(balance.asset));
      let expected=BigInt(balance.amount);
      if (sameAsset(balance.asset,preview.give.asset)) expected-=BigInt(preview.give.amount);
      if (sameAsset(balance.asset,preview.receive.asset)) expected+=BigInt(preview.receive.amount);
      if (balance.asset.kind==='btc') expected-=BigInt(preview.feeSats);
      if (!result || !sameAsset(result.asset,balance.asset) || BigInt(result.amount)!==expected) throw new LocalError('Изменён баланс или потерян посторонний актив',409);
    }
    return preview;
  }
  async preview(id:string) {
    const trade=await this.trade(id);
    if (!trade.settlementPackage || !['AWAITING_APPROVAL','SIGNING'].includes(trade.status)) throw new LocalError('Окончательный пакет ещё не готов; подпись недоступна',409,'PACKAGE_UNAVAILABLE');
    const operation=this.store.get<Operation>(`operation:${id}`);
    if (operation && ['SIGNING','SIGNED','RECONCILING','BROADCAST','CONFIRMED'].includes(operation.state)) throw new LocalError('Этот профиль уже передал или мог передать подпись; нужна сверка',409);
    const preview=await this.validatePackage(trade,trade.settlementPackage);
    const approvalToken=randomUUID();
    const approval=ApprovalSchema.parse({protocolVersion:1,approvalId:randomUUID(),ownerId:this.ownerId,walletId:preview.walletId,network:preview.network,tradeId:id,planRevision:trade.plan.revision,packageId:preview.packageId,planDigest:preview.planDigest,unsignedTxDigest:preview.unsignedTxDigest,commitmentDigest:preview.commitmentDigest,approvedAt:Date.now()});
    this.store.set(`approval:${id}`,{tokenHash:digestValue(approvalToken),package:trade.settlementPackage,preview,approval});
    return {preview,approvalToken};
  }
  async approve(id:string,body:unknown) {
    const input=z.object({approvalToken:z.string().uuid(),confirmed:z.literal(true)}).strict().parse(body);
    const saved=this.store.get<SavedApproval>(`approval:${id}`);
    if (!saved || saved.tokenHash!==digestValue(input.approvalToken)) throw new LocalError('Approval отсутствует или устарел',409);
    if (this.store.get<Operation>(`operation:${id}`)?.state && this.store.get<Operation>(`operation:${id}`)!.state !== 'PREPARING') throw new LocalError('Повторная подпись запрещена; выполните сверку',409);
    const trade=await this.trade(id);
    if (!trade.settlementPackage || !['AWAITING_APPROVAL','SIGNING'].includes(trade.status)) throw new LocalError('Пакет больше не доступен для подписи',409);
    const preview=await this.validatePackage(trade,trade.settlementPackage);
    if (digestValue(preview)!==digestValue(saved.preview)) throw new LocalError('Условия изменились: проверьте новый preview и подтвердите заново',409,'STALE_APPROVAL');
    this.store.set(`operation:${id}`,{state:'SIGNING'});
    this.store.set(`approval:${id}`,null);
    try {
      // Market must durably lock the whole ring BEFORE a signature can exist locally.
      await this.message(trade,'signature',{packageId:preview.packageId,unsignedTxDigest:preview.unsignedTxDigest,commitmentDigest:preview.commitmentDigest,signatureMayExist:true});
      const locked=await this.trade(id);
      if (locked.status!=='SIGNING' || !locked.settlementPackage || locked.settlementPackage.unsignedTxDigest!==preview.unsignedTxDigest || locked.settlementPackage.commitmentDigest!==preview.commitmentDigest) throw new LocalError('Сделка остановлена перед подписью; требуется сверка',409);
      const result=await this.wallet.sign(trade.settlementPackage,{...saved.approval,approvedAt:Date.now()});
      if (result.status!=='signed' || result.signature===undefined) throw new LocalError(result.reason || 'Wallet не вернул подпись',409);
      this.store.set(`signature:${id}`,result.signature);
      this.store.set(`operation:${id}`,{state:'SIGNED'});
      await this.message(trade,'signature',{packageId:preview.packageId,unsignedTxDigest:preview.unsignedTxDigest,commitmentDigest:preview.commitmentDigest,signature:result.signature});
      const updated=await this.trade(id);
      const signatures=[...new Map(updated.messages.filter(m=>m.message.type==='signature' && (m.message.payload as {signature?:unknown})?.signature!==undefined).map(m=>[m.ownerId,{ownerId:m.ownerId,signature:(m.message.payload as {signature:unknown}).signature}])).values()];
      const cap=await this.wallet.capabilities();
      if (new Set(signatures.map(s=>s.ownerId)).size===updated.plan.participants.length && cap.broadcast) {
        const receipt=ReceiptSchema.parse(await this.wallet.finalize(trade.settlementPackage,signatures));
        this.checkReceipt(id,receipt);
        if (receipt.txid) await this.message(trade,'broadcast',receipt);
        this.store.set(`operation:${id}`,{state:receipt.state==='reconciling'?'RECONCILING':'BROADCAST'});
      }
      return {status:'signed',reason:'Подпись передана; подтверждение цепи и принятие RGB ещё проверяются отдельно.'};
    } catch (error) {
      this.store.set(`operation:${id}`,{state:'RECONCILING',reason:'Результат подписи/отправки требует проверки wallet adapter'});
      throw error;
    }
  }
  private checkReceipt(id:string,receipt:ReturnType<typeof ReceiptSchema.parse>) {
    if (receipt.tradeId!==id || receipt.network!=='regtest') throw new LocalError('Receipt относится к другой сделке/сети',409);
    if (receipt.state==='confirmed' && (!receipt.txid || !receipt.chainConfirmed || !receipt.rgbAccepted || receipt.mode!=='real')) throw new LocalError('Нет подтверждения цепи и RGB acceptance',409);
  }
  async sync(id:string) {
    const trade=await this.trade(id);
    const receipt=ReceiptSchema.parse(await this.wallet.sync(id));
    this.checkReceipt(id,receipt);
    this.store.set(`receipt:${id}`,receipt);
    if (receipt.mode==='real') {
      if (trade.status!=='CONFIRMED') await this.message(trade,'receipt',receipt);
      if (receipt.state==='confirmed') this.store.set(`operation:${id}`,{state:'CONFIRMED'});
    }
    return receipt;
  }
  async reject(id:string,reason:string) {
    const trade=await this.trade(id);
    const op=this.store.get<Operation>(`operation:${id}`);
    const unsafe=op && ['SIGNING','SIGNED','BROADCAST','RECONCILING','CONFIRMED'].includes(op.state);
    await this.message(trade,'reject',{reason,signatureMayExist:Boolean(unsafe)});
    if (unsafe || ['SIGNING','READY_TO_BROADCAST','BROADCAST','RECONCILING','CONFIRMED'].includes(trade.status)) {
      this.store.set(`operation:${id}`,{state:'RECONCILING'});
      return {status:'reconciling',reason:'Подпись могла быть передана. Резервы не освобождены.'};
    }
    await this.wallet.release(id);
    this.store.set(`operation:${id}`,{state:'CANCELLED'});
    return {status:'cancelled'};
  }
}
