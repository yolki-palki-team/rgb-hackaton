import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TradeWorkflow,
  nextTradeAction,
  tradeProgress,
  type WorkflowClient,
} from '../ui/src/workflow.ts';
import { sampleTrades, type Trade } from '../ui/src/model.ts';

const trade = (status: string, extra: Partial<Trade> = {}): Trade => ({
  ...sampleTrades.direct,
  status,
  ...extra,
});
const checked = {
  give: '100000 sats',
  receive: '100 DUSD',
  feeSats: '500',
  btcDeltaSats: '-100500',
  digest: 'digest',
};

test('direct and ring workflows prepare, validate once, and stop for explicit approval', async () => {
  for (const kind of ['direct', 'ring'] as const) {
    const calls: string[] = [];
    const client: WorkflowClient = {
      prepare: async () => {
        calls.push('prepare');
      },
      preview: async () => {
        calls.push('preview');
        return checked;
      },
      sync: async () => {
        calls.push('sync');
      },
    };
    const workflow = new TradeWorkflow();
    await workflow.advance(client, trade('PREPARING', { kind }));
    assert.deepEqual(await workflow.advance(client, trade('AWAITING_APPROVAL', { kind })), checked);
    await workflow.advance(client, trade('SIGNING', { kind, validatedPreview: checked }));
    assert.deepEqual(calls, ['prepare', 'preview']);
    // A peer signing does not authorize this wallet.
    assert.equal(nextTradeAction(trade('SIGNING')), 'preview');
    assert.equal(nextTradeAction(trade('RECONCILING')), 'preview');
  }
});

test('durable local approval resumes recovery after restart, terminal states stop', async () => {
  const calls: string[] = [];
  const workflow = new TradeWorkflow();
  await workflow.advance(
    {
      prepare: async () => assert.fail('must not prepare'),
      preview: async () => assert.fail('must not reapprove'),
      sync: async () => {
        calls.push('sync');
      },
    },
    trade('AWAITING_APPROVAL', { signingAuthorized: true }),
  );
  assert.deepEqual(calls, ['sync']);
  for (const status of ['CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED', 'UNSUPPORTED']) {
    assert.equal(nextTradeAction(trade(status, { signingAuthorized: true })), null);
  }
  assert.equal(tradeProgress(trade('CONFIRMED')).waiting, false);
});

test('automatic requests never overlap and repeated failures back off then pause', async () => {
  let finish!: () => void;
  let calls = 0;
  const client: WorkflowClient = {
    prepare: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    preview: async () => checked,
    sync: async () => {},
  };
  const workflow = new TradeWorkflow();
  const pending = workflow.advance(client, trade('PREPARING'), 0);
  await workflow.advance(client, trade('PREPARING'), 1);
  assert.equal(calls, 1);
  finish();
  await pending;
  client.prepare = async () => {
    calls++;
    throw new Error('Wallet offline');
  };
  await workflow.advance(client, trade('PREPARING'), 10);
  await workflow.advance(client, trade('PREPARING'), 11);
  assert.equal(calls, 2);
  await workflow.advance(client, trade('PREPARING'), 10_010);
  await workflow.advance(client, trade('PREPARING'), 30_010);
  assert.equal(workflow.paused, true);
  await workflow.advance(client, trade('PREPARING'), 100_000);
  assert.equal(calls, 4);
  workflow.retry();
  client.prepare = async () => {
    calls++;
  };
  await workflow.advance(client, trade('PREPARING'), 100_001);
  assert.equal(calls, 5);
  assert.equal(workflow.error, null);
});
