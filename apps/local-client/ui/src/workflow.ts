import type { Trade } from './model';

// This transport deliberately has no approve/sign method. Signing stays a user action.
export type WorkflowClient = {
  prepare(id: string): Promise<unknown>;
  preview(id: string): Promise<Trade['validatedPreview']>;
  sync(id: string): Promise<unknown>;
};
export type WorkflowAction = 'prepare' | 'preview' | 'sync';
export function nextTradeAction(trade: Trade): WorkflowAction | null {
  if (['CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED'].includes(trade.status))
    return null;
  if (trade.recoveryRequired || trade.signingAuthorized) return 'sync';
  if (['BROADCAST', 'READY_TO_BROADCAST'].includes(trade.status)) return 'sync';
  if (['RESERVED', 'PREPARING'].includes(trade.status)) return 'prepare';
  if (
    ['AWAITING_APPROVAL', 'SIGNING', 'RECONCILING'].includes(trade.status) &&
    !trade.validatedPreview
  )
    return 'preview';
  return null;
}

export class TradeWorkflow {
  private inFlight = false;
  private tradeId: string | null = null;
  private failures = 0;
  private retryAt = 0;
  error: string | null = null;
  get paused() {
    return this.failures >= 3;
  }
  retry() {
    this.failures = 0;
    this.retryAt = 0;
    this.error = null;
  }
  async advance(client: WorkflowClient, trade: Trade, now = Date.now()) {
    if (this.inFlight) return;
    if (this.tradeId !== trade.id) {
      this.tradeId = trade.id;
      this.retry();
    }
    const action = nextTradeAction(trade);
    if (
      !action &&
      ['CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED'].includes(trade.status)
    )
      this.retry();
    if (!action || this.paused || now < this.retryAt) return;
    this.inFlight = true;
    try {
      const result = await client[action](trade.id);
      this.retry();
      return action === 'preview' ? (result as Trade['validatedPreview']) : undefined;
    } catch (error) {
      this.failures += 1;
      this.retryAt = now + Math.min(30_000, 5000 * 2 ** this.failures);
      this.error = error instanceof Error ? error.message : 'Local wallet unavailable';
    } finally {
      this.inFlight = false;
    }
  }
}

export function tradeProgress(trade: Trade): {
  step: number;
  title: string;
  detail: string;
  waiting: boolean;
} {
  if (trade.status === 'CONFIRMED')
    return {
      step: 4,
      title: 'Swap complete',
      detail:
        'Bitcoin is confirmed and your RGB assets have been accepted. Your balances are up to date.',
      waiting: false,
    };
  if (['CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED'].includes(trade.status))
    return {
      step: 0,
      title: trade.status === 'UNSUPPORTED' ? 'This swap is unavailable' : 'This swap has stopped',
      detail: 'Review the details below before creating another order.',
      waiting: false,
    };
  if (trade.txid || ['BROADCAST', 'READY_TO_BROADCAST'].includes(trade.status))
    return {
      step: 3,
      title: 'Waiting for confirmation',
      detail:
        'We’re checking Bitcoin and accepting your RGB assets automatically. On regtest, a new block must be mined by the local test setup.',
      waiting: true,
    };
  if (trade.signingAuthorized)
    return {
      step: 2,
      title: 'Waiting for the other wallets',
      detail:
        'Your approval is saved. We’ll finish the swap when every participant is ready. You don’t need to click again.',
      waiting: true,
    };
  if (trade.recoveryRequired)
    return {
      step: 2,
      title: 'Checking the swap status',
      detail:
        'We’re checking the saved transaction state with your wallet. No new approval is being requested.',
      waiting: true,
    };
  if (trade.validatedPreview)
    return {
      step: 1,
      title: 'Your swap is ready to review',
      detail:
        'Check what you give, what you receive and the fee. Only you can approve the signature.',
      waiting: false,
    };
  return {
    step: 0,
    title: 'Preparing your swap',
    detail:
      'The wallets are assembling and checking one atomic transaction. This can take a little while; we’ll keep checking for you.',
    waiting: true,
  };
}
