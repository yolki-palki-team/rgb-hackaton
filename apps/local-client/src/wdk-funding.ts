import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { entropyToMnemonic } from 'bip39';
import { address as btcAddress, networks, Transaction } from 'bitcoinjs-lib';
import WalletManagerBtc, { ElectrumTcp } from '@tetherto/wdk-wallet-btc';
import {
  FundingTargetSchema,
  type WalletAdapter,
  type FundingTarget,
} from '@rgb-exchange/contracts';
import { z } from 'zod';
import type { FundingOperation, FundingStatus } from './funding-types.ts';

export class FundingError extends Error {}

const REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const MAX_FEE = 10_000n;
const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((v) => BigInt(v) >= 1000n && BigInt(v) <= 2_100_000_000_000_000n);
type SavedOperation = FundingOperation & { walletId: string; ownerId: string; rawHex?: string };

/** Only public summaries leave this module. Seeds and signed transactions stay in the private database. */
export interface FundingAccount {
  address(): Promise<string>;
  balance(): Promise<bigint>;
  quote(address: string, amount: bigint): Promise<bigint>;
  sign(address: string, amount: bigint): Promise<string>;
  validate(raw: string, operation: FundingOperation): Promise<bigint>;
  broadcast(raw: string): Promise<string>;
  receipt(txid: string): Promise<'pending' | 'confirmed' | 'absent'>;
  close(): void;
}

export type FundingOptions = {
  directory: string;
  ownerId: string;
  wallet: WalletAdapter;
  electrumPort?: number;
  // Dependency injection for contract tests; production always uses the real WDK factory.
  accountFactory?: (mnemonic: string) => Promise<FundingAccount>;
};

function publicOperation(saved: SavedOperation | null): FundingOperation | null {
  if (!saved) return null;
  const { id, status, network, address, amountSats, feeSats, maxFeeSats, expiresAt, txid, reason } =
    saved;
  return { id, status, network, address, amountSats, feeSats, maxFeeSats, expiresAt, txid, reason };
}

/** Verify the local indexer's chain, independently of the address prefix in configuration. */
export async function verifyRegtestElectrum(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let input = '';
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(5000, () => finish(new FundingError('Local regtest Electrum timed out.')));
    socket.on('error', () => finish(new FundingError('Local regtest Electrum is unavailable.')));
    socket.on('connect', () =>
      socket.write(JSON.stringify({ id: 1, method: 'server.features', params: [] }) + '\n'),
    );
    socket.on('data', (chunk) => {
      input += chunk.toString();
      if (input.length > 65_536) return finish(new FundingError('Invalid Electrum response.'));
      if (!input.includes('\n')) return;
      try {
        const result = JSON.parse(input.split('\n')[0]);
        if (result.id !== 1 || result.result?.genesis_hash !== REGTEST_GENESIS)
          throw new FundingError('WDK funding requires the local regtest chain.');
        finish();
      } catch {
        finish(new FundingError('WDK funding requires the local regtest chain.'));
      }
    });
    socket.on('end', () =>
      finish(new FundingError('Local regtest Electrum closed the connection.')),
    );
  });
}

/** Independently bind every signed input, recipient output, change output and fee. */
export async function validateFundingTransaction(
  raw: string,
  operation: FundingOperation,
  ownAddress: string,
  previous: (txid: string) => Promise<string>,
): Promise<bigint> {
  const tx = Transaction.fromHex(raw);
  const ownScript = btcAddress.toOutputScript(ownAddress, networks.regtest);
  const destination = btcAddress.toOutputScript(operation.address, networks.regtest);
  const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
  if (!tx.ins.length || tx.outs.length < 1 || tx.outs.length > 2 || same(ownScript, destination))
    throw new FundingError('Invalid funding transaction.');
  const seen = new Set<string>();
  let incoming = 0n;
  for (const input of tx.ins) {
    const id = Buffer.from(input.hash).reverse().toString('hex');
    const key = `${id}:${input.index}`;
    const prev = Transaction.fromHex(await previous(id));
    const output = prev.outs[input.index];
    if (seen.has(key) || prev.getId() !== id || !output || !same(output.script, ownScript))
      throw new FundingError('Funding input does not belong to this WDK account.');
    // Only a normal SegWit signature committing to every output is accepted.
    if (input.witness.length !== 2 || input.witness[0].at(-1) !== Transaction.SIGHASH_ALL)
      throw new FundingError('Invalid funding signature mode.');
    seen.add(key);
    incoming += output.value;
  }
  let received = 0n;
  let outgoing = 0n;
  let recipientCount = 0;
  for (const output of tx.outs) {
    if (same(output.script, destination)) {
      received += output.value;
      recipientCount++;
    } else if (!same(output.script, ownScript))
      throw new FundingError('Unexpected funding recipient.');
    outgoing += output.value;
  }
  const fee = incoming - outgoing;
  if (
    recipientCount !== 1 ||
    received !== BigInt(operation.amountSats) ||
    fee < 1n ||
    fee > BigInt(operation.maxFeeSats) ||
    fee > MAX_FEE
  )
    throw new FundingError('Signed funding amount or fee differs from the approved limits.');
  return fee;
}

async function realAccount(mnemonic: string, port: number): Promise<FundingAccount> {
  const client = new ElectrumTcp({ host: '127.0.0.1', port, network: 'regtest', maxRetry: 0 });
  const manager = new WalletManagerBtc(mnemonic, {
    network: 'regtest',
    client,
    bip: 84,
    transactionMaxFee: MAX_FEE,
  });
  const account = await manager.getAccount(0);
  const ready = async () => {
    await verifyRegtestElectrum(port);
    await client.connect();
  };
  return {
    address: () => account.getAddress(),
    balance: async () => {
      await ready();
      return account.getBalance();
    },
    quote: async (to, value) => {
      await ready();
      return (await account.quoteSendTransaction({ to, value, feeRate: 1n })).fee;
    },
    sign: async (to, value) => {
      await ready();
      return account.signTransaction({ to, value, feeRate: 1n });
    },
    validate: async (raw, operation) => {
      await ready();
      return validateFundingTransaction(raw, operation, await account.getAddress(), (id) =>
        client.getTransaction(id),
      );
    },
    broadcast: async (raw) => {
      await ready();
      return (await account.sendTransaction(raw, 0)).hash;
    },
    receipt: async (txid) => {
      await ready();
      const history = await client.getHistory(await account.getAddress());
      if (!history.some((item) => item.tx_hash === txid)) return 'absent';
      const receipt = await account.getTransaction(txid);
      if (receipt.transaction.getId() !== txid) throw new FundingError('Funding receipt mismatch.');
      return receipt.finality === 'confirmed' || receipt.finality === 'final'
        ? 'confirmed'
        : 'pending';
    },
    close: () => {
      manager.dispose();
      void client.close();
    },
  };
}

export class WdkFunding {
  private db: DatabaseSync | null = null;
  private account: FundingAccount | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: FundingOptions) {
    if (
      !Number.isInteger(options.electrumPort ?? 50001) ||
      (options.electrumPort ?? 50001) < 1024 ||
      (options.electrumPort ?? 50001) > 65535
    )
      throw new FundingError('Invalid WDK Electrum port.');
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private database(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.options.directory, 0o700);
    const file = join(this.options.directory, 'funding.sqlite');
    const db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      const lock = db.prepare("SELECT value FROM records WHERE key='process'").get() as
        { value: string } | undefined;
      if (lock) {
        const pid = Number(lock.value);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          alive = !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
        }
        if (alive)
          throw new FundingError('This funding wallet is already open in another process.');
      }
      db.prepare("INSERT OR REPLACE INTO records VALUES ('process', ?)").run(String(process.pid));
      const owner = db.prepare("SELECT value FROM records WHERE key='owner'").get() as
        { value: string } | undefined;
      if (owner && owner.value !== this.options.ownerId)
        throw new FundingError('Funding wallet owner mismatch.');
      db.prepare("INSERT OR REPLACE INTO records VALUES ('owner', ?)").run(this.options.ownerId);
      db.exec('COMMIT');
      this.db = db;
      return db;
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  private read<T>(key: string): T | null {
    const row = this.database().prepare('SELECT value FROM records WHERE key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  private save(key: string, value: unknown) {
    this.database()
      .prepare('INSERT OR REPLACE INTO records VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }
  private async target(): Promise<FundingTarget> {
    if (!this.options.wallet.fundingTarget)
      throw new FundingError('Connect the real regtest wallet backend to enable WDK funding.');
    const state = await this.options.wallet.state();
    const target = FundingTargetSchema.parse(await this.options.wallet.fundingTarget());
    if (
      state.mode !== 'real' ||
      state.network !== 'regtest' ||
      state.ownerId !== this.options.ownerId ||
      target.ownerId !== this.options.ownerId ||
      state.walletId !== target.walletId
    )
      throw new FundingError('Funding target identity or network mismatch.');
    btcAddress.toOutputScript(target.address, networks.regtest);
    const bound = this.read<string>('recipient-wallet');
    if (bound && bound !== target.walletId)
      throw new FundingError('The exchange wallet identity has changed.');
    return target;
  }
  private async accountForWallet(): Promise<FundingAccount> {
    if (this.account) return this.account;
    const mnemonic = this.read<string>('mnemonic');
    if (!mnemonic) throw new FundingError('Create the separate WDK funding account first.');
    this.account = await (
      this.options.accountFactory ??
      ((seed) => realAccount(seed, this.options.electrumPort ?? 50001))
    )(mnemonic);
    return this.account;
  }
  async status(): Promise<FundingStatus> {
    let operation: FundingOperation | null = null;
    try {
      operation = publicOperation(this.read<SavedOperation>('operation'));
      await this.target();
      if (!this.read('mnemonic')) return { available: true, network: 'regtest', operation };
      const account = await this.accountForWallet();
      const address = await account.address();
      try {
        return {
          available: true,
          network: 'regtest',
          address,
          balanceSats: String(await account.balance()),
          operation,
        };
      } catch {
        return {
          available: false,
          network: 'regtest',
          address,
          operation,
          reason: 'The local regtest Electrum server is unavailable. Start it and refresh.',
        };
      }
    } catch {
      return {
        available: false,
        network: 'regtest',
        operation,
        reason:
          'WDK funding is unavailable. Connect the real wallet backend, finish any active trade, and refresh.',
      };
    }
  }
  async create(body: unknown): Promise<FundingStatus> {
    z.object({ confirmed: z.literal(true) })
      .strict()
      .parse(body);
    const target = await this.target();
    if (!this.read('mnemonic')) {
      this.save('recipient-wallet', target.walletId);
      this.save('mnemonic', entropyToMnemonic(randomBytes(32)));
    }
    return this.status();
  }
  async preview(body: unknown): Promise<FundingOperation> {
    const { amountSats } = z.object({ amountSats: amountSchema }).strict().parse(body);
    const prior = this.read<SavedOperation>('operation');
    if (prior && !['PREVIEW', 'CONFIRMED'].includes(prior.status))
      throw new FundingError('Resolve the existing funding transaction before creating another.');
    const target = await this.target();
    const account = await this.accountForWallet();
    if ((await account.address()) === target.address)
      throw new FundingError('Funding and exchange wallets must be separate.');
    const fee = await account.quote(target.address, BigInt(amountSats));
    if (fee < 1n || fee > MAX_FEE)
      throw new FundingError('Funding fee is above the 10,000 sat limit.');
    // A bounded tolerance covers size differences between unsigned quote and signed SegWit transaction.
    const maxFee = fee + 100n < MAX_FEE ? fee + 100n : MAX_FEE;
    if ((await account.balance()) < BigInt(amountSats) + maxFee)
      throw new FundingError(
        'Insufficient BTC in the WDK funding account, including the fee limit.',
      );
    const saved: SavedOperation = {
      id: randomUUID(),
      status: 'PREVIEW',
      network: 'regtest',
      address: target.address,
      walletId: target.walletId,
      ownerId: target.ownerId,
      amountSats,
      feeSats: String(fee),
      maxFeeSats: String(maxFee),
      expiresAt: Date.now() + 120_000,
    };
    this.save('operation', saved);
    return publicOperation(saved)!;
  }
  async approve(body: unknown): Promise<FundingOperation> {
    const { operationId } = z
      .object({ operationId: z.string().uuid(), confirmed: z.literal(true) })
      .strict()
      .parse(body);
    const saved = this.read<SavedOperation>('operation');
    if (!saved || saved.id !== operationId)
      throw new FundingError('Funding preview changed. Review it again.');
    if (saved.status !== 'PREVIEW') return publicOperation(saved)!;
    if (saved.expiresAt <= Date.now())
      throw new FundingError('Funding preview expired. Review it again.');
    const target = await this.target();
    if (
      target.walletId !== saved.walletId ||
      target.ownerId !== saved.ownerId ||
      target.address !== saved.address
    )
      throw new FundingError('Funding destination changed. Review it again.');
    const account = await this.accountForWallet();
    saved.status = 'SIGNING';
    this.save('operation', saved);
    try {
      saved.rawHex = await account.sign(saved.address, BigInt(saved.amountSats));
      saved.txid = Transaction.fromHex(saved.rawHex).getId();
      // Save the signed bytes before any validation/network lookup that may fail.
      this.save('operation', saved);
      saved.feeSats = String(await account.validate(saved.rawHex, saved));
      saved.status = 'SIGNED';
      this.save('operation', saved);
    } catch {
      saved.status = 'RECONCILING';
      saved.reason =
        'Signing or validation was interrupted. Funds were not automatically retried. Refresh to reconcile the saved operation.';
      this.save('operation', saved);
      return publicOperation(saved)!;
    }
    return this.sendSaved(saved, account);
  }
  private async sendSaved(
    saved: SavedOperation,
    account: FundingAccount,
  ): Promise<FundingOperation> {
    if (!saved.rawHex || !saved.txid) return publicOperation(saved)!;
    // An uncertain result is durable before submission. Retries can only send these exact bytes.
    saved.status = 'RECONCILING';
    saved.reason = 'Checking submission of the saved transaction. Do not create a replacement.';
    this.save('operation', saved);
    try {
      await account.validate(saved.rawHex, saved);
      const hash = await account.broadcast(saved.rawHex);
      if (hash !== saved.txid) throw new FundingError('Funding transaction hash mismatch.');
      saved.status = 'BROADCAST';
      delete saved.reason;
    } catch {
      saved.reason =
        'Broadcast result is unknown. Refresh to check or resend the same saved transaction.';
    }
    this.save('operation', saved);
    return publicOperation(saved)!;
  }
  async sync(): Promise<FundingStatus> {
    const saved = this.read<SavedOperation>('operation');
    if (saved && saved.status !== 'PREVIEW') {
      const account = await this.accountForWallet();
      if (saved.txid && saved.rawHex) {
        try {
          await account.validate(saved.rawHex, saved);
          const receipt = await account.receipt(saved.txid);
          if (receipt === 'confirmed') saved.status = 'CONFIRMED';
          else if (receipt === 'pending') saved.status = 'BROADCAST';
          else {
            await this.sendSaved(saved, account);
            return this.status();
          }
          delete saved.reason;
          this.save('operation', saved);
        } catch {
          saved.status = 'RECONCILING';
          saved.reason =
            'Could not verify the saved transaction. Keep this operation and retry refresh when the local chain is available.';
          this.save('operation', saved);
        }
      } else {
        saved.status = 'RECONCILING';
        saved.reason =
          'Signing was interrupted before a transaction was saved. No automatic replacement is allowed; inspect the local wallet state.';
        this.save('operation', saved);
      }
    }
    return this.status();
  }
  close() {
    this.account?.close();
    this.account = null;
    if (this.db) {
      this.db
        .prepare("DELETE FROM records WHERE key='process' AND value=?")
        .run(String(process.pid));
      this.db.close();
      this.db = null;
    }
  }
}
