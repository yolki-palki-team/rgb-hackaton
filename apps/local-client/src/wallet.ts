import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  WalletCapabilitiesSchema,
  WalletStateSchema,
  WalletPreviewSchema,
  PrepareResultSchema,
  SignatureResultSchema,
  ReceiptSchema,
  type WalletAdapter,
  type WalletState,
  type TradePlan,
  type SettlementPackage,
  type Approval,
} from '@rgb-exchange/contracts';

export function requireLoopback(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Wallet RPC must use a loopback HTTP URL');
  return url;
}
export const REAL_WALLET_UNAVAILABLE =
  'Real wallet unavailable: configure WALLET_RPC_URL and WALLET_RPC_TOKEN.';
const unavailable = async (): Promise<never> => {
  throw new Error(REAL_WALLET_UNAVAILABLE);
};
export class UnavailableWalletAdapter implements WalletAdapter {
  capabilities = unavailable;
  state = unavailable;
  reserve = unavailable;
  release = unavailable;
  prepare = unavailable;
  validate = unavailable;
  sign = unavailable;
  finalize = unavailable;
  sync = unavailable;
}
export class HttpWalletAdapter implements WalletAdapter {
  private readonly url: URL;
  constructor(
    url: string,
    private readonly token: string,
  ) {
    this.url = requireLoopback(url);
    if (token.length < 16) throw new Error('WALLET_RPC_TOKEN must contain at least 16 characters');
  }
  private async call(method: string, params: object): Promise<unknown> {
    const response = await fetch(new URL('/rpc', this.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ protocolVersion: 1, requestId: randomUUID(), method, params }),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`Wallet RPC ${method}: HTTP ${response.status}; settlement not assumed`);
    const envelope = z
      .object({
        protocolVersion: z.literal(1),
        result: z.unknown().optional(),
        error: z
          .object({ code: z.string().regex(/^[A-Z0-9_]{1,80}$/), message: z.string() })
          .optional(),
      })
      .strict()
      .parse(await response.json());
    if (envelope.error)
      throw new Error(`Wallet adapter rejected the request: ${envelope.error.code}`);
    return envelope.result;
  }
  async capabilities() {
    return WalletCapabilitiesSchema.parse(await this.call('capabilities', {}));
  }
  async state() {
    return WalletStateSchema.parse(await this.call('state', {}));
  }
  async reserve(plan: TradePlan) {
    return z
      .object({ reservationId: z.string().min(1) })
      .strict()
      .parse(await this.call('reserve', { plan }));
  }
  async release(tradeId: string) {
    await this.call('release', { tradeId });
  }
  async prepare(plan: TradePlan, materials: Array<{ ownerId: string; material: unknown }>) {
    return PrepareResultSchema.parse(await this.call('prepare', { plan, materials }));
  }
  async validate(pkg: SettlementPackage, plan: TradePlan) {
    return WalletPreviewSchema.parse(await this.call('validate', { package: pkg, plan }));
  }
  async sign(pkg: SettlementPackage, approval: Approval) {
    return SignatureResultSchema.parse(await this.call('sign', { package: pkg, approval }));
  }
  async recoverSignature(pkg: SettlementPackage) {
    return SignatureResultSchema.parse(await this.call('recoverSignature', { package: pkg }));
  }
  async finalize(
    pkg: SettlementPackage,
    signatures: Array<{ ownerId: string; signature: unknown }>,
  ) {
    return ReceiptSchema.parse(await this.call('finalize', { package: pkg, signatures }));
  }
  async sync(tradeId: string) {
    return ReceiptSchema.parse(await this.call('sync', { tradeId }));
  }
}
export class MockWalletAdapter implements WalletAdapter {
  constructor(private readonly ownerId: string) {}
  async capabilities() {
    return WalletCapabilitiesSchema.parse({
      protocolVersion: 1,
      mode: 'mock',
      network: 'regtest',
      directSwap: false,
      ringSwap: false,
      signing: false,
      broadcast: false,
      adapterVersion: 'A-balance-mock-v1',
      reason:
        'The demo wallet supports balances and matching. BTC/RGB signing and broadcast are disabled.',
    });
  }
  async state(): Promise<WalletState> {
    return WalletStateSchema.parse({
      walletId: `mock-wallet-${this.ownerId}`,
      ownerId: this.ownerId,
      network: 'regtest',
      mode: 'mock',
      observedAt: Date.now(),
      balances: [
        {
          asset: { kind: 'btc', network: 'regtest', symbol: 'BTC', precision: 8 },
          amount: '1000000',
        },
        {
          asset: {
            kind: 'rgb',
            network: 'regtest',
            symbol: 'X',
            precision: 0,
            contractId: 'mock-contract-X',
          },
          amount: '1000',
        },
        {
          asset: {
            kind: 'rgb',
            network: 'regtest',
            symbol: 'DUSD',
            precision: 0,
            contractId: 'mock-contract-DUSD',
          },
          amount: '1000',
        },
      ],
    });
  }
  async reserve(_plan: TradePlan): Promise<{ reservationId: string }> {
    throw new Error('Mock cannot reserve blockchain inputs');
  }
  async release(_tradeId: string) {}
  async prepare(_plan: TradePlan, _materials: Array<{ ownerId: string; material: unknown }>) {
    return PrepareResultSchema.parse({
      status: 'unsupported',
      reason: 'Atomic settlement unavailable in mock',
    });
  }
  async validate(_pkg: SettlementPackage, _plan: TradePlan): Promise<never> {
    throw new Error('Mock cannot validate a final Bitcoin/RGB package');
  }
  async sign(_pkg: SettlementPackage, _approval: Approval): Promise<never> {
    throw new Error('Mock cannot sign');
  }
  async finalize(
    pkg: SettlementPackage,
    _signatures: Array<{ ownerId: string; signature: unknown }>,
  ) {
    return this.sync(pkg.tradeId);
  }
  async sync(tradeId: string) {
    return ReceiptSchema.parse({
      mode: 'mock',
      tradeId,
      network: 'regtest',
      chainConfirmed: false,
      rgbAccepted: false,
      state: 'unsupported',
      reason: 'No blockchain settlement in mock',
    });
  }
}
