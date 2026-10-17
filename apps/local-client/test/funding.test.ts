import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Transaction, payments, networks, address as btcAddress } from 'bitcoinjs-lib';
import type { FundingTarget } from '@rgb-exchange/contracts';
import { MockWalletAdapter } from '../src/wallet.ts';
import { WdkFunding, validateFundingTransaction, type FundingAccount } from '../src/wdk-funding.ts';
import type { FundingOperation } from '../src/funding-types.ts';

const own = payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.regtest }).address!;
const recipient = payments.p2wpkh({
  hash: Buffer.alloc(20, 2),
  network: networks.regtest,
}).address!;
const other = payments.p2wpkh({ hash: Buffer.alloc(20, 3), network: networks.regtest }).address!;
const script = (address: string) => btcAddress.toOutputScript(address, networks.regtest);
const previous = new Transaction();
previous.addInput(Buffer.alloc(32, 7), 0);
previous.addOutput(script(own), 100_000n);

class TargetWallet extends MockWalletAdapter {
  target: FundingTarget = {
    walletId: 'mock-wallet-A',
    ownerId: 'A',
    network: 'regtest',
    address: recipient,
  };
  real = true;
  override async state() {
    const state = await super.state();
    return { ...state, mode: this.real ? ('real' as const) : ('mock' as const) };
  }
  async fundingTarget() {
    return this.target;
  }
}

class AccountDouble implements FundingAccount {
  signs = 0;
  broadcasts: string[] = [];
  loseResponse = false;
  fee = 150n;
  observed: 'pending' | 'confirmed' | 'absent' = 'absent';
  async address() {
    return own;
  }
  async balance() {
    return 100_000n;
  }
  async quote() {
    return 150n;
  }
  async sign(address: string, amount: bigint) {
    this.signs++;
    const tx = new Transaction();
    tx.addInput(previous.getHash(), 0);
    tx.setWitness(0, [Buffer.from([1, 1]), Buffer.alloc(33, 1)]);
    tx.addOutput(script(address), amount);
    tx.addOutput(script(own), 100_000n - amount - this.fee);
    return tx.toHex();
  }
  async validate(raw: string, operation: FundingOperation) {
    return validateFundingTransaction(raw, operation, own, async () => previous.toHex());
  }
  async broadcast(raw: string) {
    this.broadcasts.push(raw);
    if (this.loseResponse) throw new Error('synthetic lost response');
    this.observed = 'pending';
    return Transaction.fromHex(raw).getId();
  }
  async receipt() {
    return this.observed;
  }
  close() {}
}

function setup(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'palka-funding-test-'));
  const wallet = new TargetWallet('A');
  const account = new AccountDouble();
  const options = { directory, wallet, ownerId: 'A', accountFactory: async () => account };
  let funding = new WdkFunding(options);
  t.after(() => {
    funding.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    wallet,
    account,
    get funding() {
      return funding;
    },
    restart() {
      funding.close();
      funding = new WdkFunding(options);
      return funding;
    },
  };
}

test('funding needs a real wallet and explicit creation; responses never contain seed or signed bytes', async (t) => {
  const f = setup(t);
  f.wallet.real = false;
  assert.equal((await f.funding.status()).available, false);
  await assert.rejects(f.funding.create({ confirmed: true }));
  f.wallet.real = true;
  assert.equal((await f.funding.status()).address, undefined);
  await assert.rejects(f.funding.create({ confirmed: false }));
  const status = await f.funding.create({ confirmed: true });
  assert.equal(status.address, own);
  assert.equal(statSync(join(f.directory, 'funding.sqlite')).mode & 0o077, 0);
  assert.equal(statSync(f.directory).mode & 0o077, 0);
  assert.doesNotMatch(JSON.stringify(status), /mnemonic|rawHex|privateKey/);
  const contender = new WdkFunding({ directory: f.directory, wallet: f.wallet, ownerId: 'A' });
  t.after(() => contender.close());
  await assert.rejects(contender.create({ confirmed: true }), /already open/);
  assert.equal((await f.restart().status()).address, own);
});

test('funding validates amounts, immutable target, explicit approval and bounded fees', async (t) => {
  const f = setup(t);
  await f.funding.create({ confirmed: true });
  for (const amountSats of ['0', '-1', '1.5', '01', '999', '2100000000000001'])
    await assert.rejects(f.funding.preview({ amountSats }));
  await assert.rejects(f.funding.preview({ amountSats: '1000', address: other }));
  await assert.rejects(f.funding.preview({ amountSats: '100000' }), /Insufficient/);
  const preview = await f.funding.preview({ amountSats: '10000' });
  assert.equal(f.account.signs, 0);
  assert.equal(preview.maxFeeSats, '250');
  await assert.rejects(f.funding.approve({ operationId: preview.id, confirmed: false }));
  f.wallet.target.address = other;
  await assert.rejects(
    f.funding.approve({ operationId: preview.id, confirmed: true }),
    /destination changed/,
  );
  f.wallet.target.address = recipient;
  f.account.fee = 251n;
  const rejected = await f.funding.approve({ operationId: preview.id, confirmed: true });
  assert.equal(rejected.status, 'RECONCILING');
  assert.equal(f.account.broadcasts.length, 0);
  await f.funding.sync();
  assert.equal(f.account.broadcasts.length, 0);
  await assert.rejects(f.funding.preview({ amountSats: '10000' }), /Resolve/);
});

test('expired or replaced previews never sign', async (t) => {
  const f = setup(t);
  await f.funding.create({ confirmed: true });
  const old = await f.funding.preview({ amountSats: '10000' });
  const current = await f.funding.preview({ amountSats: '11000' });
  await assert.rejects(f.funding.approve({ operationId: old.id, confirmed: true }), /changed/);
  t.mock.method(Date, 'now', () => current.expiresAt + 1);
  await assert.rejects(f.funding.approve({ operationId: current.id, confirmed: true }), /expired/);
  assert.equal(f.account.signs, 0);
});

test('lost broadcast response survives restart and only the identical transaction is retried', async (t) => {
  const f = setup(t);
  await f.funding.create({ confirmed: true });
  const preview = await f.funding.preview({ amountSats: '10000' });
  f.account.loseResponse = true;
  const result = await f.funding.approve({ operationId: preview.id, confirmed: true });
  assert.equal(result.status, 'RECONCILING');
  assert.ok(result.txid);
  assert.doesNotMatch(JSON.stringify(result), /rawHex|mnemonic/);
  f.restart();
  await f.funding.approve({ operationId: preview.id, confirmed: true });
  assert.equal(f.account.signs, 1);
  f.account.loseResponse = false;
  const retry = await f.funding.sync();
  assert.equal(retry.operation?.status, 'BROADCAST');
  assert.equal(f.account.broadcasts[0], f.account.broadcasts[1]);
  assert.equal(f.account.signs, 1);
  f.account.observed = 'confirmed';
  const confirmed = await f.restart().sync();
  assert.equal(confirmed.operation?.status, 'CONFIRMED');
  assert.equal(confirmed.operation?.txid, result.txid);
  assert.equal(f.account.broadcasts.length, 2);
});

test('signed transaction validation rejects changed recipient, wrong previous outputs and permissive sighash', async (t) => {
  const f = setup(t);
  await f.funding.create({ confirmed: true });
  const preview = await f.funding.preview({ amountSats: '10000' });
  const raw = await f.account.sign(recipient, 10000n);
  assert.equal(await f.account.validate(raw, preview), 150n);
  await assert.rejects(f.account.validate(raw, { ...preview, address: other }));
  await assert.rejects(f.account.validate(raw, { ...preview, amountSats: '9999' }));
  const changed = Transaction.fromHex(raw);
  changed.ins[0].witness[0] = Buffer.from([1, 0x81]);
  await assert.rejects(f.account.validate(changed.toHex(), preview), /signature mode/);
  const wrongPrev = Transaction.fromHex(previous.toHex());
  wrongPrev.outs[0].script = script(other);
  await assert.rejects(
    validateFundingTransaction(raw, preview, own, async () => wrongPrev.toHex()),
    /does not belong/,
  );
});
