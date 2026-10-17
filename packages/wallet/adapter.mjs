import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('.', import.meta.url));
export class UnsupportedSettlementError extends Error {
  constructor(operation) {
    super(
      `${operation}: this legacy bridge is read-only; use protocol-v1 HTTP sidecar described in docs/settlement.md`,
    );
    this.code = 'UNVERIFIED_SETTLEMENT_CAPABILITY';
  }
}

// A owns the network API and contracts. This bridge is local subprocess IPC only.
export function createWalletAdapter({
  profile,
  stateDir = resolve(base, 'state'),
  binary = resolve(base, 'native/target/debug/rgb-settlement-spike'),
}) {
  if (!['alice', 'bob', 'carol'].includes(profile)) throw new Error('Unknown local profile');
  const request = (op, data = {}) =>
    new Promise((accept, reject) => {
      const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Local RGB SDK timed out'));
      }, 60000);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          child.kill();
          reject(new Error('SDK response exceeded limit'));
        } else stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 8192) stderr += chunk;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr.trim() || `Local RGB SDK exited ${code}`));
        try {
          accept(JSON.parse(stdout));
        } catch {
          reject(new Error('Invalid SDK JSON response'));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...data, op, profile, stateDir }));
    });
  return Object.freeze({
    async capabilities() {
      try {
        return { protocolVersion: 'wallet-spike-v0', ...(await request('capabilities')) };
      } catch {
        return {
          protocolVersion: 'wallet-spike-v0',
          mode: 'unavailable',
          network: 'regtest',
          directAtomic: false,
          ringAtomic: false,
          sign: false,
          reason: 'Native RGB backend unavailable. Run the documented bootstrap/build.',
        };
      }
    },
    async state() {
      const result = await request('state');
      return {
        ...result,
        mode: 'real',
        balancesSource: 'RGB stock restricted to wallet-owned unspent outputs',
        sdkAssetBalanceIndexAuthoritative: false,
      };
    },
    async identity() {
      return request('identity');
    },
    async prepare() {
      throw new UnsupportedSettlementError('prepare through production adapter');
    },
    async sign() {
      throw new UnsupportedSettlementError('sign through production adapter');
    },
    async broadcast() {
      throw new UnsupportedSettlementError('broadcast through production adapter');
    },
  });
}
