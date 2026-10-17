import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseOfferLink,
  validateTradeId,
  validateWalletRequest,
  walletReadyForDesktop,
} from '../src/security.ts';

const orderId = 'order-123e4567-e89b-42d3-a456-426614174000';
const tradeId = '123e4567-e89b-42d3-a456-426614174000';

test('offer deep links carry one published order ID and no credentials or actions', () => {
  assert.equal(parseOfferLink(`palka://offer/${orderId}`), orderId);
  for (const link of [
    `palka://offer/${orderId}?token=secret`,
    `palka://offer/${orderId}#secret`,
    `palka://offer/${orderId}/prepare`,
    `palka://offer//${orderId}`,
    `palka://other/${orderId}`,
    `foreign://offer/${orderId}`,
    `https://offer/${orderId}`,
    `palka://offer/${orderId}%2Fprepare`,
    `palka://offer/${orderId}%3Ftoken=secret`,
    'palka://offer/order-secret',
    'palka://offer/order-123e4567-e89b-42d3-a456-426614174000@evil',
  ])
    assert.equal(parseOfferLink(link), null, link);
});

test('generic renderer bridge allows only named local operations, with signing isolated', () => {
  for (const path of [
    '/api/health',
    '/api/state',
    '/api/policy',
    '/api/snapshot',
    '/api/funding',
    '/api/history',
    '/api/history?cursor=b3JkZXItMQ',
    `/api/trades/${tradeId}`,
    `/api/trades/${tradeId}/progress`,
  ]) {
    assert.equal(validateWalletRequest('GET', path), true, path);
  }
  for (const path of [
    '/api/interpret',
    '/api/draft/validate',
    '/api/orders',
    '/api/funding/create',
    '/api/funding/preview',
    '/api/funding/sync',
    `/api/orders/${orderId}/cancel`,
    `/api/trades/${tradeId}/prepare`,
    `/api/trades/${tradeId}/preview`,
    `/api/trades/${tradeId}/sync`,
    `/api/trades/${tradeId}/reject`,
  ]) {
    assert.equal(validateWalletRequest('POST', path), true, path);
  }
  for (const [method, path] of [
    ['POST', `/api/trades/${tradeId}/approve`],
    ['POST', '/api/funding/approve'],
    ['POST', '/api/funding/preview?address=attacker'],
    ['GET', '/api/funding/seed'],
    ['POST', '/api/history'],
    ['GET', '/api/history?cursor='],
    ['GET', '/api/history?cursor=one&cursor=two'],
    ['GET', '/api/history?cursor=one&token=secret'],
    ['GET', '/api/history?token=secret'],
    ['GET', '/api/history?cursor=%2Fsecret'],
    ['GET', '/api/history?cursor=one#secret'],
    ['GET', `/api/history?cursor=${'a'.repeat(301)}`],
    ['GET', '/api/orders'],
    ['POST', '/api/state'],
    ['POST', `/api/trades/${tradeId}/approve?approvalToken=secret`],
    ['GET', '/api/health#secret'],
    ['GET', '/api/trades/%2e%2e'],
    ['GET', '/api/trades/../state'],
    ['POST', '/api/admin/settings'],
    ['DELETE', '/api/orders'],
  ])
    assert.equal(validateWalletRequest(method, path), false, `${method} ${path}`);
  assert.equal(validateTradeId(tradeId), true);
  assert.equal(validateTradeId('../trade-1'), false);
  assert.equal(validateTradeId('trade-1?token=secret'), false);
  assert.equal(validateTradeId('.'), false);
  assert.equal(validateTradeId('..'), false);
});

test('desktop opens for an authenticated real wallet that needs reconciliation', () => {
  const capabilities = {
    protocolVersion: 1,
    mode: 'real',
    network: 'regtest',
    directSwap: false,
    ringSwap: false,
    signing: false,
    broadcast: false,
    adapterVersion: 'rgb-cooperative-v1',
    reason: 'Allocation index requires reconciliation',
  };
  assert.equal(walletReadyForDesktop({ protocolVersion: 1, result: capabilities }), true);
  assert.equal(
    walletReadyForDesktop({ protocolVersion: 1, result: { ...capabilities, mode: 'mock' } }),
    false,
  );
  assert.equal(
    walletReadyForDesktop({ protocolVersion: 1, result: { ...capabilities, network: 'mainnet' } }),
    false,
  );
  assert.equal(
    walletReadyForDesktop({ protocolVersion: 1, error: { code: 'WALLET_REJECTED' } }),
    false,
  );
});
